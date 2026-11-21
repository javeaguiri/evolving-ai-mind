// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/form-changes.mjs
//
// How far a form's answer moved from where it opened — counted the same by the web, while the form
// is open, and by /proc, for the answer it records (GATE_ANSWERED, docs/arch-web-app.md §8). Pure.

export const MULTI = new Set(['multi_select', 'checkbox']);

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
  if (Array.isArray(a) || Array.isArray(b)) {
    const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String).sort();
    return JSON.stringify(list(a)) !== JSON.stringify(list(b));
  }
  return String(a ?? '').trim() !== String(b ?? '').trim();
}

/** The inputs an answer's values moved from where they opened. */
export function countChanges(inputs, values) {
  const initial = initialValues(inputs);
  return inputs.filter(f => isChanged(f, values ?? {}, initial)).length;
}
