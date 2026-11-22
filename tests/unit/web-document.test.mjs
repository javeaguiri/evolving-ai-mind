// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/web-document.test.mjs
//
// A records panel's document view (Sprint 19 item 7; docs/arch-web-app.md §6.2, §6.4): an entity's
// root as a form and its child tables as grids, saved at once against the root's version — what a
// save asks, what a conflict leaves and how it is named — and a panel's error kept in its frame.
// The entity here is invented: a box, its items and its notes.

import { describe, it, before } from 'node:test';
import assert                   from 'node:assert/strict';
import * as esbuild             from 'esbuild';

import { tableLabel } from '../../src/shared/schema-utils.mjs';
import { documentColumns, noDocumentEdits, childEdits, withChildEdits, hasDocumentEdits, documentProblems,
         problemCount, documentWrites, afterDocumentConflict, documentMoved } from '../../src/ui/web/app/records/document.mjs';
import { setCell, addRow, setAddedCell, toggleRemoved } from '../../src/ui/web/app/records/edits.mjs';

const APP_DIR = new URL('../../src/ui/web/app/', import.meta.url).pathname;
const V1 = '2026-11-21 09:31:10.551203+00';
const V2 = '2026-11-22 09:20:41.004113+00';

const col = (name, type, extra = {}) => ({ name, type, label: name[0].toUpperCase() + name.slice(1).replace(/_/g, ' '), labelFallback: true, nullable: true, editable: false, ...extra });
const SYS = [col('id', 'serial', { nullable: false }), col('created_at', 'timestamptz'), col('updated_at', 'timestamptz')];
const SCHEMA = {
  source: 'Box', kind: 'entity', domain: 'stuff',
  table: { table: 'PGD_Boxes', versioned: true, addRows: false, deleteRows: false, columns: [
    ...SYS, col('label', 'varchar', { editable: true, nullable: false }), col('notes', 'text', { editable: true }),
    col('size', 'integer', { editable: true }), col('shelf_id', 'integer', { editable: true, references: { table: 'PGD_Shelves', column: 'id' } }),
    col('origin', 'varchar'),
  ] },
  children: [
    { table: 'PGD_BoxItems', versioned: true, addRows: true, deleteRows: true, parentKey: 'box_id', columns: [
      ...SYS, col('box_id', 'integer'), col('thing_id', 'integer', { editable: true, nullable: false, references: { table: 'PGD_Things', column: 'id' } }),
      col('count', 'numeric', { editable: true }),
    ] },
    { table: 'PGD_BoxNotes', versioned: true, addRows: true, deleteRows: false, parentKey: 'box_id', columns: [
      ...SYS, col('box_id', 'integer'), col('position', 'integer', { editable: true }), col('text', 'text', { editable: true }),
    ] },
  ],
};
const DOC = {
  entity: { id: 7, label: 'Winter', notes: 'Coats', size: 3, shelf_id: 2, origin: 'attic', _version: V1 },
  children: {
    PGD_BoxItems: [{ id: 14, box_id: 7, thing_id: 9, count: '2', _version: V1 }, { id: 15, box_id: 7, thing_id: 4, count: '1', _version: V1 }],
    PGD_BoxNotes: [{ id: 31, box_id: 7, position: 1, text: 'Fragile', _version: V1 }],
  },
};
const rootCol  = name => documentColumns(SCHEMA.table).find(c => c.name === name);
const itemCol  = name => documentColumns(SCHEMA.children[0]).find(c => c.name === name);

describe('the document\'s shape', () => {
  it('documentColumns: not the system\'s columns, nor a child\'s parent key', () => {
    assert.deepEqual(documentColumns(SCHEMA.table).map(c => c.name), ['label', 'notes', 'size', 'shelf_id', 'origin']);
    assert.deepEqual(documentColumns(SCHEMA.children[0]).map(c => c.name), ['thing_id', 'count']);
  });
  it('tableLabel: a table\'s name as a heading', () => {
    assert.deepEqual(['PGD_BoxItems', 'PGD_RecipeSteps', 'PGD_Inventory'].map(tableLabel), ['Box items', 'Recipe steps', 'Inventory']);
  });
});

describe('what a save asks', () => {
  it('the root\'s version, its changed fields, and each child table\'s rows with their own versions', () => {
    let e = { ...noDocumentEdits(), root: setCell(noDocumentEdits().root, DOC.entity, rootCol('size'), '4') };
    e = withChildEdits(e, 'PGD_BoxItems', c => toggleRemoved(setCell(c, DOC.children.PGD_BoxItems[0], itemCol('count'), '2,5'), 15));
    e = withChildEdits(e, 'PGD_BoxNotes', c => setAddedCell(addRow(c, 'new-1'), 'new-1', documentColumns(SCHEMA.children[1])[1], 'Keep dry '));
    assert.equal(hasDocumentEdits(e), true);
    assert.deepEqual(documentWrites(e, DOC, SCHEMA), {
      version: V1,
      root: { changes: { size: 4 } },
      children: {
        PGD_BoxItems: { update: [{ id: 14, version: V1, changes: { count: 2.5 } }], delete: [{ id: 15, version: V1 }] },
        PGD_BoxNotes: { insert: [{ text: 'Keep dry' }] },
      },
    });
  });
  it('a save of children only sends the root\'s version and nothing of its fields', () => {
    const e = withChildEdits(noDocumentEdits(), 'PGD_BoxItems', c => setCell(c, DOC.children.PGD_BoxItems[1], itemCol('count'), '3'));
    const body = documentWrites(e, DOC, SCHEMA);
    assert.deepEqual([body.version, 'root' in body, Object.keys(body.children)], [V1, false, ['PGD_BoxItems']]);
  });
  it('documentProblems: the root\'s and each child\'s, counted together', () => {
    let e = { ...noDocumentEdits(), root: setCell(noDocumentEdits().root, DOC.entity, rootCol('label'), '') };
    e = withChildEdits(e, 'PGD_BoxItems', c => addRow(c, 'new-1'));
    const problems = documentProblems(e, SCHEMA);
    assert.deepEqual(problems.root, { '7:label': 'is required' });
    assert.deepEqual(problems.children.PGD_BoxItems, { 'new-1:thing_id': 'is required' });
    assert.equal(problemCount(problems), 2);
  });
});

