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
import { executeStep, buildDialog, resolveGateOptions }
                                from './step-executor.mjs';
import { resolvePath }          from './template-resolver.mjs';
import { extractTemplateRefs }  from './simulation-engine.mjs';
import { shouldWriteEpisodicMemory } from './memory-writer.mjs';

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
  const { action, workflowRunId, userResponse, responseData, message_ts, traceId, stepExecutionId } = message;
  return dispatch({ action, workflowRunId, userResponse, responseData, message_ts, traceId, source: 'sqs', stepExecutionId });
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

async function dispatch({ action, workflowRunId, userResponse, responseData, message_ts, traceId, source, stepExecutionId }) {
  switch (action) {
    case 'execute_top': return executeTop({ workflowRunId, traceId, source, stepExecutionId });
    case 'resume_gate': return resumeGate({ workflowRunId, userResponse, responseData, message_ts, traceId, source });
    case 'resume_llm':  return resumeLlm({ workflowRunId, traceId });
    case 'cancel':      return cancelRun({ workflowRunId, traceId });
    default:
      throw new Error(`run-workflow: unknown action "${action}"`);
  }
}

// ---------------------------------------------------------------------------
// execute_top
// ---------------------------------------------------------------------------

async function executeTop({ workflowRunId, traceId, source, stepExecutionId }) {

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

  // Guard against stale SQS execute_top messages arriving after the run completed.
  // Without this check, the completed run has an empty stack (cleared at completion),
  // so executeTop would push a new root frame and re-execute the workflow from step 1.
  if (run.status === 'completed') {
    console.info('run-workflow: run already completed — discarding execute_top', { workflowRunId, traceId });
    return { skipped: true, reason: 'completed' };
  }

  // Guard against SQS redelivery executing a step while the run is suspended at a
  // human_gate. Without this check, a redelivered execute_top re-executes the gate
  // step and posts a second HUMAN_GATE message to Slack. The user sees two
  // identical gate messages — clicking the second one leaves the first with
  // buttons permanently visible since chat.update targets the clicked message's ts,
  // not the orphaned earlier one.
  if (run.status === 'awaiting_human_gate') {
    console.info('run-workflow: run awaiting human gate — discarding execute_top', { workflowRunId, traceId });
    return { skipped: true, reason: 'awaiting_human_gate' };
  }

  // Same shield for a replay break (docs/arch-replay.md §5). A break suspends the run at
  // a developer, exactly like a human_gate suspends at a user. A redelivered execute_top
  // that arrives while suspended must not re-execute the seam and break (or serve) a
  // second time. resume_llm transitions the run to 'running' before re-enqueuing, so a
  // legitimate resume passes this guard; only stray redeliveries are discarded.
  if (run.status === 'awaiting_llm_break') {
    console.info('run-workflow: run awaiting llm break — discarding execute_top', { workflowRunId, traceId });
    return { skipped: true, reason: 'awaiting_llm_break' };
  }

  // Initialise root frame on first call
  if (run.stack.length === 0) {
    const rootFrame = {
      frame_id:      randomUUID(),
      type:          'workflow',
      status:        'running',
      workflow_name: run.workflow_name,
      current_step:  '1',
      local_state:   { input: run.input ?? {} },
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

  // If top is a resolved replay break frame — resume it (docs/arch-replay.md §5). The
  // resolution (and any supplied response) were written onto the frame by the resume
  // endpoint (A5). Thread them into re-execution of the underlying llm_call step: the
  // break wrote no audit row, so the step re-runs rather than being idempotency-blocked.
  let breakResolution = null;
  if (top.type === 'llm_break') {
    const resolution = top.resolution;
    if (!resolution) {
      console.warn('run-workflow: llm_break frame has no resolution — skipping', { workflowRunId: run.id, traceId });
      return { skipped: true, reason: 'llm_break_unresolved' };
    }
    if (resolution === 'abort') {
      run.stack.pop();
      await updateRows('PGC_WorkflowRun',
        [{ column: 'id', op: 'eq', value: run.id }],
        { status: 'cancelled', stack: [], completed_at: new Date().toISOString() }
      );
      if (run.callback) {
        await enqueueCallback(run.callback, {
          type: 'HUMAN_NOTIFICATION', workflowRunId: run.id,
          message: `Replay run ${run.id} aborted at the break.`, traceId,
        });
      }
      console.info('run-workflow: llm_break aborted', { workflowRunId: run.id, traceId });
      return { action: 'cancelled' };
    }
    breakResolution = { ...(top.break ?? {}), resolution, response: top.response, session_id: top.session_id ?? null };
    run.stack.pop();
    await persistStack(run);
  }

  const frame = topFrame(run);
  const steps = await loadSteps(run.workflow_name, traceId);
  const step  = findStep(steps, frame.current_step);

  if (!step) {
    const msg = `step "${frame.current_step}" not found in workflow "${run.workflow_name}"`;
    console.error('run-workflow: step not found — failing run', {
      workflowRunId: run.id, step: frame.current_step, traceId,
    });
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { status: 'failed', error: { step: frame.current_step, message: msg } }
    );
    if (source === 'sqs' && run.callback) {
      await enqueueCallback(run.callback, {
        type: 'WORKFLOW_ERROR', workflowRunId: run.id,
        step: frame.current_step, message: msg,
        traceId,
      });
    }
    // Tier 1 self-repair — broken routing target produced an invalid step key
    await enqueueWorkflow({
      type:         'TROUBLESHOOT_WORKFLOW',
      workflowName: run.workflow_name,
      stackTrace:   msg,
      autoFix:      true,
      traceId,
      callback:     run.callback,
    });
    return { skipped: true, reason: 'step_not_found' };
  }

  // Idempotency check — use stepExecutionId when present so loop re-entries
  // (same step key, new iteration) are not blocked by prior-iteration audit rows.
  const idempotencyKey = stepExecutionId ?? String(frame.current_step);
  const alreadyRan = await checkIdempotency(run.id, frame.frame_id, idempotencyKey);
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
      // Tier 1 self-repair — diagnose the workflow that just failed
      await enqueueWorkflow({
        type:         'TROUBLESHOOT_WORKFLOW',
        workflowName: run.workflow_name,
        stackTrace:   msg,
        autoFix:      true,
        traceId,
        callback:     run.callback,
      });
      return { skipped: true, reason: 'stuck' };
    }

    // stuckCount === 1: first idempotency hit on this step.
    // The original Lambda already executed this step and enqueued the next
    // execute_top. Re-enqueueing here duplicates that message and sustains any
    // burst that reached this path — the amplifier behind recursive loop
    // detection. Discard silently; the run advances via the already-enqueued
    // continuation.
    const likelyCause = (source === 'sqs' && !sameStep) ? 'sqs_redelivery' : 'routing_loop_start';
    console.warn('run-workflow: idempotency hit — discarding duplicate', {
      workflowRunId: run.id,
      step:          frame.current_step,
      stuckCount,
      likelyCause,
      source,
      traceId,
    });
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { error: { stuck_step: frame.current_step, stuck_count: stuckCount } }
    );
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
    result = await executeStep({ step, localState: frame.local_state, run, traceId, breakResolution });
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
    // Tier 1 self-repair — only for structural errors, not transient LLM response failures.
    // LLM errors (invalid JSON, timeout, empty response) and validation failures indicate
    // a prompt or service quality issue — TROUBLESHOOT_WORKFLOW analyses workflow definition
    // structure and cannot fix those.
    //
    // Tier 1b — Agent API 400 on an llm_call step means output_schema is incompatible
    // with the structured output spec. DIAGNOSE_PROMPT_SCHEMA runs a deterministic repair
    // and presents a human confirmation gate before writing the fix.
    //
    // System workflow guard: self-repair workflows (fix_workflow, diagnose_prompt_schema)
    // must not re-enter the repair loop when they themselves fail. They are the repair
    // layer — recursing into TROUBLESHOOT_WORKFLOW or DIAGNOSE_PROMPT_SCHEMA from inside
    // them causes an infinite loop. Log the failure only.
    const SYSTEM_REPAIR_WORKFLOWS = new Set(['fix_workflow', 'diagnose_prompt_schema']);
    const isSystemRepairWorkflow  = SYSTEM_REPAIR_WORKFLOWS.has(run.workflow_name);

    const isApiSchemaError = !isSystemRepairWorkflow
      && step.type === 'llm_call' && /Agent API error 400/i.test(stepError.message);
    const isLlmError = isApiSchemaError
      || /LLM (returned|call timed)|llm_call validation failed/i.test(stepError.message);

    if (isApiSchemaError && step.input?.prompt) {
      await enqueueWorkflow({
        type:           'DIAGNOSE_PROMPT_SCHEMA',
        intentCategory: step.input.prompt,
        workflowRunId:  run.id,
        traceId,
        callback:       run.callback,
      });
    } else if (!isLlmError && !isSystemRepairWorkflow) {
      await enqueueWorkflow({
        type:         'TROUBLESHOOT_WORKFLOW',
        workflowName: run.workflow_name,
        stackTrace:   `Step ${frame.current_step} (${step.type}) failed: ${stepError.message}`,
        autoFix:      true,
        traceId,
        callback:     run.callback,
      });
    } else if (isSystemRepairWorkflow) {
      console.error('run-workflow: system repair workflow failed — suppressing recursive repair', {
        workflowName: run.workflow_name, step: frame.current_step,
        error: stepError.message, traceId,
      });
    }
    throw stepError;
  }

  // ── Handle replay break (docs/arch-replay.md §5) ───────────────────────────
  // MUST run before the audit write: a break leaves NO 'completed' audit row, so on
  // resume the step re-executes rather than being idempotency-blocked (unlike a
  // human_gate, which records its audit before suspending because it never re-runs).
  // Reuses the human_gate suspension machinery — push a frame, set status, notify,
  // return without enqueuing a continuation. A hard halt: only resume_llm moves it.
  if (result.nextAction === 'llm_break' && result.breakPayload) {
    // A12 — name the downstream llm_call steps a drifted key also reaches, so the notification
    // does not promise "keeps the suffix free" for a key several later steps read. Computed here
    // because `steps` (the workflow definition) is in scope only in run-workflow; stashed on the
    // payload so the notification and the GET report both read it off the frame (checklist 2e).
    result.breakPayload.blast_radius = computeBlastRadius(
      steps, frame.current_step, drivenInputKeys(result.breakPayload.input_diff)
    );
    const breakFrame = {
      frame_id:      randomUUID(),
      type:          'llm_break',
      status:        'awaiting',
      step_number:   frame.current_step,
      workflow_name: run.workflow_name,
      break:         result.breakPayload,
      local_state:   frame.local_state,
      pushed_at:     new Date().toISOString(),
    };
    run.stack.push(breakFrame);

    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      {
        status:     'awaiting_llm_break',
        stack:      run.stack,
        step_count: (run.step_count ?? 0) + 1,
      }
    );

    if (run.callback) {
      await enqueueCallback(run.callback, buildBreakNotification(run, result.breakPayload, traceId));
    }

    console.info('run-workflow: llm_call break suspended', {
      workflowRunId: run.id, step: frame.current_step, reason: result.breakPayload.reason, traceId,
    });
    return { action: 'llm_break', step: frame.current_step };
  }

  const durationMs = Date.now() - stepStart;

  // Write step audit row — step_key uses idempotencyKey so redeliveries match this row.
  await recordStepAudit(
    run.id, frame.frame_id, frame.current_step, step.type,
    'completed',
    { step: frame.current_step, type: step.type },
    result.outputValue ? { summary: JSON.stringify(result.outputValue).slice(0, 200) } : null,
    null, durationMs, idempotencyKey
  );

  // Clear any stuck-step state now that a step executed successfully
  if (run.error?.stuck_step) {
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { error: null }
    );
  }

  // Persist output_key → local_state.
  // Comma-separated output_key (e.g. "a,b,c") destructures an object return value into
  // multiple top-level local_state keys simultaneously.
  //
  // `null` is a value, not an absence: a step that initialises a key to null (create_workflow
  // step 20a) is declaring "this key exists and is empty". Dropping it left the key missing
  // from local_state, and template resolution renders a missing key as the literal token —
  // so the LLM received the string "{{user_workflow_feedback}}" as the user's feedback.
  // Only `undefined` (the step produced no output) skips the write.
  if (step.output_key && typeof step.output_key === 'string' && result.outputValue !== undefined) {
    const outKeys = step.output_key.split(',').map(k => k.trim());
    if (outKeys.length > 1 && typeof result.outputValue === 'object' && result.outputValue !== null) {
      for (const key of outKeys) {
        if (key in result.outputValue) setPath(frame.local_state, key, result.outputValue[key]);
      }
    } else {
      setPath(frame.local_state, step.output_key, result.outputValue);
    }
  }

  // ── Handle iterator ────────────────────────────────────────────────────
  if (result.nextAction === 'iterator') {
    return startIterator({ step, frame, run, traceId });
  }

  // ── Handle human_gate suspension ───────────────────────────────────────
  if (result.nextAction === 'suspend' && result.gatePayload) {
    // step.options may be a {{template}} string (e.g. a level-dependent button set) —
    // resolve it once here, before persisting step_ref, so resume_gate can always
    // assume options is a live array. Same treatment as the iterator item_step suspend
    // path below (executeIteratorInline) for a nested human_gate's options.
    const rawOptions = step.options;
    const resolvedOptions = (typeof rawOptions === 'string' && rawOptions.startsWith('{{'))
      ? (resolvePath(frame.local_state, rawOptions.replace(/^\{\{|\}\}$/g, '')) ?? [])
      : (rawOptions ?? []);
    const resolvedStepRef = { ...step, options: resolvedOptions };
    const gateFrame = {
      frame_id:      randomUUID(),
      type:          'human_gate',
      status:        'awaiting',
      gate_type:     step.gate_type,
      step_ref:      resolvedStepRef,
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
      type:          step.notify_type ?? 'HUMAN_NOTIFICATION',
      workflowRunId: run.id,
      message:       result.notifyMessage,
      format:        'markdown',
      traceId,
      ...(result.notifyReveals ? { reveals: result.notifyReveals } : {}),
    });
  }

  // ── Handle cancel ──────────────────────────────────────────────────────
  // A regular step (e.g. a condition's on_else) can route to 'cancel', same
  // control token human_gate options already use — mirrors resumeGate's
  // inline cancel handling below rather than the standalone SQS 'cancel'
  // dispatch (cancelRun), which has no run to notify a callback against yet.
  if (result.nextAction === 'cancel') {
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { status: 'cancelled', stack: [], completed_at: new Date().toISOString() }
    );
    if (run.callback) {
      await enqueueCallback(run.callback, {
        type: 'HUMAN_NOTIFICATION', workflowRunId: run.id,
        message: 'Workflow cancelled.', traceId,
      });
    }
    console.info('run-workflow: cancelled', { workflowRunId: run.id, traceId });
    return { action: 'cancelled' };
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
    if (shouldWriteEpisodicMemory(run)) {
      await enqueueWorkflow({
        type:         'MEMORY_WRITE',
        runId:        run.id,
        workflowName: run.workflow_name,
        domain:       run.input?.domain ?? null,
        traceId,
      });
    }
    return { action: 'completed' };
  }

  // ── Advance to next step ───────────────────────────────────────────────
  const nextStepKey = resolveNextStep(steps, frame.current_step, result.nextAction);
  frame.current_step = nextStepKey;

  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    {
      stack:      run.stack,
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

  // ── cancel ─────────────────────────────────────────────────────────────
  // An option's ROUTING comes from its on_select, never from its action name. A gate must
  // carry an option with action "cancel" (the routing rules require one), but a workflow is
  // free to point that option somewhere other than the exit — live edit_budget labels it
  // "Edit More" and routes it back to the category picker with on_select "11". Cancelling
  // the run on the action name alone ignored that and killed the workflow instead of going
  // back, which is the same "the action name carries behaviour" mistake removed from
  // item_action. So: only cancel when the matched option actually routes to cancel, or when
  // nothing matched (a bare Cancel click with no option behind it).
  const cancelOption = userResponse === 'cancel'
    ? [...resolveGateOptions(stepRef, localState), ...(stepRef.special_buttons ?? [])]
        .find(o => o.action === 'cancel')
    : null;
  const cancelRoutesAway = cancelOption?.on_select && cancelOption.on_select !== 'cancel';

  if (userResponse === 'cancel' && !cancelRoutesAway) {
    await updateRows('PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: run.id }],
      { status: 'cancelled', stack: [], completed_at: new Date().toISOString() }
    );
    if (run.callback) {
      await enqueueCallback(run.callback, {
        type: 'HUMAN_NOTIFICATION', workflowRunId: run.id,
        message: 'Workflow cancelled.', traceId,
      });
    }
    console.info('run-workflow: cancelled', { workflowRunId: run.id, traceId });
    return { action: 'cancelled' };
  }

  // ── confirm (or any option that advances) ─────────────────────────────
  // choice gate uses option.value (HTML radio semantics); all others use option.action.
  // stepRef.options is always a resolved array by this point — a {{template}} options
  // field is resolved once when the gate frame is pushed (see the two suspend sites),
  // never lazily here.
  const isChoice      = gateType === 'choice';
  // resolveGateOptions, not stepRef.options — an option carrying `iterator` is one
  // option per data row, and its value is still "{{year}}-{{month}}" until resolved.
  // Matching the raw list could never match the "2026-07" the user actually picked.
  // This is the same list buildDialog rendered, from the same resolver, so what the
  // user saw and what we match against cannot disagree.
  const allOptions    = [...resolveGateOptions(stepRef, localState), ...(stepRef.special_buttons ?? [])];

  // Past a handful of options, callback.mjs draws a choice gate as a dropdown plus a
  // Select button rather than one button per option — a rendering decision, made there.
  // The Select button therefore carries no option value of its own; the chosen option
  // arrives in state.values as responseData.selectedValue. Resolve it back to the option
  // before anything matches on userResponse, so the gate behaves identically either way.
  // Guarded on 'cancel': a user who picks a month and then clicks Cancel means Cancel.
  let choiceResponse = userResponse;
  if (isChoice && userResponse !== 'cancel' && responseData?.selectedValue) {
    choiceResponse = responseData.selectedValue;
  }

  const matchedOption = allOptions.find(o =>
    isChoice ? o.value === choiceResponse : o.action === choiceResponse
  );

  // A choice gate must never advance on a value that matches no option — clicking Select
  // with nothing chosen would otherwise fall through to the default 'next' route and skip
  // the decision entirely. Re-render in place instead, the same stay-suspended pattern
  // list_selection and form use.
  if (isChoice && !matchedOption && choiceResponse !== 'cancel') {
    const dialogForRetry = buildDialog(stepRef, localState);
    dialogForRetry.fields.unshift({
      type:  'typography',
      value: '⚠️ Choose an option before selecting.',
    });
    await enqueueCallback(run.callback, {
      type:          'HUMAN_GATE',
      workflowRunId: run.id,
      gate_type:     gateType,
      dialog:        dialogForRetry,
      callback:      run.callback,
      traceId,
    });
    console.info('run-workflow: choice — no option selected, gate re-rendered', {
      workflowRunId: run.id, userResponse, traceId,
    });
    return { action: 'choice_unselected' };
  }
  // True when this resume carries text typed into a modal. Used only to decide where the
  // modal's value is written (an option-level output_key). It is NOT a signal that a modal
  // was dismissed — a dismissed modal never resumes the gate at all (interactive.mjs's
  // handleViewClosed leaves it suspended), and every plain button click also has no
  // inputValue. Reading it as "the modal was cancelled" is what made on_modal_close a trap.
  const hasModalInput = !!responseData?.inputValue;
  // A row's own action button click routes via item_action.on_select directly —
  // never via a matching options[] entry, since every options[] entry also
  // renders as its own visible bottom button (would duplicate the per-row
  // button). Gated only on item_action.on_select being present, not on
  // gate_type: whether a row click advances (drill-down) or does something
  // else entirely is the calling workflow's concern, not this gate's.
  const itemActionMatch = stepRef.item_action?.action === userResponse && stepRef.item_action?.on_select
    ? stepRef.item_action
    : null;

  // list_selection's Select button is a single shared control (Sprint 7 Track D —
  // markdown table + one picker, replacing one accessory button per row, which was
  // throwing msg_blocks_too_long above ~8 rows). The click identifies no row by
  // itself — the chosen row rides in Slack's state.values — so resolve it here
  // against context_key's fully-resolved items (reusing buildDialog's own item_action
  // application rather than re-implementing it) before the advance logic below runs.
  // A selection that doesn't resolve to a selectable row re-renders the same gate in
  // place with an error line — it never silently advances on an unresolved value.
  if (itemActionMatch) {
    // The click carries one of two things, depending on which control callback.mjs
    // rendered for this list. Normally it's a static_select's chosen option
    // (responseData.selectedValue — a JSON {id, table} payload), which pins the row's
    // source table alongside its id, so a level spanning more than one child table
    // can't resolve a colliding id to the wrong table's row. Past Slack's 100-option
    // cap the list falls back to a shared text box, and the click carries a bare typed
    // id (responseData.inputValue) with no table — there, a collision still resolves
    // first-hit, unchanged and acceptable at this app's scale.
    let selected = null;
    if (responseData?.selectedValue) {
      try {
        selected = JSON.parse(responseData.selectedValue);
      } catch {
        selected = null;
      }
    }
    const typedId = responseData?.inputValue?.trim();

    const dialogForLookup = buildDialog(stepRef, localState);
    const listItems = dialogForLookup.fields.find(f => f.type === 'list')?.items ?? [];

    let matchedItem = null;
    if (selected) {
      matchedItem = listItems.find(item =>
        item.secondaryAction
        && String(item.id) === String(selected.id)
        && (item.responseData?.table ?? null) === (selected.table ?? null)
      ) ?? null;
    } else if (typedId) {
      matchedItem = listItems.find(item => item.secondaryAction && String(item.id) === typedId) ?? null;
    }

    if (!matchedItem) {
      dialogForLookup.fields.unshift({
        type:  'typography',
        value: selected
          ? '⚠️ That selection no longer matches a row in this list — please try again.'
          : typedId
            ? `⚠️ No selectable row with ID "${typedId}" — please check and try again.`
            : '⚠️ Choose a record before selecting.',
      });
      await enqueueCallback(run.callback, {
        type:          'HUMAN_GATE',
        workflowRunId: run.id,
        gate_type:     gateType,
        dialog:        dialogForLookup,
        callback:      run.callback,
        message_ts,
        traceId,
      });
      console.info('run-workflow: list_selection — unresolved selection, gate re-rendered', {
        workflowRunId: run.id, selected, typedId, traceId,
      });
      return { action: 'list_selection_invalid' };
    }

    responseData = Object.prototype.hasOwnProperty.call(matchedItem, 'responseData')
      ? matchedItem.responseData
      : { tableName: matchedItem.id };
  }

  // form gate — write the collected field map to output_key. Slack enforces a field's
  // `optional` flag only on *modal* submit; a message's Submit button performs no
  // validation at all, so required fields are checked here. A gap re-renders the gate
  // rather than advancing with a hole in the data, mirroring list_selection's
  // unresolved-selection path. Cancel skips validation — you can always back out.
  if (gateType === 'form' && userResponse !== 'cancel') {
    const values  = responseData?.formValues ?? {};
    const isEmpty = v => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
    const missing = (stepRef.fields ?? [])
      .filter(f => f.optional !== true && isEmpty(values[f.name]))
      .map(f => f.label ?? f.name);

    if (missing.length > 0) {
      const dialogForForm = buildDialog(stepRef, localState);
      dialogForForm.fields.unshift({
        type:  'typography',
        value: `⚠️ Please complete: ${missing.join(', ')}.`,
      });
      // Deliberately no message_ts: the re-render posts a fresh gate rather than
      // editing in place. Slack's chat.update is unreliable on a message carrying
      // input blocks, and a silently-dropped edit would look identical to a hang.
      await enqueueCallback(run.callback, {
        type:          'HUMAN_GATE',
        workflowRunId: run.id,
        gate_type:     gateType,
        dialog:        dialogForForm,
        callback:      run.callback,
        traceId,
      });
      console.info('run-workflow: form — required fields missing, gate re-rendered', {
        workflowRunId: run.id, missing, traceId,
      });
      return { action: 'form_incomplete', missing };
    }

    if (stepRef.output_key) {
      setPath(localState, stepRef.output_key, values);
      frame.local_state = localState;
      console.info('run-workflow: form values written to local_state', {
        workflowRunId: run.id, output_key: stepRef.output_key,
        fields: Object.keys(values), traceId,
      });
    }
  }

  // on_modal_close removed (D5). It was unreachable AND a trap. Unreachable because a
  // dismissed modal never resumes the gate at all — interactive.mjs's handleViewClosed
  // deliberately enqueues nothing and leaves the gate suspended, which is the correct
  // behaviour and what the Sprint 6 fix established. A trap because `hasModalInput` is
  // false for ANY plain button click, so an option declaring on_modal_close would have
  // hijacked a normal click and routed there instead of on_select. Zero live workflows
  // used it; workflow-schema.json advertised it anyway. Same shape as remove_item and
  // edit_list: a capability that does not work is worse than one that does not exist.
  const onSelect = matchedOption?.on_select ?? itemActionMatch?.on_select ?? 'next';

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

  // followup_prompt gate: write modal inputValue to output_key — same semantics as text_input.
  if (gateType === 'followup_prompt' && responseData?.inputValue && stepRef.output_key) {
    setPath(localState, stepRef.output_key, responseData.inputValue);
    frame.local_state = localState;
  }

  // choice gate: write selected value to output_key (parallel to text_input).
  // When responseData.inputValue is present (modal submission), prefer it over userResponse
  // so the typed text — not the button name — is written to the state key.
  // confirm gate with context_key: write userResponse to output_key (dynamic domain selection).
  if (isChoice && stepRef.output_key) {
    // choiceResponse, not userResponse — under dropdown rendering the click carries the
    // Select button's action, and the real answer is the option chosen in state.values.
    const selectionValue = responseData?.inputValue ?? choiceResponse;
    setPath(localState, stepRef.output_key, selectionValue);
    frame.local_state = localState;
    console.info('run-workflow: choice gate — selection written to local_state', {
      output_key: stepRef.output_key,
      selection:  selectionValue,
      traceId,
    });
  }

  // option-level output_key: options that carry a modal descriptor can declare
  // output_key to write the modal's inputValue directly into local_state, allowing
  // the workflow to route to an llm_call step without a redundant downstream
  // text_input gate. Applies to all gate types including choice.
  if (matchedOption?.output_key && hasModalInput) {
    setPath(localState, matchedOption.output_key, responseData.inputValue);
    frame.local_state = localState;
    console.info('run-workflow: option output_key — modal inputValue written to local_state', {
      output_key:  matchedOption.output_key,
      valueLength: responseData.inputValue.length,
      traceId,
    });
  }

  // For dynamic confirm gates (context_key present), always write userResponse to
  // output_key — regardless of whether userResponse matched a static option.
  // The previous guard (!matchedOption) caused selections that happened to share an
  // action name with a static option (e.g. "system") to bypass the write entirely,
  // leaving output_key undefined in local_state for downstream steps.
  if (gateType === 'confirm' && stepRef.context_key && stepRef.output_key) {
    setPath(localState, stepRef.output_key, userResponse);
    frame.local_state = localState;
    console.info('run-workflow: dynamic confirm gate — selection written to local_state', {
      output_key: stepRef.output_key,
      selection:  userResponse,
      traceId,
    });
  }

  // A row was selected and the gate's item_action declares on_select — an "advance"
  // action (e.g. drill-down). responseData is the matched row's own payload, resolved
  // just above from the shared picker. Write it to output_key before the generic
  // matchedOption/on_select advance below routes to wherever item_action.on_select
  // points.
  if (itemActionMatch && stepRef.output_key) {
    // Legacy rows never set their own responseData, so callback.mjs sends the
    // { tableName } shape by default — write the bare scalar, exactly as before.
    // Rows that carry a workflow-supplied responseData (no tableName key, e.g.
    // { table, id, hasChildren } for recursive drill-down) get written through whole.
    const hasLegacyShape = responseData && Object.prototype.hasOwnProperty.call(responseData, 'tableName');
    const value = hasLegacyShape ? responseData.tableName : responseData;
    setPath(localState, stepRef.output_key, value);
    frame.local_state = localState;
    console.info('run-workflow: list_selection item_action — clicked row value written to local_state', {
      output_key: stepRef.output_key,
      value,
      traceId,
    });
  }

  // action_key — record WHICH option the user chose, for any gate type.
  //
  // Every other gate already surfaces its selection: choice writes the picked value,
  // dynamic confirm writes userResponse, list_selection writes the clicked row,
  // text_input writes the typed text. A `form` gate could not: output_key is spoken for
  // by the field values, so the button was used for routing and then discarded.
  //
  // That made a save-and-continue loop undesignable. Run 719's edit_budget needed
  // "Update persists and re-shows the form" and "Done persists and exits" — both must go
  // through the SAME write, so the decision has to survive the write and be read by a
  // condition afterwards. The designer wrote {{edit_action}} and noted it was "tracked via
  // a hidden mechanism or gate action value": it knew exactly what it needed, and the
  // harness did not have it. Routing the two buttons to separate chains instead would
  // duplicate the serv_upsert; making Done skip the write would lose the user's edits.
  //
  // Writes the option's `value` — its identity — falling back to `action`. `label` is
  // display text and is never the contract.
  if (stepRef.action_key && matchedOption) {
    const actionValue = matchedOption.value ?? matchedOption.action;
    setPath(localState, stepRef.action_key, actionValue);
    frame.local_state = localState;
    console.info('run-workflow: gate action written to local_state', {
      workflowRunId: run.id, action_key: stepRef.action_key, value: actionValue, traceId,
    });
  }

  // Pop gate frame
  run.stack.pop();
  const parentFrame = topFrame(run);

  if (parentFrame?.type === 'iterator') {
    // Gate was suspended inside an iterator item_step.
    // Advance the index — do not set current_step (iterator frames use current_index).
    // Strip the item binding injected by executeIteratorInline before merging state back
    // to avoid polluting the iterator frame with the item from the completed gate.
    const { item: _item, ...parentScopedState } = localState;
    parentFrame.local_state = parentScopedState;
    // Collect the gate response into the iterator's results array so that iterator
    // completion writes the full collected array to output_key (not []).
    // Human_gate items never reach the frame.results.push() in executeIteratorInline
    // because they return early on suspend, leaving results empty.
    const completedItem = parentFrame.items[parentFrame.current_index];
    const gateResult    = stepRef.output_key
      ? resolvePath(localState, stepRef.output_key)
      : userResponse;
    parentFrame.results.push(
      completedItem?.id !== undefined
        ? { id: completedItem.id, value: gateResult }
        : gateResult
    );
    parentFrame.current_index++;
    console.info('run-workflow: iterator item gate confirmed — index advanced', {
      workflowRunId: run.id, newIndex: parentFrame.current_index, traceId,
    });
  } else if (parentFrame) {
    parentFrame.local_state = localState;
    const steps    = await loadSteps(run.workflow_name, traceId);
    const nextStep = resolveOnSelect(steps, frame.step_number, onSelect);
    parentFrame.current_step = nextStep;
  }

  // Determine the state snapshot to persist — when the parent is an iterator,
  // use the stripped parent-scoped state (item binding already removed above).
  const persistedState = parentFrame?.type === 'iterator'
    ? (() => { const { item: _i, ...s } = localState; return s; })()
    : localState;

  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    {
      status:     'running',
      stack:      run.stack,
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
// resume_llm — resume a suspended replay break (docs/arch-replay.md §5)
// ---------------------------------------------------------------------------

// The resume endpoint (A5) writes { resolution, response? } onto the top llm_break
// frame, then enqueues resume_llm carrying only workflowRunId. This handler transitions
// the run out of suspension; executeTop's llm_break path then consumes the resolution
// from the frame and re-executes the step. Thin by design — the re-execution is
// executeTop's job, exactly as a normal step's is.
async function resumeLlm({ workflowRunId, traceId }) {
  const run = await loadRun(workflowRunId, traceId);

  if (run.status !== 'awaiting_llm_break') {
    console.warn('run-workflow: resume_llm — not awaiting llm break (duplicate?)', {
      workflowRunId, status: run.status, traceId,
    });
    return { skipped: true, reason: 'not_awaiting_llm_break' };
  }

  const frame = topFrame(run);
  if (!frame || frame.type !== 'llm_break') {
    console.warn('run-workflow: resume_llm — no llm_break frame on top', {
      workflowRunId, topType: frame?.type, traceId,
    });
    return { skipped: true, reason: 'no_break_frame' };
  }

  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    { status: 'running' }
  );
  await enqueueWorkflow({
    type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId,
  });

  console.info('run-workflow: resume_llm — transitioned to running', {
    workflowRunId, resolution: frame.resolution, traceId,
  });
  return { action: 'resumed_llm', resolution: frame.resolution };
}

// Build the break notification (docs/arch-replay.md §5) — the developer interface, not a
// status report. Carries a literal, runnable curl for every resolution: base URL from
// SERV_API_URL (the API Gateway host also serving /proc), $INTERNAL_API_KEY referenced as
// an env var so no key material is ever rendered, and both run IDs labelled. use_recorded
// is offered only when a candidate recording exists (a miss has nothing to accept).
/**
 * A6 — one line naming which `input` keys moved, so the drift is legible without a curl.
 * "drift: input" alone cannot be acted on: a changed step_type_contracts and a materially
 * different question look identical at component level and have opposite right answers.
 * Returns '' when there is nothing useful to say, so the line is omitted rather than empty.
 */
export function summariseInputDrift(inputDiff) {
  if (!inputDiff) return '';
  const fmt = (e) => `${e.key} (${e.chars ?? '?'} chars)`;
  const parts = [];
  if (inputDiff.added?.length)   parts.push(`added: ${inputDiff.added.map(fmt).join(', ')}`);
  if (inputDiff.removed?.length) parts.push(`removed: ${inputDiff.removed.map(fmt).join(', ')}`);
  if (inputDiff.changed?.length) {
    parts.push(`changed: ${inputDiff.changed.map(e => `${e.key} (${e.was_chars ?? '?'}→${e.chars ?? '?'} chars)`).join(', ')}`);
  }
  if (!parts.length) return '';
  // Naming what held still is as load-bearing as naming what moved: "step_type_contracts
  // unchanged" is what tells a developer this is a different question, not a contract edit.
  if (inputDiff.unchanged?.length) parts.push(`unchanged: ${inputDiff.unchanged.join(', ')}`);
  return parts.join('  |  ');
}

/** Recursively collect every string value in a step input (strings may carry {{tokens}}). */
function collectTemplateStrings(input, acc = []) {
  if (typeof input === 'string')        acc.push(input);
  else if (Array.isArray(input))        for (const v of input) collectTemplateStrings(v, acc);
  else if (input && typeof input === 'object') for (const v of Object.values(input)) collectTemplateStrings(v, acc);
  return acc;
}

/** The local_state source roots a step's input references (base key of each {{token}}). */
function inputSourceRoots(input) {
  const roots = new Set();
  for (const str of collectTemplateStrings(input)) {
    for (const ref of extractTemplateRefs(str)) roots.add(ref.split('.')[0].replace(/\[.*/, ''));
  }
  return roots;
}

/** Input keys whose value differs from the recording (added or changed) — the ones that drive
 *  this step's answer differently and may propagate downstream. Empty when input_diff is absent. */
function drivenInputKeys(inputDiff) {
  if (!inputDiff) return [];
  return [...(inputDiff.added ?? []).map(e => e.key), ...(inputDiff.changed ?? []).map(e => e.key)];
}

/**
 * A12 — the downstream reach of a drifted key. `use_recorded` is offered as "keeps the suffix
 * free", which is false when a drifted local_state value also feeds later llm_call steps:
 * accepting the recording here just defers the identical decision to each of them.
 *
 * Pure graph analysis over the workflow definition — no new data, and nothing specific to any one
 * workflow. For each drifted input key it finds the local_state source root the key resolves from
 * at the breaking step, then names every OTHER llm_call step whose input references that same root.
 * Returns { key: [stepId, …] } in step-array order; a key with no other reader is omitted.
 * Exported for unit testing.
 */
export function computeBlastRadius(steps, currentStepId, driftedKeys) {
  if (!Array.isArray(steps) || !Array.isArray(driftedKeys) || driftedKeys.length === 0) return {};
  const current = steps.find(s => String(s.step) === String(currentStepId));
  if (!current) return {};

  const out = {};
  for (const key of driftedKeys) {
    const sourceRoots = inputSourceRoots(current.input?.[key]);
    if (sourceRoots.size === 0) continue;
    const readers = [];
    for (const s of steps) {
      if (s.type !== 'llm_call' || String(s.step) === String(currentStepId)) continue;
      const stepRoots = inputSourceRoots(s.input);
      if ([...sourceRoots].some(r => stepRoots.has(r))) readers.push(String(s.step));
    }
    if (readers.length) out[key] = readers;
  }
  return out;
}

export function buildBreakNotification(run, payload, traceId) {
  const base    = process.env.SERV_API_URL ?? '';
  const runId   = run.id;
  const resume  = `${base}/api/v1/proc/replay/${runId}/resume`;
  const read    = `${base}/api/v1/proc/replay/${runId}`;
  const source  = run.replay_source_run_id != null ? `run ${run.replay_source_run_id}` : '(record — no source run)';
  const driftTxt = Array.isArray(payload.drift) && payload.drift.length ? `  (drift: ${payload.drift.join(', ')})` : '';
  const inputTxt = summariseInputDrift(payload.input_diff);

  const lines = [
    `🛑  Run ${runId} — BROKE at step ${payload.step_id}, awaiting resume`,
    ``,
    `    workflow     ${run.workflow_name}`,
    `    step         ${payload.step_id} · ${payload.intent_category}`,
    `    replaying    ${source}`,
    `    reason       ${payload.reason}${driftTxt}`,
    ...(inputTxt ? [`    input        ${inputTxt}`] : []),
    `    policy       ${payload.policy}`,
    ``,
    `Read the break — assembled prompt, drift, local_state diff:`,
    `  curl -s -H "x-api-key: $INTERNAL_API_KEY" "${read}"`,
  ];
  if (payload.candidate_session_id != null) {
    // A9 — one disposition line governing use_recorded, so its framing reflects what actually
    // moved (a reworded prompt vs. a different question), not an unconditional "free".
    const dispoLines = payload.disposition?.headline ? [payload.disposition.headline] : [];
    // A12 — where a drifted key is read downstream, "keeps the suffix free" is false: name the
    // later readers so accepting is a decision with its real cost visible.
    const blastLines = Object.entries(payload.blast_radius ?? {}).map(
      ([k, readers]) => `   ⤷ ${k} is also read by step${readers.length > 1 ? 's' : ''} ${readers.join(', ')} — accepting here defers that decision, it does not resolve it`,
    );
    const ids = Array.isArray(payload.candidate_ids) ? payload.candidate_ids : [];
    if (ids.length > 1) {
      // Several passes recorded under one step_id and nothing distinguishes them, so the pick is
      // arbitrary (newest first) — offer each by name rather than present a coin flip as a default.
      lines.push(
        ``,
        ...dispoLines,
        `⚠  ${ids.length} recordings for this step — the default pick (${payload.candidate_session_id}) is the newest,`,
        `   not necessarily the one this pass corresponds to. Name the recording:`,
        ...blastLines,
        ...ids.map(id =>
          `  curl -s -X POST -H "x-api-key: $INTERNAL_API_KEY" -H 'content-type: application/json' -d '{"resolution":"use_recorded","sessionId":${id}}' "${resume}"`),
      );
    } else {
      lines.push(
        ``,
        ...dispoLines,
        ...blastLines,
        `Resume with the recorded response:`,
        `  curl -s -X POST -H "x-api-key: $INTERNAL_API_KEY" -H 'content-type: application/json' -d '{"resolution":"use_recorded"}' "${resume}"`,
      );
    }
  }
  lines.push(
    ``,
    `Resume by calling the LLM for this step only — costs one call:`,
    `  curl -s -X POST -H "x-api-key: $INTERNAL_API_KEY" -H 'content-type: application/json' -d '{"resolution":"call_live"}' "${resume}"`,
    ``,
    `Resume with a response you write — free:`,
    `  curl -s -X POST -H "x-api-key: $INTERNAL_API_KEY" -H 'content-type: application/json' -d @resume.json "${resume}"`,
    `  resume.json:  { "resolution": "supplied", "response": { ... } }`,
    ``,
    `Record the rest: add  "breakPolicy": "always"  to any resume body.`,
    `Abandon:  -d '{"resolution":"abort"}'`,
  );

  return {
    type:          'HUMAN_NOTIFICATION',
    workflowRunId: runId,
    message:       lines.join('\n'),
    format:        'text',
    traceId,
  };
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
    frame_id:       randomUUID(),
    type:           'iterator',
    status:         'running',
    workflow_name:  run.workflow_name,
    item_step:      step.item_step,
    items_key:      step.items_key,
    output_key:     step.output_key,
    on_complete:    step.on_complete ?? 'next',
    execution_mode: step.execution_mode ?? null,
    parent_step:    frame.current_step,
    items:          items,
    current_index:  0,
    results:        [],
    local_state:    frame.local_state,
    pushed_at:      new Date().toISOString(),
  };
  run.stack.push(iterFrame);

  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    { stack: run.stack, step_count: (run.step_count ?? 0) + 1 }
  );

  await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId });
  return { action: 'iterator_started', total: items.length };
}

