// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/runs.mjs
//
// /api/v1/proc/runs (docs/arch-web-app.md §2.4, §3.1, §4.3):
//   GET   runs the principal may see, newest first, each named by its label
//   GET   /runs/{runId} — one of them, by the same rule: the run drawer and run page's heading
//   POST  start a named domain workflow for the principal — no intent classification
//
// A started run's callback is { provider: 'web', channel: <principal> }: every message it sends
// is written to the inbox and nowhere else (sqs-callback.mjs). The run is its own thread, so the
// callback carries no threadId. Transport-agnostic — no AWS SDK, no Slack SDK.

import { randomUUID }                from 'crypto';
import { respond, err }              from '../shared/lambda-utils.mjs';
import { getRows, insertRow }        from '../shared/serv-client.mjs';
import { enqueueWorkflow }           from '../shared/sqs-callback.mjs';
import { readPrincipal, canSeeRun }  from './principal.mjs';

export const RUNS_DEFAULT_LIMIT = 20;
export const RUNS_MAX_LIMIT     = 100;
const STATUSES    = ['pending', 'running', 'awaiting_human_gate', 'awaiting_llm_break', 'completed', 'failed', 'cancelled'];
const RUN_COLUMNS = ['id', 'workflow_id', 'label', 'status', 'started_at', 'created_at', 'callback'];

/**
 * @returns {{ workflow: string|null, domain: string|null, status: string|null, limit: number, before: number|null } | { error: string }}
 */
export function parseRunsQuery(query = {}) {
  const whole  = v => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
  const limit  = query.limit  === undefined ? RUNS_DEFAULT_LIMIT : whole(query.limit);
  const before = query.before === undefined ? null : whole(query.before);
  if (Number.isNaN(limit) || limit < 1 || limit > RUNS_MAX_LIMIT) return { error: `limit must be between 1 and ${RUNS_MAX_LIMIT}` };
  if (Number.isNaN(before)) return { error: 'before must be a run id' };
  if (query.status !== undefined && !STATUSES.includes(query.status)) return { error: `status must be one of ${STATUSES.join(', ')}` };
  return { workflow: query.workflow || null, domain: query.domain || null, status: query.status ?? null, limit, before };
}

/**
 * One run as a list entry (RunSummary).
 *
 * @param {object} r     A PGC_WorkflowRun row (RUN_COLUMNS)
 * @param {object} [wf]  Its workflow { name, display }
 */
export function toRunSummary(r, wf) {
  return {
    runId:         r.id,
    workflowName:  wf?.name ?? null,
    workflowLabel: wf?.display?.label ?? null,
    label:         r.label ?? null,
    status:        r.status,
    startedAt:     r.started_at ?? r.created_at,
  };
}

/**
 * Shape one page from up to limit + 1 runs, newest first. Runs the principal may not see are
 * dropped after the bound, so the cursor is the last run examined, not the last returned.
 *
 * @param {object[]} rows        PGC_WorkflowRun rows (RUN_COLUMNS)
 * @param {Map<number, object>} workflows  id → { name, display }
 */
export function toRunsPage(rows, workflows, principal, limit) {
  const examined = rows.slice(0, limit);
  const runs = examined.filter(r => canSeeRun(principal, r)).map(r => toRunSummary(r, workflows.get(r.workflow_id)));
  return { runs, cursor: examined.length ? examined[examined.length - 1].id : null, more: rows.length > limit };
}