describe('a conflict', () => {
  const AFTER = {
    entity: { ...DOC.entity, notes: 'Coats and hats', _version: V2 },
    children: { ...DOC.children, PGD_BoxItems: [{ ...DOC.children.PGD_BoxItems[0], count: '5', _version: V2 }, DOC.children.PGD_BoxItems[1]] },
  };
  const conflicts = [{ table: 'PGD_Boxes', id: 7, reason: 'changed' }, { table: 'PGD_BoxItems', id: 14, reason: 'changed' }];

  it('an edit to a root field someone else changed is dropped; the root\'s other edits and the other rows\' are kept', () => {
    let e = { ...noDocumentEdits(), root: setCell(setCell(noDocumentEdits().root, DOC.entity, rootCol('notes'), 'Mine'), DOC.entity, rootCol('size'), '9') };
    e = withChildEdits(e, 'PGD_BoxItems', c => setCell(setCell(c, DOC.children.PGD_BoxItems[0], itemCol('count'), '1'), DOC.children.PGD_BoxItems[1], itemCol('count'), '6'));
    const left = afterDocumentConflict(e, DOC, AFTER, conflicts, SCHEMA);
    assert.deepEqual(left.root.changes, { 7: { size: '9' } });
    assert.deepEqual(childEdits(left, 'PGD_BoxItems').changes, { 15: { count: '6' } });
  });

  it('named: the document by its label when its fields moved, and a child row by the row its key names — never its id', () => {
    assert.deepEqual(documentMoved(DOC, AFTER, conflicts, SCHEMA, { PGD_Things: [{ value: '9', label: 'Hammer' }] }),
      [{ name: 'Winter', reason: 'changed' }, { name: 'Hammer', reason: 'changed' }]);
    assert.deepEqual(documentMoved(DOC, AFTER, conflicts, SCHEMA)[1], { name: '#14', reason: 'changed' }, 'without its options, the row\'s own id');
  });

  it('when only the root\'s version moved — a part was added elsewhere — the document is named', () => {
    const after = { ...DOC, entity: { ...DOC.entity, _version: V2 } };
    assert.deepEqual(documentMoved(DOC, after, [{ table: 'PGD_Boxes', id: 7, reason: 'changed' }], SCHEMA), [{ name: 'Winter', reason: 'changed' }]);
  });
});

describe('drawn', () => {
  let ui;
  before(async () => {
    const out = await esbuild.build({
      stdin: {
        contents: `export { renderToString } from 'react-dom/server';
                   export { RootForm, DocumentView } from './records/DocumentView.jsx';
                   export { PanelBoundary } from './panels/PanelBoundary.jsx';
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
  const where = { locale: 'en', timeZone: 'Europe/Madrid' };

  it('the root form: an open field its control — text a text area, a key a drop-down by label — the rest as read', () => {
    const html = ui.renderToString(ui.createElement(ui.RootForm, {
      columns: documentColumns(SCHEMA.table), entity: DOC.entity, edits: noDocumentEdits().root, problems: {}, where,
      options: { shelf_id: [{ value: '2', label: 'Top shelf' }] }, onCell() {},
    }));
    assert.match(html, /<input[^>]*name="root-label"[^>]*value="Winter"/);
    assert.match(html, /<textarea[^>]*name="root-notes"[^>]*>Coats<\/textarea>/);
    assert.match(html, /<select[^>]*name="root-shelf_id"[^>]*>.*<option value="2" selected="">Top shelf<\/option>/);
    assert.match(html, /<span class="flabel">Origin<\/span><span>attic<\/span>/);
    assert.doesNotMatch(html, /root-origin|root-id|Updated at/);
  });

  it('a changed root field is marked', () => {
    const edits = setCell(noDocumentEdits().root, DOC.entity, rootCol('size'), '4');
    const html  = ui.renderToString(ui.createElement(ui.RootForm, {
      columns: documentColumns(SCHEMA.table), entity: DOC.entity, edits, problems: {}, where, options: {}, onCell() {},
    }));
    assert.match(html, /<div class="changed"><div class="fld"><label for="f-root-size"/);
  });

  it('the document view opens on its picker, named by the root table, while its records are read', () => {
    const html = ui.renderToString(ui.createElement(ui.DocumentView, {
      api: { get: () => new Promise(() => {}) }, source: 'Box', schema: SCHEMA, where, onSignInRequired() {}, onNotice() {},
    }));
    assert.match(html, /<span class="flabel">Boxes<\/span><select[^>]*disabled=""[^>]*><option value="" selected="">Loading/);
  });

  it('a panel that fails keeps its error in its frame', () => {
    const boundary = new ui.PanelBoundary({ title: 'Stock', width: '1/2' });
    boundary.state = ui.PanelBoundary.getDerivedStateFromError(new TypeError('x.map is not a function'));
    const html = ui.renderToString(boundary.render());
    assert.match(html, /<section class="panel w-half" aria-label="Stock">/);
    assert.match(html, /This panel ran into a problem:(<!-- -->)? <code>x\.map is not a function<\/code>/);
    assert.match(html, /Try again/);
  });
});
