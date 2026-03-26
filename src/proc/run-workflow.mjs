// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/run-workflow.mjs
// Handles POST /api/v1/proc/run-workflow (HTTP test path) and
//         WORKFLOW_STEP SQS WorkflowQueue messages (production path).
//
// The Step Processor — generic, declarative execution of any workflow
// defined in PGC_Workflow.steps. No workflow-specific code here.
//
// Three SQS actions:
//   execute_top  — load top stack frame, execute current step, advance
//   resume_gate  — receive user response to a human_gate, apply mutation
//                  or pop frame and advance
//   cancel       — mark run cancelled
//
// Stack discipline:
//   - Each execute_top is one SQS hop — one step per message
//   - human_gate suspends by pushing a gate frame; resume_gate pops it
//   - iterator pushes an iterator frame (sequential, one item at a time)
//   - Stack persisted to PGC_WorkflowRun.stack after every mutation
//
// Idempotency:
//   - Before executing, check PGC_WorkflowRunStep for (run_id, frame_id, step_key)
//   - step_key is the string step key — "3a", "3b", "3d" etc. — stored in the
//     step_key text column added by migrate-step-key.mjs
//   - If found — SQS redelivery — apply stuck-step guard and re-enqueue
//
// Transport-agnostic — no AWS SDK, no Slack SDK.
// All SQS operations go through sqs-callback.mjs.

import { randomUUID }           from 'crypto';
import { ok, err }              from '../shared/lambda-utils.mjs';
import { enqueueCallback, enqueueWorkflow }
                                from '../shared/sqs-callback.mjs';
import { getRows, insertRow, updateRows }
                                from '../shared/serv-client.mjs';
import { executeStep, buildDialog }
                                from './step-executor.mjs';
