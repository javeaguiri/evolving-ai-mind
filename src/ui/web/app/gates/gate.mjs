// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/gates/gate.mjs
//
// A gate's decisions on the web (docs/arch-web-app.md §5), pure: what its inputs hold, whether a
// form is a grid, what may be sent, and the answer — the same answer Slack sends for the same
// click, so a workflow cannot tell which surface it came from (form-fields.mjs extractFieldValue):
// an empty field is null, a select's "none" null, a multi-select an array, a date-time epoch
// seconds. Numbers are checked by the shared rule PROC checks them by again.

import { numberRule, readNumber } from '../../../../shared/number-rule.mjs';

const MULTI = new Set(['multi_select', 'checkbox']);

/** The gate's input fields — a form's fields, in order. */
export const inputsOf = dialog => (dialog?.fields ?? []).filter(f => f.type === 'input');

/** What each input opens on: its `initial`, as the dialog carries it. */
export function initialValues(inputs) {
  return Object.fromEntries(inputs.map(f => {
    if (MULTI.has(f.input_type)) return [f.name, Array.isArray(f.initial) ? f.initial.map(String) : f.initial != null && f.initial !== '' ? [String(f.initial)] : []];
    return [f.name, f.initial === undefined || f.initial === null ? '' : String(f.initial)];
  }));
}

/** Has this input moved from where it opened? */
export function isChanged(field, values, initial) {
  const a = values[field.name], b = initial[field.name];
  return Array.isArray(a) ? JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort()) : String(a ?? '').trim() !== String(b ?? '').trim();
}

/**
 * What stops an answer being sent: a required field left empty, a number the shared rule refuses.
 * A cancel is sent as it is — Slack sends a cancel without checking either.
 *
 * @returns {{ name: string, problem: string }[]}  problem completes "<label> …"
 */
export function fieldProblems(inputs, values) {
  const problems = [];
  for (const f of inputs) {
    const v     = values[f.name];
    const empty = Array.isArray(v) ? v.length === 0 : String(v ?? '').trim() === '';
    if (empty) {
      if (!f.optional) problems.push({ name: f.name, problem: 'is required' });
      continue;
    }
    if (f.input_type === 'number') {
      const read = readNumber(String(v), numberRule(f));
      if (read.problem) problems.push({ name: f.name, problem: read.problem });
    }
  }
  return problems;
}

/** One field's value as Slack sends it. */
function answerValue(field, value) {
  if (MULTI.has(field.input_type)) return (value ?? []).filter(v => v !== '');
  const text = String(value ?? '').trim();
  if (text === '') return null;
  if (field.input_type === 'datetime') {
    const when = new Date(text);
    return Number.isNaN(when.getTime()) ? text : String(Math.floor(when.getTime() / 1000));
  }
  return text;
}

/** A form's answer: every field, as Slack sends it. */
export function formValues(inputs, values) {
  return Object.fromEntries(inputs.map(f => [f.name, answerValue(f, values[f.name])]));
}

/**
 * The answer to send for a click (§5.2), beside the gateId the caller adds.
 *
 * @param {string} gateType
 * @param {string} action           The button's action, a choice's value, or a row's action
 * @param {object} [extra]          { values, inputs } for a form; { inputValue } for a text
 *                                  box or a modal button; { row } for a list row
 */
export function answerFor(gateType, action, { values, inputs, inputValue, row } = {}) {
  if (row) return { action, inputValue: String(row.id), listGroup: row.responseData?.table ?? '' };
  if (gateType === 'form' && inputs?.length) return { action, formValues: formValues(inputs, values) };
  const text = typeof inputValue === 'string' ? inputValue.trim() : '';
  return text ? { action, inputValue: text } : { action };
}

/**
 * A form is a grid when every input names its row and its column (§5.2). Rows and columns in
 * first-appearance order; a row's header is its first field's label; `group` a heading row.
 *
 * @returns {{ columns: string[], rows: { key: string, label: string, group: string|null, cells: Record<string, object> }[] } | null}
 */
export function gridOf(inputs) {
  if (inputs.length === 0 || !inputs.every(f => f.row && f.column)) return null;
  const columns = [];
  const rows    = new Map();
  for (const f of inputs) {
    if (!columns.includes(f.column)) columns.push(f.column);
    if (!rows.has(f.row)) rows.set(f.row, { key: f.row, label: f.label, group: f.group ?? null, cells: {} });
    rows.get(f.row).cells[f.column] = f;
  }
  return { columns, rows: [...rows.values()] };
}

/**
 * A grid's sections (§5.2): each run of rows under one `group`, drawn as that group's subheading
 * over its own table. Rows keep their index in the whole grid, so keyboard movement runs on from
 * one section into the next.
 *
 * @param {{ rows: object[] }} grid
 * @returns {{ group: string|null, rows: { row: object, r: number }[] }[]}
 */
export function gridSections(grid) {
  const sections = [];
  grid.rows.forEach((row, r) => {
    const last = sections.at(-1);
    if (last && last.group === row.group) last.rows.push({ row, r });
    else sections.push({ group: row.group, rows: [{ row, r }] });
  });
  return sections;
}

/**
 * The cell keyboard movement lands on (§5.2): Enter and the arrow keys move between cells; past
 * an edge it stays.
 *
 * @param {{ r: number, c: number }} at
 * @param {string} key                  'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Enter'
 * @param {{ rows: number, columns: number }} size
 */
export function moveCell(at, key, size) {
  const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], Enter: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];
  if (!step) return at;
  const r = Math.min(Math.max(at.r + step[0], 0), size.rows - 1);
  const c = Math.min(Math.max(at.c + step[1], 0), size.columns - 1);
  return { r, c };
}

/** A list's columns: every key any item's fields hold, in first-appearance order (§5.1). */
export function listColumns(items) {
  const keys = [];
  for (const item of items) for (const k of Object.keys(item.fields ?? {})) if (!keys.includes(k)) keys.push(k);
  return keys;
}
