// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/api/routes.mjs
//
// The web routes WebApiFunction forwards — the eleven operations of docs/openapi.yaml's UI-Web
// section, and nothing else (docs/arch-web-app.md §3.1). An allow-list, never a proxy: a method
// or path not listed here, or a path parameter outside its pattern, never reaches PROC. Each
// web path is its PROC path under /api/v1/proc/, and each route names the query parameters it
// passes on. Pure.

const RUN_ID = /^[1-9][0-9]{0,15}$/;
const NAME   = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * @typedef {object} WebRoute
 * @property {string}   operationId  The spec's operation
 * @property {string}   method
 * @property {Array<string|RegExp>} path  A literal segment, or the pattern a path parameter matches
 * @property {string[]} [query]      Query parameters passed to PROC
 * @property {boolean}  [body]       The request's JSON body is passed to PROC
 */

/** @type {WebRoute[]} */
export const WEB_ROUTES = [
  { operationId: 'webGetMe',          method: 'GET',  path: ['me'] },
  { operationId: 'webListWorkflows',  method: 'GET',  path: ['workflows'] },
  { operationId: 'webListPages',      method: 'GET',  path: ['pages'] },
  { operationId: 'webReadSourceRows', method: 'GET',  path: ['sources', NAME, 'rows'], query: ['columns', 'filter', 'order_by', 'limit'] },
  { operationId: 'webGetOutput',      method: 'GET',  path: ['outputs', NAME] },
  { operationId: 'webListRuns',       method: 'GET',  path: ['runs'], query: ['workflow', 'domain', 'status', 'limit', 'before'] },
  { operationId: 'webStartRun',       method: 'POST', path: ['runs'], body: true },
  { operationId: 'webReadInbox',      method: 'GET',  path: ['inbox'], query: ['after', 'run', 'limit'] },
  { operationId: 'webListGates',      method: 'GET',  path: ['gates'] },
  { operationId: 'webGetGate',        method: 'GET',  path: ['gates', RUN_ID] },
  { operationId: 'webAnswerGate',     method: 'POST', path: ['gates', RUN_ID, 'responses'], body: true },
];

/**
 * The route a request names, or null. Segments are matched exactly — no empty segment, no
 * trailing slash.
 *
 * @param {string} method
 * @param {string} proxy  The {proxy+} capture under /api/v1/ui/web/
 * @returns {{ route: WebRoute, procPath: string } | null}
 */
export function matchRoute(method, proxy) {
  const segments = String(proxy ?? '').split('/');
  for (const route of WEB_ROUTES) {
    if (route.method !== method || route.path.length !== segments.length) continue;
    const fits = route.path.every((part, i) => typeof part === 'string' ? part === segments[i] : part.test(segments[i]));
    if (fits) return { route, procPath: segments.join('/') };
  }
  return null;
}

/**
 * The query parameters a route passes on, from the request's — any other is dropped.
 *
 * @param {WebRoute} route
 * @param {Record<string, string>|null} query
 * @returns {Record<string, string>}
 */
export function pickQuery(route, query) {
  const picked = {};
  for (const name of route.query ?? []) {
    if (query?.[name] !== undefined) picked[name] = query[name];
  }
  return picked;
}
