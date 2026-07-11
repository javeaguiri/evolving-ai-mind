// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/classify-intent-crud.test.mjs
//
// Unit tests for the direct table-CRUD listing path in src/proc/classify-intent.mjs
// (`/m list <table>`). Those helpers are module-private — classify-intent.mjs
// exports only handle() — so this file keeps faithful copies, the same convention
// callback.test.mjs uses for dialogToBlocks and friends. Keep them in sync.
//
// Run: node --test tests/unit/classify-intent-crud.test.mjs

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

// ── Faithful copy of CRUD_LIST_LIMIT from classify-intent.mjs ────────────────
// Keep in sync with src/proc/classify-intent.mjs:CRUD_LIST_LIMIT
const CRUD_LIST_LIMIT = 500;

// ── Faithful copy of pickLabelColumn from classify-intent.mjs ───────────────
// Keep in sync with src/proc/classify-intent.mjs:pickLabelColumn
function pickLabelColumn(columns = []) {
  const byName = new Set(columns.map(c => c.name));
  if (byName.has('name'))  return 'name';
  if (byName.has('title')) return 'title';

  const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at']);
  const UNREADABLE     = new Set(['jsonb', 'json', 'vector', 'bytea']);
  const candidate = columns.find(c =>
    !SYSTEM_COLUMNS.has(c.name)
    && !/embedding/i.test(c.name)
    && !UNREADABLE.has(String(c.type).toLowerCase())
  );
  return candidate?.name ?? null;
}

// ── Faithful copy of formatTableCrudResult's serv_query branch ──────────────
// Keep in sync with src/proc/classify-intent.mjs:formatTableCrudResult
function formatQueryResult(tableName, output, labelColumn = null) {
  const rows = Array.isArray(output) ? output : [];
  if (rows.length === 0) return `No rows found in \`${tableName}\`.`;

  const listing = rows
    .map((r, i) => `${i + 1}. ${(labelColumn ? r[labelColumn] : null) ?? r.id} (id: ${r.id})`)
    .join('\n');

  const heading = rows.length >= CRUD_LIST_LIMIT
    ? `Showing the first ${CRUD_LIST_LIMIT} rows in \`${tableName}\` — there may be more. Add a filter to narrow the list.`
    : `Found ${rows.length} row${rows.length !== 1 ? 's' : ''} in \`${tableName}\`:`;

  return `${heading}\n${listing}`;
}

describe('pickLabelColumn', () => {
  it('prefers name, then title', () => {
    assert.equal(pickLabelColumn([{ name: 'title', type: 'text' }, { name: 'name', type: 'text' }]), 'name');
    assert.equal(pickLabelColumn([{ name: 'description', type: 'text' }, { name: 'title', type: 'text' }]), 'title');
  });

  it('skips system columns, embeddings, and unreadable types', () => {
    const columns = [
      { name: 'id',              type: 'serial' },
      { name: 'created_at',      type: 'timestamptz' },
      { name: 'intent_embedding', type: 'vector' },
      { name: 'steps',           type: 'jsonb' },
      { name: 'table_name',      type: 'text' },
    ];
    assert.equal(pickLabelColumn(columns), 'table_name',
      'a jsonb/vector/system column must never be chosen as a display label');
  });

  it('returns null when nothing is readable — the listing falls back to ids', () => {
    assert.equal(pickLabelColumn([{ name: 'id', type: 'serial' }, { name: 'payload', type: 'jsonb' }]), null);
    assert.equal(pickLabelColumn([]), null);
  });
});

describe('formatTableCrudResult — serv_query listing', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `row ${i + 1}` }));

  it('lists every row — the former 10-row slice is gone', () => {
    const out = formatQueryResult('PGC_Workflow', rows(14), 'name');
    assert.ok(out.includes('Found 14 rows'));
    assert.ok(out.includes('14. row 14 (id: 14)'), 'the 14th row must be listed, not discarded');
    assert.ok(!out.includes('and 4 more'), 'no truncation notice below the ceiling');
  });

  it('reports honestly when the 500-row ceiling is reached', () => {
    const out = formatQueryResult('PGC_SessionEntry', rows(CRUD_LIST_LIMIT), 'name');
    assert.ok(out.includes(`Showing the first ${CRUD_LIST_LIMIT} rows`),
      'must not report a truncated count as if it were the total');
    assert.ok(out.includes('there may be more'));
  });

  it('falls back to the id when the row has no label column', () => {
    const out = formatQueryResult('PGC_Thing', [{ id: 7 }], null);
    assert.ok(out.includes('1. 7 (id: 7)'));
  });

  it('reports an empty table plainly', () => {
    assert.equal(formatQueryResult('PGD_Empty', [], 'name'), 'No rows found in `PGD_Empty`.');
  });
});