async function executeIteratorItem({ run, traceId }) {
  const frame = topFrame(run);

  // For sequential iterators, process all remaining items inline in this
  // Lambda invocation rather than one SQS hop per item. This eliminates
  // the concurrency throttling issue where rapid SQS messages from large
  // iterators hit the Lambda concurrency limit and get dropped.
  // execution_mode: 'sequential' (the default for all generated workflows)
  // triggers this path. Non-sequential iterators fall through to the
  // original one-item-per-invocation path.
  if (frame.execution_mode === 'sequential' || !frame.execution_mode) {
    return executeIteratorInline({ run, frame, traceId });
  }

  return executeIteratorOneItem({ run, frame, traceId });
}

// Process all remaining iterator items in a single Lambda invocation.
// Writes stack + step_count once at the end rather than once per item.
async function executeIteratorInline({ run, frame, traceId }) {
  const stepStart0 = Date.now();

  while (frame.current_index < frame.items.length) {
    const item          = frame.items[frame.current_index];
    const itemLocalState = { ...frame.local_state, item };
    const itemStep      = frame.item_step;

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
        itemStep?.type ?? 'unknown', 'failed', { tableName: item.tableName }, null,
        itemError.message, Date.now() - stepStart
      );
      const msg = `Iterator step "${frame.parent_step}" failed at index ${frame.current_index} (${item.tableName}): ${itemError.message}. Run id: ${run.id}`;
      console.error('run-workflow: iterator item failed', {
        workflowRunId: run.id, index: frame.current_index,
        tableName: item.tableName, error: itemError.message, traceId,
      });
      await updateRows('PGC_WorkflowRun',
        [{ column: 'id', op: 'eq', value: run.id }],
        { status: 'failed', error: { step: frame.parent_step, index: frame.current_index, tableName: item.tableName, message: itemError.message } }
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

    // Human gate suspension — item_step is a human_gate that needs user input.
    // Persist current index, push gate frame, suspend run — resume_gate will
    // re-enter the iterator at the same index after the user responds.
    if (result.nextAction === 'suspend' && result.gatePayload) {
      // step_ref.options may be a template string ("{{item.options}}") in the workflow
      // definition. resume_gate calls stepRef.options.find() so it needs the live array.
      // Resolve it from itemLocalState before persisting the frame.
      const rawOptions = itemStep.options;
      const resolvedOptions = (typeof rawOptions === 'string' && rawOptions.startsWith('{{'))
        ? (resolvePath(itemLocalState, rawOptions.replace(/^\{\{|\}\}$/g, '')) ?? [])
        : (rawOptions ?? []);
      const resolvedStepRef = { ...itemStep, options: resolvedOptions };
      const gateFrame = {
        frame_id:      randomUUID(),
        type:          'human_gate',
        status:        'awaiting',
        gate_type:     itemStep.gate_type,
        step_ref:      resolvedStepRef,
        step_number:   frame.parent_step,
        workflow_name: run.workflow_name,
        local_state:   itemLocalState,
        pushed_at:     new Date().toISOString(),
      };
      run.stack.push(gateFrame);
      await updateRows('PGC_WorkflowRun',
        [{ column: 'id', op: 'eq', value: run.id }],
        {
          status:     'awaiting_human_gate',
          stack:      run.stack,
          step_count: (run.step_count ?? 0) + 1,
        }
      );
      await enqueueCallback(run.callback, result.gatePayload);
      console.info('run-workflow: iterator item human_gate suspended', {
        workflowRunId: run.id, index: frame.current_index, traceId,
      });
      return { action: 'suspended', gateType: itemStep.gate_type };
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
  }

  // All items done — pop iterator frame, advance parent
  const results     = frame.results;
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
      step_count: (run.step_count ?? 0) + results.length + 1,
    }
  );

  console.info('run-workflow: iterator complete (inline sequential)', {
    workflowRunId: run.id,
    parentStep:    frame.parent_step,
    nextStep:      parentFrame?.current_step,
    total:         frame.items.length,
    totalMs:       Date.now() - stepStart0,
    traceId,
  });

  await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId });
  return { action: 'iterator_complete', results };
}

