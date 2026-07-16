// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/llm-harness.mjs
//
// LLM call harness — extracted from step-executor.mjs.
// Adds memory retrieval and model alias resolution on top of the core
// prompt-load → context-inject → call → validate → diagnostics flow.
//
// Exports:
//   assembleInstructions() — pure function for unit testing
//   executeLlmCall()       — full async handler used by step-executor.mjs

import { callLlm, callLlmWithCorrection, callLlmWithResumption } from '../shared/llm-client.mjs';
import { validate, logPromptError }                               from './review-output.mjs';
import { getRows, insertRow }                                     from '../shared/serv-client.mjs';
import { resolveInput, resolveTemplate }                          from './template-resolver.mjs';
import { retrieveMemories, formatMemoryBlock }                    from './memory-client.mjs';
import { computeFingerprint, diffInputKeys }                      from './fingerprint.mjs';
import { lookupRecording, decideReplayAction, getRecordedResponse } from './replay-corpus.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * The PGC_StepType columns that constitute a step type's contract — what an LLM needs to
 * know to author a step. Excludes row bookkeeping (id, status, created_at, updated_at):
 * it is not contract, and injecting it makes an unrelated row edit look like request drift.
 * Exported for the fingerprint-stability test.
 */
export const STEP_TYPE_CONTRACT_COLUMNS = [
  'step_type', 'description', 'input_contract', 'output_contract',
  'on_success_options', 'on_failure_options', 'requires_capability',
];

/**
 * A6 — turn `drift: ['input']` into a sentence a developer can act on.
 *
 * `input` is ambiguous: `step_type_contracts` moving is benign (an injected contract changed;
 * accepting the recording is right), while the question keys moving means a materially different
 * question was asked (accepting it discards the difference). Opposite correct answers, identical
 * component-level signal — so the disposition (A9) cannot fire without knowing which keys moved.
 *
 * Sizes are carried so the report says WHAT arrived, not merely that something did.
 * Returns null when either side has no per-key hashes — absent data is unknowable, never
 * "unchanged".
 */
export function describeInputDrift(currentKeys, candidateFingerprint) {
  const cand = candidateFingerprint?.input_keys ?? null;
  const raw  = diffInputKeys(currentKeys ?? null, cand);
  if (!raw) return null;
  const cur = currentKeys ?? {};
  return {
    added:     raw.added.map(k   => ({ key: k, chars: cur[k]?.n ?? null })),
    removed:   raw.removed.map(k => ({ key: k, chars: cand[k]?.n ?? null })),
    changed:   raw.changed.map(k => ({ key: k, chars: cur[k]?.n ?? null, was_chars: cand[k]?.n ?? null })),
    unchanged: raw.unchanged,
  };
}

/**
 * Resolve a model alias (e.g. 'smart', 'cheap') to a concrete model ID using
 * the llm_model_aliases entry in PGC_SystemContext.
 * Returns the original value unchanged when no alias is found.
 */
function resolveModelAlias(model, contextRows) {
  if (!model) return model;
  const aliasRow = contextRows?.find(r => r.key === 'llm_model_aliases');
  if (!aliasRow?.content || typeof aliasRow.content !== 'object') return model;
  return aliasRow.content[model] ?? model;
}

/**
 * Derive the call scope for memory retrieval from the run context and
 * the resolved step input (which may carry 'domain' from the workflow).
 */
export function deriveCallScope(run, resolvedInput) {
  const scope = {};
  const domain = resolvedInput?.domain ?? run?.input?.domain ?? null;
  const workflowName = run?.workflow_name ?? null;
  if (domain) scope.domain = domain;
  if (workflowName) scope.workflow = workflowName;
  return scope;
}

/**
 * Canonical routing resolver — mirrors the private resolveNextAction in
 * step-executor.mjs. Defined here to avoid a circular import.
 */
function resolveNextAction(onSuccess) {
  if (!onSuccess || onSuccess === 'next') return 'next';
  if (onSuccess === 'end')               return 'end';
  if (onSuccess === 'cancel')            return 'cancel';
  return onSuccess;
}

