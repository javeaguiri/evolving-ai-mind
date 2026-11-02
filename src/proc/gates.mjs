// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/gates.mjs
//
// POST /api/v1/proc/gates/{runId}/responses — answer the gate a run is waiting at, from any
// surface: the web app, and Novia's answer_gate. Slack answers through interactive.mjs, which
// enqueues the same resume_gate message.
//
// A gate is answered by run AND gate (docs/arch-web-app.md §2.2): the answer names the
// gate_id its frame received when it was pushed, and an answer for any other gate is refused
// here, and again in resumeGate when the message is applied. A form's number fields are read
// with the rule Slack applies (src/shared/number-rule.mjs), so /proc only ever sees numbers.
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { randomUUID }                    from 'crypto';
import { respond, err }                  from '../shared/lambda-utils.mjs';
import { getRows }                       from '../shared/serv-client.mjs';
import { enqueueWorkflow }               from '../shared/sqs-callback.mjs';
import { numberRule, readNumber }        from '../shared/number-rule.mjs';
import { resolveFormFields }             from './step-executor.mjs';

const isEmpty = v => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Check an answer against the run it is for, and build the resume_gate message.
 *
 * @param {object|null} run   PGC_WorkflowRun row ({ id, status, stack, callback }), or null
 * @param {object} body       { gateId, action, formValues?, inputValue?, listGroup?, selectedValue? }
 * @returns {{ status: number, body: object } | { message: object }}
 */
export function checkGateResponse(run, body = {}) {
  const { gateId, action, formValues, inputValue, listGroup, selectedValue } = body;
  if (!gateId || !action) {
    return { status: 400, body: { error: 'gateId and action are required' } };
  }
  if (!run) return { status: 404, body: { error: 'run_not_found' } };

  const stack = Array.isArray(run.stack) ? run.stack : [];
  const frame = stack[stack.length - 1];
  if (run.status !== 'awaiting_human_gate' || frame?.type !== 'human_gate') {
    return { status: 409, body: { error: 'gate_not_waiting', status: run.status } };
  }
  if (gateId !== frame.gate_id) {
    return { status: 409, body: { error: 'gate_moved', waitingGateId: frame.gate_id ?? null } };
  }

  let values = formValues;
  if (frame.gate_type === 'form' && action !== 'cancel' && formValues && typeof formValues === 'object') {
    values = { ...formValues };
    const invalid = [];
    for (const field of resolveFormFields(frame.step_ref ?? {}, frame.local_state ?? {})) {
      if (field?.type !== 'number' || isEmpty(values[field.name])) continue;
      const read = readNumber(String(values[field.name]), numberRule(field));
      if (read.problem !== undefined) invalid.push({ name: field.name, problem: read.problem });
      else values[field.name] = read.value;
    }
    if (invalid.length > 0) return { status: 422, body: { error: 'invalid_fields', fields: invalid } };
  }

  const responseData = {
    ...(values        !== undefined ? { formValues: values } : {}),
    ...(inputValue    !== undefined ? { inputValue }        : {}),
    ...(listGroup     !== undefined ? { listGroup }         : {}),
    ...(selectedValue !== undefined ? { selectedValue }     : {}),
  };
  return {
    message: {
      type:          'WORKFLOW_STEP',
      action:        'resume_gate',
      workflowRunId: run.id,
      gateId,
      userResponse:  action,
      ...(Object.keys(responseData).length > 0 && { responseData }),
      callback:      run.callback ?? null,
    },
  };
}

/**
 * Answer a gate: check it, then enqueue resume_gate. Shared by the HTTP route and by Novia.
 *
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function answerGate(runId, body, traceId) {
  const resp = await getRows('PGC_WorkflowRun', [{ column: 'id', op: 'eq', value: runId }],
    undefined, 1, undefined, ['id', 'status', 'stack', 'callback']);
  const checked = checkGateResponse(resp.rows?.[0] ?? null, body);
  if (!checked.message) return checked;

  await enqueueWorkflow({ ...checked.message, traceId, enqueuedAt: new Date().toISOString() });
  console.info('proc/gates: answer accepted, resume_gate enqueued', {
    workflowRunId: runId, gateId: body.gateId, action: body.action, traceId,
  });
  return { status: 202, body: { runId } };
}

export async function handle(req) {
  const traceId  = req.traceId ?? req.correlationId ?? randomUUID();
  const segments = (req.proxy || '').split('/').filter(Boolean);
  const runId    = Number(segments[1]);

  if ((req.method ?? 'POST') !== 'POST' || segments.length !== 3 || segments[2] !== 'responses' || !Number.isInteger(runId)) {
    return err(404, `gates route not found: ${req.method} /${req.proxy}`, req.correlationId);
  }

  const { status, body } = await answerGate(runId, req.body ?? {}, traceId);
  return respond(status, { success: status === 202, ...body }, req.correlationId);
}