import { resolvePath }          from './template-resolver.mjs';

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export async function handle(req) {
  const body    = req.body ?? {};
  const traceId = req.traceId ?? req.correlationId ?? randomUUID();
  const action  = body.action ?? 'execute_top';
  const workflowRunId = body.workflowRunId;

  if (!workflowRunId) {
    return err(400, 'workflowRunId is required', req.correlationId);
  }

  try {
    const result = await dispatch({
      action,
      workflowRunId,
      userResponse: body.userResponse,
      responseData: body.responseData,
      traceId,
      source: req.source ?? 'http',
    });
    if (req.source === 'http') return ok(result, req.correlationId);
  } catch (error) {
    console.error('run-workflow: unhandled error', { error: error.message, traceId });
    if (req.source === 'http') {
      return err(500, `run-workflow failed: ${error.message}`, req.correlationId);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// SQS dispatch — called by handler.mjs for WORKFLOW_STEP messages
// ---------------------------------------------------------------------------

export async function dispatchSqs(message) {
  const { action, workflowRunId, userResponse, responseData, message_ts, traceId } = message;
  return dispatch({ action, workflowRunId, userResponse, responseData, message_ts, traceId, source: 'sqs' });
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

async function dispatch({ action, workflowRunId, userResponse, responseData, message_ts, traceId, source }) {
  switch (action) {
    case 'execute_top': return executeTop({ workflowRunId, traceId, source });
    case 'resume_gate': return resumeGate({ workflowRunId, userResponse, responseData, message_ts, traceId, source });
    case 'cancel':      return cancelRun({ workflowRunId, traceId });
    default:
      throw new Error(`run-workflow: unknown action "${action}"`);
  }
}

// ---------------------------------------------------------------------------
// execute_top
// ---------------------------------------------------------------------------

async function executeTop({ workflowRunId, traceId, source }) {

  const run = await loadRun(workflowRunId, traceId);

  // Shutdown contract — Step Processor must check status before executing any step.
  // If /shutdown fired while this message was in-flight, discard without executing.
  if (run.status === 'cancelled') {
    console.info('run-workflow: run cancelled — discarding execute_top', { workflowRunId, traceId });
    return { skipped: true, reason: 'cancelled' };
  }

  // Guard against SQS retries re-executing a run already marked failed.
  // Iterator item errors mark the run failed then rethrow — SQS retries the message
  // 3× before DLQ. Without this check, each retry attempts the same failed item again.
  if (run.status === 'failed') {
    console.info('run-workflow: run already failed — discarding execute_top', { workflowRunId, traceId });
    return { skipped: true, reason: 'failed' };
  }

  // Initialise root frame on first call
  if (run.stack.length === 0) {
    const rootFrame = {
      frame_id:      randomUUID(),
      type:          'workflow',
      status:        'running',
      workflow_name: run.workflow_name,
      current_step:  '1',
      local_state:   { ...(run.state?.local_state ?? {}), input: run.input ?? {} },
      on_complete:   'end',
      pushed_at:     new Date().toISOString(),
    };
    run.stack.push(rootFrame);
    await persistStack(run);
  }

  // If top is an iterator frame — execute the next item
  const top = topFrame(run);
  if (top.type === 'iterator') {
    return executeIteratorItem({ run, traceId });
  }

  const frame = top;
  const steps = await loadSteps(run.workflow_name, traceId);
  const step  = findStep(steps, frame.current_step);

  if (!step) {
    throw new Error(`step "${frame.current_step}" not found in workflow "${run.workflow_name}"`);
  }

  // Idempotency check
  const alreadyRan = await checkIdempotency(run.id, frame.frame_id, frame.current_step);
  if (alreadyRan) {
    // Lightweight Guard 1 — stuck-step detection.
    // If the same step keeps hitting idempotency, the workflow routing is broken.
    // Track consecutive hits in run.error.stuck_step / stuck_count (no schema change).
    // After 3 hits on the same step, fail the run and notify the user.
    const stuck      = run.error ?? {};
    const sameStep   = stuck.stuck_step === frame.current_step;
    const stuckCount = sameStep ? (stuck.stuck_count ?? 1) + 1 : 1;

    if (stuckCount >= 3) {
      const msg = `Workflow stuck at step "${frame.current_step}" — possible routing error in workflow definition. Run id: ${run.id}`;
      console.error('run-workflow: stuck-step limit reached — failing run', {
        workflowRunId: run.id, step: frame.current_step, stuckCount, traceId,
      });
      await updateRows('PGC_WorkflowRun',
        [{ column: 'id', op: 'eq', value: run.id }],
        { status: 'failed', error: { stuck_step: frame.current_step, stuck_count: stuckCount, message: msg } }
      );
      if (run.callback) {
        await enqueueCallback(run.callback, {
          type:          'WORKFLOW_ERROR',
          workflowRunId: run.id,
          step:          frame.current_step,
          message:       msg,
          traceId,
        });
      }
      return { skipped: true, reason: 'stuck' };
    }

    // Not yet at limit — record the hit and re-enqueue
    console.warn('run-workflow: idempotency hit — possible stuck step', {
      workflowRunId: run.id, step: frame.current_step, stuckCount, traceId,
    });
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { error: { stuck_step: frame.current_step, stuck_count: stuckCount } }
    );
    await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId });
    return { skipped: true };
  }

  console.info('run-workflow: execute_top', {
    workflowRunId: run.id, workflowName: run.workflow_name,
    step: frame.current_step, stepType: step.type, traceId,
  });

  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    { status: 'running' }
  );

  const stepStart = Date.now();
  let result;

  try {
    result = await executeStep({ step, localState: frame.local_state, run, traceId });
  } catch (stepError) {
    await recordStepAudit(run.id, frame.frame_id, frame.current_step, step.type,
      'failed', null, null, stepError.message, Date.now() - stepStart);
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { status: 'failed', error: { step: frame.current_step, message: stepError.message } }
    );
    if (source === 'sqs' && run.callback) {
      await enqueueCallback(run.callback, {
        type: 'WORKFLOW_ERROR', workflowRunId: run.id,
        step: frame.current_step, message: `Step ${frame.current_step} failed: ${stepError.message}`,
        traceId,
      });
    }
    throw stepError;
  }

  const durationMs = Date.now() - stepStart;

  // Write step audit row
  await recordStepAudit(
    run.id, frame.frame_id, frame.current_step, step.type,
    'completed',
    { step: frame.current_step, type: step.type },
    result.outputValue ? { summary: JSON.stringify(result.outputValue).slice(0, 200) } : null,
    null, durationMs
  );

  // Clear any stuck-step state now that a step executed successfully
  if (run.error?.stuck_step) {
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { error: null }
    );
  }

  // Persist output_key → local_state
  if (step.output_key && result.outputValue !== null && result.outputValue !== undefined) {
    setPath(frame.local_state, step.output_key, result.outputValue);
  }

  // ── Handle iterator ────────────────────────────────────────────────────
  if (result.nextAction === 'iterator') {
    return startIterator({ step, frame, run, traceId });
  }

  // ── Handle human_gate suspension ───────────────────────────────────────
  if (result.nextAction === 'suspend' && result.gatePayload) {
    const gateFrame = {
      frame_id:      randomUUID(),
      type:          'human_gate',
      status:        'awaiting',
      gate_type:     step.gate_type,
      step_ref:      step,
      step_number:   frame.current_step,
      workflow_name: run.workflow_name,
      local_state:   frame.local_state,
      pushed_at:     new Date().toISOString(),
    };
    run.stack.push(gateFrame);

    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      {
        status:     'awaiting_human_gate',
        stack:      run.stack,
        state:      { local_state: frame.local_state },
        step_count: (run.step_count ?? 0) + 1,
      }
    );

    await enqueueCallback(run.callback, result.gatePayload);

    console.info('run-workflow: human_gate suspended', {
      workflowRunId: run.id, gateType: step.gate_type, traceId,
    });
    return { action: 'suspended', gateType: step.gate_type };
  }

  // ── Handle notify ──────────────────────────────────────────────────────
  if (step.type === 'notify' && result.notifyMessage) {
    await enqueueCallback(run.callback, {
      type:          step.notify_type ?? 'WORKFLOW_NOTIFY',
      workflowRunId: run.id,
      message:       result.notifyMessage,
      traceId,
    });
  }

  // ── Handle end ─────────────────────────────────────────────────────────
  if (result.nextAction === 'end' || step.type === 'end') {
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      {
        status:       'completed',
        completed_at: new Date().toISOString(),
        stack:        [],
        state:        { local_state: frame.local_state },
        step_count:   (run.step_count ?? 0) + 1,
      }
    );
    console.info('run-workflow: workflow completed', { workflowRunId: run.id, traceId });
    return { action: 'completed' };
  }

  // ── Advance to next step ───────────────────────────────────────────────
  const nextStepKey = resolveNextStep(steps, frame.current_step, result.nextAction);
  frame.current_step = nextStepKey;

  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    {
      stack:      run.stack,
      state:      { local_state: frame.local_state },
      step_count: (run.step_count ?? 0) + 1,
    }
  );

  await enqueueWorkflow({
    type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId,
  });

  return { action: 'advanced', nextStep: nextStepKey };
}

