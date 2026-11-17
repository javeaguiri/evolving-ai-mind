// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/records/format.mjs
//
// A cell's value as a person reads it (docs/arch-web-app.md §6.3, §13): by its column's type and
// the panel's `format`, through Intl in the user's locale and timezone — never a literal symbol,
// never toLocaleString() without a locale. A currency is shown only when the panel names one: the
// app never guesses it. Pure.

const NUMERIC_TYPE = /^(numeric|decimal|integer|int[248]?|smallint|bigint|serial|bigserial|real|double precision|float[48]?)\b/;

const typeOf = column => String(column.type ?? '').toLowerCase();

/** Numbers line up on the right. */
export const isNumericColumn = column => NUMERIC_TYPE.test(typeOf(column));

/**
 * A `date` column is a calendar day. SERV sends it as that day's UTC midnight, so it is read and
 * shown in UTC — the same day in every timezone.
 */
function formatDay(value, locale) {
  const day = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(day);
}

function formatNumber(value, column, row, locale) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (column.format === 'currency') {
    const code = column.currency ?? row?.[column.currency_column];
    if (typeof code === 'string' && /^[A-Z]{3}$/.test(code)) {
      return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(n);
    }
  }
  if (column.format === 'percent') return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(n);
  return new Intl.NumberFormat(locale).format(n);
}

/**
 * @param {*} value
 * @param {{ type: string, format?: string, currency?: string, currency_column?: string }} column
 * @param {object} row                 The whole row — a currency may name the row's own column
 * @param {{ locale: string, timeZone: string }} where
 * @returns {string}
 */
export function formatValue(value, column, row, { locale, timeZone }) {
  if (value === null || value === undefined || value === '') return '';
  const type = typeOf(column);
  if (type === 'date') return formatDay(value, locale);
  if (type.startsWith('timestamp')) {
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) return String(value);
    return column.format === 'date'
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(when)
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(when);
  }
  if (column.format === 'date') return formatDay(value, locale);
  if (isNumericColumn(column)) return formatNumber(value, column, row, locale);
  if (typeof value === 'boolean') return value ? '✓' : '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
