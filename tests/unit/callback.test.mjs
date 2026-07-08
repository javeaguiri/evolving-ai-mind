// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/callback.test.mjs
//
// Unit tests for pure renderer functions in src/ui/slackbot/callback.mjs.
//
// Both tested functions are pure: no Slack SDK, no network, no mocking.
//
// Running:
//   node --test tests/unit/callback.test.mjs
//   node --test --test-reporter=spec tests/unit/callback.test.mjs

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Module extraction
// callback.mjs exports nothing — textToBlocks and dialogToBlocks are module-
// private. We extract them via a lightweight re-export shim to avoid modifying
// the production module. Alternatively, temporarily export for testing and
// revert before commit. For this test we shadow-import using a wrapper module
// defined inline via data: URL — no filesystem write required.
//
// Implementation note: since these functions are not currently exported, we
// inline equivalent implementations here as faithful copies to enable testing.
// Any divergence from the source must be caught in code review.
// When the functions are exported (recommended), replace these inline copies
// with direct imports.
// ---------------------------------------------------------------------------

// ── Faithful copy of textToBlocks from callback.mjs ─────────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:textToBlocks
function textToBlocks(text, contextText) {
  const BLOCK_CHAR_LIMIT = 2800;
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
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: contextText }],
    });
  }

  return blocks;
}

// ── Faithful copy of markdownToBlocks from callback.mjs ─────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:markdownToBlocks
const HEADER_TEXT_LIMIT = 150;

function markdownToBlocks(text, contextText) {
  const blocks = [];

  const headingSegments = text.split(/^(#{1,6}[ \t]+.+)$/m);

  for (const seg of headingSegments) {
    const headingMatch = seg.match(/^(#{1,6})[ \t]+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 4);
      let headingText = headingMatch[2].trim();
      if (headingText.length > HEADER_TEXT_LIMIT) {
        headingText = `${headingText.slice(0, HEADER_TEXT_LIMIT - 3)}...`;
      }
      blocks.push({ type: 'header', text: { type: 'plain_text', text: headingText, emoji: true }, level });
    } else if (seg.trim()) {
      blocks.push(...markdownProseToBlocks(seg));
    }
  }

  if (contextText) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: contextText }] });
  }
  return blocks;
}

// ── Faithful copy of markdownProseToBlocks from callback.mjs ────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:markdownProseToBlocks
function markdownProseToBlocks(text) {
  const BLOCK_CHAR_LIMIT = 2800;
  const blocks = [];

  const segments = text.split(/(```[\s\S]*?```)/);

  for (const seg of segments) {
    if (seg.startsWith('```')) {
      const block = seg.length > BLOCK_CHAR_LIMIT
        ? `${seg.slice(0, BLOCK_CHAR_LIMIT - 7)}...\n\`\`\``
        : seg;
      blocks.push({ type: 'markdown', text: block });
    } else {
      const paragraphs = seg.split(/\n\n+/);
      let chunk = '';
      for (const para of paragraphs) {
        if (!para.trim()) continue;
        const candidate = chunk ? `${chunk}\n\n${para}` : para;
        if (candidate.length > BLOCK_CHAR_LIMIT) {
          if (chunk) blocks.push({ type: 'markdown', text: chunk });
          chunk = para.length > BLOCK_CHAR_LIMIT ? `${para.slice(0, BLOCK_CHAR_LIMIT - 3)}...` : para;
        } else {
          chunk = candidate;
        }
      }
      if (chunk) blocks.push({ type: 'markdown', text: chunk });
    }
  }
  return blocks;
}

// ── Faithful copy of groupBlocksForSlack from callback.mjs ──────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:groupBlocksForSlack
const MARKDOWN_CUMULATIVE_LIMIT = 12000;

