// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/api/proc-client.mjs
//
// WebApiFunction's calls upstream — to PROC with the internal key, and to Cognito for /me
// (docs/arch-web-app.md §1, §3). Every PROC call is built afresh: the internal key and
// x-principal-user, set from the token's verified sub, and nothing from the browser's own
// headers. A PROC error with a code becomes a WebError with that code; a call that fails, times
// out, or answers without a code is 502 upstream_unavailable (docs/openapi.yaml WebError).

/** Under API Gateway's 29 s, so a slow upstream is ours to report, not a gateway timeout. */
export const UPSTREAM_TIMEOUT_MS = 25_000;

/** English for each code the web routes return — what the app's catalog falls back on. */
const MESSAGES = {
  route_not_found:      'There is no such page of the home brain.',
  invalid_body:         'The request was not readable.',
  upstream_unavailable: "Can't reach the home brain.",
  principal_required:   'You are not signed in.',
  household_required:   'This is for the household only.',
  invalid_query:        'The request asked for something the home brain cannot read.',
  run_not_found:        'That run does not exist.',
  run_forbidden:        'That run is not yours to see.',
  gate_not_waiting:     'That run is not waiting for an answer.',
  gate_moved:           'This was answered elsewhere.',
  invalid_fields:       'Some answers need correcting.',
  workflow_not_found:   'That workflow does not exist.',
  no_output:            'That workflow has not produced anything yet.',
  source_not_found:     'Those records do not exist.',
  pages_truncated:      'The pages could not all be read.',
  workflows_truncated:  'The workflows could not all be read.',
};

export class WebError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} [message]
   * @param {object[]} [fields]
   */
  constructor(status, code, message, fields) {
    super(message ?? MESSAGES[code] ?? code);
    this.status = status;
    this.code   = code;
    this.fields = fields;
  }

  /** The WebError body. */
  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.fields ? { fields: this.fields } : {}) } };
  }
}

export const upstreamUnavailable = () => new WebError(502, 'upstream_unavailable');

/**
 * One upstream HTTP call, bounded. The status and the parsed body (null when not JSON); a call
 * that fails or times out is upstream_unavailable.
 *
 * @returns {Promise<{ ok: boolean, status: number, body: any }>}
 */
export async function fetchUpstream(url, init) {
  try {
    const res  = await fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    console.error('web-api: upstream call failed', { url: String(url), error: e.message });
    throw upstreamUnavailable();
  }
}

/**
 * Call a PROC route as the principal.
 *
 * @param {object} call
 * @param {string} call.method
 * @param {string} call.procPath       Under /api/v1/proc/
 * @param {Record<string,string>} [call.query]
 * @param {object} [call.body]
 * @param {string} call.sub            The Cognito token's sub, as the authorizer verified it
 * @param {string} call.correlationId
 * @returns {Promise<{ status: number, body: object }>}  PROC's status and body on a 2xx
 */
export async function callProc({ method, procPath, query = {}, body, sub, correlationId }) {
  const url = new URL(`${process.env.PROC_API_URL}/api/v1/proc/${procPath}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);

  const headers = {
    'x-api-key':        process.env.INTERNAL_API_KEY ?? '',
    'x-correlation-id': correlationId,
    ...(sub ? { 'x-principal-user': sub } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetchUpstream(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  if (res.ok && res.body && typeof res.body === 'object') return { status: res.status, body: res.body };
  if (!res.ok && typeof res.body?.error === 'string') {
    throw new WebError(res.status, res.body.error, res.body.message, res.body.fields);
  }
  console.error('web-api: PROC answered without a code', { procPath, status: res.status });
  throw upstreamUnavailable();
}
