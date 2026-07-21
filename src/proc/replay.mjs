// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/replay.mjs
//
// LLM replay harness endpoints (docs/arch-replay.md §9). Transport-agnostic PROC module —
// no AWS SDK. Three routes, dispatched by proxy segments (the last-segment req.route model
// cannot express /replay/{runId}/resume):
//
//   POST /proc/replay                 start a replay or record run  → new runId
//   GET  /proc/replay/{runId}         status + break report when broken
//   POST /proc/replay/{runId}/resume  supply a resolution, enqueue resume_llm
//
// A FOURTH entry point of identical shape to create-domain / create-workflow /
// classify-intent handoff (arch-replay.md §9): insert a PGC_WorkflowRun with workflow_id +
// input, enqueue execute_top. It never re-executes the source in place and never copies the
// source's session entries — recordings are looked up by content fingerprint.

import { randomUUID }                    from 'crypto';
import { ok, err }                       from '../shared/lambda-utils.mjs';
import { getRows, insertRow, updateRows } from '../shared/serv-client.mjs';
import { enqueueWorkflow, enqueueCallback } from '../shared/sqs-callback.mjs';

const BREAK_POLICIES = ['never', 'on_miss', 'always'];
const RESOLUTIONS    = ['use_recorded', 'call_live', 'supplied', 'abort'];

/**
 * Pure route parser — which replay action a request maps to. Exported for unit testing.
 * `segments` is the proxy path split on '/', first element already known to be 'replay'.
 */
export function parseReplayRoute(method, segments) {
  const runId  = segments[1];
  const action = segments[2];
  if (method === 'POST' && runId === undefined)                    return { action: 'start' };
  if (method === 'GET'  && runId !== undefined && action === undefined) return { action: 'get', runId };
  if (method === 'POST' && runId !== undefined && action === 'resume')  return { action: 'resume', runId };
  return { action: null };
}

export async function handle(req) {
  const traceId = req.traceId ?? req.correlationId ?? randomUUID();

  // SQS path — a REPLAY message from the /replay Slack command. sourceRunId present →
  // start a replay; absent → list recent runs. (Record-from-scratch is HTTP-only, §9.)
  if (req.source === 'sqs') {
    return (req.body?.sourceRunId != null) ? startReplay(req, traceId) : listReplays(req, traceId);
  }

  // HTTP path — dispatch by proxy segments (path params the last-segment model can't express).
  const segments = (req.proxy || '').split('/').filter(Boolean);
  const { action, runId } = parseReplayRoute(req.method ?? 'POST', segments);

  switch (action) {
    case 'start':  return startReplay(req, traceId);
    case 'get':    return getReplay(req, Number(runId), traceId);
    case 'resume': return resumeReplay(req, Number(runId), traceId);
    default:       return err(404, `replay route not found: ${req.method} /${req.proxy}`, req.correlationId);
  }
}

