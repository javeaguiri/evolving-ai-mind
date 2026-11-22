// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/web-records-edit.test.mjs
//
// A records panel's grid in edit mode (Sprint 19 item 6; docs/arch-web-app.md §6.1, §6.4): which
// cells take an editor, the edits as they stand, what they ask POST /sources/{table}/rows, what a
// save or a conflict leaves — pure — and the grid, its notices and a foreign key's label drawn.

import { describe, it, before } from 'node:test';
import assert                   from 'node:assert/strict';
import * as esbuild             from 'esbuild';

import { editorFor, editsInGrid, withSchema, canEdit, cellText, readCell, noEdits, hasEdits, setCell, addRow, setAddedCell,
         dropAdded, toggleRemoved, editProblems, writesOf, applySaved, afterConflict, movedRows, referenceOptions } from '../../src/ui/web/app/records/edits.mjs';
import { rowsRequest } from '../../src/ui/web/app/records/query.mjs';
import { ApiError }    from '../../src/ui/web/app/api/client.mjs';

const APP_DIR = new URL('../../src/ui/web/app/', import.meta.url).pathname;
const V1 = '2026-11-21 10:02:11.120391+00';
const V2 = '2026-11-22 09:14:03.551210+00';

const COLUMNS = withSchema([
  { name: 'id', type: 'serial', label: 'Id' },
  { name: 'day', type: 'date', label: 'Day' },
  { name: 'title', type: 'varchar', label: 'Title' },
  { name: 'amount', type: 'numeric', label: 'Amount' },
  { name: 'count', type: 'integer', label: 'Count' },
  { name: 'kind_id', type: 'integer', label: 'Kind' },
  { name: 'done', type: 'boolean', label: 'Done' },
  { name: 'stamp', type: 'timestamptz', label: 'Stamp' },
], { columns: [
  { name: 'id', nullable: false, editable: false },
  { name: 'day', nullable: false, editable: true },
  { name: 'title', nullable: false, editable: true },
  { name: 'amount', nullable: true, editable: true },
  { name: 'count', nullable: true, editable: true },
  { name: 'kind_id', nullable: true, editable: true, references: { table: 'PGD_Kinds', column: 'id' } },
  { name: 'done', nullable: true, editable: true },
  { name: 'stamp', nullable: true, editable: true },
] });
const by = name => COLUMNS.find(c => c.name === name);
const ROWS = [
  { id: 1, day: '2026-11-20T00:00:00.000Z', title: 'Shop A', amount: '30.10', count: 2, kind_id: 8, done: false, stamp: null, _version: V1 },
  { id: 2, day: '2026-11-21T00:00:00.000Z', title: 'Shop B', amount: '5.00',  count: 1, kind_id: null, done: true, stamp: null, _version: V1 },
];

describe('which cells take an editor', () => {
  it('by type: a foreign key a select, never a typed id; numbers, dates, text; timestamps not in the grid', () => {
    assert.deepEqual(['kind_id', 'done', 'count', 'amount', 'day', 'title', 'stamp'].map(n => editorFor(by(n))), [
      { input_type: 'select' }, { input_type: 'select' }, { input_type: 'number', decimal: false }, { input_type: 'number', decimal: true },
      { input_type: 'date' }, { input_type: 'text' }, null,
    ]);
  });
  it('only what the policy opens, and the grid can edit', () => {
    assert.deepEqual(COLUMNS.filter(editsInGrid).map(c => c.name), ['day', 'title', 'amount', 'count', 'kind_id', 'done']);
  });
  it('withSchema: a column the schema does not name is read-only', () => {
    assert.deepEqual(withSchema([{ name: 'x', type: 'text' }], { columns: [] })[0], { name: 'x', type: 'text', editable: false, nullable: true });
  });
  it('canEdit: a versioned table opening something the panel shows; never a view or entity', () => {
    const table = { versioned: true, addRows: false, deleteRows: false };
    assert.equal(canEdit({ kind: 'table', table }, [by('title')]), true);
    assert.equal(canEdit({ kind: 'table', table }, [by('id'), by('stamp')]), false);
    assert.equal(canEdit({ kind: 'table', table: { ...table, addRows: true } }, []), true);
    assert.equal(canEdit({ kind: 'table', table: { ...table, versioned: false } }, [by('title')]), false);
    assert.equal(canEdit({ kind: 'entity', table }, [by('title')]), false);
    assert.equal(canEdit(null, [by('title')]), false);
  });
});

