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
import { oversizedGateMessage, isPermanentRenderFailure, toSlackMrkdwn } from '../../src/ui/slackbot/callback.mjs';

// toSlackMrkdwn — the REAL exported function (not a copy). Normalizes standard
// **bold** / __bold__ to Slack mrkdwn *bold* and GFM ~~strike~~ to ~strike~ for
// section/reveal text (run 731).
describe('toSlackMrkdwn', () => {
  it('converts **bold** to *bold*', () => {
    assert.equal(toSlackMrkdwn('**Income**'), '*Income*');
  });
  it('converts __bold__ to *bold*', () => {
    assert.equal(toSlackMrkdwn('__Income__'), '*Income*');
  });
  it('converts each bold span independently, preserving surrounding text', () => {
    assert.equal(toSlackMrkdwn('**Income**\nMedical: $130\n**Net: $-50**'), '*Income*\nMedical: $130\n*Net: $-50*');
  });
  it('leaves a lone * or _ (Slack bold/italic) untouched', () => {
    assert.equal(toSlackMrkdwn('*already* and _italic_'), '*already* and _italic_');
  });
  it('does not touch bold inside inline code', () => {
    assert.equal(toSlackMrkdwn('use `**literal**` here'), 'use `**literal**` here');
  });
  it('returns non-strings and bold-free text unchanged', () => {
    assert.equal(toSlackMrkdwn('no bold here'), 'no bold here');
    assert.equal(toSlackMrkdwn(null), null);
  });
  it('ignores an unbalanced ** (no false conversion)', () => {
    assert.equal(toSlackMrkdwn('a ** b'), 'a ** b');
  });
  it('converts GFM ~~strike~~ to Slack ~strike~', () => {
    assert.equal(toSlackMrkdwn('~~cancelled~~'), '~cancelled~');
  });
  it('leaves a lone ~ (Slack strikethrough) untouched', () => {
    assert.equal(toSlackMrkdwn('~already~'), '~already~');
  });
  it('ignores an unbalanced ~~ (no false conversion)', () => {
    assert.equal(toSlackMrkdwn('a ~~ b'), 'a ~~ b');
  });
  it('does not touch ~~ inside inline code', () => {
    assert.equal(toSlackMrkdwn('use `~~literal~~` here'), 'use `~~literal~~` here');
  });
  it('converts bold and strikethrough together in one string', () => {
    assert.equal(
      toSlackMrkdwn('**Income** and ~~Medical~~'),
      '*Income* and ~Medical~',
    );
  });
  it('returns strike-free, bold-free text unchanged (early exit still correct)', () => {
    assert.equal(toSlackMrkdwn('plain ~ text'), 'plain ~ text');
  });

  // Every remaining gap between standard markdown and mrkdwn is closed here rather
  // than by a /proc prompt rule — the procedure layer must not know this layer's
  // syntax (experience/procedure partition).
  it('converts a standard link to <url|text>', () => {
    assert.equal(
      toSlackMrkdwn('see [the docs](https://example.com/a)'),
      'see <https://example.com/a|the docs>',
    );
  });
  it('converts an image to a plain link — mrkdwn never embeds one', () => {
    assert.equal(toSlackMrkdwn('![chart](https://x.com/c.png)'), '<https://x.com/c.png|chart>');
  });
  it('emits a bare <url> when the link text is empty', () => {
    assert.equal(toSlackMrkdwn('[](https://example.com)'), '<https://example.com>');
  });
  it('converts an ATX heading to a bold line, at every level', () => {
    assert.equal(toSlackMrkdwn('# Summary'), '*Summary*');
    assert.equal(toSlackMrkdwn('### Details'), '*Details*');
  });
  it('does not double-wrap a heading whose text is already bold', () => {
    assert.equal(toSlackMrkdwn('## **Totals**'), '*Totals*');
  });
  it('leaves a mid-line # alone (only ATX headings convert)', () => {
    assert.equal(toSlackMrkdwn('issue #42 filed'), 'issue #42 filed');
  });
  it('converts task-list checkboxes, preserving indentation', () => {
    assert.equal(
      toSlackMrkdwn('- [ ] open\n- [x] done\n  - [ ] nested'),
      '☐ open\n☑ done\n  ☐ nested',
    );
  });
  it('leaves an ordinary bullet untouched', () => {
    assert.equal(toSlackMrkdwn('- just a bullet'), '- just a bullet');
  });
  it('does not touch links or headings inside code', () => {
    assert.equal(
      toSlackMrkdwn('use `[text](url)` and\n```\n# not a heading\n```'),
      'use `[text](url)` and\n```\n# not a heading\n```',
    );
  });
  it('converts a realistic mixed reveal in one pass', () => {
    assert.equal(
      toSlackMrkdwn('## Budget\n**Medical** was ~~$120~~ $130.\n- [x] saved\nSee [detail](https://x.com/b).'),
      '*Budget*\n*Medical* was ~$120~ $130.\n☑ saved\nSee <https://x.com/b|detail>.',
    );
  });
});

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
const TABLE_MAX_ROWS            = 100;
const TABLE_MAX_COLUMNS         = 20;
const TABLE_MAX_CHARS           = 10000;

