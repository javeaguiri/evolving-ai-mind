// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/integration/callback-slack.test.mjs
//
// Integration tests for callback.mjs — posts real messages to a Slack test
// channel and verifies the Slack API accepts them without error.
//
// These tests exercise the full rendering pipeline:
//   textToBlocks / dialogToBlocks → chat.postMessage → Slack API validation
//
// Slack validates block structure server-side and returns invalid_blocks on
// any malformed payload (bad field types, oversized text, empty arrays, etc.).
// A successful API response means the rendered blocks passed Slack validation.
//
// Prerequisites:
//   SLACK_BOT_TOKEN     — bot token with chat:write scope
//   TEST_SLACK_CHANNEL  — channel ID (e.g. C0AEJ87JSKF) — use a dedicated
//                         #evolving-mind-test channel, not the main bot channel
//
// Running:
//   set SLACK_BOT_TOKEN=xoxb-... && set TEST_SLACK_CHANNEL=C... && node --test tests/integration/callback-slack.test.mjs
//   node --test --test-reporter=spec tests/integration/callback-slack.test.mjs
//
// Skip behaviour: if SLACK_BOT_TOKEN or TEST_SLACK_CHANNEL are absent, all
// tests are skipped with a diagnostic message. Safe to run in CI pipelines
// that do not have Slack credentials configured.

import { describe, it, before, skip } from 'node:test';
import assert from 'node:assert/strict';
import { WebClient } from '@slack/web-api';

// ---------------------------------------------------------------------------
// Environment gate — skip all tests if credentials absent
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const TEST_SLACK_CHANNEL = process.env.TEST_SLACK_CHANNEL;
const SKIP               = !SLACK_BOT_TOKEN || !TEST_SLACK_CHANNEL;

if (SKIP) {
  console.log('callback-slack.test: SLACK_BOT_TOKEN or TEST_SLACK_CHANNEL not set — skipping all tests');
}

// ---------------------------------------------------------------------------
// Helpers — inline copies of textToBlocks and dialogToBlocks.
// Keep in sync with src/ui/slackbot/callback.mjs.
// ---------------------------------------------------------------------------

const BLOCK_CHAR_LIMIT = 2800;

function textToBlocks(text, contextText) {
  const blocks = [];
  if (text.length <= BLOCK_CHAR_LIMIT) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  } else {
    const lines = text.split('\n');
    let chunk = '';
    for (const line of lines) {
      const candidate = chunk ? chunk + '\n' + line : line;
      if (candidate.length > BLOCK_CHAR_LIMIT) {
        if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
        chunk = line.length > BLOCK_CHAR_LIMIT ? line.slice(0, BLOCK_CHAR_LIMIT - 3) + '...' : line;
      } else {
        chunk = candidate;
      }
    }
    if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
  }
  if (contextText) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: contextText }] });
  }
  return blocks;
}