// Original one-item-per-invocation path — kept for non-sequential iterators.
async function executeIteratorOneItem({ run, frame, traceId }) {
  const item = frame.items[frame.current_index];

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
      itemStep?.type ?? 'unknown', 'failed', { tableName: item.tableName }, null,
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

  // Self-completing iterator: if this was the last item, execute the completion
  // path inline rather than enqueuing another execute_top hop. This eliminates
  // the SQS message loss window that causes runs to get permanently stuck after
  // the last item — the iterator frame pop and parent advancement happen in the
  // same Lambda invocation as the final item execution.
  if (frame.current_index >= frame.items.length) {
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
        step_count: (run.step_count ?? 0) + 1,
      }
    );

    console.info('run-workflow: iterator complete (inline)', {
      workflowRunId: run.id,
      parentStep:    frame.parent_step,
      nextStep:      parentFrame?.current_step,
      total:         frame.items.length,
      traceId,
    });

    await enqueueWorkflow({ type: 'WORKFLOW_STEP', action: 'execute_top', workflowRunId: run.id, traceId });
    return { action: 'iterator_complete', results };
  }

  await updateRows('PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: run.id }],
    { stack: run.stack, step_count: (run.step_count ?? 0) + 1 }
  );

  // Enqueue next item
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

// replay_source_run_id + llm_break_policy MUST be here: the replay harness reads the
// break policy off the run row at the seam (docs/arch-replay.md §7a). Omit them and they
// arrive undefined — failing closed to `never` and silently billing a run meant to replay.
export const LOAD_RUN_COLUMNS = ['id', 'workflow_id', 'status', 'input', 'stack', 'callback', 'step_count', 'error', 'replay_source_run_id', 'llm_break_policy'];