describe('a cell, as text and as saved', () => {
  it('cellText: a date as its day, null empty', () => {
    assert.deepEqual([cellText(ROWS[0].day, by('day')), cellText(null, by('amount')), cellText(8, by('kind_id'))], ['2026-11-20', '', '8']);
  });
  it('readCell: a decimal comma read; a whole number required where the type is integer', () => {
    assert.deepEqual(readCell('31,20', by('amount')), { value: 31.2 });
    assert.deepEqual(readCell('2.5', by('count')), { problem: 'must be a whole number' });
    assert.deepEqual(readCell('abc', by('amount')), { problem: 'must be a number' });
  });
  it('readCell: empty is null where allowed, required where not', () => {
    assert.deepEqual(readCell('  ', by('amount')), { value: null });
    assert.deepEqual(readCell('', by('title')), { problem: 'is required' });
  });
  it('readCell: a foreign key as its id, a boolean, a date', () => {
    assert.deepEqual([readCell('9', by('kind_id')), readCell('true', by('done')), readCell('2026-12-01', by('day')), readCell('1/12', by('day'))],
      [{ value: 9 }, { value: true }, { value: '2026-12-01' }, { problem: 'must be a date' }]);
  });
});

describe('the edits', () => {
  it('setCell: a cell set back to what was read is no longer changed, nor its row', () => {
    let e = setCell(noEdits(), ROWS[0], by('amount'), '31');
    assert.deepEqual(e.changes, { 1: { amount: '31' } });
    assert.equal(hasEdits(e), true);
    e = setCell(e, ROWS[0], by('amount'), '30.10');
    assert.deepEqual(e.changes, {});
    assert.equal(hasEdits(e), false);
  });
  it('new rows first; one dropped; a row removed and put back', () => {
    let e = addRow(addRow(noEdits(), 'new-1'), 'new-2');
    assert.deepEqual(e.added.map(a => a.key), ['new-2', 'new-1']);
    e = dropAdded(setAddedCell(e, 'new-1', by('title'), 'x'), 'new-2');
    assert.deepEqual(e.added, [{ key: 'new-1', cells: { title: 'x' } }]);
    assert.deepEqual(toggleRemoved(toggleRemoved(noEdits(), 2), 2).removed, []);
  });
  it('editProblems: changed cells, and every editable cell of a new row; a removed row is not checked', () => {
    let e = setCell(noEdits(), ROWS[0], by('count'), '1.5');
    e = setCell(e, ROWS[1], by('title'), '');
    e = toggleRemoved(e, 2);
    e = setAddedCell(addRow(e, 'new-1'), 'new-1', by('amount'), '4');
    assert.deepEqual(editProblems(e, COLUMNS), { '1:count': 'must be a whole number', 'new-1:day': 'is required', 'new-1:title': 'is required' });
  });
});

describe('what a save asks, and what it leaves', () => {
  it('writesOf: changed rows with their version, new rows with the cells given, removed rows with their version', () => {
    let e = setCell(noEdits(), ROWS[0], by('amount'), '31,2');
    e = setCell(e, ROWS[0], by('kind_id'), '');
    e = toggleRemoved(setCell(e, ROWS[1], by('title'), 'gone anyway'), 2);
    e = setAddedCell(setAddedCell(addRow(e, 'new-1'), 'new-1', by('title'), 'Shop C'), 'new-1', by('amount'), ' ');
    assert.deepEqual(writesOf(e, ROWS, COLUMNS), {
      update: [{ id: 1, version: V1, changes: { amount: 31.2, kind_id: null } }],
      insert: [{ title: 'Shop C' }],
      delete: [{ id: 2, version: V1 }],
    });
  });
  it('writesOf: nothing asked of a row no longer read', () => {
    const e = toggleRemoved(setCell(noEdits(), ROWS[0], by('title'), 'x'), 2);
    assert.deepEqual(writesOf(e, [], COLUMNS), {});
  });
  it('applySaved: changed rows replaced with their new version, new rows first, removed rows gone', () => {
    const rows = applySaved(ROWS, { updated: [{ id: 1, amount: '31.20', _version: V2 }], inserted: [{ id: 3, title: 'Shop C', _version: V2 }], deleted: [2] });
    assert.deepEqual(rows.map(r => [r.id, r._version]), [[3, V2], [1, V2]]);
    assert.equal(rows[1].title, 'Shop A');
  });
  it('afterConflict: edits to rows that moved dropped, the rest and new rows kept', () => {
    let e = setCell(setCell(noEdits(), ROWS[0], by('title'), 'a'), ROWS[1], by('title'), 'b');
    e = addRow(toggleRemoved(e, 2), 'new-1');
    const left = afterConflict(e, [{ table: 'PGD_X', id: 2, reason: 'changed' }]);
    assert.deepEqual([left.changes, left.removed, left.added.length], [{ 1: { title: 'a' } }, [], 1]);
  });
  it('movedRows: named by the label column, else the id', () => {
    assert.deepEqual(movedRows([{ id: 1, reason: 'changed' }, { id: 9, reason: 'deleted' }], ROWS, COLUMNS),
      [{ name: 'Shop A', reason: 'changed' }, { name: '#9', reason: 'deleted' }]);
  });
  it('referenceOptions: by id, labelled by the label column, in label order', () => {
    const body = { columns: [{ name: 'id', type: 'serial' }, { name: 'name', type: 'varchar' }], rows: [{ id: 8, name: 'Travel' }, { id: 3, name: 'Food' }] };
    assert.deepEqual(referenceOptions(body, 'en'), [{ value: '3', label: 'Food' }, { value: '8', label: 'Travel' }]);
  });
  it('rowsRequest asks for versions only while editing', () => {
    assert.equal(rowsRequest({ source: 'PGD_X' }, 0, true).query.with_version, 'true');
    assert.ok(!('with_version' in rowsRequest({ source: 'PGD_X' }).query));
  });
  it('ApiError keeps a conflict\'s rows', () => {
    assert.deepEqual(new ApiError(409, 'version_conflict', 'm', undefined, [{ id: 1 }]).conflicts, [{ id: 1 }]);
  });
});

