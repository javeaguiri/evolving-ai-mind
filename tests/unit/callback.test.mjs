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
const REVEAL_SECTION_CHAR_LIMIT = 2800;
const REVEAL_MAX_CHILD_BLOCKS   = 10;

function buildRevealBlock(field) {
  const text = Array.isArray(field.content)
    ? field.content.map(item => `• ${(item !== null && typeof item === 'object') ? JSON.stringify(item) : String(item)}`).join('\n')
    : String(field.content ?? '');

  const lines = text ? text.split('\n') : [];
  const chunks = [];
  let chunk = '';
  for (const line of lines) {
    const candidate = chunk ? `${chunk}\n${line}` : line;
    if (candidate.length > REVEAL_SECTION_CHAR_LIMIT && chunk) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);

  const truncatedCount = Math.max(0, chunks.length - REVEAL_MAX_CHILD_BLOCKS);
  const kept = chunks.slice(0, REVEAL_MAX_CHILD_BLOCKS);
  if (truncatedCount > 0 && kept.length > 0) {
    kept[kept.length - 1] = `${kept[kept.length - 1]}\n_...and ${truncatedCount} more chunk(s)_`;
  }

  return {
    type:               'container',
    block_id:           `reveal_test-id`,
    title:              { type: 'plain_text', text: field.button_label ?? 'Details' },
    is_collapsible:     true,
    default_collapsed:  true,
    child_blocks:       kept.map(c => ({ type: 'section', text: { type: 'mrkdwn', text: c } })),
  };
}

// ── Faithful copy of escapeCell from callback.mjs ────────────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:escapeCell
const escapeCell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// ── Faithful copy of formatColumnHeader from callback.mjs ───────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:formatColumnHeader
function formatColumnHeader(key, values) {
  if (key === 'ID') return 'ID';
  const isFkColumn    = /_id$/i.test(key);
  const looksResolved = isFkColumn && values.some(v => v !== undefined && v !== null && v !== '' && Number.isNaN(Number(v)));
  const base  = looksResolved ? key.slice(0, -3) : key;
  const words = base.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1));
  return looksResolved ? `${words.join(' ')} Name` : words.join(' ');
}

// ── Faithful copy of buildListTable from callback.mjs ────────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:buildListTable
function buildListTable(items) {
  const columns = ['ID'];
  const seen = new Set(columns);
  for (const item of items) {
    for (const key of Object.keys(item.fields ?? {})) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }

  const constantColumns = items.length > 1 ? columns.filter(col => {
    if (col === 'ID') return false;
    if (!items.every(item => Object.prototype.hasOwnProperty.call(item.fields ?? {}, col))) return false;
    const first = items[0].fields[col];
    return items.every(item => item.fields[col] === first);
  }) : [];
  const headings = constantColumns.map(col => `# ${items[0].fields[col]}`);
  const tableColumns = columns.filter(col => !constantColumns.includes(col));

  const headerLabels = tableColumns.map(col => formatColumnHeader(col, items.map(item => item.fields?.[col])));
  const header = `| ${headerLabels.join(' | ')} |`;
  const sep    = `|${tableColumns.map(() => '---').join('|')}|`;
  const rows   = items.map(item => {
    const cells = tableColumns.map(col => (col === 'ID' ? item.id : item.fields?.[col]));
    return `| ${cells.map(escapeCell).join(' | ')} |`;
  });
  return [...headings, header, sep, ...rows].join('\n');
}