async function loadRun(workflowRunId, traceId) {
  const resp = await getRows(
    'PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: workflowRunId }],
    undefined, 1, undefined, LOAD_RUN_COLUMNS
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
    { stack: run.stack }
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
    undefined, 1, undefined, ['id']
  );
  return resp.success && resp.count > 0;
}

async function recordStepAudit(runId, frameId, stepNumber, stepType,
    status, inputSnapshot, outputSnapshot, errorMsg, durationMs, stepKey) {
  try {
    await insertRow('PGC_WorkflowRunStep', {
      run_id:          runId,
      frame_id:        frameId,
      step_number:     parseInt(stepNumber, 10) || 0,  // kept for iterator items (integer index)
      step_key:        stepKey ?? String(stepNumber),  // UUID per execution or string step label
      step_type:       stepType,
      status,
      input_snapshot:  inputSnapshot ?? null,
      output_snapshot: outputSnapshot ?? null,
      error:           errorMsg ? { message: errorMsg } : null,
      duration_ms:     durationMs,
    });
  } catch (e) {
    console.error('run-workflow: step audit write failed', { runId, frameId, stepKey: String(stepNumber), error: e.message });
  }
}

function resolveNextStep(steps, currentStepKey, nextAction) {
  if (nextAction === 'end')            return 'end';
  if (nextAction?.startsWith('step:')) return nextAction.slice(5);
  // Bare step key — any token that matches an existing step key is a direct jump.
  if (nextAction && nextAction !== 'next' && steps.some(s => String(s.step) === String(nextAction))) {
    return String(nextAction);
  }
  const idx = steps.findIndex(s => String(s.step) === String(currentStepKey));
  if (idx === -1 || idx === steps.length - 1) return 'end';
  return String(steps[idx + 1].step);
}

function resolveOnSelect(steps, currentStepKey, onSelect) {
  if (onSelect === 'cancel')           return 'cancel';
  if (onSelect === 'end')              return 'end';
  if (onSelect?.startsWith('step:'))   return onSelect.slice(5);
  // Bare step key — any token that matches an existing step key is a direct jump.
  if (onSelect && onSelect !== 'next' && steps.some(s => String(s.step) === String(onSelect))) {
    return String(onSelect);
  }
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