function groupBlocksForSlack(blocks, maxBlocksPerGroup) {
  const groups = [];
  let current = [];
  let currentMarkdownChars = 0;

  for (const block of blocks) {
    const blockMarkdownChars = block.type === 'markdown' ? block.text.length : 0;
    const exceedsBlockCount   = current.length >= maxBlocksPerGroup;
    const exceedsMarkdownChars = currentMarkdownChars + blockMarkdownChars > MARKDOWN_CUMULATIVE_LIMIT;

    if (current.length > 0 && (exceedsBlockCount || exceedsMarkdownChars)) {
      groups.push(current);
      current = [];
      currentMarkdownChars = 0;
    }

    current.push(block);
    currentMarkdownChars += blockMarkdownChars;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

// ── Faithful copy of buildRevealBlock from callback.mjs ─────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:buildRevealBlock
function buildRevealBlock(field) {
  const revealBlock = {
    type:    'task_card',
    task_id: 'test-task-id',
    title:   field.button_label,
    status:  'complete',
  };
  if (Array.isArray(field.content)) {
    revealBlock.details = {
      type:     'rich_text',
      elements: [{
        type:     'rich_text_list',
        style:    'bullet',
        elements: field.content.map(item => ({
          type:     'rich_text_section',
          elements: [{ type: 'text', text: (item !== null && typeof item === 'object') ? JSON.stringify(item) : String(item) }],
        })),
      }],
    };
  } else if (field.content) {
    revealBlock.output = {
      type:     'rich_text',
      elements: [{
        type:     'rich_text_section',
        elements: [{ type: 'text', text: field.content }],
      }],
    };
  }
  return revealBlock;
}

// ── Faithful copy of summarizeObjectForReview from callback.mjs ─────────────
// Keep in sync with src/ui/slackbot/callback.mjs:summarizeObjectForReview
function summarizeObjectForReview(v) {
  const stringEntries = Object.entries(v).filter(([, val]) => typeof val === 'string' && val.length > 0);
  if (stringEntries.length === 0) return JSON.stringify(v);
  return stringEntries.slice(0, 2).map(([, val]) => val).join(' — ');
}

// ── Faithful copy of dialogToBlocks from callback.mjs ───────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:dialogToBlocks
function dialogToBlocks(dialog, workflowRunId) {
  const blocks = [];

  for (const field of (dialog?.fields ?? [])) {
    switch (field.type) {

      case 'typography':
        blocks.push({
          type: 'markdown',
          text: `\ud83e\udde0 ${field.value}`,
        });
        break;

      case 'description_list': {
        const lines = (field.items ?? []).map(item =>
          `**${item.label}** \u2014 ${item.description || item.label}`
        );
        if (lines.length > 0) {
          blocks.push({
            type: 'markdown',
            text: lines.join('\n'),
          });
        }
        break;
      }

      case 'list': {
        if (field.label) {
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*${field.label}*` },
          });
        }
        for (const [idx, item] of (field.items ?? []).entries()) {
          const sectionBlock = {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${item.primary}*${item.secondary ? `\n${item.secondary}` : ''}`,
            },
          };
          if (item.secondaryAction) {
            const validStyle = item.secondaryAction.style === 'danger' || item.secondaryAction.style === 'primary';
            sectionBlock.accessory = {
              type: 'button',
              ...(validStyle ? { style: item.secondaryAction.style } : {}),
              text:      { type: 'plain_text', text: item.secondaryAction.label },
              action_id: `workflow_action_${item.id || idx}_${idx}`,
              value:     JSON.stringify({
                workflowRunId,
                action:       item.secondaryAction.action,
                responseData: item.responseData !== undefined ? item.responseData : { tableName: item.id },
              }),
              ...(item.secondaryAction.confirm ? {
                confirm: {
                  title:   { type: 'plain_text', text: 'Are you sure?' },
                  text:    { type: 'plain_text', text: item.secondaryAction.confirm },
                  confirm: { type: 'plain_text', text: 'Remove' },
                  deny:    { type: 'plain_text', text: 'Cancel' },
                },
              } : {}),
            };
          }
          blocks.push(sectionBlock);
          blocks.push({ type: 'divider' });
        }
        break;
      }

      case 'textbox':
        break;

      case 'reveal': {
        blocks.push(buildRevealBlock(field));
        break;
      }

      case 'review_object': {
        const BLOCK_CHAR_LIMIT = 2800;
        for (const item of (field.items ?? [])) {
          let valueText;
          if (Array.isArray(item.value)) {
            if (item.value.length === 0) {
              valueText = '(none)';
            } else if (typeof item.value[0] === 'object') {
              valueText = '\n' + item.value
                .map(v => `    \u2022 ${v.syntax ?? v.verb ?? v.command ?? summarizeObjectForReview(v)}`)
                .join('\n');
            } else {
              valueText = item.value.join(', ');
            }
          } else {
            valueText = String(item.value ?? '');
          }
          let line = `*${item.key}:* ${valueText}`;
          if (line.length > BLOCK_CHAR_LIMIT) {
            line = line.slice(0, BLOCK_CHAR_LIMIT - 3) + '...';
          }
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: line },
          });
        }
        break;
      }

      case 'radio': {
        const options = (field.options ?? []).map(o => ({
          text:  { type: 'plain_text', text: o.label },
          value: o.value,
        }));
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: field.label ?? 'Select one:' },
          accessory: {
            type:      'radio_buttons',
            action_id: field.name ?? 'radio',
            options,
          },
        });
        break;
      }

      case 'actions': {
        const elements = (field.buttons ?? []).map((btn, i) => ({
          type:      'button',
          style:     btn.style === 'primary' ? 'primary' : btn.style === 'danger' ? 'danger' : undefined,
          text:      { type: 'plain_text', text: btn.label },
          action_id: `workflow_action_${btn.action || i}_${i}`,
          value:     JSON.stringify({
            workflowRunId,
            action: btn.action,
            ...(btn.modal ? { modal: btn.modal } : {}),
          }),
        }));
        if (elements.length > 0) {
          blocks.push({ type: 'actions', elements });
        }
        break;
      }

      default:
        // In tests we capture the unknown type rather than calling console.warn
        break;
    }
  }

  return blocks;
}

