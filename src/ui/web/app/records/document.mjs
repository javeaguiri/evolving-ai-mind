// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/records/document.mjs
//
// A document's edits (docs/arch-web-app.md §6.2, §6.4), pure: an entity — its root record as a
// form, each child table beneath it as a grid — edited and saved at once through
// POST /sources/{entity}/records/{id}, checked against the root's version, which moves whenever
// any part of the document does. The root is edited as one row and each child table as a grid,
// with the grid's own edits (edits.mjs). Which tables are children, and which column holds a
// child's parent, is the source's schema (GET /sources/{entity}/schema).

import { pickLabelColumn } from '../../../../shared/schema-utils.mjs';
import { noEdits, hasEdits, editProblems, writesOf, afterConflict, movedRows } from './edits.mjs';

const SYSTEM = new Set(['id', 'created_at', 'updated_at']);

/**
 * A table's columns as a document shows them: not the system's, nor a child's parent key —
 * the server sets that.
 *
 * @param {{ columns: object[], parentKey?: string }} table  SourceTable
 */
export function documentColumns(table) {
  return table.columns.filter(c => !SYSTEM.has(c.name) && c.name !== table.parentKey).map(c => ({ ...c, shown: true }));
}

/** A table's name as a heading: `PGD_RecipeSteps` → `Recipe steps`. */
export function tableLabel(name) {
  const words = String(name).replace(/^PG[CD]_/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/).filter(Boolean);
  const text  = words.join(' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** No edits to the root or any child table. */
export const noDocumentEdits = () => ({ root: noEdits(), children: {} });

export const childEdits = (edits, table) => edits.children[table] ?? noEdits();

export const withChildEdits = (edits, table, change) => ({ ...edits, children: { ...edits.children, [table]: change(childEdits(edits, table)) } });

export const hasDocumentEdits = edits => hasEdits(edits.root) || Object.values(edits.children).some(hasEdits);

/**
 * Every value that cannot be saved — the root's, and each child table's by table name.
 *
 * @param {object} schema  SourceSchema of an entity
 */
export function documentProblems(edits, schema) {
  const children = {};
  for (const child of schema.children ?? []) children[child.table] = editProblems(childEdits(edits, child.table), documentColumns(child));
  return { root: editProblems(edits.root, documentColumns(schema.table)), children };
}

export const problemCount = problems =>
  Object.keys(problems.root).length + Object.values(problems.children).reduce((n, p) => n + Object.keys(p).length, 0);

/**
 * What a save asks the server: the root's version — the document's — its changed fields, and each
 * child table's changed, new and removed rows (RowWrites), each with its own version.
 *
 * @param {{ entity: object, children: Record<string, object[]> }} doc  The document as read
 */
export function documentWrites(edits, doc, schema) {
  const root = writesOf(edits.root, [doc.entity], documentColumns(schema.table)).update?.[0]?.changes;
  const children = {};
  for (const child of schema.children ?? []) {
    const writes = writesOf(childEdits(edits, child.table), doc.children?.[child.table] ?? [], documentColumns(child));
    if (Object.keys(writes).length) children[child.table] = writes;
  }
  return {
    version: doc.entity._version,
    ...(root ? { root: { changes: root } } : {}),
    ...(Object.keys(children).length ? { children } : {}),
  };
}

/** The root fields another change moved: their values differ between two reads. */
function movedFields(before, after, columns) {
  return columns.map(c => c.name).filter(name => JSON.stringify(before?.[name] ?? null) !== JSON.stringify(after?.[name] ?? null));
}

/**
 * What a conflict leaves, once the document is read again: an edit to a root field someone else
 * changed is dropped, as is an edit to a child row that moved; every other edit is kept, to be
 * saved against the versions just read. The root is always named in a conflict — its version
 * moves with any part of the document — so its own fields are compared, not its version.
 *
 * @param {object} before   The document as it was read before
 * @param {object} after    The document read again
 * @param {{ table: string, id: number }[]} conflicts  The 409's rows
 */
export function afterDocumentConflict(edits, before, after, conflicts, schema) {
  const moved = new Set(movedFields(before.entity, after.entity, documentColumns(schema.table)));
  const rootChanges = Object.fromEntries(Object.entries(edits.root.changes).map(([id, cells]) =>
    [id, Object.fromEntries(Object.entries(cells).filter(([name]) => !moved.has(name)))]).filter(([, cells]) => Object.keys(cells).length));
  const children = {};
  for (const [table, childState] of Object.entries(edits.children)) {
    children[table] = afterConflict(childState, conflicts.filter(c => c.table === table));
  }
  return { root: { ...edits.root, changes: rootChanges }, children };
}

/**
 * What moved, as a person names it: the document by its label when its own fields changed, each
 * child row that moved by its label — an ingredient line by its ingredient. When nothing named
 * moved — another part was added — the document itself is named as changed.
 *
 * @param {Record<string, {value: string, label: string}[]>} [byTable]  A referenced table's rows as options
 * @returns {{ name: string, reason: string }[]}
 */
export function documentMoved(before, after, conflicts, schema, byTable = {}) {
  const rootColumns = documentColumns(schema.table);
  const label       = pickLabelColumn(rootColumns);
  const name        = String((label && before.entity[label]) || `#${before.entity.id}`);
  const rows = (schema.children ?? []).flatMap(child => {
    const columns = documentColumns(child);
    const options = Object.fromEntries(columns.filter(c => c.references).map(c => [c.name, byTable[c.references.table] ?? []]));
    return movedRows(conflicts.filter(c => c.table === child.table), before.children?.[child.table] ?? [], columns, options);
  });
  const root = movedFields(before.entity, after.entity, rootColumns).length ? [{ name, reason: 'changed' }] : [];
  return root.length || rows.length ? [...root, ...rows] : [{ name, reason: 'changed' }];
}