// ---------------------------------------------------------------------------
// assembleInstructions — pure, exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Select the PGC_SystemContext subset injected into a prompt for this call.
 * A row is injected when it is inject_always or its inject_for list names this
 * intentCategory, AND its key is not already supplied by resolvedInput (step
 * input takes precedence). Returns { key: content }.
 *
 * The single source of truth for "what system context is injected" — used by
 * assembleInstructions (to substitute it) and by the request fingerprint (to hash
 * the system_context component). One function so the two cannot drift.
 */
export function selectInjectedContext(contextRows, resolvedInput, intentCategory) {
  const contextMap = {};
  for (const row of contextRows ?? []) {
    const injectFor = Array.isArray(row.inject_for) ? row.inject_for : [];
    const injectAlways = row.inject_always === true;
    if ((injectAlways || injectFor.includes(intentCategory)) && !(row.key in resolvedInput)) {
      contextMap[row.key] = row.content;
    }
  }
  return contextMap;
}

/**
 * Assemble the system instructions string for an LLM call.
 *
 * Order of assembly:
 *   1. Substitute inject_always + inject_for PGC_SystemContext values as
 *      {{key}} tokens into prompt_text
 *   2. Append the memory block (if any memories retrieved) after all
 *      token substitution
 *
 * Step input values (resolvedInput) take precedence over contextRows —
 * a key present in resolvedInput will not be overwritten by a context row.
 *
 * @param {object}   promptRow       PGC_Prompt row
 * @param {object}   resolvedInput   Step input resolved against local_state
 * @param {object[]} contextRows     All PGC_SystemContext rows
 * @param {object[]} memories        Budget-selected PGC_Memory rows
 * @param {string}   intentCategory  Used to match inject_for arrays
 * @returns {string}                 Final instructions string
 */
export function assembleInstructions(promptRow, resolvedInput, contextRows, memories, intentCategory) {
  const contextMap = selectInjectedContext(contextRows, resolvedInput, intentCategory);

  const allSubstitutions = { ...contextMap, ...resolvedInput };
  let instructions = Object.entries(allSubstitutions).reduce((text, [key, val]) => {
    const placeholder    = `{{${key}}}`;
    const substitution   = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
    return text.split(placeholder).join(substitution);
  }, promptRow.prompt_text ?? '');

  if (memories?.length > 0) {
    instructions += '\n\n' + formatMemoryBlock(memories);
  }

  return instructions;
}

// ---------------------------------------------------------------------------
// executeLlmCall
// ---------------------------------------------------------------------------

/**
 * Execute an llm_call step with memory injection and model alias resolution.
 *
 * Flow:
 *   1. Load PGC_Prompt by intent_category
 *   2. Load all PGC_SystemContext rows
 *   3. Resolve model alias (smart → anthropic/claude-sonnet-4-6, etc.)
 *   4. Retrieve memories if memory_config.memory_budget_tokens > 0
 *   5. Assemble instructions via assembleInstructions()
 *   6. Call LLM (with truncation and parse-error recovery)
 *   7. Validate output via review-output.mjs
 *   8. Write diagnostics session (non-blocking)
 *
 * @param {object} params
 * @param {object} params.step        Step definition from PGC_Workflow.steps
 * @param {object} params.localState  Current frame local_state
 * @param {object} params.run         PGC_WorkflowRun row (read-only)
 * @param {string} params.traceId
 * @param {object} [params.breakResolution]  present only on resume after a replay break
 *   was resolved (docs/arch-replay.md §5): { resolution, response?, fingerprint,
 *   candidate_session_id }. Overrides the break policy for this one call.
 * @returns {Promise<StepResult>}
 */