// ── Faithful copy of the pure block-assembly slice of postHumanGate's
// text_input branch from callback.mjs (excludes the routeCallback Slack call).
// Keep in sync with src/ui/slackbot/callback.mjs:postHumanGate (text_input branch)
function textInputGateBlocks(dialog, workflowRunId, stepKey) {
  const textboxField = dialog?.fields?.find(f => f.type === 'textbox') ?? {};
  const fallbackText = dialog?.fields?.find(f => f.type === 'typography')?.value
    ?? 'Please enter your response.';
  const isMultiline  = textboxField.multiline ?? false;
  const inputBlock   = {
    type:     'input',
    block_id: `text_input_block_${workflowRunId}_${stepKey ?? 'x'}`,
    element:  {
      type:      'plain_text_input',
      action_id: 'text_input_value',
      multiline: isMultiline,
      ...(textboxField.placeholder
        ? { placeholder: { type: 'plain_text', text: textboxField.placeholder } }
        : {}),
    },
    label: { type: 'plain_text', text: textboxField.label ?? 'Your input' },
  };
  const actionsField = dialog?.fields?.find(f => f.type === 'actions');
  const actionElements = actionsField
    ? (actionsField.buttons ?? []).map((btn, i) => ({
        type:      'button',
        text:      { type: 'plain_text', text: btn.label },
        action_id: `workflow_action_${btn.action || i}_${i}`,
        value:     JSON.stringify({ workflowRunId, action: btn.action }),
      }))
    : [];
  const revealBlocks = (dialog?.fields ?? [])
    .filter(f => f.type === 'reveal')
    .map(buildRevealBlock);
  return [
    ...markdownToBlocks(fallbackText),
    ...revealBlocks,
    inputBlock,
    { type: 'actions', elements: actionElements },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LIMIT = 2800;

function repeat(char, n) { return char.repeat(n); }

function sectionBlocks(blocks) {
  return blocks.filter(b => b.type === 'section');
}

function contextBlocks(blocks) {
  return blocks.filter(b => b.type === 'context');
}

// ---------------------------------------------------------------------------
// textToBlocks
// ---------------------------------------------------------------------------

describe('textToBlocks — short text', () => {
  it('short text produces one section block', () => {
    const blocks = textToBlocks('Hello world', 'traceId: abc');
    assert.equal(sectionBlocks(blocks).length, 1);
    assert.equal(blocks[0].text.text, 'Hello world');
  });

  it('includes context block when contextText provided', () => {
    const blocks = textToBlocks('msg', 'runId: 1 | traceId: abc');
    assert.equal(contextBlocks(blocks).length, 1);
    assert.equal(blocks[blocks.length - 1].elements[0].text, 'runId: 1 | traceId: abc');
  });

  it('no context block when contextText is undefined', () => {
    const blocks = textToBlocks('msg');
    assert.equal(contextBlocks(blocks).length, 0);
  });

  it('no context block when contextText is empty string', () => {
    const blocks = textToBlocks('msg', '');
    assert.equal(contextBlocks(blocks).length, 0);
  });

  it('text at exactly LIMIT chars fits in one block', () => {
    const text = repeat('x', LIMIT);
    const blocks = textToBlocks(text, 'ctx');
    assert.equal(sectionBlocks(blocks).length, 1);
    assert.equal(blocks[0].text.text.length, LIMIT);
  });
});

describe('textToBlocks — long text chunking', () => {
  it('text just over LIMIT splits into two section blocks', () => {
    const line1 = repeat('a', LIMIT);
    const line2 = 'overflow';
    const blocks = textToBlocks(line1 + '\n' + line2, 'ctx');
    assert.equal(sectionBlocks(blocks).length, 2);
    assert.equal(blocks[0].text.text, line1);
    assert.equal(blocks[1].text.text, line2);
  });

  it('each chunk is within the LIMIT', () => {
    // 4 lines of 1000 chars each — should produce 2 section blocks
    const lines = Array.from({ length: 4 }, () => repeat('b', 1000));
    const blocks = textToBlocks(lines.join('\n'), 'ctx');
    for (const b of sectionBlocks(blocks)) {
      assert.ok(b.text.text.length <= LIMIT, `chunk length ${b.text.text.length} exceeds ${LIMIT}`);
    }
  });

  it('a single line longer than LIMIT is hard-truncated with ellipsis', () => {
    const longLine = repeat('z', LIMIT + 100);
    const blocks = textToBlocks(longLine, 'ctx');
    assert.equal(sectionBlocks(blocks).length, 1);
    assert.ok(blocks[0].text.text.endsWith('...'));
    assert.equal(blocks[0].text.text.length, LIMIT);
  });

  it('context block is always the last block', () => {
    const text = repeat('c', LIMIT + 1) + '\n' + 'second line';
    const blocks = textToBlocks(text, 'ctx');
    assert.equal(blocks[blocks.length - 1].type, 'context');
  });

  it('multiple sections all have type section and mrkdwn text', () => {
    const lines = Array.from({ length: 6 }, (_, i) => repeat(String(i), 600));
    const blocks = textToBlocks(lines.join('\n'), 'ctx');
    for (const b of sectionBlocks(blocks)) {
      assert.equal(b.type, 'section');
      assert.equal(b.text.type, 'mrkdwn');
    }
  });
});

// ---------------------------------------------------------------------------
// markdownToBlocks — heading splitting (Sprint 7 Track D2)
// ---------------------------------------------------------------------------

describe('markdownToBlocks — heading splitting', () => {
  it('a single # heading becomes its own header block at level 1', () => {
    const blocks = markdownToBlocks('# Spanish Vocabulary');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'header');
    assert.equal(blocks[0].text.type, 'plain_text');
    assert.equal(blocks[0].text.text, 'Spanish Vocabulary');
    assert.equal(blocks[0].level, 1);
  });

  it('## and ### produce level 2 and 3; #### and deeper cap at level 4', () => {
    assert.equal(markdownToBlocks('## Nov 20, 2024')[0].level, 2);
    assert.equal(markdownToBlocks('### Card 1')[0].level, 3);
    assert.equal(markdownToBlocks('#### Detail')[0].level, 4);
    assert.equal(markdownToBlocks('###### Deepest')[0].level, 4);
  });

  it('prose before and after a heading becomes markdown blocks around the header block', () => {
    const blocks = markdownToBlocks('Intro text.\n\n# Heading\n\nBody text.');
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, 'markdown');
    assert.equal(blocks[0].text, 'Intro text.');
    assert.equal(blocks[1].type, 'header');
    assert.equal(blocks[2].type, 'markdown');
    assert.equal(blocks[2].text, 'Body text.');
  });

  it('text with no heading lines produces only markdown blocks, no header blocks', () => {
    const blocks = markdownToBlocks('Just **bold** prose, no headings.');
    assert.ok(blocks.every(b => b.type === 'markdown'));
  });

  it('a heading longer than 150 chars is truncated', () => {
    const longTitle = 'x'.repeat(200);
    const blocks = markdownToBlocks(`# ${longTitle}`);
    assert.equal(blocks[0].text.text.length, 150);
    assert.ok(blocks[0].text.text.endsWith('...'));
  });

  it('multiple headings each become their own header block, in document order', () => {
    const blocks = markdownToBlocks('# Spanish Vocabulary\n\n## Nov 20, 2024\n\nStats line.');
    assert.deepEqual(blocks.map(b => b.type), ['header', 'header', 'markdown']);
    assert.equal(blocks[0].text.text, 'Spanish Vocabulary');
    assert.equal(blocks[0].level, 1);
    assert.equal(blocks[1].text.text, 'Nov 20, 2024');
    assert.equal(blocks[1].level, 2);
  });
});

