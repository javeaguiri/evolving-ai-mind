// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/shared/column-header.mjs
//
// A record table's column header — what a person reads above a column of a workflow's records,
// drawn alike by Slack (slackbot/callback.mjs) and the web (web/app/gates). Pure presentation, no
// domain knowledge.

/**
 * Title-cases a snake_case field name (ease_factor -> Ease Factor, front -> Front). A key ending
 * in _id whose values no longer look like raw ids (the workflow already resolved the FK to its
 * label, keeping the original column name) drops the _id suffix and reads as "<Prefix> Name"
 * (deck_id -> Deck Name) instead — judged from the data itself, so an _id column still holding
 * raw numeric ids (never resolved) is left as a plain title-cased "Deck Id".
 * @param {string} key
 * @param {unknown[]} values  The column's values, one per record
 * @returns {string}
 */
export function formatColumnHeader(key, values) {
  if (key === 'ID') return 'ID';
  const isFkColumn    = /_id$/i.test(key);
  const looksResolved = isFkColumn && values.some(v => v !== undefined && v !== null && v !== '' && Number.isNaN(Number(v)));
  const base  = looksResolved ? key.slice(0, -3) : key;
  const words = base.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1));
  return looksResolved ? `${words.join(' ')} Name` : words.join(' ');
}
