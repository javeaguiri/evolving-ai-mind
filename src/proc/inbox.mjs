// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/inbox.mjs
//
// GET /api/v1/proc/inbox — the principal's messages, after a cursor (docs/arch-web-app.md §2.1,
// §3.1). Reads PGC_UiMessage, which enqueueCallback writes for every message to a person.
//
//   without ?run   the principal's own web messages (provider 'web', channel = their sub)
//   with ?run      every message of that run, whichever provider it went to — how a
//                  Slack-started run is followed on the web — once the run is checked against
//                  the principal (principal.mjs canSeeRun)
//
// The page is bounded and says so: `more` is true when rows past the last one returned remain.
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { respond, err }              from '../shared/lambda-utils.mjs';
import { getRows }                   from '../shared/serv-client.mjs';
import { readPrincipal, canSeeRun }  from './principal.mjs';

export const INBOX_DEFAULT_LIMIT = 50;
export const INBOX_MAX_LIMIT     = 200;

const COLUMNS = ['id', 'provider', 'thread_id', 'workflow_run_id', 'message_type', 'payload', 'created_at'];

/**
 * Read ?after, ?run and ?limit. Each is optional; a present one must be a whole number in range.
 *
 * @returns {{ after: number, run: number|null, limit: number } | { error: string }}
 */
export function parseInboxQuery(query = {}) {
  const whole = v => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
  const after = query.after === undefined ? 0 : whole(query.after);
  const run   = query.run   === undefined ? null : whole(query.run);
  const limit = query.limit === undefined ? INBOX_DEFAULT_LIMIT : whole(query.limit);
  if (Number.isNaN(after)) return { error: 'after must be a whole number' };
  if (Number.isNaN(run) || run === 0) return { error: 'run must be a run id' };
  if (Number.isNaN(limit) || limit < 1 || limit > INBOX_MAX_LIMIT) {
    return { error: `limit must be between 1 and ${INBOX_MAX_LIMIT}` };
  }
  return { after, run, limit };
}

/**
 * Shape one page of PGC_UiMessage rows, read with limit + 1 so the extra row says whether more remain.
 */
export function toInboxPage(rows, after, limit) {
  const page     = rows.slice(0, limit);
  const messages = page.map(r => ({
    id:            Number(r.id),
    provider:      r.provider,
    threadId:      r.thread_id,
    workflowRunId: r.workflow_run_id,
    messageType:   r.message_type,
    payload:       r.payload,
    createdAt:     r.created_at,
  }));
  return {
    messages,
    cursor: messages.length ? messages[messages.length - 1].id : after,
    more:   rows.length > limit,
  };
}

/**
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function readInbox(principal, { after, run, limit }) {
  const filters = [{ column: 'id', op: 'gt', value: after }];
  if (run === null) {
    filters.push({ column: 'provider', op: 'eq', value: 'web' },
                 { column: 'channel',  op: 'eq', value: principal.user });
  } else {
    const found = await getRows('PGC_WorkflowRun', [{ column: 'id', op: 'eq', value: run }],
      undefined, 1, undefined, ['id', 'callback']);
    const runRow = found.rows?.[0];
    if (!runRow) return { status: 404, body: { error: 'run_not_found' } };
    if (!canSeeRun(principal, runRow)) return { status: 403, body: { error: 'run_forbidden' } };
    filters.push({ column: 'workflow_run_id', op: 'eq', value: run });
  }

  const resp = await getRows('PGC_UiMessage', filters, 'id ASC', limit + 1, undefined, COLUMNS);
  return { status: 200, body: toInboxPage(resp.rows ?? [], after, limit) };
}

export async function handle(req) {
  if ((req.method ?? 'GET') !== 'GET') {
    return err(404, `inbox route not found: ${req.method} /${req.proxy}`, req.correlationId);
  }
  const principal = readPrincipal(req.headers);
  if (!principal) return respond(401, { success: false, error: 'principal_required' }, req.correlationId);

  const query = parseInboxQuery(req.query);
  if (query.error) {
    return respond(400, { success: false, error: 'invalid_query', message: query.error }, req.correlationId);
  }

  const { status, body } = await readInbox(principal, query);
  return respond(status, { success: status === 200, ...body }, req.correlationId);
}