// ---------------------------------------------------------------------------
// resume_gate
// ---------------------------------------------------------------------------

async function resumeGate({ workflowRunId, userResponse, responseData, message_ts, traceId, source }) {

  const run   = await loadRun(workflowRunId, traceId);
  const frame = topFrame(run);

  if (!frame || frame.type !== 'human_gate') {
    console.warn('run-workflow: resume_gate — no gate frame on top', {
      workflowRunId, topType: frame?.type, traceId,
    });
    return { skipped: true, reason: 'no_gate_frame' };
  }

  if (run.status !== 'awaiting_human_gate') {
    console.warn('run-workflow: resume_gate — not awaiting (duplicate?)', {
      workflowRunId, status: run.status, traceId,
    });
    return { skipped: true, reason: 'not_awaiting' };
  }

  const { gate_type: gateType, step_ref: stepRef, local_state: localState } = frame;

  console.info('run-workflow: resume_gate', {
    workflowRunId: run.id, gateType, userResponse, traceId,
  });

  // ── remove_item — mutate, re-render, stay suspended ────────────────────
  if (userResponse === 'remove_item') {
    if (!responseData?.tableName) {
      throw new Error('resume_gate remove_item: responseData.tableName is required');
    }

    const contextItems = resolvePath(localState, stepRef.context_key) ?? [];
    const filtered     = contextItems.filter(
      item => item[stepRef.item_primary_key] !== responseData.tableName
    );
    setPath(localState, stepRef.context_key, filtered);
    frame.local_state = localState;

    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { stack: run.stack, state: { local_state: localState } }
    );

    const updatedDialog = buildDialog(stepRef, localState);
    await enqueueCallback(run.callback, {
      type:          'WORKFLOW_GATE',
      workflowRunId: run.id,
      gate_type:     gateType,
      dialog:        updatedDialog,
      callback:      run.callback,
      message_ts,    // present on remove_item — signals callback.mjs to chat.update in-place
      traceId,
    });

    console.info('run-workflow: remove_item — gate re-rendered', {
      workflowRunId: run.id, removed: responseData.tableName,
      remaining: filtered.length, traceId,
    });
    return { action: 'remove_item', remaining: filtered.length };
  }

  // ── cancel ─────────────────────────────────────────────────────────────
  if (userResponse === 'cancel') {
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { status: 'cancelled', stack: [], completed_at: new Date().toISOString() }
    );
    if (run.callback) {
      await enqueueCallback(run.callback, {
        type: 'WORKFLOW_CANCELLED', workflowRunId: run.id,
        message: 'Workflow cancelled.', traceId,
      });
    }
    console.info('run-workflow: cancelled', { workflowRunId: run.id, traceId });
    return { action: 'cancelled' };
  }

  // ── confirm (or any option that advances) ─────────────────────────────
  const matchedOption = (stepRef.options ?? []).find(o => o.action === userResponse);
  const onSelect      = matchedOption?.on_select ?? 'next';

  // For text_input gates, write the typed value to local_state[output_key]
  // before popping the frame. The value arrives in responseData.inputValue
  // (extracted from payload.state.values by interactive.mjs).
  if (gateType === 'text_input' && responseData?.inputValue && stepRef.output_key) {
    setPath(localState, stepRef.output_key, responseData.inputValue);
    frame.local_state = localState;
    console.info('run-workflow: text_input value written to local_state', {
      output_key: stepRef.output_key,
      valueLength: responseData.inputValue.length,
      traceId,
    });
  }

  // Pop gate frame
  run.stack.pop();
  const parentFrame = topFrame(run);

  if (parentFrame) {
    parentFrame.local_state = localState;
    const steps    = await loadSteps(run.workflow_name, traceId);
    const nextStep = resolveOnSelect(steps, frame.step_number, onSelect);
    parentFrame.current_step = nextStep;
  }

  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    {
      status:     'running',
      stack:      run.stack,
      state:      { local_state: localState },
      step_count: (run.step_count ?? 0) + 1,
    }
  );

  await enqueueWorkflow({
    type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId,
  });

  console.info('run-workflow: gate confirmed — advancing', {
    workflowRunId: run.id, onSelect, traceId,
  });
  return { action: 'confirmed', onSelect };
}

