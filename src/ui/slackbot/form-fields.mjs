// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/form-fields.mjs
//
// The form gate's block_id contract, shared by the two sides that must agree on it:
// callback.mjs writes the block_id when rendering a field, interactive.mjs parses it
// back to rebuild the answers as a map. Keeping the prefix and the parser in one
// place means the two cannot drift apart.

// A form field's answer is identified by the field name encoded in its block_id:
//   form_field_<workflowRunId>::<fieldName>
// '::' separates the run id from the name — field names may contain underscores, so
// an underscore-delimited id could not be split back reliably.
export const FORM_BLOCK_PREFIX = 'form_field_';

// An option whose value is the empty string is the standard way to offer "none" in a
// form (HTML's <option value="">), but Slack rejects an empty option value and with it
// the whole message (run 870). callback.mjs renders '' as this token; extractFieldValue
// reads it back as null — the same answer as a select left unchosen.
export const EMPTY_OPTION_VALUE = '__empty__';

// A list_selection gate renders one ID box per source table, so a level showing two
// tables (a record's ingredients and its steps) can show the same id twice without
// ambiguity: the box the user typed in names the table. The box is identified by
//   list_select_input_<workflowRunId>::<table>
// with an empty table for rows that carry none. The Select button under each box
// carries the same table, and collectListIdValue reads that box and no other.
export const LIST_ID_BLOCK_PREFIX = 'list_select_input_';

export function listIdBlockId(workflowRunId, table) {
  return `${LIST_ID_BLOCK_PREFIX}${workflowRunId}::${table ?? ''}`;
}

/**
 * The ID typed into one table's box on a list_selection gate.
 *
 * @param {object} stateValues  payload.state.values
 * @param {string} table        the table named by the clicked Select button ('' for none)
 * @returns {string|null}  the trimmed typed id, or null when that box is empty
 */
export function collectListIdValue(stateValues = {}, table = '') {
  for (const [blockId, blockValues] of Object.entries(stateValues)) {
    if (!blockId.startsWith(LIST_ID_BLOCK_PREFIX)) continue;
    const separatorAt = blockId.indexOf('::');
    if (separatorAt === -1 || blockId.slice(separatorAt + 2) !== table) continue;
    const typed = Object.values(blockValues ?? {})[0]?.value?.trim();
    return typed ? typed : null;
  }
  return null;
}

/**
 * Normalise one Slack state.values entry to the value the workflow actually wants.
 * Each element type reports its answer under a different key.
 *
 * @param {object} actionValue  state.values[block_id][action_id]
 * @returns {string|string[]|null}
 */