// POST /proc/replay  (HTTP)  |  REPLAY message with sourceRunId  (SQS, from /replay Slack cmd)
async function startReplay(req, traceId) {
  const { sourceRunId, workflow, input, breakPolicy } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const fail = (code, msg) => {
    if (req.source === 'sqs') {
      if (callback) enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', message: `❌ Replay failed — ${msg}`, traceId });
      return;
    }
    return err(code, msg, req.correlationId);
  };

  if (!BREAK_POLICIES.includes(breakPolicy)) {
    return fail(400, `breakPolicy must be one of: ${BREAK_POLICIES.join(', ')}`);
  }

  let workflowId;
  let runInput;
  let srcId = null;

  if (sourceRunId != null) {
    const src = await getRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: sourceRunId }], undefined, 1, undefined, ['id', 'workflow_id', 'input']);
    if (!src.success || src.count === 0) return fail(404, `source run ${sourceRunId} not found`);
    workflowId = src.rows[0].workflow_id;
    runInput   = src.rows[0].input;
    srcId      = sourceRunId;
  } else {
    if (!workflow || input === undefined) {
      return fail(400, 'sourceRunId omitted — workflow and input are required');
    }
    const wf = await getRows('PGC_Workflow',
      [{ column: 'name', op: 'eq', value: workflow }], undefined, 1, undefined, ['id']);
    if (!wf.success || wf.count === 0) return fail(404, `workflow "${workflow}" not found`);
    workflowId = wf.rows[0].id;
    runInput   = input;
  }

  const runResp = await insertRow('PGC_WorkflowRun', {
    workflow_id:          workflowId,
    trace_id:             traceId,
    triggered_by:         'api',
    status:               'running',
    input:                runInput,
    callback:             callback ?? null,
    llm_break_policy:     breakPolicy,
    replay_source_run_id: srcId,
    started_at:           new Date().toISOString(),
  });
  if (!runResp.success) return fail(500, `Failed to insert replay run: ${runResp.error}`);

  const runId = runResp.row.id;
  console.info('proc/replay: replay run created', { runId, sourceRunId: srcId, breakPolicy, traceId });

  await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: runId, traceId });

  if (req.source === 'sqs') {
    if (callback) {
      const src = srcId != null ? `replaying run ${srcId}` : 'record from scratch';
      await enqueueCallback(callback, {
        type:          'HUMAN_NOTIFICATION',
        workflowRunId: runId,
        message:       `🔁 Replay run *${runId}* started — ${src}, policy \`${breakPolicy}\`. Breaks post here; inspect/resume over HTTP at \`/api/v1/proc/replay/${runId}\`.`,
        traceId,
      });
    }
    return;
  }
  return ok({ runId, status: 'running' }, req.correlationId);
}

// REPLAY message with NO sourceRunId (SQS, from `/replay` with no arg) — list recent runs
// so a developer can pick one. Replayability (a fingerprinted corpus) is confirmed at
// replay time by whether the run breaks, not pre-checked here.
async function listReplays(req, traceId) {
  const callback = req.callback ?? req.body?.callback ?? null;

  const runsResp = await getRows('PGC_WorkflowRun', [],
    { column: 'id', direction: 'desc' }, 15, undefined, ['id', 'workflow_id', 'status', 'replay_source_run_id']);
  const runs = runsResp.success ? (runsResp.rows ?? []) : [];

  const wfResp = await getRows('PGC_Workflow', [], undefined, 500, undefined, ['id', 'name']);
  const names  = {};
  if (wfResp.success) for (const w of wfResp.rows ?? []) names[w.id] = w.name;

  const lines = ['*Recent runs* — `/replay <id>` to replay · `/replay <id> record` to record:', ''];
  for (const r of runs) {
    const tag = r.replay_source_run_id != null ? ` _(replay of ${r.replay_source_run_id})_` : '';
    lines.push(`• \`${r.id}\`  ${names[r.workflow_id] ?? 'workflow ' + r.workflow_id}  — ${r.status}${tag}`);
  }
  if (runs.length === 0) lines.push('_(no runs yet)_');

  if (callback) {
    await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', message: lines.join('\n'), traceId });
  }
  console.info('proc/replay: listed recent runs', { count: runs.length, traceId });
}

// GET /proc/replay/{runId}
async function getReplay(req, runId, traceId) {
  const resp = await getRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: runId }], undefined, 1, undefined, ['id', 'status', 'stack', 'replay_source_run_id']);
  if (!resp.success || resp.count === 0) return err(404, `replay run ${runId} not found`, req.correlationId);

  const run  = resp.rows[0];
  const top  = Array.isArray(run.stack) && run.stack.length ? run.stack[run.stack.length - 1] : null;

  let report = null;
  if (run.status === 'awaiting_llm_break' && top?.type === 'llm_break' && top.break) {
    const b = top.break;
    report = {
      step_id:              b.step_id,
      intent_category:      b.intent_category,
      reason:               b.reason,
      policy:               b.policy,
      drift:                b.drift ?? null,
      instructions:         b.instructions,        // the assembled prompt — served from the frame, not PGC_Session
      fingerprint:          b.fingerprint?.components ?? null,
      candidate_session_id: b.candidate_session_id ?? null,
      candidate_ids:        b.candidate_ids ?? null,
      // A6 — computed once at the seam, where both sides were already in hand, and stashed on
      // the frame. Recomputing it here would make the report a second derivation of one truth
      // (checklist rule 2e) and cost a SERV read to re-fetch what the lookup already had.
      input_diff:           b.input_diff ?? null,
      // A9/A12 — disposition (how to treat use_recorded) and blast radius (which downstream
      // steps a drifted key reaches) are stashed on the frame too, read here rather than
      // re-derived. blast_radius is added by run-workflow at break time (it needs the steps).
      disposition:          b.disposition ?? null,
      blast_radius:         b.blast_radius ?? null,
    };
  }

  return ok({ runId: run.id, status: run.status, break: report }, req.correlationId);
}