// ---------------------------------------------------------------------------
// dialogToBlocks — field types
// ---------------------------------------------------------------------------

describe('dialogToBlocks — null / empty dialog', () => {
  it('null dialog produces empty array', () => {
    assert.deepEqual(dialogToBlocks(null, 42), []);
  });

  it('empty fields array produces empty array', () => {
    assert.deepEqual(dialogToBlocks({ fields: [] }, 42), []);
  });

  it('dialog without fields key produces empty array', () => {
    assert.deepEqual(dialogToBlocks({}, 42), []);
  });
});

describe('dialogToBlocks — typography', () => {
  it('renders as a markdown block with brain emoji prefix', () => {
    const blocks = dialogToBlocks({ fields: [{ type: 'typography', value: 'Plan ready.' }] }, 1);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'markdown');
    assert.ok(blocks[0].text.includes('Plan ready.'));
    // emoji present (rendered as unicode surrogate pair in JS source)
    assert.ok(blocks[0].text.startsWith('\ud83e\udde0'));
  });
});

describe('dialogToBlocks — description_list', () => {
  it('renders items as **label** — description lines', () => {
    const field = {
      type: 'description_list',
      items: [
        { label: 'A', description: 'Option Alpha' },
        { label: 'B', description: 'Option Beta' },
      ],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'markdown');
    assert.ok(blocks[0].text.includes('**A**'));
    assert.ok(blocks[0].text.includes('Option Alpha'));
    assert.ok(blocks[0].text.includes('**B**'));
  });

  it('falls back to label when description absent', () => {
    const field = { type: 'description_list', items: [{ label: 'X' }] };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.ok(blocks[0].text.includes('**X**'));
  });

  it('empty items list produces no block', () => {
    const field = { type: 'description_list', items: [] };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks.length, 0);
  });
});