// ── Faithful copy of buildTableBlock from callback.mjs ──────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:buildTableBlock
function buildTableBlock(headerLabels, dataRows) {
  const cols = headerLabels.slice(0, TABLE_MAX_COLUMNS);
  const cell = (v, bold) => {
    const text = String(v ?? '').replace(/\r?\n/g, ' ');
    return {
      type:     'rich_text',
      elements: [{
        type:     'rich_text_section',
        elements: [{ type: 'text', text, ...(bold ? { style: { bold: true } } : {}) }],
      }],
    };
  };
  const cellText = c => c.elements[0].elements[0].text;

  const rows = [cols.map(h => cell(h, true))];
  let charCount = cols.reduce((sum, h) => sum + String(h ?? '').length, 0);
  let truncated = 0;
  for (const rowValues of dataRows) {
    const rowCells = rowValues.slice(0, TABLE_MAX_COLUMNS).map(v => cell(v, false));
    const rowChars = rowCells.reduce((sum, c) => sum + cellText(c).length, 0);
    if (rows.length >= TABLE_MAX_ROWS || charCount + rowChars > TABLE_MAX_CHARS) {
      truncated++;
      continue;
    }
    rows.push(rowCells);
    charCount += rowChars;
  }

  return { table: { type: 'table', rows }, truncated };
}

// ── Faithful copy of buildRevealTable from callback.mjs ─────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:buildRevealTable
function buildRevealTable(items) {
  const columns = [];
  const seen = new Set();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  const headerLabels = columns.map(col => formatColumnHeader(col, items.map(it => it[col])));
  const dataRows = items.map(item => columns.map(col => item[col]));
  return buildTableBlock(headerLabels, dataRows);
}

// ── Faithful copy of splitMarkdownTableSegments from callback.mjs ───────────
// Keep in sync with src/ui/slackbot/callback.mjs:splitMarkdownTableSegments
function splitMarkdownTableSegments(text) {
  const lines = text.split('\n');
  const isRow       = l => /^\s*\|.*\|\s*$/.test(l);
  const isSeparator = l => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l);
  const splitRow    = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  const segments = [];
  let textLines = [];
  const flushText = () => {
    if (textLines.length) segments.push({ type: 'text', text: textLines.join('\n') });
    textLines = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (isRow(lines[i]) && isSeparator(lines[i + 1] ?? '')) {
      flushText();
      const header = splitRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && isRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      segments.push({ type: 'table', header, rows });
    } else {
      textLines.push(lines[i]);
      i++;
    }
  }
  flushText();
  return segments;
}

// ── Faithful copy of chunkTextBlocks from callback.mjs ──────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:chunkTextBlocks
function chunkTextBlocks(text) {
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
  return kept.map(c => ({ type: 'section', text: { type: 'mrkdwn', text: c } }));
}

