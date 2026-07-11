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
    return actionValue.selected_options.map(o => o.value);
  }
  // static_select / radio_buttons
  if (actionValue.selected_option) return actionValue.selected_option.value ?? null;
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
 * Only form blocks are read — a gate's other inputs (list_selection's picker, a
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

    const actionValue = Object.values(blockValues ?? {})[0];
    values[name] = extractFieldValue(actionValue);
    found = true;
  }

  return found ? values : null;
}