// ---------------------------------------------------------------------------
// Iterator
// ---------------------------------------------------------------------------

async function startIterator({ step, frame, run, traceId }) {
  const items = resolvePath(frame.local_state, step.items_key) ?? [];

  if (items.length === 0) {
    const steps    = await loadSteps(run.workflow_name, traceId);
    const nextStep = resolveNextStep(steps, frame.current_step, step.on_complete ?? 'next');
    frame.current_step = nextStep;
    await persistStack(run);
    await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId });
    return { action: 'iterator_empty' };
  }

  const iterFrame = {
    frame_id:      randomUUID(),
    type:          'iterator',
    status:        'running',
    workflow_name: run.workflow_name,
    item_step:     step.item_step,
    items_key:     step.items_key,
    output_key:    step.output_key,
    on_complete:   step.on_complete ?? 'next',
    parent_step:   frame.current_step,
    items:         items,
    current_index: 0,
    results:       [],
    local_state:   frame.local_state,
    pushed_at:     new Date().toISOString(),
  };
  run.stack.push(iterFrame);

  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    { stack: run.stack, state: { local_state: frame.local_state }, step_count: (run.step_count ?? 0) + 1 }
  );

  await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId });
  return { action: 'iterator_started', total: items.length };
}

async function executeIteratorItem({ run, traceId }) {
  const frame = topFrame(run);
  const item  = frame.items[frame.current_index];

  if (!item) {
    // All items done — pop iterator frame, write output_key, advance parent
    const results = frame.results;
    run.stack.pop();
    const parentFrame = topFrame(run);

    if (parentFrame && frame.output_key) {
      setPath(parentFrame.local_state, frame.output_key, results);
    }

    if (parentFrame) {
      const steps    = await loadSteps(run.workflow_name, traceId);
      const nextStep = resolveNextStep(steps, frame.parent_step, frame.on_complete);
      parentFrame.current_step = nextStep;
    }

    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      {
        stack:      run.stack,
        state:      { local_state: parentFrame?.local_state ?? {} },
        step_count: (run.step_count ?? 0) + 1,
      }
    );

    await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId });
    return { action: 'iterator_complete', results };
  }

  // Execute item_step with item injected into local_state as 'item'
  const itemLocalState = { ...frame.local_state, item };
  const itemStep       = frame.item_step;

  console.info('run-workflow: iterator item', {
    workflowRunId: run.id,
    index:         frame.current_index,
    total:         frame.items.length,
    tableName:     item.tableName,
    traceId,
  });

  const stepStart = Date.now();
  let result;

  try {
    result = await executeStep({ step: itemStep, localState: itemLocalState, run, traceId });
  } catch (itemError) {
    await recordStepAudit(
      run.id, frame.frame_id, frame.current_index,
      itemStep.type, 'failed', { tableName: item.tableName }, null,
      itemError.message, Date.now() - stepStart
    );
    // Mark the run failed and notify the user before rethrowing.
    // Without this, the error propagates to the SQS handler, retries 3×,
    // goes to DLQ, and the user receives no notification.
    const msg = `Iterator step "${frame.parent_step}" failed creating table "${item.tableName}": ${itemError.message}. Run id: ${run.id}`;
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { status: 'failed', error: { step: frame.parent_step, tableName: item.tableName, message: itemError.message } }
    );
    if (run.callback) {
      await enqueueCallback(run.callback, {
        type:          'WORKFLOW_ERROR',
        workflowRunId: run.id,
        step:          frame.parent_step,
        message:       msg,
        traceId,
      });
    }
    throw itemError;
  }

  await recordStepAudit(
    run.id, frame.frame_id, frame.current_index,
    itemStep.type, 'completed',
    { tableName: item.tableName },
    result.outputValue ? { summary: JSON.stringify(result.outputValue).slice(0, 100) } : null,
    null, Date.now() - stepStart
  );

  frame.results.push(result.outputValue ?? { tableName: item.tableName, status: 'created' });
  frame.current_index++;

  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    { stack: run.stack, step_count: (run.step_count ?? 0) + 1 }
  );

  // Enqueue next item (or completion)
  await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId });
  return { action: 'iterator_item_done', index: frame.current_index - 1 };
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