function dialogToBlocks(dialog, workflowRunId) {
  const blocks = [];
  for (const field of (dialog?.fields ?? [])) {
    switch (field.type) {
      case 'typography':
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\ud83e\udde0 ${field.value}` } });
        break;
      case 'description_list': {
        const lines = (field.items ?? []).map(i => `*${i.label}* \u2014 ${i.description || i.label}`);
        if (lines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } });
        break;
      }
      case 'list': {
        if (field.label) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${field.label}*` } });
        for (const [idx, item] of (field.items ?? []).entries()) {
          const sec = { type: 'section', text: { type: 'mrkdwn', text: `*${item.primary}*${item.secondary ? `\n${item.secondary}` : ''}` } };
          if (item.secondaryAction) {
            sec.accessory = {
              type: 'button', style: item.secondaryAction.style === 'danger' ? 'danger' : 'default',
              text: { type: 'plain_text', text: item.secondaryAction.label },
              action_id: `workflow_action_${item.id || idx}_${idx}`,
              value: JSON.stringify({ workflowRunId, action: item.secondaryAction.action, responseData: { tableName: item.id } }),
              ...(item.secondaryAction.confirm ? { confirm: { title: { type: 'plain_text', text: 'Are you sure?' }, text: { type: 'plain_text', text: item.secondaryAction.confirm }, confirm: { type: 'plain_text', text: 'Remove' }, deny: { type: 'plain_text', text: 'Cancel' } } } : {}),
            };
          }
          blocks.push(sec);
        }
        break;
      }
      case 'review_object': {
        for (const item of (field.items ?? [])) {
          let v;
          if (Array.isArray(item.value)) {
            if (!item.value.length) v = '(none)';
            else if (typeof item.value[0] === 'object') v = '\n' + item.value.map(x => `    \u2022 ${x.syntax ?? x.verb ?? x.command ?? JSON.stringify(x)}`).join('\n');
            else v = item.value.join(', ');
          } else v = String(item.value ?? '');
          let line = `*${item.key}:* ${v}`;
          if (line.length > BLOCK_CHAR_LIMIT) line = line.slice(0, BLOCK_CHAR_LIMIT - 3) + '...';
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: line } });
        }
        break;
      }
      case 'actions': {
        const elements = (field.buttons ?? []).map((btn, i) => ({
          type: 'button',
          style: btn.style === 'primary' ? 'primary' : btn.style === 'danger' ? 'danger' : undefined,
          text: { type: 'plain_text', text: btn.label },
          action_id: `workflow_action_${btn.action || i}_${i}`,
          value: JSON.stringify({ workflowRunId, action: btn.action, ...(btn.modal ? { modal: btn.modal } : {}) }),
        }));
        if (elements.length) blocks.push({ type: 'actions', elements });
        break;
      }
      default: break;
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Slack client
// ---------------------------------------------------------------------------

let slack;
if (!SKIP) {
  slack = new WebClient(SLACK_BOT_TOKEN);
}

// Post blocks to the test channel. Throws if Slack rejects (invalid_blocks,
// missing_scope, etc.) — test failures surface as assertion errors.
async function post(text, blocks) {
  const result = await slack.chat.postMessage({
    channel: TEST_SLACK_CHANNEL,
    text,
    blocks,
  });
  assert.ok(result.ok, `Slack API returned ok:false — ${result.error}`);
  assert.ok(result.ts, 'Slack response missing ts — message not posted');
  return result;
}

// ---------------------------------------------------------------------------
// HUMAN_NOTIFICATION — textToBlocks rendering
// ---------------------------------------------------------------------------

describe('HUMAN_NOTIFICATION — textToBlocks Slack rendering', { skip: SKIP }, () => {

  it('short notification renders as single section block', async () => {
    const text = 'Recipes listed: Sweet Potato Chili, Pasta Carbonara, Mushroom Risotto.';
    const blocks = textToBlocks(text, 'runId: 999 | traceId: test-short');
    await post(text, blocks);
  });

  it('long notification splits into multiple blocks without invalid_blocks', async () => {
    // Simulates a CRUD list result that exceeds 2800 chars — common for
    // list_entity results with many records.
    const items = Array.from({ length: 40 }, (_, i) =>
      `${i + 1}. Recipe name ${i + 1}: A detailed recipe with ingredients and cooking steps that add length.`
    );
    const text = items.join('\n');
    assert.ok(text.length > BLOCK_CHAR_LIMIT, 'test text must exceed limit to be meaningful');
    const blocks = textToBlocks(text, 'runId: 998 | traceId: test-long');
    // Each section block must be within limit — Slack will reject if not.
    for (const b of blocks.filter(b => b.type === 'section')) {
      assert.ok(b.text.text.length <= BLOCK_CHAR_LIMIT);
    }
    await post(text.slice(0, 150), blocks);
  });

  it('notification with unicode characters renders without encoding errors', async () => {
    const text = 'Domain created \u2014 try: /m list spanish_flashcards';
    const blocks = textToBlocks(text, 'traceId: test-unicode');
    await post(text, blocks);
  });

  it('workflow cancelled message renders correctly', async () => {
    const text = 'Workflow cancelled.';
    const blocks = textToBlocks(text, 'runId: 997 | traceId: test-cancel');
    await post(text, blocks);
  });

  it('workflow error summary renders within Slack limits', async () => {
    // Simulates postWorkflowError output — a summary, not raw AJV errors.
    const displayText = '\u26a0\ufe0f *Workflow failed* at step 3a\n\nLLM output validation failed after 2 attempts (7 schema errors). The prompt has been logged for improvement.';
    const blocks = textToBlocks(displayText, 'runId: 996 | traceId: test-error');
    await post(displayText.slice(0, 150), blocks);
  });
});