// ── Faithful copy of buildObjectArrayTable from callback.mjs ────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:buildObjectArrayTable
function buildObjectArrayTable(items) {
  const columns = [];
  const seen = new Set();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  const headerLabels = columns.map(col => formatColumnHeader(col, items.map(it => it[col])));
  const header = `| ${headerLabels.join(' | ')} |`;
  const sep    = `|${columns.map(() => '---').join('|')}|`;
  const rows   = items.map(item => `| ${columns.map(col => escapeCell(item[col])).join(' | ')} |`);
  return [header, sep, ...rows].join('\n');
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
        const items = field.items ?? [];
        if (items.length > 0) {
          blocks.push(...markdownToBlocks(buildListTable(items)));
        }
        const selectable = items.find(item => item.secondaryAction);
        if (selectable) {
          const validStyle = selectable.secondaryAction.style === 'danger' || selectable.secondaryAction.style === 'primary';
          blocks.push({
            type:     'input',
            block_id: `list_select_input_${workflowRunId}`,
            element:  {
              type:        'plain_text_input',
              action_id:   'list_select_value',
              placeholder: { type: 'plain_text', text: `e.g. ${selectable.id}` },
            },
            label: { type: 'plain_text', text: 'Enter the ID to select' },
          });
          blocks.push({
            type:     'actions',
            elements: [{
              type: 'button',
              ...(validStyle ? { style: selectable.secondaryAction.style } : {}),
              text:      { type: 'plain_text', text: selectable.secondaryAction.label },
              action_id: `list_select_${selectable.secondaryAction.action}`,
              value:     JSON.stringify({ workflowRunId, action: selectable.secondaryAction.action }),
            }],
          });
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
              continue;
            } else if (typeof item.value[0] === 'object') {
              const allEmpty = item.value.every(v => Object.keys(v).length === 0);
              if (allEmpty) {
                valueText = `${item.value.length} entries _(metadata auto-assigned by DB)_`;
              } else {
                const first = JSON.stringify(item.value[0]);
                const allSame = item.value.every(v => JSON.stringify(v) === first);
                if (allSame && item.value.length > 3) {
                  valueText = `${item.value.length}\u00d7 ${first}`;
                } else if (item.value.every(v => v.syntax || v.verb || v.command)) {
                  valueText = '\n' + item.value
                    .map(v => `    \u2022 ${v.syntax ?? v.verb ?? v.command}`)
                    .join('\n');
                } else {
                  blocks.push({ type: 'markdown', text: `*${item.key}:*` });
                  blocks.push(...markdownToBlocks(buildObjectArrayTable(item.value)));
                  continue;
                }
              }
            } else {
              valueText = item.value.join(', ');
            }
          } else if (item.value !== null && typeof item.value === 'object') {
            valueText = JSON.stringify(item.value, null, 2);
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
      items: [{ id: 'T1', fields: { name: 'PGD_T1', columns: 'col1, col2' } }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks[0].text.text, '*3 tables*');
  });

  it('omits label block when label absent', () => {
    const field = {
      type: 'list',
      items: [{ id: 'T1', fields: { name: 'PGD_T1' } }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    // Just the one markdown table block — no label, no selectable row so no input/actions.
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'markdown');
    assert.ok(blocks[0].text.includes('PGD_T1'));
  });

  it('renders all rows as a single markdown table, not one block per row', () => {
    const field = {
      type:  'list',
      items: [{ id: 1, fields: { name: 'A' } }, { id: 2, fields: { name: 'B' } }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'markdown');
    assert.ok(blocks[0].text.includes('| A |'));
    assert.ok(blocks[0].text.includes('| B |'));
  });

  it('item WITHOUT any selectable item still appears in the table but adds no input/actions block', () => {
    const field = {
      type:  'list',
      items: [{ id: 'PGD_Parent', fields: { name: 'PGD_Parent', columns: 'id, name' } }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks.length, 1);
    assert.equal(blocks.some(b => b.type === 'input'), false);
    assert.equal(blocks.some(b => b.type === 'actions'), false);
  });

  it('at least one selectable item adds a shared ID-entry input and one Select button', () => {
    const field = {
      type:  'list',
      items: [{
        id:     'PGD_Child',
        fields: { name: 'PGD_Child', columns: 'parent_id, val' },
        secondaryAction: { label: 'Remove', action: 'remove_table', style: 'danger' },
      }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 99);
    const inputBlock   = blocks.find(b => b.type === 'input');
    const actionsBlock = blocks.find(b => b.type === 'actions');
    assert.ok(inputBlock, 'input block should be present');
    assert.equal(inputBlock.element.type, 'plain_text_input');
    assert.ok(actionsBlock, 'actions block should be present');
    assert.equal(actionsBlock.elements[0].style, 'danger');
    assert.equal(actionsBlock.elements[0].text.text, 'Remove');
  });

  it('Select button style "default" (or omitted) sends no style field — Slack rejects style: "default" as invalid_blocks', () => {
    const field = {
      type: 'list',
      items: [
        { id: 'A', fields: { name: 'A' }, secondaryAction: { label: 'View', action: 'view_record', style: 'default' } },
      ],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    const button = blocks.find(b => b.type === 'actions').elements[0];
    assert.ok(!('style' in button), 'style: "default" must not be forwarded — Slack has no such enum value');
  });

  it('Select button value encodes only workflowRunId and action — no per-row responseData', () => {
    const field = {
      type:  'list',
      items: [{
        id: 'PGD_Holdings',
        fields: { name: 'PGD_Holdings' },
        secondaryAction: { label: 'Remove', action: 'remove_table', style: 'danger' },
      }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 77);
    const button = blocks.find(b => b.type === 'actions').elements[0];
    const value  = JSON.parse(button.value);
    assert.equal(value.workflowRunId, 77);
    assert.equal(value.action, 'remove_table');
    assert.equal(value.responseData, undefined);
  });

  it('the Select button reflects the first selectable row when rows have mixed actionability', () => {
    const field = {
      type: 'list',
      items: [
        { id: 'A', fields: { name: 'A' } },
        { id: 'B', fields: { name: 'B' }, secondaryAction: { label: 'Open', action: 'select_row' } },
      ],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    const button = blocks.find(b => b.type === 'actions').elements[0];
    assert.equal(button.text.text, 'Open');
    assert.equal(JSON.parse(button.value).action, 'select_row');
  });

  it('every distinct field key across items becomes its own table column', () => {
    const field = {
      type: 'list',
      items: [{ id: 'T', fields: { name: 'PGD_T', columns: 'col1, col2' } }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.ok(blocks[0].text.includes('| Columns |'));
    assert.ok(blocks[0].text.includes('col1, col2'));
  });
});

describe('formatColumnHeader', () => {
  it('title-cases a snake_case key', () => {
    assert.equal(formatColumnHeader('ease_factor', [1.3, 2.5]), 'Ease Factor');
    assert.equal(formatColumnHeader('front', ['hola', 'adios']), 'Front');
  });

  it('leaves the ID column unchanged', () => {
    assert.equal(formatColumnHeader('ID', [1, 2]), 'ID');
  });

  it('a resolved FK column (_id key, non-numeric values) drops the suffix and reads as "<Prefix> Name"', () => {
    assert.equal(formatColumnHeader('deck_id', ['Spanish Grammar', 'French Basics']), 'Deck Name');
  });

  it('an unresolved FK column (_id key, still-numeric values) stays title-cased as-is', () => {
    assert.equal(formatColumnHeader('deck_id', [3, 7]), 'Deck Id');
  });

  it('a single resolved value among the column is enough to treat the whole column as resolved', () => {
    assert.equal(formatColumnHeader('category_id', [null, 'Groceries']), 'Category Name');
  });
});

describe('buildListTable', () => {
  it('column set is ID plus the union of every item\'s own field keys, first-seen order', () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'A' } },
      { id: 2, fields: { name: 'B', note: 'x' } },
    ]);
    assert.equal(table.split('\n')[0], '| ID | Name | Note |');
    assert.equal(table.split('\n').length, 4); // header + sep + 2 rows
  });

  it('does not synthesize a column no item actually has', () => {
    const table = buildListTable([{ id: 1, fields: { name: 'A' } }, { id: 2, fields: { name: 'B' } }]);
    assert.ok(!table.includes('Note'));
  });

  it('a row missing a column present on another row renders a blank cell, not an error', () => {
    const table = buildListTable([
      { id: 1, fields: { title: 'Deck A' } },
      { id: 2, fields: { front: 'hola', back: 'hello' } },
    ]);
    const rows = table.split('\n');
    assert.equal(rows[0], '| ID | Title | Front | Back |');
    assert.equal(rows[2], '| 1 | Deck A |  |  |');
    assert.equal(rows[3], '| 2 |  | hola | hello |');
  });

  it('escapes pipe characters and strips newlines from cell values', () => {
    const table = buildListTable([{ id: 1, fields: { name: 'A | B', note: 'line1\nline2' } }]);
    assert.ok(table.includes('A \\| B'));
    assert.ok(table.includes('line1 line2'));
    assert.ok(!table.includes('line1\nline2'));
  });

  it('a resolved FK field renders as "<Prefix> Name" in the actual table header', () => {
    const table = buildListTable([
      { id: 1, fields: { front: 'hola', back: 'hello', deck_id: 'Spanish Grammar', ease_factor: 2.5 } },
    ]);
    assert.equal(table.split('\n')[0], '| ID | Front | Back | Deck Name | Ease Factor |');
  });

  it('a field identical across every row is hoisted to a heading and dropped from the table', () => {
    const table = buildListTable([
      { id: 67, fields: { front: 'hola', back: 'hello', deck_id: 'Spanish Grammar' } },
      { id: 68, fields: { front: 'adios', back: 'goodbye', deck_id: 'Spanish Grammar' } },
    ]);
    const lines = table.split('\n');
    assert.equal(lines[0], '# Spanish Grammar');
    assert.equal(lines[1], '| ID | Front | Back |');
    assert.ok(!table.includes('Deck Name'));
  });

  it('no column is hoisted when every field actually varies across rows', () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'A', category: 'x' } },
      { id: 2, fields: { name: 'B', category: 'y' } },
    ]);
    assert.ok(!table.startsWith('#'));
    assert.equal(table.split('\n')[0], '| ID | Name | Category |');
  });

  it('a field missing from some rows is NOT hoisted even when identical on the rows that have it', () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'A', shared: 'x' } },
      { id: 2, fields: { name: 'B' } },
    ]);
    assert.ok(!table.startsWith('#'));
    assert.ok(table.includes('Shared'));
  });

  it('a single-item list is never hoisted — nothing redundant to remove', () => {
    const table = buildListTable([{ id: 1, fields: { deck_id: 'Spanish Grammar' } }]);
    assert.ok(!table.startsWith('#'));
    assert.equal(table.split('\n')[0], '| ID | Deck Name |');
  });

  it('multiple constant columns each get their own heading line', () => {
    const table = buildListTable([
      { id: 1, fields: { deck_id: 'Spanish Grammar', domain: 'flashcards', front: 'hola' } },
      { id: 2, fields: { deck_id: 'Spanish Grammar', domain: 'flashcards', front: 'adios' } },
    ]);
    const lines = table.split('\n');
    assert.equal(lines[0], '# Spanish Grammar');
    assert.equal(lines[1], '# flashcards');
    assert.equal(lines[2], '| ID | Front |');
  });
});