async function cancelRun({ workflowRunId, traceId }) {
  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: workflowRunId }],
    { status: 'cancelled', stack: [], completed_at: new Date().toISOString() }
  );
  console.info('run-workflow: cancelled', { workflowRunId, traceId });
  return { action: 'cancelled' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadRun(workflowRunId, traceId) {
  const resp = await getRows(
    'PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: workflowRunId }],
    undefined, 1
  );
  if (!resp.success || resp.count === 0) {
    throw new Error(`WorkflowRun ${workflowRunId} not found`);
  }
  const run = resp.rows[0];

  // Resolve workflow name if not cached in run
  if (!run.workflow_name) {
    const wfResp = await getRows(
      'PGC_Workflow',
      [{ column: 'id', op: 'eq', value: run.workflow_id }],
      undefined, 1
    );
    run.workflow_name = wfResp.rows?.[0]?.name ?? 'unknown';
  }

  run.state            = run.state ?? {};
  run.state.local_state = run.state.local_state ?? {};
  return run;
}

async function loadSteps(workflowName, traceId) {
  const resp = await getRows(
    'PGC_Workflow',
    [{ column: 'name', op: 'eq', value: workflowName }],
    undefined, 1
  );
  if (!resp.success || resp.count === 0) {
    throw new Error(`Workflow "${workflowName}" not found in PGC_Workflow`);
  }
  return resp.rows[0].steps ?? [];
}

function findStep(steps, stepKey) {
  return steps.find(s => String(s.step) === String(stepKey)) ?? null;
}

function topFrame(run) {
  return run.stack.length > 0 ? run.stack[run.stack.length - 1] : null;
}

async function persistStack(run) {
  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    { stack: run.stack, state: { local_state: topFrame(run)?.local_state ?? {} } }
  );
}

