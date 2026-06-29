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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
  const contextMap = {};
  for (const row of contextRows ?? []) {
    const injectFor = Array.isArray(row.inject_for) ? row.inject_for : [];
    const injectAlways = row.inject_always === true;
    if ((injectAlways || injectFor.includes(intentCategory)) && !(row.key in resolvedInput)) {
      contextMap[row.key] = row.content;
    }
  }

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
 * @returns {Promise<StepResult>}
 */
export async function executeLlmCall({ step, localState, run, traceId }) {
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
  if (!('step_type_contracts' in resolvedInput) && promptRow.prompt_text?.includes('{{step_type_contracts}}')) {
    const stResp = await getRows('PGC_StepType', [{ column: 'status', op: 'eq', value: 'live' }]);
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

  console.info('step-executor: llm_call', {
    intentCategory,
    promptVersion:    promptRow.version,
    model:            resolvedModel,
    memoriesInjected: memories.length,
    traceId,
  });

  const t0 = Date.now();
  let rawOutput;
  let priorErrorType;
  try {
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

  const validationResult = await validate({
    intentCategory,
    output: rawOutput,
    traceId,
    priorErrorType,
  });

  const finalOutput = validationResult.correctedOutput ?? rawOutput;

  // Diagnostics — non-blocking; failure is logged but does not fail the step
  let diagnosticPayload = null;
  try {
    const diagnosticsRow    = contextRows.find(r => r.key === 'diagnostics_config');
    const diagnosticsConfig = diagnosticsRow?.content ?? null;
    const enabledWorkflows  = diagnosticsConfig?.enabled_workflows ?? [];

    if (run?.workflow_name && enabledWorkflows.includes(run.workflow_name)) {
      const sessionResp = await insertRow('PGC_Session', {
        session_type:    'llm_call_diagnostic',
        workflow_name:   run.workflow_name,
        run_id:          run.id,
        trace_id:        traceId,
        step_id:         step.step,
        intent_category: intentCategory,
      });
      if (sessionResp.success) {
        const sessionId = sessionResp.row.id;
        const queryId   = sessionResp.row.query_id;
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
        diagnosticPayload = { queryId, sessionId, intentCategory, traceId };
        console.info('step-executor: diagnostics session created', { sessionId, queryId, traceId });
      }
    }
  } catch (diagErr) {
    console.warn('step-executor: diagnostics write failed (non-fatal)', diagErr.message);
  }

  if (!validationResult.valid) {
    const validationError = new Error(
      `llm_call validation failed after ${validationResult.attempt} attempt(s): ` +
      JSON.stringify(validationResult.errors)
    );
    if (diagnosticPayload) validationError.diagnosticPayload = diagnosticPayload;
    throw validationError;
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
    outputValue:      finalOutput,
    nextAction:       resolveNextAction(step.on_success),
    meta:             { llmMs, attempt: validationResult.attempt },
    diagnosticPayload,
  };
}
