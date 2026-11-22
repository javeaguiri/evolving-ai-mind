// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/api/client.mjs
//
// The app's calls to /api/v1/ui/web/ (docs/arch-web-app.md §3): same origin, the access token as
// a bearer header. A 401 is answered by one refresh and one retry — a token can expire between
// the check and the call; a second 401 ends the session. A WebError body becomes an ApiError
// with its code; a 502 or a call that never arrives is upstream_unavailable, the §9
// "Can't reach the home brain" banner.

import { SignInRequired } from '../auth/session.mjs';

export const API_BASE = '/api/v1/ui/web';

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {object[]} [fields]
   */
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code   = code;
    this.fields = fields;
  }
}

/**
 * @param {object} deps
 * @param {{ accessToken: () => Promise<string>, forceRefresh: () => Promise<void> }} deps.session
 * @param {typeof fetch} deps.fetch
 */
export function createApiClient({ session, fetch }) {
  async function send(method, path, token, query, body) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null))}` : '';
    try {
      return await fetch(`${API_BASE}/${path}${qs === '?' ? '' : qs}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(0, 'upstream_unavailable', "Can't reach the home brain.");
    }
  }

  /**
   * @param {string} method
   * @param {string} path              Under /api/v1/ui/web/, no leading slash
   * @param {{ query?: object, body?: object }} [options]
   * @returns {Promise<any>}           The response body; throws ApiError or SignInRequired
   */
  async function request(method, path, { query, body } = {}) {
    let res = await send(method, path, await session.accessToken(), query, body);
    if (res.status === 401) {
      await session.forceRefresh();
      res = await send(method, path, await session.accessToken(), query, body);
      if (res.status === 401) throw new SignInRequired('the API refused a fresh token');
    }
    const parsed = await res.json().catch(() => null);
    if (res.ok) return parsed;
    const error = parsed?.error;
    if (res.status === 502 || !error?.code) throw new ApiError(res.status, 'upstream_unavailable', error?.message ?? "Can't reach the home brain.");
    throw new ApiError(res.status, error.code, error.message, error.fields);
  }

  return {
    request,
    get:  (path, query)  => request('GET', path, { query }),
    post: (path, body)   => request('POST', path, { body }),
    patch: (path, body)  => request('PATCH', path, { body }),
  };
}