describe('drawn', () => {
  let ui;
  before(async () => {
    const out = await esbuild.build({
      stdin: {
        contents: `export { renderToString } from 'react-dom/server';
                   export { RecordsBody, EditNotice } from './panels/RecordsPanel.jsx';
                   export { EditGrid } from './records/EditGrid.jsx';
                   export { initI18n } from './i18n.mjs';
                   export { createElement } from 'react';`,
        resolveDir: APP_DIR, loader: 'jsx',
      },
      bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', write: false, logLevel: 'silent',
      banner: { js: `import { createRequire } from 'module'; const require = createRequire(${JSON.stringify(APP_DIR)});` },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    ui = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString('base64')}`);
    await ui.initI18n('en');
  });

  const where   = { locale: 'en', timeZone: 'Europe/Madrid' };
  const options = { kind_id: [{ value: '8', label: 'Travel' }] };
  const shown   = ['title', 'amount', 'kind_id', 'stamp'].map(by);
  const grid    = (edits, extra = {}) => ui.renderToString(ui.createElement(ui.EditGrid, {
    columns: shown, rows: ROWS, edits, problems: {}, options, allow: { addRows: true, deleteRows: true }, where,
    onCell() {}, onAddedCell() {}, onRemove() {}, onDropAdded() {}, ...extra,
  }));

  it('an editable cell is an input; a foreign key a select of its rows by label; the rest shown as read', () => {
    const html = grid(noEdits());
    assert.match(html, /<input[^>]*name="1-title"[^>]*value="Shop A"/);
    assert.match(html, /<select[^>]*name="1-kind_id"[^>]*><option value="">[^<]*<\/option><option value="8" selected="">Travel<\/option><\/select>/);
    assert.doesNotMatch(html, /name="1-stamp"/);
  });

  it('a changed cell is marked, a problem too; a new row first; a removed row struck, with its undo', () => {
    let e = setCell(noEdits(), ROWS[0], by('title'), 'Shop Z');
    e = addRow(toggleRemoved(e, 2), 'new-1');
    const html = grid(e, { problems: { 'new-1:title': 'is required' } });
    assert.match(html, /<td class="changed"><input[^>]*value="Shop Z"/);
    assert.match(html, /<tr class="new"><td class="bad">/);
    assert.match(html, /<tr class="removed">/);
    assert.match(html, /aria-label="Keep #2"[^>]*>↺</);
    assert.ok(html.indexOf('new-1-title') < html.indexOf('1-title"'));
  });

  it('without delete, no remove control on a read row', () => {
    assert.doesNotMatch(grid(noEdits(), { allow: { addRows: false, deleteRows: false } }), /Remove #1/);
  });

  it('view mode shows a foreign key by the label of the row it names', () => {
    const html = ui.renderToString(ui.createElement(ui.RecordsBody, {
      config: { source: 'PGD_X', columns: ['title', 'kind_id'] }, view: 'grid', where, onOpen() {}, options,
      body: { columns: [{ name: 'title', type: 'varchar', label: 'Title' }, { name: 'kind_id', type: 'integer', label: 'Kind' }], rows: ROWS, more: false },
    }));
    assert.match(html, /<th scope="col">Title<\/th><th scope="col">Kind<\/th>/);
    assert.match(html, /<td>Shop A<\/td><td>Travel<\/td>/);
    assert.match(html, /<td>Shop B<\/td><td><\/td>/);
  });

  for (const [notice, pattern] of [
    [{ kind: 'saved' }, /role="status">Saved\./],
    [{ kind: 'moved', rows: [{ name: 'Shop A', reason: 'changed' }, { name: '#9', reason: 'deleted' }] }, /role="alert">Not saved — changed by someone else since you opened it: Shop A was changed; #9 was deleted\./],
    [{ kind: 'refused', fields: [{ name: 'PGD_X.title', problem: 'column_not_editable' }, { name: 'PGD_X', problem: 'add_rows' }] }, /PGD_X\.title can’t be edited; rows can’t be added to PGD_X/],
    [{ kind: 'invalid', message: 'update[0].version must be…' }, /Couldn’t save: update\[0\]\.version must be…/],
    [{ kind: 'failed' }, /Couldn’t save — try again\./],
  ]) {
    it(`a notice: ${notice.kind}`, () => {
      assert.match(ui.renderToString(ui.createElement(ui.EditNotice, { notice, onClose() {} })), pattern);
    });
  }
});
