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

/**
 * The page a location names, its path parameters, and the run drawer's run (`?run=`). Pure.
 *
 * @param {string} pathname
 * @param {string} [search]
 * @returns {{ page: string, params: Record<string, string>, run: number|null }}
 */
export function matchPath(pathname, search = '') {
  const runParam = new URLSearchParams(search).get('run');
  const run      = /^[1-9][0-9]*$/.test(runParam ?? '') ? Number(runParam) : null;
  for (const route of ROUTES) {
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    try {
      const params = Object.fromEntries((route.params ?? []).map((name, i) => [name, decodeURIComponent(m[i + 1])]));
      return { page: route.page, params, run };
    } catch {
      break;   // a malformed %-escape names no page
    }
  }
  return { page: 'notFound', params: {}, run };
}

const listeners = new Set();
const notify    = () => listeners.forEach(l => l());

function subscribe(listener) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => { listeners.delete(listener); window.removeEventListener('popstate', listener); };
}

/** Go to a path on this site, adding it to the back stack. */
export function navigate(to) {
  window.history.pushState(null, '', to);
  notify();
}

/** Replace the current entry — used once a sign-in returns, so Back never lands on the callback. */
export function replace(to) {
  window.history.replaceState(null, '', to);
  notify();
}

const snapshot = () => window.location.pathname + window.location.search;

/** The current route, re-drawn when it changes. */
export function useRoute() {
  const location = useSyncExternalStore(subscribe, snapshot);
  const at = location.indexOf('?');
  return matchPath(at < 0 ? location : location.slice(0, at), at < 0 ? '' : location.slice(at));
}