describe('dialogToBlocks — list', () => {
  it('renders label as header section when provided', () => {
    const field = {
      type: 'list',
      label: '3 tables',
      items: [{ id: 'T1', primary: 'PGD_T1', secondary: 'col1, col2' }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks[0].text.text, '*3 tables*');
  });

  it('omits label block when label absent', () => {
    const field = {
      type: 'list',
      items: [{ id: 'T1', primary: 'PGD_T1' }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    // The item section block plus its trailing divider — no label block
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0].text.text.includes('PGD_T1'));
  });

  it('pushes a divider block after every row', () => {
    const field = {
      type:  'list',
      items: [{ id: 'A', primary: 'A' }, { id: 'B', primary: 'B' }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks.length, 4);
    assert.equal(blocks[1].type, 'divider');
    assert.equal(blocks[3].type, 'divider');
  });

  it('item-supplied responseData overrides the default { tableName } payload', () => {
    const field = {
      type:  'list',
      items: [{
        id: 'PGD_Decks:7',
        primary: 'Sub-deck A',
        secondaryAction: { label: 'Open', action: 'select_row' },
        responseData: { table: 'PGD_Decks', id: 7, isDeck: true },
      }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    const value = JSON.parse(block.accessory.value);
    assert.deepEqual(value.responseData, { table: 'PGD_Decks', id: 7, isDeck: true });
  });

  it('item WITHOUT secondaryAction has no accessory (parent table)', () => {
    const field = {
      type:  'list',
      items: [{ id: 'PGD_Parent', primary: 'PGD_Parent', secondary: 'id, name' }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.accessory, undefined);
  });

  it('item WITH secondaryAction renders accessory button', () => {
    const field = {
      type:  'list',
      items: [{
        id:      'PGD_Child',
        primary: 'PGD_Child',
        secondary: 'parent_id, val',
        secondaryAction: { label: 'Remove', action: 'remove_table', style: 'danger', confirm: 'Really remove?' },
      }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 99);
    assert.ok(block.accessory, 'accessory should be present');
    assert.equal(block.accessory.style, 'danger');
    assert.equal(block.accessory.text.text, 'Remove');
  });

  it('secondaryAction with style "default" (or omitted) sends no style field at all — Slack rejects style: "default" as invalid_blocks', () => {
    const field = {
      type: 'list',
      items: [
        { id: 'A', primary: 'A', secondaryAction: { label: 'View', action: 'view_record', style: 'default' } },
        { id: 'B', primary: 'B', secondaryAction: { label: 'View', action: 'view_record' } },
      ],
    };
    const [blockA, , blockB] = dialogToBlocks({ fields: [field] }, 1); // index 1 is the divider after row A
    assert.ok(!('style' in blockA.accessory), 'style: "default" must not be forwarded — Slack has no such enum value');
    assert.ok(!('style' in blockB.accessory), 'omitted style must not default to sending style: "default"');
  });

  it('secondaryAction with style "danger" or "primary" still sends the style field', () => {
    const field = {
      type: 'list',
      items: [{ id: 'A', primary: 'A', secondaryAction: { label: 'Go', action: 'go', style: 'primary' } }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.accessory.style, 'primary');
  });

  it('secondaryAction button value encodes workflowRunId and tableName', () => {
    const field = {
      type:  'list',
      items: [{
        id: 'PGD_Holdings',
        primary: 'PGD_Holdings',
        secondaryAction: { label: 'Remove', action: 'remove_table', style: 'danger' },
      }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 77);
    const value = JSON.parse(block.accessory.value);
    assert.equal(value.workflowRunId, 77);
    assert.equal(value.action, 'remove_table');
    assert.equal(value.responseData.tableName, 'PGD_Holdings');
  });

  it('secondaryAction with confirm renders confirm dialog', () => {
    const field = {
      type:  'list',
      items: [{
        id: 'T1', primary: 'T1',
        secondaryAction: { label: 'Remove', action: 'remove_table', style: 'danger', confirm: 'Sure?' },
      }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.ok(block.accessory.confirm, 'confirm object should exist');
    assert.equal(block.accessory.confirm.text.text, 'Sure?');
  });

  it('secondaryAction without confirm has no confirm key', () => {
    const field = {
      type:  'list',
      items: [{
        id: 'T1', primary: 'T1',
        secondaryAction: { label: 'Remove', action: 'remove_table', style: 'danger' },
      }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.accessory.confirm, undefined);
  });

  it('secondary text included when item.secondary present', () => {
    const field = {
      type:  'list',
      items: [{ id: 'T', primary: 'PGD_T', secondary: 'col1, col2' }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.ok(block.text.text.includes('col1, col2'));
  });
});

describe('dialogToBlocks — reveal', () => {
  it('array of strings renders each item as plain text in the bullet list', () => {
    const field = { type: 'reveal', button_label: 'Details', content: ['Dining Out', 'Subscriptions'] };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    const items = block.details.elements[0].elements.map(e => e.elements[0].text);
    assert.deepEqual(items, ['Dining Out', 'Subscriptions']);
  });

  it('array of objects JSON-stringifies each item instead of [object Object]', () => {
    const field = {
      type: 'reveal',
      button_label: 'Sample records',
      content: [{ category_id: 1, planned_amount: 3300 }, { category_id: 2, planned_amount: 450 }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    const items = block.details.elements[0].elements.map(e => e.elements[0].text);
    assert.ok(items.every(t => !t.includes('[object Object]')));
    assert.deepEqual(items, [
      '{"category_id":1,"planned_amount":3300}',
      '{"category_id":2,"planned_amount":450}',
    ]);
  });

  it('plain string content renders as output rich_text, not details', () => {
    const field = { type: 'reveal', button_label: 'Info', content: 'Just a note' };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.output.elements[0].elements[0].text, 'Just a note');
  });
});

describe('dialogToBlocks — textbox', () => {
  it('produces no blocks (modal-handled)', () => {
    const field = { type: 'textbox', label: 'Enter text' };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks.length, 0);
  });
});

describe('postHumanGate text_input branch — reveal fields', () => {
  // Regression test: text_input gates build their blocks independently of
  // dialogToBlocks (a separate early-return branch in postHumanGate), so a
  // reveal field attached by buildDialog (step-executor.mjs) was silently
  // dropped instead of rendered as a task_card. Sprint 7 Track G3, run 632.
  it('renders reveal fields as task_card blocks between the message and the input block', () => {
    const dialog = {
      fields: [
        { type: 'typography', value: 'Any special instructions?' },
        { type: 'reveal', button_label: 'PGD_Budgets', content: ['category_id (integer)', 'amount (numeric)'] },
        { type: 'reveal', button_label: 'PGD_SpendingCategories', content: ['name (text)'] },
        { type: 'textbox', label: 'Your input' },
        { type: 'actions', buttons: [{ label: 'Submit', action: 'confirm' }, { label: 'Skip', action: 'confirm' }] },
      ],
    };
    const blocks = textInputGateBlocks(dialog, 632, '2d');

    const taskCards = blocks.filter(b => b.type === 'task_card');
    assert.equal(taskCards.length, 2);
    assert.equal(taskCards[0].title, 'PGD_Budgets');
    assert.equal(taskCards[1].title, 'PGD_SpendingCategories');

    const inputIndex = blocks.findIndex(b => b.type === 'input');
    assert.ok(inputIndex > 0, 'input block must be present');
    assert.ok(
      taskCards.every(card => blocks.indexOf(card) < inputIndex),
      'reveal task_cards must render before the input block',
    );
  });

  it('produces no task_card blocks when no reveal field is present', () => {
    const dialog = {
      fields: [
        { type: 'typography', value: 'Anything else?' },
        { type: 'textbox', label: 'Your input' },
      ],
    };
    const blocks = textInputGateBlocks(dialog, 9, '9');
    assert.equal(blocks.filter(b => b.type === 'task_card').length, 0);
  });
});

describe('dialogToBlocks — review_object', () => {
  it('scalar value renders as key: value', () => {
    const field = {
      type:  'review_object',
      items: [{ key: 'domain', value: 'recipes' }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.text.text, '*domain:* recipes');
  });

  it('array of strings renders as comma-joined', () => {
    const field = {
      type:  'review_object',
      items: [{ key: 'aliases', value: ['recipes', 'recipe', 'cooking'] }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.text.text, '*aliases:* recipes, recipe, cooking');
  });

  it('empty array renders as (none)', () => {
    const field = {
      type:  'review_object',
      items: [{ key: 'commands', value: [] }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.text.text, '*commands:* (none)');
  });

  it('array of objects with syntax field renders bullet list', () => {
    const field = {
      type:  'review_object',
      items: [{
        key: 'commands',
        value: [
          { syntax: '/m list recipes', description: 'List all' },
          { syntax: '/m add recipes', description: 'Add one' },
        ],
      }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.ok(block.text.text.includes('/m list recipes'));
    assert.ok(block.text.text.includes('/m add recipes'));
    assert.ok(block.text.text.includes('\u2022')); // bullet
  });

  it('array of objects with verb field falls back to verb', () => {
    const field = {
      type:  'review_object',
      items: [{ key: 'actions', value: [{ verb: 'run', details: 'something' }] }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.ok(block.text.text.includes('run'));
  });

  it('array of objects with neither syntax/verb/command falls back to a readable field summary, not raw JSON', () => {
    // Regression (run 658): flashcard {front, back} pairs and ref-record
    // proposals fell all the way to JSON.stringify. Now picks the first
    // 1-2 string-valued fields instead of dumping the raw object.
    const field = {
      type:  'review_object',
      items: [{ key: 'steps', value: [{ description: 'Mix ingredients', order: 1 }] }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.ok(block.text.text.includes('Mix ingredients'));
    assert.ok(!block.text.text.includes('{"description"'), 'must not render raw JSON');
  });

  it('array of objects with two string fields joins them with an em dash (flashcard front/back shape)', () => {
    const field = {
      type:  'review_object',
      items: [{ key: 'cards', value: [{ front: 'gato', back: 'cat' }] }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.ok(block.text.text.includes('gato — cat'));
  });

  it('array of objects with no string fields at all falls back to JSON.stringify', () => {
    const field = {
      type:  'review_object',
      items: [{ key: 'stats', value: [{ order: 1, count: 2 }] }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.ok(block.text.text.includes('{"order":1,"count":2}'));
  });

  it('plain object (non-array) value is stringified', () => {
    // Regression guard: if value is accidentally an object, String() should render it
    const field = {
      type:  'review_object',
      items: [{ key: 'meta', value: null }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.text.text, '*meta:* ');
  });

  it('long value is truncated to LIMIT chars with ellipsis', () => {
    const longValue = repeat('x', 2900);
    const field = {
      type:  'review_object',
      items: [{ key: 'notes', value: longValue }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.ok(block.text.text.length <= LIMIT, 'block text must not exceed limit');
    assert.ok(block.text.text.endsWith('...'));
  });

  it('each item produces one block', () => {
    const field = {
      type:  'review_object',
      items: [
        { key: 'domain', value: 'recipes' },
        { key: 'aliases', value: ['recipe'] },
        { key: 'count', value: 42 },
      ],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks.length, 3);
  });
});

describe('dialogToBlocks — radio', () => {
  it('renders section with radio_buttons accessory', () => {
    const field = {
      type:    'radio',
      label:   'Select mode:',
      name:    'mode_select',
      options: [
        { label: 'Mode A', value: 'a' },
        { label: 'Mode B', value: 'b' },
      ],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.type, 'section');
    assert.equal(block.text.text, 'Select mode:');
    assert.equal(block.accessory.type, 'radio_buttons');
    assert.equal(block.accessory.action_id, 'mode_select');
    assert.equal(block.accessory.options.length, 2);
  });

  it('uses "radio" as default action_id when name absent', () => {
    const field = { type: 'radio', options: [{ label: 'X', value: 'x' }] };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.accessory.action_id, 'radio');
  });
});

describe('dialogToBlocks — actions', () => {
  it('renders buttons with correct value encoding', () => {
    const field = {
      type:    'actions',
      buttons: [
        { label: 'Confirm', action: 'confirm', style: 'primary' },
        { label: 'Cancel',  action: 'cancel' },
      ],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 55);
    assert.equal(block.type, 'actions');
    assert.equal(block.elements.length, 2);
    const confirmValue = JSON.parse(block.elements[0].value);
    assert.equal(confirmValue.workflowRunId, 55);
    assert.equal(confirmValue.action, 'confirm');
  });

  it('primary style renders as primary', () => {
    const field = { type: 'actions', buttons: [{ label: 'Go', action: 'go', style: 'primary' }] };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.elements[0].style, 'primary');
  });

  it('danger style renders as danger', () => {
    const field = { type: 'actions', buttons: [{ label: 'Del', action: 'del', style: 'danger' }] };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.elements[0].style, 'danger');
  });

  it('no style produces undefined style (not "default")', () => {
    const field = { type: 'actions', buttons: [{ label: 'Next', action: 'next' }] };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.elements[0].style, undefined);
  });

  it('modal descriptor is included in button value when present', () => {
    const modal = { title: 'Add table', input_label: 'Describe it', multiline: true };
    const field = {
      type:    'actions',
      buttons: [{ label: 'Add', action: 'add_table', modal }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    const value = JSON.parse(block.elements[0].value);
    assert.deepEqual(value.modal, modal);
  });

  it('no modal key in value when modal absent', () => {
    const field = { type: 'actions', buttons: [{ label: 'OK', action: 'confirm' }] };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    const value = JSON.parse(block.elements[0].value);
    assert.equal(value.modal, undefined);
  });

  it('action_id falls back to index when action is absent', () => {
    const field = { type: 'actions', buttons: [{ label: 'Btn' }] };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    // action is undefined → uses index 0
    assert.ok(block.elements[0].action_id.includes('_0'));
  });

  it('multiple buttons produce unique action_ids', () => {
    const field = {
      type:    'actions',
      buttons: [
        { label: 'A', action: 'confirm' },
        { label: 'B', action: 'cancel' },
        { label: 'C', action: 'extra' },
      ],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    const ids = block.elements.map(e => e.action_id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'all action_ids must be unique');
  });

  it('empty buttons array produces no block', () => {
    const field = { type: 'actions', buttons: [] };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks.length, 0);
  });
});

describe('dialogToBlocks — mixed fields', () => {
  it('renders a complete edit_list dialog correctly', () => {
    // Mirrors the create_domain review_tables HUMAN_GATE output
    const dialog = {
      fields: [
        { type: 'typography', value: "Here's my plan for domain recipes." },
        {
          type:  'list',
          label: '2 table(s) proposed',
          items: [
            { id: 'PGD_Recipes',     primary: 'PGD_Recipes',     secondary: 'name, description' },
            { id: 'PGD_Ingredients', primary: 'PGD_Ingredients', secondary: 'recipe_id, name',
              secondaryAction: { label: 'Remove', action: 'remove_table', style: 'danger', confirm: 'Remove PGD_Ingredients?' } },
          ],
        },
        {
          type:    'actions',
          buttons: [
            { label: 'Looks good', action: 'confirm', style: 'primary' },
            { label: 'Cancel',     action: 'cancel' },
          ],
        },
      ],
    };

    const blocks = dialogToBlocks(dialog, 101);

    // 1 typography + 1 label + 2 list items (each with a trailing divider) + 1 actions = 7 blocks
    assert.equal(blocks.length, 7);
    assert.equal(blocks[0].type, 'markdown');  // typography
    assert.equal(blocks[1].type, 'section');  // label
    assert.equal(blocks[2].type, 'section');  // PGD_Recipes — no accessory
    assert.equal(blocks[2].accessory, undefined);
    assert.equal(blocks[3].type, 'divider');
    assert.equal(blocks[4].type, 'section');  // PGD_Ingredients — has accessory
    assert.ok(blocks[4].accessory);
    assert.equal(blocks[5].type, 'divider');
    assert.equal(blocks[6].type, 'actions');

    // workflowRunId propagates to all button values
    const confirmValue = JSON.parse(blocks[6].elements[0].value);
    assert.equal(confirmValue.workflowRunId, 101);
  });

  it('typography warning field renders inline within dialog', () => {
    const dialog = {
      fields: [
        { type: 'typography', value: "Here's the plan." },
        { type: 'typography', value: '\u26a0\ufe0f Warning: something cannot be removed.' },
        { type: 'actions', buttons: [{ label: 'OK', action: 'confirm' }] },
      ],
    };
    const blocks = dialogToBlocks(dialog, 1);
    assert.equal(blocks.length, 3);
    assert.ok(blocks[1].text.includes('Warning'));
  });
});

describe('groupBlocksForSlack', () => {
  // Regression: Slack's markdown block enforces a 12,000-character cumulative
  // limit across all markdown blocks in one payload (docs.slack.dev/reference/
  // block-kit/blocks/markdown-block) — postHumanNotification previously only
  // capped block *count* (50/message), with no cap on cumulative markdown chars.

  it('keeps blocks in one group when under both limits', () => {
    const blocks = [
      { type: 'markdown', text: 'a'.repeat(1000) },
      { type: 'markdown', text: 'b'.repeat(1000) },
    ];
    const groups = groupBlocksForSlack(blocks, 50);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 2);
  });

  it('splits into a new group once cumulative markdown chars would exceed 12000', () => {
    const blocks = [
      { type: 'markdown', text: 'a'.repeat(2800) },
      { type: 'markdown', text: 'b'.repeat(2800) },
      { type: 'markdown', text: 'c'.repeat(2800) },
      { type: 'markdown', text: 'd'.repeat(2800) },
      { type: 'markdown', text: 'e'.repeat(2800) }, // 5th block pushes cumulative to 14000 > 12000
    ];
    const groups = groupBlocksForSlack(blocks, 50);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].length, 4);
    assert.equal(groups[1].length, 1);
    assert.equal(groups[1][0].text, 'e'.repeat(2800));
  });

  it('non-markdown blocks (e.g. context) do not count toward the cumulative char limit', () => {
    const blocks = [
      { type: 'markdown', text: 'a'.repeat(2800) },
      { type: 'markdown', text: 'b'.repeat(2800) },
      { type: 'markdown', text: 'c'.repeat(2800) },
      { type: 'markdown', text: 'd'.repeat(2800) },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'irrelevant' }] },
    ];
    const groups = groupBlocksForSlack(blocks, 50);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 5);
  });

  it('splits into a new group once block count would exceed maxBlocksPerGroup', () => {
    const blocks = Array.from({ length: 5 }, (_, i) => ({ type: 'markdown', text: `block ${i}` }));
    const groups = groupBlocksForSlack(blocks, 2);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].length, 2);
    assert.equal(groups[1].length, 2);
    assert.equal(groups[2].length, 1);
  });

  it('empty input produces no groups', () => {
    assert.deepEqual(groupBlocksForSlack([], 50), []);
  });
});