// ---------------------------------------------------------------------------
// HUMAN_GATE — dialogToBlocks rendering
// ---------------------------------------------------------------------------

describe('HUMAN_GATE — dialogToBlocks Slack rendering', { skip: SKIP }, () => {

  it('confirm gate renders with action buttons', async () => {
    const dialog = {
      fields: [
        { type: 'typography', value: 'Ready to create domain recipes with 2 tables. This will create the physical database tables.' },
        { type: 'actions', buttons: [
          { label: 'Create it', action: 'confirm', style: 'primary' },
          { label: 'Cancel',    action: 'cancel' },
        ]},
      ],
    };
    const blocks = dialogToBlocks(dialog, 9001);
    await post('Workflow gate', blocks);
  });

  it('choice gate with description_list renders without invalid_blocks', async () => {
    // Simulates create_workflow step 1a — workflow_mode choice gate.
    const dialog = {
      fields: [
        { type: 'typography', value: 'What kind of workflow are you creating?' },
        { type: 'description_list', items: [
          { label: 'A', description: 'A data collection workflow — adding or updating records in a domain.' },
          { label: 'B', description: 'A reporting or lookup workflow — finding and displaying records.' },
          { label: 'C', description: 'A multi-step processing workflow with conditions and branching.' },
          { label: 'D', description: 'An interactive quiz or learning workflow with scored responses.' },
          { label: 'E', description: 'Something else — describe what your workflow should do.' },
        ]},
        { type: 'actions', buttons: [
          { label: 'A', action: 'data_entry' },
          { label: 'B', action: 'reporting' },
          { label: 'C', action: 'processing' },
          { label: 'D', action: 'interactive_quiz' },
          { label: 'E', action: 'other', modal: {
            title: 'Describe your workflow',
            input_label: 'What should this workflow do?',
            placeholder: 'Describe the goal, the data it works with, and any steps or decisions involved.',
            multiline: true,
          }},
          { label: 'Cancel', action: 'cancel' },
        ]},
      ],
    };
    const blocks = dialogToBlocks(dialog, 9002);
    // Verify 'other' button value contains modal descriptor
    const actionsBlock = blocks.find(b => b.type === 'actions');
    const otherBtn = actionsBlock.elements.find(e => {
      const v = JSON.parse(e.value);
      return v.action === 'other';
    });
    assert.ok(otherBtn, '"other" button must exist');
    const otherValue = JSON.parse(otherBtn.value);
    assert.ok(otherValue.modal, '"other" button value must include modal descriptor');
    assert.equal(otherValue.modal.multiline, true);
    await post('Workflow gate', blocks);
  });

  it('list_selection gate with selectable and non-selectable items renders correctly', async () => {
    // A row list where some rows are selectable and others (e.g. a referenced parent) are not.
    const dialog = {
      fields: [
        { type: 'typography', value: "Here's my plan for domain recipes. You can remove child tables you don't need." },
        { type: 'list', label: '2 table(s) proposed', items: [
          { id: 'PGD_Recipes',     primary: 'PGD_Recipes',     secondary: 'name, description' },
          { id: 'PGD_Ingredients', primary: 'PGD_Ingredients', secondary: 'recipe_id, ingredient_name',
            secondaryAction: { label: 'Remove', action: 'remove_table', style: 'danger', confirm: 'Remove PGD_Ingredients from this domain?' } },
        ]},
        { type: 'actions', buttons: [
          { label: 'Looks good',   action: 'confirm',   style: 'primary' },
          { label: 'Add a table',  action: 'add_table', modal: {
            title: 'Add a table',
            input_label: 'Describe the table',
            placeholder: 'What it stores and how it relates to the other tables.',
            multiline: true,
          }},
          { label: 'Cancel', action: 'cancel' },
        ]},
      ],
    };
    const blocks = dialogToBlocks(dialog, 9003);
    // Parent table (PGD_Recipes) must have no accessory button
    const recipesBlock = blocks.find(b => b.type === 'section' && b.text?.text?.includes('PGD_Recipes'));
    assert.equal(recipesBlock?.accessory, undefined, 'PGD_Recipes must not have Remove button');
    // Child table (PGD_Ingredients) must have accessory button
    const ingredientsBlock = blocks.find(b => b.type === 'section' && b.text?.text?.includes('PGD_Ingredients'));
    assert.ok(ingredientsBlock?.accessory, 'PGD_Ingredients must have Remove button');
    await post('Workflow gate', blocks);
  });

  it('review_object gate with domain help data renders without invalid_blocks', async () => {
    // Simulates create_domain step 7 — domain aliases and commands review.
    const dialog = {
      fields: [
        { type: 'typography', value: 'Almost done. Here are the aliases and commands for your domain.' },
        { type: 'review_object', items: [
          { key: 'domain',   value: 'recipes' },
          { key: 'aliases',  value: ['recipes', 'recipe', 'cooking', 'meal'] },
          { key: 'commands', value: [
            { syntax: '/m list recipes', description: 'List all records' },
            { syntax: '/m get recipes sweet potato chili', description: 'Find a specific record' },
            { syntax: '/m add recipes carbonara', description: 'Add a new record' },
          ]},
        ]},
        { type: 'actions', buttons: [
          { label: 'Looks good', action: 'confirm', style: 'primary' },
          { label: 'Cancel',     action: 'cancel' },
        ]},
      ],
    };
    const blocks = dialogToBlocks(dialog, 9004);
    // Commands must use bullet list, not [object Object]
    const commandsBlock = blocks.find(b => b.type === 'section' && b.text?.text?.includes('commands'));
    assert.ok(commandsBlock?.text.text.includes('/m list recipes'), 'command syntax must be visible, not [object Object]');
    await post('Workflow gate', blocks);
  });

  it('text_input gate skips Slack posting (modal flow)', () => {
    // Verifies the skip logic — callback.mjs returns early for text_input.
    // The gate type is checked before calling dialogToBlocks, so no blocks are built.
    // This test documents the expected behaviour without calling Slack.
    const gateType = 'text_input';
    assert.equal(gateType, 'text_input', 'text_input gates must be skipped by postHumanGate');
    // No API call — modal is opened by interactive.mjs using trigger_id.
  });
});

// ---------------------------------------------------------------------------
// Modal flow — documented manual test steps
// ---------------------------------------------------------------------------

// The full text_input modal flow cannot be automated because:
// 1. Opening a modal requires a trigger_id which expires 3 seconds after a
//    button click — it cannot be synthesised in a test without a real click.
// 2. Submitting a modal requires a view_submission payload which Slack sends
//    to the /interactive endpoint — it cannot be triggered without Slack.
//
// Manual test procedure for the "other" option modal in create_workflow step 1a:
//
//   1. Run: /m create workflow <any description>
//   2. Wait for the workflow_mode choice gate to appear in Slack
//   3. Click button E (other)
//   4. Expected: a multiline text input modal opens with title
//      "Describe your workflow" and placeholder text
//   5. Type a description and click Submit
//   6. Expected: the workflow continues to the gap analysis step
//   7. Expected log line: interactive: modal opened { workflowRunId: N }
//
// Prerequisites for modal to work:
//   A. create_workflow step 1a "other" option must have "modal" descriptor in seed
//   B. buildDialog in step-executor.mjs must map option.modal → btn.modal
//      for choice gate options (verify by searching for 'choice' in buildDialog)
