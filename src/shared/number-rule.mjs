// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/number-rule.mjs
//
// A form gate's `number` field: what may be typed into it, and the number it reads as. One
// rule for every surface that collects an answer — Slack's interactive.mjs, and /proc's gate
// responses endpoint that the web app and Novia answer through — so a value accepted on one
// is accepted on all.

/**
 * The rule a `number` field declares: decimal unless `decimal: false`, with optional bounds.
 *
 * @param {object} field  A form field definition
 * @returns {{ decimal: boolean, min?: number, max?: number }}
 */
export function numberRule(field = {}) {
  return {
    decimal: field.decimal !== false,
    ...(field.min !== undefined && field.min !== null && field.min !== '' ? { min: Number(field.min) } : {}),
    ...(field.max !== undefined && field.max !== null && field.max !== '' ? { max: Number(field.max) } : {}),
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