async function checkIdempotency(runId, frameId, stepKey) {
  // Use step_key (text) — step_number integer collapses "3a"/"3b"/"3d" to 3,
  // causing false positive idempotency hits across branching workflow steps.
  const resp = await getRows(
    'PGC_WorkflowRunStep',
    [
      { column: 'run_id',   op: 'eq', value: runId   },
      { column: 'frame_id', op: 'eq', value: frameId },
      { column: 'step_key', op: 'eq', value: String(stepKey) },
    ],
    undefined, 1
  );
  return resp.success && resp.count > 0;
}

async function recordStepAudit(runId, frameId, stepNumber, stepType,
    status, inputSnapshot, outputSnapshot, errorMsg, durationMs) {
  await insertRow('PGC_WorkflowRunStep', {
    run_id:          runId,
    frame_id:        frameId,
    step_number:     parseInt(stepNumber, 10) || 0,  // kept for iterator items (integer index)
    step_key:        String(stepNumber),              // string key — "3a", "3d", "1", etc.
    step_type:       stepType,
    status,
    input_snapshot:  inputSnapshot ?? null,
    output_snapshot: outputSnapshot ?? null,
    error:           errorMsg ? { message: errorMsg } : null,
    duration_ms:     durationMs,
  });
}

function resolveNextStep(steps, currentStepKey, nextAction) {
  if (nextAction === 'end')            return 'end';
  if (nextAction?.startsWith('step:')) return nextAction.slice(5);
  const idx = steps.findIndex(s => String(s.step) === String(currentStepKey));
  if (idx === -1 || idx === steps.length - 1) return 'end';
  return String(steps[idx + 1].step);
}

function resolveOnSelect(steps, currentStepKey, onSelect) {
  if (onSelect === 'cancel')           return 'cancel';
  if (onSelect === 'end')              return 'end';
  if (onSelect?.startsWith('step:'))   return onSelect.slice(5);
  return resolveNextStep(steps, currentStepKey, 'next');
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