async function listRuns(principal, { workflow, domain, status, limit, before }) {
  const filters = [];
  if (workflow || domain) {
    const wfFilters = [];
    if (workflow) wfFilters.push({ column: 'name',   op: 'eq', value: workflow });
    if (domain)   wfFilters.push({ column: 'domain', op: 'eq', value: domain });
    const wfs = await getRows('PGC_Workflow', wfFilters, undefined, undefined, undefined, ['id']);
    const ids = (wfs.rows ?? []).map(w => w.id);
    if (!ids.length) return { runs: [], cursor: null, more: false };
    filters.push({ column: 'workflow_id', op: 'in', value: ids });
  }
  if (status)          filters.push({ column: 'status', op: 'eq', value: status });
  if (before !== null) filters.push({ column: 'id',     op: 'lt', value: before });

  const runResp = await getRows('PGC_WorkflowRun', filters, 'id DESC', limit + 1, undefined, RUN_COLUMNS);
  const rows    = runResp.rows ?? [];
  const wfIds   = [...new Set(rows.map(r => r.workflow_id))];
  const wfResp  = wfIds.length
    ? await getRows('PGC_Workflow', [{ column: 'id', op: 'in', value: wfIds }], undefined, undefined, undefined, ['id', 'name', 'display'])
    : { rows: [] };
  const workflows = new Map((wfResp.rows ?? []).map(w => [w.id, w]));
  return toRunsPage(rows, workflows, principal, limit);
}

/**
 * One run, checked against the principal as the list is.
 *
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function getRun(principal, runId) {
  const runResp = await getRows('PGC_WorkflowRun', [{ column: 'id', op: 'eq', value: runId }], undefined, 1, undefined, RUN_COLUMNS);
  const run     = runResp.rows?.[0];
  if (!run) return { status: 404, body: { error: 'run_not_found' } };
  if (!canSeeRun(principal, run)) return { status: 403, body: { error: 'run_forbidden' } };
  const wfResp = await getRows('PGC_Workflow', [{ column: 'id', op: 'eq', value: run.workflow_id }], undefined, 1, undefined, ['id', 'name', 'display']);
  return { status: 200, body: toRunSummary(run, wfResp.rows?.[0]) };
}

/**
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function startRun(principal, body = {}, traceId = randomUUID()) {
  if (!principal.roles.includes('household')) return { status: 403, body: { error: 'household_required' } };
  const { workflow } = body;
  if (!workflow || typeof workflow !== 'string') return { status: 400, body: { error: 'missing_fields', message: 'workflow is required' } };

  const wfResp = await getRows('PGC_Workflow', [{ column: 'name', op: 'eq', value: workflow }],
    { column: 'version', direction: 'desc' }, 1, undefined, ['id', 'domain']);
  const wf = wfResp.rows?.[0];
  if (!wf || wf.domain == null) return { status: 404, body: { error: 'workflow_not_found' } };

  const runResp = await insertRow('PGC_WorkflowRun', {
    workflow_id:  wf.id,
    trace_id:     traceId,
    triggered_by: 'web',
    status:       'pending',
    input:        { domain: wf.domain },
    stack:        [],
    state:        {},
    callback:     { provider: 'web', channel: principal.user },
  });
  const runId = runResp.row.id;

  await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: runId, traceId });
  console.info('proc/runs: run started from the web', { workflow, workflowRunId: runId, traceId });
  return { status: 202, body: { runId } };
}

export async function handle(req) {
  const segments = (req.proxy || '').split('/').filter(Boolean);
  const runId    = /^[1-9][0-9]*$/.test(segments[1] ?? '') ? Number(segments[1]) : null;
  const isOne    = req.method === 'GET' && segments.length === 2 && runId !== null;
  if (segments.length > 1 && !isOne) return err(404, `runs route not found: ${req.method} /${req.proxy}`, req.correlationId);

  const principal = readPrincipal(req.headers);
  if (!principal) return respond(401, { success: false, error: 'principal_required' }, req.correlationId);

  if (isOne) {
    const { status, body } = await getRun(principal, runId);
    return respond(status, { success: status === 200, ...body }, req.correlationId);
  }
  if (req.method === 'GET') {
    const query = parseRunsQuery(req.query);
    if (query.error) return respond(400, { success: false, error: 'invalid_query', message: query.error }, req.correlationId);
    return respond(200, { success: true, ...(await listRuns(principal, query)) }, req.correlationId);
  }
  if (req.method === 'POST') {
    const { status, body } = await startRun(principal, req.body ?? {}, req.correlationId);
    return respond(status, { success: status === 202, ...body }, req.correlationId);
  }
  return err(404, `runs route not found: ${req.method} /${req.proxy}`, req.correlationId);
}
