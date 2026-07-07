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

  const frame = top;
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
  if (step.output_key && typeof step.output_key === 'string' && result.outputValue !== null && result.outputValue !== undefined) {
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
      { stack: run.stack }
    );

    const updatedDialog = buildDialog(stepRef, localState);
    await enqueueCallback(run.callback, {
      type:          'HUMAN_GATE',
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
        type: 'HUMAN_NOTIFICATION', workflowRunId: run.id,
        message: 'Workflow cancelled.', traceId,
      });
    }
    console.info('run-workflow: cancelled', { workflowRunId: run.id, traceId });
    return { action: 'cancelled' };
  }

  // ── confirm (or any option that advances) ─────────────────────────────
  // choice gate uses option.value (HTML radio semantics); all others use option.action.
  const isChoice      = gateType === 'choice';
  const allOptions    = [...(stepRef.options ?? []), ...(stepRef.special_buttons ?? [])];
  const matchedOption = allOptions.find(o =>
    isChoice ? o.value === userResponse : o.action === userResponse
  );
  // When the modal was dismissed without submitting (no inputValue), route via
  // on_modal_close if the option declares it — allows list_selection gates to loop
  // back to themselves rather than falling through to on_select (which would
  // advance with no captured value).
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
  const onSelect = (
    !hasModalInput && matchedOption?.on_modal_close !== undefined
      ? matchedOption.on_modal_close
      : matchedOption?.on_select
  ) ?? itemActionMatch?.on_select ?? 'next';

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
    const selectionValue = responseData?.inputValue ?? userResponse;
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

  // A row's own accessory button was clicked and its item_action declares
  // on_select — an "advance" action (e.g. drill-down), as opposed to remove_item's
  // "mutate this list and stay suspended" behavior handled above. Every row
  // shares the same item_action.action, so the clicked row is identified only
  // by responseData.tableName (same field name callback.mjs's 'list' field type
  // already sends for any row-level secondaryAction, regardless of what the
  // action does). Write it to output_key before the generic matchedOption/
  // on_select advance below routes to wherever item_action.on_select points.
  if (itemActionMatch && stepRef.output_key) {
    setPath(localState, stepRef.output_key, responseData?.tableName);
    frame.local_state = localState;
    console.info('run-workflow: list_selection item_action — clicked row id written to local_state', {
      output_key: stepRef.output_key,
      id:         responseData?.tableName,
      traceId,
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

const LOAD_RUN_COLUMNS = ['id', 'workflow_id', 'status', 'input', 'stack', 'callback', 'step_count', 'error'];

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
