// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/language-map.mjs
//
// A label stored as a string or a language map (docs/arch-web-app.md §13), read in one language.
// One rule for PROC (page titles, domain and workflow labels) and the web app (panel titles,
// column labels — the maps GET /pages and GET /runs pass on as stored). Pure, no I/O.

/**
 * The label in the given language: the language itself, else English, else the first language
 * the map holds.
 *
 * @param {string|Record<string, string>|null|undefined} label
 * @param {string} [language]
 * @returns {string}
 */
export function resolveLanguageMap(label, language = 'en') {
  if (typeof label === 'string') return label;
  return label?.[language] ?? label?.en ?? Object.values(label ?? {})[0] ?? '';
}