export function extractFieldValue(actionValue) {
  if (!actionValue) return null;

  // multi_static_select / checkboxes — an array of chosen options
  if (Array.isArray(actionValue.selected_options)) {
    return actionValue.selected_options.map(o => o.value).filter(v => v !== EMPTY_OPTION_VALUE);
  }
  // static_select / radio_buttons
  if (actionValue.selected_option) {
    const value = actionValue.selected_option.value ?? null;
    return value === EMPTY_OPTION_VALUE ? null : value;
  }
  // datepicker / timepicker / datetimepicker
  if (actionValue.selected_date)      return actionValue.selected_date;
  if (actionValue.selected_time)      return actionValue.selected_time;
  if (actionValue.selected_date_time !== undefined && actionValue.selected_date_time !== null) {
    return String(actionValue.selected_date_time);
  }
  // plain_text_input
  if (typeof actionValue.value === 'string') {
    const trimmed = actionValue.value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return null;
}

/**
 * Rebuild a form gate's answers from a Slack block_actions state.values payload.
 * Only form blocks are read — a gate's other inputs (list_selection's ID box, a
 * text_input box) are left to their own handling.
 *
 * An untouched optional field reports a null/empty value; it is included as null
 * rather than omitted, so the workflow sees every field it asked for.
 *
 * @param {object} stateValues  payload.state.values
 * @returns {object|null}  { fieldName: value } — null when the gate had no form fields
 */
export function collectFormValues(stateValues = {}) {
  const values = {};
  let found = false;

  for (const [blockId, blockValues] of Object.entries(stateValues)) {
    if (!blockId.startsWith(FORM_BLOCK_PREFIX)) continue;
    const separatorAt = blockId.indexOf('::');
    if (separatorAt === -1) continue;

    const name = blockId.slice(separatorAt + 2);
    if (!name) continue;

    const [actionId, actionValue] = Object.entries(blockValues ?? {})[0] ?? [];
    const value = extractFieldValue(actionValue);
    const rule  = parseNumberActionId(actionId);
    // A number field is handed on as a number. One that does not read as a number is
    // left as typed — invalidNumberFields reports it, and the click never resumes the run.
    const read  = rule && value !== null ? readNumber(value, rule) : null;
    values[name] = read && read.problem === undefined ? read.value : value;
    found = true;
  }

  return found ? values : null;
}

// A `number` field. Slack has no number control in a message — number_input renders only
// in modals — so a number field is drawn as a text box, and keeping the field's contract
// is this layer's job: whatever is typed must come back as a number, or not at all. A web
// page gets the same from <input type="number">; /proc only ever sees the number.
//
// The field's rule travels in the element's action_id, so the reading side needs nothing
// from /proc:  form_number:<d|i>:<min>:<max>  — d allows decimals, i whole numbers only;
// an empty min or max is no bound.
export const NUMBER_ACTION_PREFIX = 'form_number';

export function numberActionId({ decimal, min, max } = {}) {
  return `${NUMBER_ACTION_PREFIX}:${decimal === true ? 'd' : 'i'}:${min ?? ''}:${max ?? ''}`;
}

export function parseNumberActionId(actionId) {
  if (typeof actionId !== 'string' || !actionId.startsWith(`${NUMBER_ACTION_PREFIX}:`)) return null;
  const [, kind, min, max] = actionId.split(':');
  return {
    decimal: kind === 'd',
    ...(min !== undefined && min !== '' ? { min: Number(min) } : {}),
    ...(max !== undefined && max !== '' ? { max: Number(max) } : {}),
  };
}

/**
 * Read what was typed into a number field.
 *
 * A decimal comma is read as the decimal point when it is the only separator — `12,50`
 * is 12.5 — because a household entering euros types it that way. Anything else that is
 * not a plain number is refused, never guessed at.
 *
 * @param {string} text  the typed value, trimmed and non-empty
 * @param {{ decimal: boolean, min?: number, max?: number }} rule
 * @returns {{ value: number } | { problem: string }}  problem completes "<label> …"
 */
export function readNumber(text, rule) {
  let t = String(text).trim();
  if (/^[+-]?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return { problem: 'must be a number' };
  const n = Number(t);
  if (!rule.decimal && !Number.isInteger(n))      return { problem: 'must be a whole number' };
  if (rule.min !== undefined && n < rule.min)    return { problem: `must be at least ${rule.min}` };
  if (rule.max !== undefined && n > rule.max)    return { problem: `must be at most ${rule.max}` };
  return { value: n };
}

/**
 * The number fields on a form gate whose typed value is not an acceptable number.
 * An empty field is not reported here: whether it may be empty is the required-field
 * check's call.
 *
 * @param {object} stateValues  payload.state.values
 * @returns {{ blockId: string, name: string, problem: string }[]}
 */
export function invalidNumberFields(stateValues = {}) {
  const invalid = [];
  for (const [blockId, blockValues] of Object.entries(stateValues)) {
    if (!blockId.startsWith(FORM_BLOCK_PREFIX)) continue;
    const [actionId, actionValue] = Object.entries(blockValues ?? {})[0] ?? [];
    const rule = parseNumberActionId(actionId);
    if (!rule) continue;
    const value = extractFieldValue(actionValue);
    if (value === null) continue;
    const read = readNumber(value, rule);
    if (read.problem !== undefined) {
      invalid.push({ blockId, name: blockId.slice(blockId.indexOf('::') + 2), problem: read.problem });
    }
  }
  return invalid;
}
