// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/records/edits.mjs
//
// A grid's edits (docs/arch-web-app.md §6.1, §6.4), pure: which cells take an editor and which,
// the edits as they stand — changed cells, new rows, removed rows — what they ask the server
// (`POST /sources/{table}/rows`, each changed or removed row with the version it was read at),
// and what a save or a conflict leaves. A cell is edited as text and read by its column's type
// only when saved — a number through the shared number rule, so a decimal comma is read. Whether
// a column is editable is the edit policy's answer, from GET /sources/{source}/schema; the server
// checks it again.

import { numberRule, readNumber } from '../../../../shared/number-rule.mjs';
import { pickLabelColumn }        from '../../../../shared/schema-utils.mjs';

const typeOf  = column => String(column.type ?? '').toLowerCase();
const INTEGER = /^(integer|int[248]?|smallint|bigint|serial|bigserial)\b/;
const DECIMAL = /^(numeric|decimal|real|double precision|float[48]?)\b/;
const TEXT    = /^(text|varchar|character varying|char|character)\b/;

/**
 * The input a cell is edited with — a form field's input_type (gates/Input.jsx) — or null when
 * the grid does not edit this type (timestamps, jsonb, arrays). A foreign key is a select of the
 * referenced rows, never a typed id.
 *
 * @param {{ type: string, references?: object }} column
 * @returns {{ input_type: string, decimal?: boolean } | null}
 */
export function editorFor(column) {
  const type = typeOf(column);
  if (column.references) return { input_type: 'select' };
  if (type === 'boolean')  return { input_type: 'select' };
  if (INTEGER.test(type))  return { input_type: 'number', decimal: false };
  if (DECIMAL.test(type))  return { input_type: 'number', decimal: true };
  if (type === 'date')     return { input_type: 'date' };
  if (TEXT.test(type))     return { input_type: 'text' };
  return null;
}

/** The policy opens it and the grid has an editor for it. */
export const editsInGrid = column => column.editable === true && editorFor(column) !== null;

/**
 * The columns read, each with what the source's schema says of it: `editable`, `references`,
 * `nullable`. A column the schema does not name is read-only.
 *
 * @param {object[]} columns       mergeColumns' result
 * @param {object|null} table      GET …/schema's `table`
 */
export function withSchema(columns, table) {
  const byName = new Map((table?.columns ?? []).map(c => [c.name, c]));
  return columns.map(c => {
    const s = byName.get(c.name);
    return { ...c, editable: s?.editable === true, nullable: s ? s.nullable : true, ...(s?.references ? { references: s.references } : {}) };
  });
}

/**
 * Whether a panel offers Edit: a table with versions that opens a column the panel shows, or
 * lets rows be added or removed.
 */
export function canEdit(schema, shown) {
  const table = schema?.table;
  if (schema?.kind !== 'table' || !table?.versioned) return false;
  return table.addRows || table.deleteRows || shown.some(editsInGrid);
}

/** A cell's value as the text its editor holds. */
export function cellText(value, column) {
  if (value === null || value === undefined) return '';
  if (typeOf(column) === 'date') return String(value).slice(0, 10);
  return String(value);
}

/**
 * A cell's text read as the value saved, or the problem with it. Empty is null where the column
 * allows it. Text is saved without its leading and trailing spaces, as a form input is — a code
 * typed `EUR ` is `EUR`.
 *
 * @returns {{ value: any } | { problem: string }}
 */
export function readCell(text, column) {
  const raw = String(text ?? '');
  if (raw.trim() === '') return column.nullable === false ? { problem: 'is required' } : { value: null };
  const type = typeOf(column);
  if (column.references) return { value: Number(raw) };
  if (type === 'boolean') return { value: raw === 'true' };
  const editor = editorFor(column);
  if (editor?.input_type === 'number') {
    const read = readNumber(raw, numberRule({ decimal: editor.decimal }));
    return read.problem ? { problem: read.problem } : { value: read.value };
  }
  if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? { value: raw.trim() } : { problem: 'must be a date' };
  return { value: raw.trim() };
}

/** No edits: nothing changed, added or removed. */
export const noEdits = () => ({ changes: {}, added: [], removed: [] });

export const hasEdits = edits =>
  Object.keys(edits.changes).length > 0 || edits.added.length > 0 || edits.removed.length > 0;

/**
 * A row's cell set to `text`. Set back to the text it was read with, the cell is no longer
 * changed, and a row with no changed cell is no longer changed either.
 */
export function setCell(edits, row, column, text) {
  const changes = { ...edits.changes };
  const cells   = { ...(changes[row.id] ?? {}) };
  if (text === cellText(row[column.name], column)) delete cells[column.name];
  else cells[column.name] = text;
  if (Object.keys(cells).length) changes[row.id] = cells; else delete changes[row.id];
  return { ...edits, changes };
}

/** A new row, empty, first in the grid. `key` names it until it is saved. */
export const addRow = (edits, key) => ({ ...edits, added: [{ key, cells: {} }, ...edits.added] });

export const setAddedCell = (edits, key, column, text) => ({
  ...edits, added: edits.added.map(a => (a.key === key ? { ...a, cells: { ...a.cells, [column.name]: text } } : a)),
});

export const dropAdded = (edits, key) => ({ ...edits, added: edits.added.filter(a => a.key !== key) });