export async function executeLlmCall({ step, localState, run, traceId, breakResolution = null }) {
  const intentCategory = step.input?.prompt;
  if (!intentCategory) throw new Error('llm_call step missing input.prompt');

  const promptResp = await getRows(
    'PGC_Prompt',
    [{ column: 'intent_category', op: 'eq', value: intentCategory }],
    { column: 'version', direction: 'desc' },
    1
  );
  if (!promptResp.success || promptResp.count === 0) {
    throw new Error(`prompt not found: intent_category="${intentCategory}"`);
  }
  const promptRow = promptResp.rows[0];

  let resolvedInput = resolveInput(step.input ?? {}, localState);

  const contextResp = await getRows('PGC_SystemContext');
  const contextRows = contextResp.success ? (contextResp.rows ?? []) : [];

  // Auto-inject step_type_contracts when the prompt references it.
  // Fetched fresh from PGC_StepType at call time — not stored in local_state.
  //
  // Ordered and column-scoped so the assembled prompt is a function of the contracts alone.
  // Without ORDER BY, row order is whatever the heap returns: updating any step type
  // relocates its row and silently reorders the array, which reaches the prompt (arrays are
  // order-significant to both JSON.stringify and stableStringify) and changes the `input`
  // fingerprint with no semantic change behind it. STEP_TYPE_CONTRACT_COLUMNS excludes id,
  // status (already filtered to 'live'), created_at and updated_at — row bookkeeping the
  // LLM has no use for, and which would otherwise make a touched row look like a new request.
  if (!('step_type_contracts' in resolvedInput) && promptRow.prompt_text?.includes('{{step_type_contracts}}')) {
    const stResp = await getRows(
      'PGC_StepType',
      [{ column: 'status', op: 'eq', value: 'live' }],
      { column: 'step_type', direction: 'asc' },
      undefined,
      undefined,
      STEP_TYPE_CONTRACT_COLUMNS,
    );
    if (stResp.success && stResp.rows?.length > 0) {
      resolvedInput = { ...resolvedInput, step_type_contracts: stResp.rows };
    }
  }

  const resolvedModel = resolveModelAlias(promptRow.model, contextRows);

  // Memory retrieval — disabled by default (budget 0) when memory_config absent
  const memCfg      = promptRow.memory_config ?? {};
  const budgetTokens = memCfg.memory_budget_tokens ?? 0;
  let memories = [];
  if (budgetTokens > 0) {
    const baseScope    = memCfg.scope_override ?? deriveCallScope(run, resolvedInput);
    const additions    = memCfg.scope_additions
      ? resolveInput(memCfg.scope_additions, localState)
      : {};
    const callScope    = { ...baseScope, ...additions };
    const memoryTypes  = memCfg.memory_types ?? ['episodic', 'semantic', 'procedural'];
    const callContext  = memCfg.include_persona ? 'chat' : 'generation';
    memories = await retrieveMemories({
      scope:        callScope,
      tags:         memCfg.tags_filter ?? null,
      budgetTokens,
      memoryTypes,
      callContext,
    });
  }

  let instructions = assembleInstructions(
    promptRow, resolvedInput, contextRows, memories, intentCategory
  );

  // When save_to_memory is set on the step, ask the LLM to include a reasoning
  // field. The field is stripped before schema validation and written to PGC_Memory.
  const saveMemCfg = step.save_to_memory
    ? resolveInput(step.save_to_memory, localState)
    : null;
  if (saveMemCfg) {
    instructions +=
      '\n\nAlso include a "reasoning" field (string) in your JSON response with 1–3 sentences summarizing the key decisions you made. Keep it under 80 words. This field is for system memory and is not shown to the user.';
  }

  const userInput = resolveTemplate(step.input?.user_input ?? '', localState);

  // Request fingerprint (docs/arch-replay.md §3) — computed at the seam from the
  // assembled request, before the LLM is called. Hashes the same injected context
  // and memory block that assembleInstructions used, so the fingerprint and the
  // prompt cannot disagree. Written to PGC_Session below; a live run populates the
  // corpus for the next replay.
  const injectedContext = selectInjectedContext(contextRows, resolvedInput, intentCategory);
  const memoryBlock     = memories.length > 0 ? formatMemoryBlock(memories) : '';
  const fingerprint     = computeFingerprint({
    promptRow, resolvedInput, userInput, model: resolvedModel, memoryBlock, injectedContext,
  });

  console.info('step-executor: llm_call', {
    intentCategory,
    promptVersion:    promptRow.version,
    model:            resolvedModel,
    memoriesInjected: memories.length,
    traceId,
  });

  // Replay decision (docs/arch-replay.md §4-§5). Two entries: a fresh call reads the
  // break policy off the run row (null ⇒ 'never' ⇒ today's live behaviour); a resume
  // carries breakResolution, which overrides the policy for this one call.
  const breakPolicy = run?.llm_break_policy ?? 'never';
  let served              = false;
  let servedResponse      = undefined;
  let servedFromSessionId = null;
  let responseSource      = 'live';

  if (breakResolution) {
    // Resuming a resolved break (§5). Assembly re-ran above; verify the fingerprint
    // matches the one stashed at break time — local_state is frozen while suspended, so
    // a mismatch is an anomaly, surfaced not swallowed.
    if (breakResolution.fingerprint?.hash && breakResolution.fingerprint.hash !== fingerprint.hash) {
      console.warn('step-executor: llm_call resume fingerprint mismatch — re-assembly differs from break', {
        intentCategory, stashed: breakResolution.fingerprint.hash, reassembled: fingerprint.hash, traceId,
      });
    }
    const res = breakResolution.resolution;
    if (res === 'use_recorded') {
      // An explicit session_id names the recording to accept; it overrides the lookup's pick,
      // which is arbitrary when a step recorded more than once and nothing distinguishes the
      // passes (arch-replay.md §5). Validated against the break's candidate_ids at the endpoint.
      const acceptedSessionId = breakResolution.session_id ?? breakResolution.candidate_session_id;
      if (acceptedSessionId == null) {
        throw new Error('llm_call resume use_recorded: no candidate recording to accept');
      }
      servedResponse      = await getRecordedResponse(acceptedSessionId);
      served              = true;
      servedFromSessionId = acceptedSessionId;
      responseSource      = 'replayed';
    } else if (res === 'supplied') {
      servedResponse = breakResolution.response;
      served         = true;
      responseSource = 'recorded';
    } else if (res === 'call_live') {
      responseSource = 'live';   // fall through to callLlm below; no re-break
    } else {
      throw new Error(`llm_call resume: unsupported resolution "${res}"`);
    }
    console.info('step-executor: llm_call resumed from break', { intentCategory, resolution: res, responseSource, traceId });
  } else if (breakPolicy !== 'never') {
    let recording = null;
    if (breakPolicy === 'on_miss') {
      recording = await lookupRecording({
        compositeHash: fingerprint.hash,
        components:    fingerprint.components,
        sourceRunId:   run.replay_source_run_id ?? null,
        stepId:        step.step,
      });
    }
    const action = decideReplayAction(breakPolicy, recording?.status ?? 'miss');
    if (action === 'break') {
      // Suspend for a developer. run-workflow (A4) pushes a break frame, sets
      // awaiting_llm_break, notifies Slack with a runnable-curl pointer, and resumes via
      // resume_llm. A hard halt — no auto-resume, same property as a human_gate.
      console.info('step-executor: llm_call break', { intentCategory, policy: breakPolicy, reason: recording?.status ?? breakPolicy, traceId });
      return {
        outputValue: null,
        nextAction:  'llm_break',
        breakPayload: {
          step_id:              step.step,
          intent_category:      intentCategory,
          policy:               breakPolicy,
          reason:               breakPolicy === 'always' ? 'always' : (recording?.status ?? 'miss'),
          fingerprint,
          instructions,
          userInput,
          drift:                recording?.drift ?? null,
          candidate_session_id: recording?.candidate?.sessionId ?? null,
          candidate_ids:        recording?.candidateIds ?? null,
          // A6 — WHICH keys within `input` moved. Computed here because this is the only place
          // both sides are already in hand; the report and the notification both read it off the
          // frame rather than re-deriving it (checklist rule 2e).
          input_diff:           describeInputDrift(fingerprint.inputKeys, recording?.candidate?.fingerprint),
        },
      };
    }
    if (action === 'serve') {
      served              = true;
      servedResponse      = recording.candidate.response;
      servedFromSessionId = recording.candidate.sessionId;
      responseSource      = 'replayed';
      console.info('step-executor: llm_call served from recording', {
        intentCategory, status: recording.status, drift: recording.drift ?? null, servedFromSessionId, traceId,
      });
    }
  }

  const t0 = Date.now();
  let rawOutput;
  let priorErrorType;
  if (served) {
    rawOutput = servedResponse;
  } else try {
    rawOutput = await callLlm(
      resolvedModel,
      instructions,
      userInput || JSON.stringify(resolvedInput),
      promptRow.output_schema,
      traceId,
      promptRow.max_output_tokens ?? undefined,
    );
  } catch (parseErr) {
    if (!parseErr.rawOutput) throw parseErr;
    if (parseErr.isTruncated) {
      console.info('step-executor: llm_call truncated — attempting resumption', { intentCategory, traceId });
      try {
        rawOutput = await callLlmWithResumption(
          resolvedModel,
          instructions,
          userInput || JSON.stringify(resolvedInput),
          promptRow.output_schema,
          traceId,
          promptRow.max_output_tokens ?? undefined,
        );
      } catch (resumptionErr) {
        await logPromptError(promptRow.id, {
          error_type:      'token_truncation',
          error_message:   `Truncated at ${promptRow.max_output_tokens} tokens; resumption also failed: ${resumptionErr.message}`,
          recovery_action: 'halt',
        });
        throw resumptionErr;
      }
      priorErrorType = 'token_truncation';
    } else {
      console.info('step-executor: llm_call parse error — attempting correction', { intentCategory, traceId });
      rawOutput = await callLlmWithCorrection(
        resolvedModel,
        instructions,
        userInput || JSON.stringify(resolvedInput),
        promptRow.output_schema,
        [{ message: parseErr.message }],
        parseErr.rawOutput,
        traceId,
        promptRow.max_output_tokens ?? undefined,
      );
    }
  }
  const llmMs = Date.now() - t0;

  // Extract and strip reasoning before schema validation.
  // The base output_schema has additionalProperties: false — reasoning would
  // fail validation if left in. We keep it separately for the memory write.
  let memoryReasoning = null;
  if (saveMemCfg && rawOutput && typeof rawOutput === 'object' && 'reasoning' in rawOutput) {
    memoryReasoning = String(rawOutput.reasoning ?? '').trim();
    rawOutput = { ...rawOutput };
    delete rawOutput.reasoning;
  }

  console.info('step-executor: llm_call completed', { llmMs, traceId });

  // On a served (replayed) response, forbid LLM correction — a recorded response must
  // never trigger a Perplexity call (AC2). A hit means schema matched, so a valid
  // recording re-validates on attempt 1; a failure means review-output's own rules
  // (code, not fingerprinted) changed since recording, which surfaces as invalid.
  const validationResult = await validate({
    intentCategory,
    output: rawOutput,
    traceId,
    priorErrorType,
    allowLlmCorrection: !served,
  });

  const finalOutput = validationResult.correctedOutput ?? rawOutput;

  // Diagnostics — non-blocking; failure is logged but does not fail the step.
  // Written unconditionally for every llm_call step so /explain can look up
  // the assembled prompt and response for any workflow run via run_id.
  try {
    if (run?.workflow_name) {
      const sessionResp = await insertRow('PGC_Session', {
        session_type:    'llm_call_diagnostic',
        workflow_name:   run.workflow_name,
        run_id:          run.id,
        trace_id:        traceId,
        step_id:         step.step,
        intent_category: intentCategory,
        // input_keys rides alongside the seven components (A6): a finer view of `input`, not an
        // eighth component — it is excluded from the composite, so recordings predating it keep
        // hitting. diffComponents judges COMPONENT_ORDER only and ignores it.
        request_fingerprint:      { ...fingerprint.components, input_keys: fingerprint.inputKeys },
        fingerprint_hash:         fingerprint.hash,
        response_source:          responseSource,
        replayed_from_session_id: servedFromSessionId,
      });
      if (sessionResp.success) {
        const sessionId = sessionResp.row.id;
        const effectiveUserMsg = userInput || JSON.stringify(resolvedInput);
        let seq = 1;
        await insertRow('PGC_SessionEntry', {
          session_id: sessionId, sequence_number: seq++, role: 'system', content: instructions,
        });
        await insertRow('PGC_SessionEntry', {
          session_id: sessionId, sequence_number: seq++, role: 'user',
          content: typeof effectiveUserMsg === 'string' ? effectiveUserMsg : JSON.stringify(effectiveUserMsg),
        });
        await insertRow('PGC_SessionEntry', {
          session_id: sessionId, sequence_number: seq++, role: 'assistant',
          content: typeof rawOutput === 'object' ? JSON.stringify(rawOutput) : String(rawOutput),
        });
        if (validationResult.attempt === 2 && Array.isArray(validationResult.attempt1Errors)) {
          const errorLines  = validationResult.attempt1Errors.map(e => `- ${e.message}`).join('\n');
          const attempt1Txt = typeof rawOutput === 'object' ? JSON.stringify(rawOutput, null, 2) : String(rawOutput);
          await insertRow('PGC_SessionEntry', {
            session_id: sessionId, sequence_number: seq++, role: 'user',
            content: `Your previous response had these specific issues that must be fixed:\n${errorLines}\n\nYour previous response was:\n${attempt1Txt}\n\nFix ONLY the issues listed above. Return the complete corrected JSON object — no explanation, no preamble, no markdown fences.`,
          });
        }
        if (validationResult.correctedOutput !== undefined) {
          const corrected = validationResult.correctedOutput;
          await insertRow('PGC_SessionEntry', {
            session_id: sessionId, sequence_number: seq++, role: 'assistant',
            content: typeof corrected === 'object' ? JSON.stringify(corrected) : String(corrected),
          });
        }
        console.info('step-executor: diagnostics session created', { sessionId, traceId });
      }
    }
  } catch (diagErr) {
    console.warn('step-executor: diagnostics write failed (non-fatal)', diagErr.message);
  }

  if (!validationResult.valid) {
    throw new Error(
      `llm_call validation failed after ${validationResult.attempt} attempt(s): ` +
      JSON.stringify(validationResult.errors)
    );
  }

  // Memory write — non-fatal; Option B: await but swallow errors so the
  // step never fails due to a memory write. Swap to SQS enqueue when G3 ships.
  if (saveMemCfg && memoryReasoning) {
    try {
      // Scope: base from run context, enriched with LLM output domain when
      // the domain isn't known until the LLM responds (e.g. create_domain),
      // then any explicit overrides from the step's save_to_memory config.
      const baseScope = deriveCallScope(run, resolvedInput);
      if (!baseScope.domain && finalOutput?.domain) baseScope.domain = finalOutput.domain;
      const explicitScope = saveMemCfg.scope ?? {};
      const memoryScope = Object.keys(explicitScope).length > 0 ? explicitScope : baseScope;

      await insertRow('PGC_Memory', {
        memory_type:     saveMemCfg.memory_type ?? 'semantic',
        scope:           memoryScope,
        content:         memoryReasoning,
        tags:            saveMemCfg.tags ?? [],
        priority:        saveMemCfg.priority ?? 5,
        token_estimate:  Math.ceil(memoryReasoning.length / 4),
        source_run_id:   run?.id ?? null,
        source_workflow: run?.workflow_name ?? null,
        source_step:     step.step ?? null,
      });
      console.info('step-executor: memory written from llm_call', { intentCategory, traceId });
    } catch (memErr) {
      console.warn('step-executor: memory write failed (non-fatal)', memErr.message);
    }
  }

  return {
    outputValue: finalOutput,
    nextAction:  resolveNextAction(step.on_success),
    meta:        { llmMs, attempt: validationResult.attempt },
  };
}