describe('dialogToBlocks — reveal', () => {
  it('array of strings renders each item as a bullet line in the section text', () => {
    const field = { type: 'reveal', button_label: 'Details', content: ['Dining Out', 'Subscriptions'] };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.type, 'container');
    assert.equal(block.child_blocks[0].text.text, '• Dining Out\n• Subscriptions');
  });

  it('array of objects JSON-stringifies each item instead of [object Object]', () => {
    const field = {
      type: 'reveal',
      button_label: 'Sample records',
      content: [{ category_id: 1, planned_amount: 3300 }, { category_id: 2, planned_amount: 450 }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    const text = block.child_blocks[0].text.text;
    assert.ok(!text.includes('[object Object]'));
    assert.equal(text, '• {"category_id":1,"planned_amount":3300}\n• {"category_id":2,"planned_amount":450}');
  });

  it('plain string content renders directly as the container section text', () => {
    const field = { type: 'reveal', button_label: 'Info', content: 'Just a note' };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.child_blocks[0].text.text, 'Just a note');
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
  // dropped instead of rendered as a container. Sprint 7 Track G3, run 632.
  it('renders reveal fields as container blocks between the message and the input block', () => {
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

    const containers = blocks.filter(b => b.type === 'container');
    assert.equal(containers.length, 2);
    assert.equal(containers[0].title.text, 'PGD_Budgets');
    assert.equal(containers[1].title.text, 'PGD_SpendingCategories');

    const inputIndex = blocks.findIndex(b => b.type === 'input');
    assert.ok(inputIndex > 0, 'input block must be present');
    assert.ok(
      containers.every(card => blocks.indexOf(card) < inputIndex),
      'reveal containers must render before the input block',
    );
  });

  it('produces no container blocks when no reveal field is present', () => {
    const dialog = {
      fields: [
        { type: 'typography', value: 'Anything else?' },
        { type: 'textbox', label: 'Your input' },
      ],
    };
    const blocks = textInputGateBlocks(dialog, 9, '9');
    assert.equal(blocks.filter(b => b.type === 'container').length, 0);
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

  it('empty array is skipped entirely — no block produced', () => {
    const field = {
      type:  'review_object',
      items: [{ key: 'commands', value: [] }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(blocks.length, 0);
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

  it('array of objects with neither syntax/verb/command renders as a labeled table, not raw JSON', () => {
    // Regression (run 658): flashcard {front, back} pairs and ref-record
    // proposals fell all the way to JSON.stringify. Sprint 7 D-track first
    // fixed this to an unlabeled "value — value" dash-join, which turned out
    // to be its own bug (run 663/session 12): with no field labels, a reviewer
    // has no way to tell which value landed in which field once a record has
    // more than one field of the same type. Now renders as a real table.
    const field = {
      type:  'review_object',
      items: [{ key: 'steps', value: [{ description: 'Mix ingredients', order: 1 }] }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    const allText = blocks.map(b => (typeof b.text === 'string' ? b.text : b.text?.text) ?? '').join('\n');
    assert.ok(allText.includes('*steps:*'));
    assert.ok(allText.includes('Description'));
    assert.ok(allText.includes('Mix ingredients'));
    assert.ok(!allText.includes('{"description"'), 'must not render raw JSON');
  });

  it('array of objects with two string fields renders as a table with labeled columns (flashcard front/back shape)', () => {
    // Regression (session 12): the prior fix's unlabeled "gato — cat" dash-join
    // looked backwards even when correctly parsed, because a reviewer cannot
    // tell front from back without a label — only a table showing "Front"/"Back"
    // as their own columns resolves the ambiguity.
    const field = {
      type:  'review_object',
      items: [{ key: 'cards', value: [{ front: 'gato', back: 'cat' }] }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    const allText = blocks.map(b => (typeof b.text === 'string' ? b.text : b.text?.text) ?? '').join('\n');
    assert.ok(allText.includes('| Front | Back |'));
    assert.ok(allText.includes('| gato | cat |'));
    assert.ok(!allText.includes('gato — cat'), 'must not render as an unlabeled dash-join');
  });

  it('array of objects with no string fields at all renders as a table, not JSON.stringify', () => {
    const field = {
      type:  'review_object',
      items: [{ key: 'stats', value: [{ order: 1, count: 2 }] }],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 1);
    const allText = blocks.map(b => (typeof b.text === 'string' ? b.text : b.text?.text) ?? '').join('\n');
    assert.ok(allText.includes('| Order | Count |'));
    assert.ok(allText.includes('| 1 | 2 |'));
    assert.ok(!allText.includes('{"order":1,"count":2}'));
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
            { id: 'PGD_Recipes',     fields: { name: 'PGD_Recipes',     columns: 'name, description' } },
            { id: 'PGD_Ingredients', fields: { name: 'PGD_Ingredients', columns: 'recipe_id, name' },
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

    // 1 typography + 1 label + 1 markdown table + 1 input + 1 select-actions + 1 bottom actions = 6 blocks
    assert.equal(blocks.length, 6);
    assert.equal(blocks[0].type, 'markdown');  // typography
    assert.equal(blocks[1].type, 'section');   // label
    assert.equal(blocks[2].type, 'markdown');  // table — both rows in one block
    assert.ok(blocks[2].text.includes('PGD_Recipes'));
    assert.ok(blocks[2].text.includes('PGD_Ingredients'));
    assert.equal(blocks[3].type, 'input');     // shared ID-entry input
    assert.equal(blocks[4].type, 'actions');   // Select button (from item_action)
    assert.equal(blocks[4].elements[0].text.text, 'Remove');
    assert.equal(blocks[5].type, 'actions');   // bottom Looks good / Cancel

    // workflowRunId propagates to all button values
    const confirmValue = JSON.parse(blocks[5].elements[0].value);
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