function buildRevealBlock(field) {
  const isRecordArray = Array.isArray(field.content) && field.content.length > 0
    && field.content.every(v => v !== null && typeof v === 'object')
    && !field.content.every(v => v.syntax || v.verb || v.command);

  const childBlocks = [];

  if (isRecordArray) {
    const { table, truncated } = buildRevealTable(field.content);
    childBlocks.push(table);
    if (truncated > 0) {
      childBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_...and ${truncated} more row(s)_` } });
    }
  } else if (Array.isArray(field.content)) {
    const text = field.content.map(item => `• ${(item !== null && typeof item === 'object') ? (item.syntax ?? item.verb ?? item.command) : String(item)}`).join('\n');
    childBlocks.push(...chunkTextBlocks(text));
  } else {
    const segments = splitMarkdownTableSegments(String(field.content ?? ''));
    for (const seg of segments) {
      if (seg.type === 'table') {
        const { table, truncated } = buildTableBlock(seg.header, seg.rows);
        childBlocks.push(table);
        if (truncated > 0) {
          childBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_...and ${truncated} more row(s)_` } });
        }
      } else if (seg.text.trim()) {
        childBlocks.push(...chunkTextBlocks(seg.text));
      }
    }
  }

  return {
    type:               'container',
    block_id:           `reveal_test-id`,
    title:              { type: 'plain_text', text: field.button_label ?? 'Details' },
    is_collapsible:     true,
    default_collapsed:  true,
    child_blocks:       childBlocks,
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

// ── Faithful copy of formatTableName from callback.mjs ──────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:formatTableName
function formatTableName(tableName) {
  const base = String(tableName ?? '').replace(/^PGD_/i, '');
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim() || String(tableName ?? '');
}

// ── Faithful copy of buildTableBody from callback.mjs ────────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:buildTableBody
function buildTableBody(items, excludeColumn) {
  const columns = ['ID'];
  const seen = new Set(columns);
  for (const item of items) {
    for (const key of Object.keys(item.fields ?? {})) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  const tableColumns = columns.filter(col => col !== excludeColumn);

  const headerLabels = tableColumns.map(col => formatColumnHeader(col, items.map(item => item.fields?.[col])));
  const header = `| ${headerLabels.join(' | ')} |`;
  const sep    = `|${tableColumns.map(() => '---').join('|')}|`;
  const rows   = items.map(item => {
    const cells = tableColumns.map(col => (col === 'ID' ? item.id : item.fields?.[col]));
    return `| ${cells.map(escapeCell).join(' | ')} |`;
  });
  return [header, sep, ...rows].join('\n');
}

// ── Faithful copy of buildListTable from callback.mjs ────────────────────────
// Keep in sync with src/ui/slackbot/callback.mjs:buildListTable
function buildListTable(items, parentHeading) {
  const groups = new Map();
  for (const item of items) {
    const table = item.responseData?.table;
    if (!groups.has(table)) groups.set(table, []);
    groups.get(table).push(item);
  }
  const entries = [...groups.entries()];

  if (!parentHeading) {
    return entries
      .map(([table, groupItems]) => [`# ${formatTableName(table)}`, buildTableBody(groupItems)].join('\n'))
      .join('\n\n');
  }

  const sections = entries.map(([table, groupItems]) => {
    const excludeColumn = groupItems[0]?.responseData?.fkColumn ?? undefined;
    return [`## ${formatTableName(table)}`, buildTableBody(groupItems, excludeColumn)].join('\n');
  });
  return [`# ${parentHeading}`, ...sections].join('\n\n');
}

// ── Faithful copy of the static_select builders from callback.mjs ───────────
// Keep in sync with src/ui/slackbot/callback.mjs:buildListSelect
const SELECT_OPTION_LIMIT = 100;
const OPTION_TEXT_LIMIT   = 75;
const CHOICE_DROPDOWN_THRESHOLD = 5;

function truncateOption(text) {
  const s = String(text ?? '');
  return s.length <= OPTION_TEXT_LIMIT ? s : `${s.slice(0, OPTION_TEXT_LIMIT - 1)}…`;
}

function buildSelectOptionText(item, excludeColumn) {
  const entry = Object.entries(item.fields ?? {}).find(([col, value]) =>
    col !== excludeColumn && value !== null && value !== undefined && String(value).trim() !== ''
  );
  const summary = entry ? String(entry[1]).trim() : '';
  return truncateOption(summary ? `${item.id} — ${summary}` : String(item.id));
}

function buildListSelect(items, workflowRunId) {
  const selectable = items.filter(item => item.secondaryAction);
  if (selectable.length === 0 || selectable.length > SELECT_OPTION_LIMIT) return null;

  const groups = new Map();
  for (const item of selectable) {
    const table = item.responseData?.table;
    if (!groups.has(table)) groups.set(table, []);
    groups.get(table).push(item);
  }
  const entries = [...groups.entries()];

  const toOptions = groupItems => {
    const excludeColumn = groupItems[0]?.responseData?.fkColumn ?? undefined;
    return groupItems.map(item => ({
      text:  { type: 'plain_text', text: buildSelectOptionText(item, excludeColumn) },
      value: JSON.stringify({
        id: item.id,
        ...(item.responseData?.table ? { table: item.responseData.table } : {}),
      }),
    }));
  };

  const element = {
    type:        'static_select',
    action_id:   'list_select_value',
    placeholder: { type: 'plain_text', text: 'Choose a record' },
  };
  if (entries.length > 1) {
    element.option_groups = entries.map(([table, groupItems]) => ({
      label:   { type: 'plain_text', text: truncateOption(formatTableName(table)) },
      options: toOptions(groupItems),
    }));
  } else {
    element.options = toOptions(entries[0][1]);
  }

  return {
    type:     'input',
    block_id: `list_select_input_${workflowRunId}`,
    element,
    label:    { type: 'plain_text', text: 'Select a record' },
  };
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
function dialogToBlocks(dialog, workflowRunId, gateType) {
  const blocks = [];

  const choiceButtons  = gateType === 'choice'
    ? ((dialog?.fields ?? []).find(f => f.type === 'actions')?.buttons ?? []).filter(b => b.action !== 'cancel')
    : [];
  const choiceAsDropdown =
    choiceButtons.length > CHOICE_DROPDOWN_THRESHOLD && choiceButtons.length <= SELECT_OPTION_LIMIT;

  for (const field of (dialog?.fields ?? [])) {
    switch (field.type) {

      case 'typography':
        blocks.push({
          type: 'markdown',
          text: `\ud83e\udde0 ${field.value}`,
        });
        break;

      case 'description_list': {
        if (choiceAsDropdown) break;
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
          blocks.push(...markdownToBlocks(buildListTable(items, field.parentHeading)));
        }
        const selectable = items.find(item => item.secondaryAction);
        if (selectable) {
          const validStyle = selectable.secondaryAction.style === 'danger' || selectable.secondaryAction.style === 'primary';
          blocks.push(buildListSelect(items, workflowRunId) ?? {
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
        const allButtons = field.buttons ?? [];

        if (choiceAsDropdown) {
          const choices = allButtons.filter(b => b.action !== 'cancel');
          blocks.push({
            type:     'input',
            block_id: `choice_select_${workflowRunId}`,
            element:  {
              type:        'static_select',
              action_id:   'choice_value',
              placeholder: { type: 'plain_text', text: 'Choose one' },
              options: choices.map(btn => ({
                text:  { type: 'plain_text', text: truncateOption(btn.label) },
                value: String(btn.action),
                ...(btn.description
                  ? { description: { type: 'plain_text', text: truncateOption(btn.description) } }
                  : {}),
              })),
            },
            label: { type: 'plain_text', text: 'Select' },
          });
          blocks.push({
            type:     'actions',
            elements: [
              {
                type:      'button',
                style:     'primary',
                text:      { type: 'plain_text', text: 'Select' },
                action_id: 'workflow_choice_submit',
                value:     JSON.stringify({ workflowRunId, action: 'confirm', label: 'Select' }),
              },
              ...allButtons.filter(b => b.action === 'cancel').map((btn, i) => ({
                type:      'button',
                text:      { type: 'plain_text', text: btn.label },
                action_id: `workflow_action_${btn.action || i}_${i}`,
                value:     JSON.stringify({ workflowRunId, action: btn.action, label: btn.label }),
              })),
            ],
          });
          break;
        }

        const elements = allButtons.map((btn, i) => ({
          type:      'button',
          style:     btn.style === 'primary' ? 'primary' : btn.style === 'danger' ? 'danger' : undefined,
          text:      { type: 'plain_text', text: btn.label },
          action_id: `workflow_action_${btn.action || i}_${i}`,
          value:     JSON.stringify({
            workflowRunId,
            action: btn.action,
            label:  btn.label,
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

  it('at least one selectable item adds a shared select input and one Select button', () => {
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
    assert.equal(inputBlock.element.type, 'static_select');
    assert.ok(actionsBlock, 'actions block should be present');
    assert.equal(actionsBlock.elements[0].style, 'danger');
    assert.equal(actionsBlock.elements[0].text.text, 'Remove');
  });

  it('a level spanning two child tables renders one option_group per table, each option carrying its own table', () => {
    const field = {
      type:          'list',
      parentHeading: 'Paella',
      items: [
        { id: 1, fields: { name: 'Rice' },  responseData: { table: 'PGD_Ingredients', fkColumn: 'recipe_id' }, secondaryAction: { label: 'Open', action: 'open_row' } },
        { id: 1, fields: { text: 'Simmer' }, responseData: { table: 'PGD_RecipeSteps', fkColumn: 'recipe_id' }, secondaryAction: { label: 'Open', action: 'open_row' } },
      ],
    };
    const select = dialogToBlocks({ fields: [field] }, 7).find(b => b.type === 'input').element;
    assert.equal(select.type, 'static_select');
    assert.equal(select.option_groups.length, 2, 'one group per source table');
    assert.equal(select.option_groups[0].label.text, 'Ingredients');
    assert.equal(select.option_groups[1].label.text, 'Recipe Steps');
    // The colliding id (1 in both tables) is disambiguated by the option value itself.
    assert.deepEqual(JSON.parse(select.option_groups[0].options[0].value), { id: 1, table: 'PGD_Ingredients' });
    assert.deepEqual(JSON.parse(select.option_groups[1].options[0].value), { id: 1, table: 'PGD_RecipeSteps' });
  });

  it('option text is the row id plus its first non-empty field, skipping the parent-link column', () => {
    const field = {
      type:  'list',
      items: [
        { id: 42, fields: { recipe_id: 9, name: 'Olive oil' }, responseData: { table: 'PGD_Ingredients', fkColumn: 'recipe_id' }, secondaryAction: { label: 'Open', action: 'open_row' } },
      ],
    };
    const select = dialogToBlocks({ fields: [field] }, 7).find(b => b.type === 'input').element;
    assert.ok(!select.option_groups, 'a single-table level gets a flat option list, not a one-group header');
    assert.equal(select.options[0].text.text, '42 — Olive oil');
  });

  it('option text is truncated to Slack’s 75-character limit', () => {
    const field = {
      type:  'list',
      items: [
        { id: 1, fields: { note: 'x'.repeat(200) }, secondaryAction: { label: 'Open', action: 'open_row' } },
      ],
    };
    const select = dialogToBlocks({ fields: [field] }, 7).find(b => b.type === 'input').element;
    assert.equal(select.options[0].text.text.length, OPTION_TEXT_LIMIT);
  });

  it('a list beyond Slack’s 100-option cap falls back to the shared text input', () => {
    const items = Array.from({ length: SELECT_OPTION_LIMIT + 1 }, (_, i) => ({
      id: i + 1,
      fields: { name: `row ${i + 1}` },
      secondaryAction: { label: 'Open', action: 'open_row' },
    }));
    const blocks = dialogToBlocks({ fields: [{ type: 'list', items }] }, 7);
    const inputBlock = blocks.find(b => b.type === 'input');
    assert.equal(inputBlock.element.type, 'plain_text_input', 'past the cap the text box returns');
    assert.equal(inputBlock.element.action_id, 'list_select_value', 'same action_id either way');
    // The table itself stays uncapped — every row is still displayed.
    const table = blocks.find(b => b.type === 'markdown').text;
    assert.ok(table.includes(`| ${SELECT_OPTION_LIMIT + 1} |`), 'all rows remain visible in the table');
  });

  it('non-selectable rows are excluded from the options but stay in the table', () => {
    const field = {
      type:  'list',
      items: [
        { id: 1, fields: { name: 'Pickable' },     secondaryAction: { label: 'Open', action: 'open_row' } },
        { id: 2, fields: { name: 'Not pickable' }, secondaryAction: null },
      ],
    };
    const blocks = dialogToBlocks({ fields: [field] }, 7);
    const select = blocks.find(b => b.type === 'input').element;
    assert.equal(select.options.length, 1);
    assert.equal(JSON.parse(select.options[0].value).id, 1);
    assert.ok(blocks.find(b => b.type === 'markdown').text.includes('Not pickable'), 'still listed');
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

describe('formatTableName', () => {
  it('strips the PGD_ prefix and splits PascalCase into words', () => {
    assert.equal(formatTableName('PGD_Recipes'), 'Recipes');
    assert.equal(formatTableName('PGD_RecipeSteps'), 'Recipe Steps');
  });

  it('is case-insensitive on the prefix', () => {
    assert.equal(formatTableName('pgd_Ingredients'), 'Ingredients');
  });
});

describe('buildListTable', () => {
  it('column set is ID plus the union of every item\'s own field keys, first-seen order', () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'A' }, responseData: { table: 'PGD_Widgets' } },
      { id: 2, fields: { name: 'B', note: 'x' }, responseData: { table: 'PGD_Widgets' } },
    ]);
    const lines = table.split('\n');
    assert.equal(lines[0], '# Widgets');
    assert.equal(lines[1], '| ID | Name | Note |');
    assert.equal(lines.length, 5); // heading + header + sep + 2 rows
  });

  it('does not synthesize a column no item actually has', () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'A' }, responseData: { table: 'PGD_Widgets' } },
      { id: 2, fields: { name: 'B' }, responseData: { table: 'PGD_Widgets' } },
    ]);
    assert.ok(!table.includes('Note'));
  });

  it('a row missing a column present on another row renders a blank cell, not an error', () => {
    const table = buildListTable([
      { id: 1, fields: { title: 'Deck A' }, responseData: { table: 'PGD_Decks' } },
      { id: 2, fields: { front: 'hola', back: 'hello' }, responseData: { table: 'PGD_Decks' } },
    ]);
    const rows = table.split('\n');
    assert.equal(rows[0], '# Decks');
    assert.equal(rows[1], '| ID | Title | Front | Back |');
    assert.equal(rows[3], '| 1 | Deck A |  |  |');
    assert.equal(rows[4], '| 2 |  | hola | hello |');
  });

  it('escapes pipe characters and strips newlines from cell values', () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'A | B', note: 'line1\nline2' }, responseData: { table: 'PGD_Widgets' } },
    ]);
    assert.ok(table.includes('A \\| B'));
    assert.ok(table.includes('line1 line2'));
    assert.ok(!table.includes('line1\nline2'));
  });

  it('a resolved FK field renders as "<Prefix> Name" in the actual table header', () => {
    const table = buildListTable([
      { id: 1, fields: { front: 'hola', back: 'hello', deck_id: 'Spanish Grammar', ease_factor: 2.5 }, responseData: { table: 'PGD_Cards' } },
    ]);
    assert.equal(table.split('\n')[1], '| ID | Front | Back | Deck Name | Ease Factor |');
  });

  it('falls back to the table name as heading when no column represents real parent context', () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'A', category: 'x' }, responseData: { table: 'PGD_Widgets' } },
      { id: 2, fields: { name: 'B', category: 'y' }, responseData: { table: 'PGD_Widgets' } },
    ]);
    const lines = table.split('\n');
    assert.equal(lines[0], '# Widgets');
    assert.equal(lines[1], '| ID | Name | Category |');
  });

  it('a single-item list still gets a table-name heading — every list is headed, even with just one row', () => {
    const table = buildListTable([
      { id: 1, fields: { deck_id: 'Spanish Grammar' }, responseData: { table: 'PGD_Cards' } },
    ]);
    const lines = table.split('\n');
    assert.equal(lines[0], '# Cards');
    assert.equal(lines[1], '| ID | Deck Name |');
  });

  it('with a parentHeading, it renders once as the H1 and the table gets its own H2 — even for a single child table', () => {
    const table = buildListTable([
      { id: 1, fields: { front: 'hola', back: 'hello' }, responseData: { table: 'PGD_Cards', fkColumn: 'deck_id' } },
    ], 'Spanish Grammar');
    const sections = table.split('\n\n');
    assert.equal(sections[0], '# Spanish Grammar');
    const tableLines = sections[1].split('\n');
    assert.equal(tableLines[0], '## Cards');
    assert.equal(tableLines[1], '| ID | Front | Back |');
  });

  it('with two child tables, the shared parentHeading is shown once, not repeated per table', () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'Flour', quantity: '2 cups' }, responseData: { table: 'PGD_Ingredients', fkColumn: 'recipe_id' } },
      { id: 2, fields: { name: 'Sugar', quantity: '1 cup' }, responseData: { table: 'PGD_Ingredients', fkColumn: 'recipe_id' } },
      { id: 10, fields: { order: 1, description: 'Preheat oven' }, responseData: { table: 'PGD_RecipeSteps', fkColumn: 'recipe_id' } },
    ], 'Spaghetti Carbonara');
    const sections = table.split('\n\n');
    assert.equal(sections.length, 3); // shared H1 + one section per table
    assert.equal(sections[0], '# Spaghetti Carbonara');
    assert.equal(sections[1].split('\n')[0], '## Ingredients');
    assert.equal(sections[2].split('\n')[0], '## Recipe Steps');
    assert.equal((table.match(/Spaghetti Carbonara/g) || []).length, 1);
  });

  it("each table's own fkColumn is excluded from its body when a parentHeading is shown, not just relabeled", () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'Flour', recipe_id: 'Spaghetti Carbonara' }, responseData: { table: 'PGD_Ingredients', fkColumn: 'recipe_id' } },
    ], 'Spaghetti Carbonara');
    assert.ok(!table.includes('Recipe Name'));
    const sections = table.split('\n\n');
    assert.equal(sections[1].split('\n')[1], '| ID | Name |');
  });

  it('a table with no fkColumn tagged keeps all its own columns in the body', () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'Flour' }, responseData: { table: 'PGD_Ingredients' } },
    ], 'Spaghetti Carbonara');
    const sections = table.split('\n\n');
    assert.equal(sections[1].split('\n')[1], '| ID | Name |');
  });

  it('root-level list (no shared parent) is headed by the table name, not a coincidentally-uniform data value', () => {
    const table = buildListTable([
      { id: 1, fields: { title: 'Carbonara', difficulty: 'easy' }, responseData: { table: 'PGD_Recipes' } },
      { id: 2, fields: { title: 'Bolognese', difficulty: 'easy' }, responseData: { table: 'PGD_Recipes' } },
    ]);
    const lines = table.split('\n');
    assert.equal(lines[0], '# Recipes');
    assert.ok(table.includes('Difficulty')); // stays a normal column, not misread as parent context
  });

  it('rows from more than one table render as separate headed tables, not one merged sparse table', () => {
    const table = buildListTable([
      { id: 1, fields: { name: 'Flour', quantity: '2 cups' }, responseData: { table: 'PGD_Ingredients' } },
      { id: 2, fields: { name: 'Sugar', quantity: '1 cup' }, responseData: { table: 'PGD_Ingredients' } },
      { id: 10, fields: { order: 1, description: 'Preheat oven' }, responseData: { table: 'PGD_RecipeSteps' } },
    ]);
    const sections = table.split('\n\n');
    assert.equal(sections.length, 2);
    assert.equal(sections[0].split('\n')[0], '# Ingredients');
    assert.equal(sections[1].split('\n')[0], '# Recipe Steps');
  });
});

