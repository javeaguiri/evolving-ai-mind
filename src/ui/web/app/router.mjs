// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/router.mjs
//
// The app's routes (docs/arch-web-app.md §4.8) on the browser's History API: the path picks a
// page, a link changes the path without a reload, Back and Forward re-draw. Every route is a
// deep link — CloudFront serves index.html for any path without a file extension.

import { useSyncExternalStore } from 'react';

const ROUTES = [
  { page: 'home',          pattern: /^\/$/ },
  { page: 'householdPage', pattern: /^\/p\/([^/]+)$/,         params: ['pageKey'] },
  { page: 'domains',       pattern: /^\/d$/ },
  { page: 'domain',        pattern: /^\/d\/([^/]+)$/,         params: ['domain'] },
  { page: 'run',           pattern: /^\/runs\/([1-9][0-9]*)$/, params: ['runId'] },
  { page: 'settings',      pattern: /^\/settings\/([a-z]+)$/, params: ['entry'] },
];

const idParam = (query, name) => {
  const value = query.get(name);
  return /^[1-9][0-9]*$/.test(value ?? '') ? Number(value) : null;
};

/**
 * The page a location names, its path parameters, the run drawer's run (`?run=`) and the
 * session her region is open on (`?minds-eye=`), both on any page. Pure.
 *
 * @param {string} pathname
 * @param {string} [search]
 * @returns {{ page: string, params: Record<string, string>, run: number|null, mindsEye: number|null }}
 */
export function matchPath(pathname, search = '') {
  const query    = new URLSearchParams(search);
  const run      = idParam(query, 'run');
  const mindsEye = idParam(query, 'minds-eye');
  for (const route of ROUTES) {
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    try {
      const params = Object.fromEntries((route.params ?? []).map((name, i) => [name, decodeURIComponent(m[i + 1])]));
      return { page: route.page, params, run, mindsEye };
    } catch {
      break;   // a malformed %-escape names no page
    }
  }
  return { page: 'notFound', params: {}, run, mindsEye };
}

const listeners = new Set();
const notify    = () => listeners.forEach(l => l());

function subscribe(listener) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => { listeners.delete(listener); window.removeEventListener('popstate', listener); };
}

/**
 * Go to a path on this site, adding it to the back stack.
 *
 * @param {string} to
 * @param {{ from?: string }} [state]  `from`: the page an overlay route (Settings) is drawn over
 */
export function navigate(to, state = null) {
  window.history.pushState(state, '', to);
  notify();
}

/** Back one entry — an overlay route closing onto the page it was opened from. */
export function back() {
  window.history.back();
}

/** Replace the current entry — used once a sign-in returns, so Back never lands on the callback. */
export function replace(to) {
  window.history.replaceState(null, '', to);
  notify();
}

const snapshot = () => window.location.pathname + window.location.search;

const splitLocation = location => {
  const at = location.indexOf('?');
  return at < 0 ? [location, ''] : [location.slice(0, at), location.slice(at)];
};

/** The route a location string names — path and query together. Pure. */
export const matchLocation = location => matchPath(...splitLocation(location));

/**
 * The current route, re-drawn when it changes, with its `location` (path and query) and `from`:
 * the location an overlay route was opened over, when it was opened inside the app (a deep link
 * has none).
 */
export function useRoute() {
  const location = useSyncExternalStore(subscribe, snapshot);
  const from     = window.history.state?.from ?? null;
  return { ...matchLocation(location), location, from };
}