/** A row marked for removal, or unmarked. */
export function toggleRemoved(edits, id) {
  return { ...edits, removed: edits.removed.includes(id) ? edits.removed.filter(r => r !== id) : [...edits.removed, id] };
}

/**
 * Every cell whose text cannot be saved, by `<row id or new key>:<column>`. A removed row is not
 * checked. A new row is checked in every column it can edit: one left empty is required where the
 * column is.
 *
 * @param {object[]} columns  The grid's columns, withSchema's
 */
export function editProblems(edits, columns) {
  const byName   = new Map(columns.map(c => [c.name, c]));
  const problems = {};
  for (const [id, cells] of Object.entries(edits.changes)) {
    if (edits.removed.includes(Number(id))) continue;
    for (const [name, text] of Object.entries(cells)) {
      const read = readCell(text, byName.get(name));
      if (read.problem) problems[`${id}:${name}`] = read.problem;
    }
  }
  for (const added of edits.added) {
    for (const column of columns.filter(editsInGrid)) {
      const read = readCell(added.cells[column.name] ?? '', column);
      if (read.problem) problems[`${added.key}:${column.name}`] = read.problem;
    }
  }
  return problems;
}

/**
 * What the edits ask the server — RowWrites. A changed row carries the version it was read at,
 * as a removed one does; a row both changed and removed is removed. A new row sends the cells
 * given, an empty one left to the table's default. An edit to a row no longer read — gone from
 * the rows read again after a conflict — has no version to send, and is not sent.
 *
 * @param {object[]} rows     The rows read, each with `_version`
 * @param {object[]} columns  The grid's columns
 */
export function writesOf(edits, rows, columns) {
  const byName = new Map(columns.map(c => [c.name, c]));
  const byId   = new Map(rows.map(r => [r.id, r]));
  const update = Object.entries(edits.changes)
    .filter(([id]) => byId.has(Number(id)) && !edits.removed.includes(Number(id)))
    .map(([id, cells]) => ({
      id: Number(id), version: byId.get(Number(id))._version,
      changes: Object.fromEntries(Object.entries(cells).map(([name, text]) => [name, readCell(text, byName.get(name)).value])),
    }));
  const insert = edits.added.map(a => Object.fromEntries(Object.entries(a.cells)
    .filter(([, text]) => String(text).trim() !== '')
    .map(([name, text]) => [name, readCell(text, byName.get(name)).value])));
  const remove = edits.removed.filter(id => byId.has(id)).map(id => ({ id, version: byId.get(id)._version }));
  return {
    ...(update.length ? { update } : {}),
    ...(insert.length ? { insert } : {}),
    ...(remove.length ? { delete: remove } : {}),
  };
}

/** The rows after a save: changed rows replaced, new rows first, removed rows gone. */
export function applySaved(rows, result) {
  const updated = new Map((result.updated ?? []).map(r => [r.id, r]));
  const deleted = new Set(result.deleted ?? []);
  return [...(result.inserted ?? []), ...rows.filter(r => !deleted.has(r.id)).map(r => (updated.has(r.id) ? { ...r, ...updated.get(r.id) } : r))];
}

/**
 * The edits a conflict leaves: those to rows that moved are dropped — they were made to a row
 * that is no longer as it was read — and the rest kept, to be saved against the versions read
 * again. New rows are kept.
 *
 * @param {{ id: number }[]} conflicts  The 409's rows
 */
export function afterConflict(edits, conflicts) {
  const moved   = new Set(conflicts.map(c => c.id));
  const changes = Object.fromEntries(Object.entries(edits.changes).filter(([id]) => !moved.has(Number(id))));
  return { ...edits, changes, removed: edits.removed.filter(id => !moved.has(id)) };
}

/**
 * The rows that moved, as a person names them: each row's label column (its `name` or `title`,
 * as the list view picks it) — a foreign key by the label of the row it names, never its id —
 * else the row's own `#id`.
 *
 * @param {Record<string, {value: string, label: string}[]>} [options]  A foreign key's rows, by column
 * @returns {{ name: string, reason: 'changed'|'deleted' }[]}
 */
export function movedRows(conflicts, rows, columns, options = {}) {
  const label  = pickLabelColumn(columns);
  const column = columns.find(c => c.name === label);
  const byId   = new Map(rows.map(r => [r.id, r]));
  const nameOf = row => {
    const value = row?.[label];
    if (value === null || value === undefined || value === '') return null;
    if (!column?.references) return String(value);
    return (options[label] ?? []).find(o => o.value === String(value))?.label ?? null;
  };
  return conflicts.map(c => ({ name: (label && nameOf(byId.get(c.id))) || `#${c.id}`, reason: c.reason }));
}

/**
 * A referenced table's rows as a select's options: valued by id, labelled by the table's label
 * column (pickLabelColumn, the rule the list view uses), in label order.
 *
 * @param {{ columns: object[], rows: object[] }} body  GET /sources/{table}/rows
 * @returns {{ value: string, label: string }[]}
 */
export function referenceOptions(body, locale) {
  const label = pickLabelColumn(body.columns ?? []);
  return (body.rows ?? [])
    .map(r => ({ value: String(r.id), label: String((label && r[label]) ?? r.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}
