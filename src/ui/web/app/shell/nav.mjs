// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/shell/nav.mjs
//
// The shell's decisions, pure (docs/arch-web-app.md §4.1, §4.8, §9): what the Pages and Domains
// menus list and where each item goes, which section the user is in, the name a waiting gate
// goes by, how long ago it started waiting, and how long to wait before asking again.

/** The household page drawn at `/` (§2.3: Home is seeded, its key fixed). */
export const HOME_PAGE_KEY = 'home';

/** The path of a household page. */
export const pagePath = pageKey => (pageKey === HOME_PAGE_KEY ? '/' : `/p/${encodeURIComponent(pageKey)}`);

/**
 * The Pages menu: `GET /pages` in `position` order.
 *
 * @param {{ pageKey: string, title: string, position: number }[]} pages
 * @returns {{ key: string, label: string, to: string }[]}
 */
export function pageItems(pages) {
  return [...pages]
    .sort((a, b) => a.position - b.position)
    .map(p => ({ key: p.pageKey, label: p.title, to: pagePath(p.pageKey) }));
}

/**
 * The Domains menu: `GET /workflows`'s domains, in the order PROC sends them, labels as sent.
 *
 * @param {{ domain: string, label: string }[]} domains
 * @returns {{ key: string, label: string, to: string }[]}
 */
export function domainItems(domains) {
  return domains.map(d => ({ key: d.domain, label: d.label, to: `/d/${encodeURIComponent(d.domain)}` }));
}

/**
 * The top-bar section a route belongs to — its menu stays highlighted.
 *
 * @param {{ page: string }} route
 * @returns {'pages'|'domains'|null}
 */
export function sectionOf(route) {
  if (route.page === 'home' || route.page === 'householdPage') return 'pages';
  if (route.page === 'domain' || route.page === 'domains') return 'domains';
  return null;
}

/**
 * The menu item a route is on, or null.
 *
 * @param {{ page: string, params: Record<string, string> }} route
 * @returns {string|null}
 */
export function currentItem(route) {
  if (route.page === 'home') return HOME_PAGE_KEY;
  if (route.page === 'householdPage') return route.params.pageKey;
  if (route.page === 'domain') return route.params.domain;
  return null;
}

/**
 * Each workflow's label by name, from `GET /workflows`.
 *
 * @param {{ workflows: { name: string, label: string }[] }[]} domains
 * @returns {Map<string, string>}
 */
export function workflowLabels(domains) {
  return new Map(domains.flatMap(d => d.workflows.map(w => [w.name, w.label])));
}

/**
 * A waiting gate's question in one line: the first line of its message, without markdown's marks.
 * The whole question is drawn inside its run; this is a list entry naming it.
 *
 * @param {{ fields?: { type: string, value?: string }[] }} dialog
 * @returns {string|null}
 */
export function gateHeadline(dialog) {
  const message = dialog?.fields?.find(f => f.type === 'typography')?.value ?? '';
  const line    = message.split('\n').map(l => l.trim()).find(l => l && !/^[-|:\s]+$/.test(l));
  if (!line) return null;
  return line.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[*_`~]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim() || null;
}

const AGE_UNITS = [
  ['year',   365 * 24 * 3600],
  ['month',  30 * 24 * 3600],
  ['week',   7 * 24 * 3600],
  ['day',    24 * 3600],
  ['hour',   3600],
  ['minute', 60],
];

/**
 * How long ago, in the user's language — "2 hours ago", "yesterday".
 *
 * @param {string} iso      When
 * @param {number} now      Epoch milliseconds
 * @param {string} locale   BCP 47
 * @returns {string}
 */
export function relativeAge(iso, now, locale) {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  const format  = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of AGE_UNITS) {
    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  }
  return format.format(0, 'second');
}

/** How often 🔔 asks while all is well, and the longest it waits after failures. */
export const POLL_MS     = 30_000;
export const POLL_MAX_MS = 300_000;

/**
 * The wait before the next read: steady while reads succeed, doubling with each failure in a row
 * up to a ceiling, so an unreachable backend is not asked ever faster (§9 Offline).
 *
 * @param {number} failures  Failed reads in a row
 * @returns {number}         Milliseconds
 */
export function pollDelay(failures) {
  return Math.min(POLL_MS * 2 ** failures, POLL_MAX_MS);
}
