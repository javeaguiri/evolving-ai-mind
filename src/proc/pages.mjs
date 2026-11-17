// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/pages.mjs
//
// GET /api/v1/proc/pages — the household's pages, the latest version of each, ordered by
// position (docs/arch-web-app.md §2.3, §4.2). Pages belong to the household, so the principal
// needs the household role. Panels are returned as stored: each was checked against its kind
// when written (page-config.mjs). Transport-agnostic — no AWS SDK, no Slack SDK.

import { respond, err }   from '../shared/lambda-utils.mjs';
import { getRows }        from '../shared/serv-client.mjs';
import { readPrincipal }  from './principal.mjs';
import { resolveLanguageMap } from '../shared/language-map.mjs';

/**
 * The latest version of each page, ordered by position then key, with its title resolved.
 *
 * @param {object[]} rows  PGC_Page rows, any order
 */
export function latestPages(rows, language = 'en') {
  const latest = new Map();
  for (const row of rows) {
    const held = latest.get(row.page_key);
    if (!held || row.version > held.version) latest.set(row.page_key, row);
  }
  return [...latest.values()]
    .sort((a, b) => a.position - b.position || a.page_key.localeCompare(b.page_key))
    .map(r => ({ pageKey: r.page_key, version: r.version, title: resolveLanguageMap(r.title, language), position: r.position, panels: r.panels }));
}

export async function handle(req) {
  if ((req.method ?? 'GET') !== 'GET') {
    return err(404, `pages route not found: ${req.method} /${req.proxy}`, req.correlationId);
  }
  const principal = readPrincipal(req.headers);
  if (!principal) return respond(401, { success: false, error: 'principal_required' }, req.correlationId);
  if (!principal.roles.includes('household')) return respond(403, { success: false, error: 'household_required' }, req.correlationId);

  // Every version row: SERV cannot ask for the latest per key, and a household holds a few dozen.
  // A read SERV cut short could drop a page whose versions are all older, so it is refused, not served.
  const resp = await getRows('PGC_Page', [], 'id DESC', undefined, undefined,
    ['page_key', 'version', 'title', 'position', 'panels']);
  if (resp.truncated) {
    console.error('proc/pages: PGC_Page read was cut short — pages withheld', { totalMatching: resp.total_matching, limit: resp.limit });
    return respond(500, { success: false, error: 'pages_truncated', totalMatching: resp.total_matching }, req.correlationId);
  }
  return respond(200, { success: true, pages: latestPages(resp.rows ?? []) }, req.correlationId);
}