// POST /proc/replay/{runId}/resume
/**
 * Shape of a resume body, independent of the run — checked before the run is read.
 * Pure; returns an error message or null.
 */
export function validateResumeBody({ resolution, response, breakPolicy, sessionId } = {}) {
  if (!RESOLUTIONS.includes(resolution))                          return `resolution must be one of: ${RESOLUTIONS.join(', ')}`;
  if (resolution === 'supplied' && response === undefined)        return 'resolution=supplied requires a response';
  if (breakPolicy !== undefined && !BREAK_POLICIES.includes(breakPolicy)) return `breakPolicy must be one of: ${BREAK_POLICIES.join(', ')}`;
  if (sessionId !== undefined) {
    if (resolution !== 'use_recorded')                            return 'sessionId applies only to resolution=use_recorded';
    if (!Number.isInteger(sessionId) || sessionId <= 0)           return 'sessionId must be a positive integer';
  }
  return null;
}

/**
 * A named recording must be one the break offered for this step. Without this a mistyped id
 * serves an unrelated response and the run continues looking correct — the silently-wrong-hit
 * failure the fingerprint exists to prevent (arch-replay.md §3). Pure; returns a message or null.
 * `offeredIds` is absent when no candidate set was read (breakPolicy: always), in which case
 * naming a recording is an explicit developer assertion and is accepted — `response_source`
 * and `replayed_from_session_id` record exactly which was used.
 */
export function validateNamedRecording(sessionId, offeredIds) {
  if (sessionId === undefined || !Array.isArray(offeredIds)) return null;
  if (offeredIds.includes(sessionId)) return null;
  return `sessionId ${sessionId} is not a recording of this step — offered: ${offeredIds.join(', ')}`;
}

async function resumeReplay(req, runId, traceId) {
  const { resolution, response, breakPolicy, sessionId } = req.body ?? {};

  const bodyError = validateResumeBody(req.body ?? {});
  if (bodyError) return err(400, bodyError, req.correlationId);

  const resp = await getRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: runId }], undefined, 1, undefined, ['id', 'status', 'stack']);
  if (!resp.success || resp.count === 0) return err(404, `replay run ${runId} not found`, req.correlationId);

  const run = resp.rows[0];
  if (run.status !== 'awaiting_llm_break') {
    return err(409, `run ${runId} is not awaiting an llm break (status: ${run.status})`, req.correlationId);
  }
  const stack = run.stack;
  const top   = stack[stack.length - 1];
  if (!top || top.type !== 'llm_break') {
    return err(409, `run ${runId} has no llm_break frame on top`, req.correlationId);
  }

  const namedError = validateNamedRecording(sessionId, top.break?.candidate_ids);
  if (namedError) return err(400, namedError, req.correlationId);

  // Write the resolution (and any supplied response) onto the break frame — a
  // design_workflow_process response can approach SQS's 256KB limit, so it rides on the
  // jsonb frame, never in the resume_llm message, which carries only workflowRunId.
  top.resolution = resolution;
  top.response   = response ?? null;
  top.session_id = sessionId ?? null;

  const updates = { stack };
  if (breakPolicy !== undefined) updates.llm_break_policy = breakPolicy;
  await updateRows('PGC_WorkflowRun', [{ column: 'id', op: 'eq', value: runId }], updates);

  await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'resume_llm', workflowRunId: runId, traceId });
  console.info('proc/replay: resume enqueued', { runId, resolution, breakPolicy: breakPolicy ?? null, traceId });
  return ok({ runId, resolution, status: 'resuming' }, req.correlationId);
}
