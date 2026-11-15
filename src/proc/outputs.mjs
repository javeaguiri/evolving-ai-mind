// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/outputs.mjs
//
// GET /api/v1/proc/outputs/{workflow} — a workflow's latest output, what a report widget shows
// (docs/arch-web-app.md §2.6): the payload of the last HUMAN_NOTIFICATION of the workflow's latest
// completed run, read from PGC_UiMessage whichever provider ran it. Nothing new is stored — the
// inbox already holds every message — so the report outlives the run. Reports belong to the
// household. Transport-agnostic — no AWS SDK, no Slack SDK.

import { respond, err }   from '../shared/lambda-utils.mjs';
import { getRows }        from '../shared/serv-client.mjs';
import { readPrincipal }  from './principal.mjs';

/**
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function latestOutput(workflow) {
  const wfResp = await getRows('PGC_Workflow', [{ column: 'name', op: 'eq', value: workflow }],
    undefined, undefined, undefined, ['id']);
  const ids = (wfResp.rows ?? []).map(w => w.id);
  if (!ids.length) return { status: 404, body: { error: 'workflow_not_found' } };

  const runResp = await getRows('PGC_WorkflowRun',
    [{ column: 'workflow_id', op: 'in', value: ids }, { column: 'status', op: 'eq', value: 'completed' }],
    'id DESC', 1, undefined, ['id', 'label', 'completed_at']);
  const run = runResp.rows?.[0];
  if (!run) return { status: 404, body: { error: 'no_output' } };

  const msgResp = await getRows('PGC_UiMessage',
    [{ column: 'workflow_run_id', op: 'eq', value: run.id }, { column: 'message_type', op: 'eq', value: 'HUMAN_NOTIFICATION' }],
    'id DESC', 1, undefined, ['payload']);
  const message = msgResp.rows?.[0];
  if (!message) return { status: 404, body: { error: 'no_output', runId: run.id } };

  return { status: 200, body: { runId: run.id, label: run.label ?? null, completedAt: run.completed_at, payload: message.payload } };
}

export async function handle(req) {
  const segments = (req.proxy || '').split('/').filter(Boolean);
  if ((req.method ?? 'GET') !== 'GET' || segments.length !== 2) {
    return err(404, `outputs route not found: ${req.method} /${req.proxy}`, req.correlationId);
  }
  const principal = readPrincipal(req.headers);
  if (!principal) return respond(401, { success: false, error: 'principal_required' }, req.correlationId);
  if (!principal.roles.includes('household')) return respond(403, { success: false, error: 'household_required' }, req.correlationId);

  const { status, body } = await latestOutput(decodeURIComponent(segments[1]));
  return respond(status, { success: status === 200, ...body }, req.correlationId);
}