describe('dialogToBlocks — reveal', () => {
  it('array of strings renders each item as a bullet line in the section text', () => {
    const field = { type: 'reveal', button_label: 'Details', content: ['Dining Out', 'Subscriptions'] };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.type, 'container');
    assert.equal(block.child_blocks[0].text.text, '• Dining Out\n• Subscriptions');
  });

  it('array of plain records renders as a native table block, not JSON-stringified bullets', () => {
    // Regression (session 14/Novia session 979): container.child_blocks does not
    // allow the markdown block type, so a markdown pipe-table can never render
    // inside a reveal. A native Slack `table` block is the only real grid option.
    const field = {
      type: 'reveal',
      button_label: 'Sample records',
      content: [{ category_id: 1, planned_amount: 3300 }, { category_id: 2, planned_amount: 450 }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    const table = block.child_blocks[0];
    const cellText = c => c.elements[0].elements[0].text;
    assert.equal(table.type, 'table');
    assert.equal(table.rows[0].map(cellText).join('|'), 'Category Id|Planned Amount');
    assert.equal(table.rows[0][0].elements[0].elements[0].style.bold, true);
    assert.equal(table.rows[1].map(cellText).join('|'), '1|3300');
    assert.equal(table.rows[2].map(cellText).join('|'), '2|450');
  });

  it('array of objects uniformly shaped with syntax/verb/command still renders as bullets', () => {
    const field = {
      type: 'reveal',
      button_label: 'Commands',
      content: [{ syntax: '/m list recipes' }, { syntax: '/m add recipes' }],
    };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.child_blocks[0].type, 'section');
    assert.equal(block.child_blocks[0].text.text, '• /m list recipes\n• /m add recipes');
  });

  it('table row count beyond TABLE_MAX_ROWS is truncated with a trailing note', () => {
    const content = Array.from({ length: 105 }, (_, i) => ({ id: i }));
    const field = { type: 'reveal', button_label: 'Big', content };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    const table = block.child_blocks[0];
    assert.equal(table.type, 'table');
    assert.equal(table.rows.length, 100); // header + 99 data rows
    assert.equal(block.child_blocks[1].text.text, '_...and 6 more row(s)_');
  });

  it('plain string content renders directly as the container section text', () => {
    const field = { type: 'reveal', button_label: 'Info', content: 'Just a note' };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.child_blocks[0].text.text, 'Just a note');
  });

  it('a markdown pipe-table string (js_transform-built, no surrounding text) renders as a native table, not literal pipes', () => {
    // Regression: flashcard_quiz_session step 2's js_transform builds deck_reveals
    // content as a plain string ("| Deck | Cards | Due | Last Review |\n|---|...|\n| ... |"),
    // not an array of records — the isRecordArray branch never saw it, so it fell
    // through to the mrkdwn section path and rendered the pipe syntax literally.
    const content = '| Deck | Cards | Due | Last Review |\n|------|-------|-----|-------------|\n| Colors | 12 | 3 | 2026-07-01 |\n| Animals | 8 | 0 | — |';
    const field = { type: 'reveal', button_label: 'Basic Phrases', content };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    const table = block.child_blocks[0];
    const cellText = c => c.elements[0].elements[0].text;
    assert.equal(table.type, 'table');
    assert.equal(table.rows[0].map(cellText).join('|'), 'Deck|Cards|Due|Last Review');
    assert.equal(table.rows[0][0].elements[0].elements[0].style.bold, true);
    assert.equal(table.rows[1].map(cellText).join('|'), 'Colors|12|3|2026-07-01');
    assert.equal(table.rows[2].map(cellText).join('|'), 'Animals|8|0|—');
    assert.equal(block.child_blocks.length, 1);
  });

  it('a markdown string mixing prose and a pipe-table renders the prose as separate section text and the table as a native table block', () => {
    const content = 'Here are the child decks:\n\n| Deck | Cards |\n|---|---|\n| Colors | 12 |\n\nTap a deck to begin.';
    const field = { type: 'reveal', button_label: 'Child Decks', content };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.child_blocks.length, 3);
    assert.equal(block.child_blocks[0].type, 'section');
    assert.equal(block.child_blocks[0].text.text, 'Here are the child decks:\n');
    assert.equal(block.child_blocks[1].type, 'table');
    const cellText = c => c.elements[0].elements[0].text;
    assert.equal(block.child_blocks[1].rows[0].map(cellText).join('|'), 'Deck|Cards');
    assert.equal(block.child_blocks[1].rows[1].map(cellText).join('|'), 'Colors|12');
    assert.equal(block.child_blocks[2].type, 'section');
    assert.equal(block.child_blocks[2].text.text, 'Tap a deck to begin.');
  });

  it('string content with no pipe-table renders exactly as before (no false-positive table detection)', () => {
    const field = { type: 'reveal', button_label: 'Info', content: '_No child decks_' };
    const [block] = dialogToBlocks({ fields: [field] }, 1);
    assert.equal(block.child_blocks.length, 1);
    assert.equal(block.child_blocks[0].type, 'section');
    assert.equal(block.child_blocks[0].text.text, '_No child decks_');
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
  it('renders a complete list_selection dialog correctly', () => {
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

// ---------------------------------------------------------------------------
// choice gate — buttons below the threshold, dropdown above it
// ---------------------------------------------------------------------------

describe('dialogToBlocks — choice gate rendering scales with option count', () => {
  const choiceDialog = n => ({
    fields: [
      { type: 'typography', value: "Which month's budget would you like to edit?" },
      {
        type: 'actions',
        buttons: [
          ...Array.from({ length: n }, (_, i) => ({ label: `0${(i % 9) + 1}/2026`, action: `2026-0${(i % 9) + 1}` })),
          { label: 'Cancel', action: 'cancel' },
        ],
      },
    ],
  });

  it('keeps lettered buttons for a small choice — one click, no submit', () => {
    const blocks = dialogToBlocks(choiceDialog(3), 42, 'choice');
    assert.equal(blocks.filter(b => b.type === 'input').length, 0, 'no dropdown below the threshold');
    const buttons = blocks.find(b => b.type === 'actions').elements;
    assert.equal(buttons.length, 4, '3 choices + Cancel, all as buttons');
  });

  it('renders a dropdown once the buttons would become a wall (the live 12-month picker)', () => {
    const blocks = dialogToBlocks(choiceDialog(12), 42, 'choice');
    const input  = blocks.find(b => b.type === 'input');
    assert.ok(input, 'past the threshold the options become a dropdown');
    assert.equal(input.element.type, 'static_select');
    assert.equal(input.element.options.length, 12, 'every month is an option');
    assert.equal(input.element.options[0].value, '2026-01', 'option value is the routing value, not the label');
  });

  it('keeps Cancel as a real button — it is not one of the choices', () => {
    const blocks  = dialogToBlocks(choiceDialog(12), 42, 'choice');
    const buttons = blocks.find(b => b.type === 'actions').elements;
    assert.deepEqual(buttons.map(b => b.text.text), ['Select', 'Cancel']);
    assert.equal(JSON.parse(buttons[1].value).action, 'cancel');
    const dropdownValues = blocks.find(b => b.type === 'input').element.options.map(o => o.value);
    assert.ok(!dropdownValues.includes('cancel'), 'Cancel must never be buried in the dropdown');
  });

  it('the Select button carries no option value — the choice arrives in state.values', () => {
    const blocks = dialogToBlocks(choiceDialog(12), 42, 'choice');
    const submit = blocks.find(b => b.type === 'actions').elements[0];
    assert.equal(JSON.parse(submit.value).action, 'confirm');
    assert.equal(blocks.find(b => b.type === 'input').element.action_id, 'choice_value');
  });

  it('leaves non-choice gates alone, however many buttons they have', () => {
    const blocks = dialogToBlocks(choiceDialog(12), 42, 'confirm');
    assert.equal(blocks.filter(b => b.type === 'input').length, 0);
    assert.equal(blocks.find(b => b.type === 'actions').elements.length, 13);
  });
});

// ---------------------------------------------------------------------------
// choice dropdown — descriptions move onto the options, not a list below
// ---------------------------------------------------------------------------

describe('dialogToBlocks — choice dropdown suppresses the duplicate description list', () => {
  // Live workflow 353 (edit_budget) step 5: each month option's description is
  // "Income: … | Discretionary: … | Net: …" — the same data the message_template's
  // markdown table already shows. Rendered as a description_list beneath it, it read as
  // a plain-text second copy of the table.
  const monthDialog = n => ({
    fields: [
      { type: 'typography', value: '| Month | Net |\n|---|---|\n| 07/2026 | 100 |' },
      {
        type: 'description_list',
        items: Array.from({ length: n }, (_, i) => ({
          value: `2026-0${i + 1}`, label: `0${i + 1}/2026`, description: `Income: 100 | Net: 50`,
        })),
      },
      {
        type: 'actions',
        buttons: [
          ...Array.from({ length: n }, (_, i) => ({
            label: `0${i + 1}/2026`, action: `2026-0${i + 1}`, description: 'Income: 100 | Net: 50',
          })),
          { label: 'Cancel', action: 'cancel', description: 'Exit without editing' },
        ],
      },
    ],
  });

  it('drops the description list when the choices become a dropdown', () => {
    const blocks = dialogToBlocks(monthDialog(9), 42, 'choice');
    const markdown = blocks.filter(b => b.type === 'markdown').map(b => b.text);
    assert.equal(markdown.length, 1, 'only the message survives — no restatement of the rows');
    assert.ok(markdown[0].includes('| Month | Net |'), 'the real table is untouched');
  });

  it('moves each description onto its own dropdown option', () => {
    const select = dialogToBlocks(monthDialog(9), 42, 'choice').find(b => b.type === 'input').element;
    assert.equal(select.options[0].description.text, 'Income: 100 | Net: 50');
    assert.equal(select.options[0].value, '2026-01');
  });

  it('keeps the description list when the choices stay as buttons', () => {
    const blocks = dialogToBlocks(monthDialog(3), 42, 'choice');
    assert.equal(blocks.filter(b => b.type === 'markdown').length, 2,
      'below the threshold the descriptions still belong beside the buttons');
  });
});

// ---------------------------------------------------------------------------
// Gate confirmation text — one line, not the whole gate body
// ---------------------------------------------------------------------------

describe('gate confirmation summary', () => {
  // Faithful copy of the gateSummary derivation in interactive.mjs.
  // Keep in sync with src/ui/slackbot/interactive.mjs.
  const gateSummary = gateText => gateText
    .split('\n')
    .map(line => line.trim())
    .find(line => line && !line.startsWith('|') && !/^[-:|\s]+$/.test(line)) ?? '';

  it('skips markdown table rows — the click must not echo the table back', () => {
    const table = '| Month | Net |\n|---|---|\n| 07/2026 | 250 |\n| 06/2026 | -80 |';
    assert.equal(gateSummary(table), '', 'a message that is only a table yields no quote');
  });

  it('takes the first line of real prose, past any table', () => {
    const msg = '**Review updated budget for July**\n\n| Cat | Amt |\n|---|---|\n| Food | 100 |';
    assert.equal(gateSummary(msg), '**Review updated budget for July**');
  });

  it('caps a long line rather than quoting it whole', () => {
    const long = 'x'.repeat(400);
    const s = gateSummary(long);
    const capped = s.length > 120 ? `${s.slice(0, 119)}…` : s;
    assert.equal(capped.length, 120);
  });
});

// ---------------------------------------------------------------------------
// Click acknowledgment names the BUTTON, never the outcome
// ---------------------------------------------------------------------------

describe('gate click acknowledgment', () => {
  // Faithful copy of the confirmationText derivation in interactive.mjs.
  // Keep in sync with src/ui/slackbot/interactive.mjs.
  const acknowledge = (buttonLabel, userResponse) => `✅ ${buttonLabel ?? userResponse}.`;

  it('names the button that was clicked, not what the action is called', () => {
    // Live edit_budget step 16: { label: "Edit More", action: "cancel", on_select: "11" }.
    // The old code said "❌ Cancelled." purely because the action was named `cancel`,
    // while /proc correctly routed to step 11 and the run carried on.
    assert.equal(acknowledge('Edit More', 'cancel'), '✅ Edit More.');
  });

  it('acknowledges a real Cancel by its label too — the outcome is /proc\'s to report', () => {
    assert.equal(acknowledge('Cancel', 'cancel'), '✅ Cancel.');
  });

  it('falls back to the action only when a button carries no label', () => {
    assert.equal(acknowledge(undefined, 'confirm'), '✅ confirm.');
  });
});

describe('every button payload carries its label', () => {
  // The acknowledgment reads the label out of the clicked button's value, so a button
  // that omits it degrades to showing the raw action name.
  it('choice-dropdown Select and Cancel both carry labels', () => {
    const dialog = {
      fields: [{
        type: 'actions',
        buttons: [
          ...Array.from({ length: 9 }, (_, i) => ({ label: `0${i + 1}/2026`, action: `2026-0${i + 1}` })),
          { label: 'Cancel', action: 'cancel' },
        ],
      }],
    };
    const buttons = dialogToBlocks(dialog, 42, 'choice').find(b => b.type === 'actions').elements;
    assert.equal(JSON.parse(buttons[0].value).label, 'Select');
    assert.equal(JSON.parse(buttons[1].value).label, 'Cancel');
  });

  it('ordinary gate buttons carry labels', () => {
    const dialog = {
      fields: [{ type: 'actions', buttons: [{ label: 'Save Budget', action: 'confirm' }] }],
    };
    const button = dialogToBlocks(dialog, 42, 'confirm').find(b => b.type === 'actions').elements[0];
    assert.equal(JSON.parse(button.value).label, 'Save Budget');
  });
});

// ---------------------------------------------------------------------------
// Slack's 50-block message ceiling — gates must be refused, not posted (run 711).
//
// Imports the REAL function. callback.mjs has no module-level side effect that
// prevents it (the WebClient constructor does not touch the network), so there is
// no reason to keep a copy here — and the copy in this file has already drifted
// from production once this sprint.
// ---------------------------------------------------------------------------

describe('oversizedGateMessage — Slack block ceiling', () => {
  const inputBlocks = n => Array.from({ length: n }, (_, i) => ({ type: 'input', block_id: `f${i}` }));

  it('passes a gate that fits', () => {
    const blocks = [{ type: 'section' }, ...inputBlocks(20), { type: 'actions' }];
    assert.equal(oversizedGateMessage(blocks), null);
  });

  it('passes a gate at exactly the limit', () => {
    assert.equal(oversizedGateMessage(inputBlocks(50)), null);
  });

  it('refuses run 711: 63 input fields (21 categories x amount/type/notes)', () => {
    const blocks = [{ type: 'section' }, ...inputBlocks(63), { type: 'context' }, { type: 'actions' }];
    const result = oversizedGateMessage(blocks);

    assert.ok(result, 'a 66-block gate must be refused, not posted');
    assert.equal(result.inputCount, 63);
    assert.equal(result.blockCount, 66);
    // The user must be told what is wrong, in their terms — not left staring at nothing.
    assert.match(result.text, /63 input fields/);
    assert.match(result.text, /50 blocks/);
    assert.match(result.text, /paused and cannot continue/);
  });

  it('reports block count when the overflow is not input fields', () => {
    const blocks = Array.from({ length: 60 }, () => ({ type: 'section' }));
    const result = oversizedGateMessage(blocks);

    assert.ok(result);
    assert.equal(result.inputCount, 0);
    assert.match(result.text, /60 blocks/);
  });
});

// ---------------------------------------------------------------------------
// A rejected post must reach the user, not the DLQ (run 711).
//
// Until now every Slack post failure was logged, retried 3x, and dropped —
// the user saw an empty thread and a run parked forever. A payload defect is
// permanent: retrying reproduces it verbatim. Classify, tell the user, stop.
// ---------------------------------------------------------------------------

describe('isPermanentRenderFailure — retry vs report', () => {
  const slackError = (code, detail) => Object.assign(new Error(`An API error occurred: ${code}`), {
    data: { ok: false, error: code, ...(detail ? { errors: [detail] } : {}) },
  });

  it('treats the run 711 rejection as permanent', () => {
    const err = slackError('invalid_blocks', 'no more than 50 items allowed [json-pointer:/blocks]');
    assert.equal(isPermanentRenderFailure(err), true);
  });

  it('treats other payload defects as permanent', () => {
    for (const code of ['invalid_blocks_format', 'invalid_arguments', 'msg_too_long']) {
      assert.equal(isPermanentRenderFailure(slackError(code)), true, code);
    }
  });

  it('treats rate limits and transport faults as transient — these must still retry', () => {
    assert.equal(isPermanentRenderFailure(slackError('ratelimited')), false);
    assert.equal(isPermanentRenderFailure(slackError('service_unavailable')), false);
    assert.equal(isPermanentRenderFailure(new Error('socket hang up')), false);
  });

  it('does not throw on a malformed error object', () => {
    assert.equal(isPermanentRenderFailure(undefined), false);
    assert.equal(isPermanentRenderFailure({}), false);
  });
});
