// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/design-domain.mjs
// Handles POST /api/v1/proc/design-domain (HTTP) and
//         DESIGN_DOMAIN SQS WorkflowQueue messages (async).
//
// Transport-agnostic — no AWS SDK, no Slack SDK imports.
// req.source determines response path only.
//
// First pass — LLM design + validation + WorkflowRun lifecycle only.
// Block Kit review message and human gate deferred to next iteration.
//
// Flow:
//   1. Validate userInput
//   2. Resolve create_domain workflow_id from PGC_Workflow
//   3. Insert PGC_WorkflowRun row (status: running)
//   4. Load create_domain prompt from PGC_Prompt
//   5. Call LLM → proposed_scaffold
//   6. Call review-output validate() — Ajv + semantic rules (2-attempt loop)
//   7a. Validation failed → update run status: failed, enqueue error callback
//   7b. Validation passed → update run: status: awaiting_human_gate,
//       write state.proposed_scaffold, increment step_count + total_execution_ms
//   8. HTTP: return scaffold. SQS: enqueue DESIGN_DOMAIN_RESULT (placeholder).

import { ok, err }            from '../shared/lambda-utils.mjs';
import { enqueueCallback }    from '../shared/sqs-callback.mjs';
import { callLlm }            from '../shared/llm-client.mjs';
import { validate }           from './review-output.mjs';
import { getRows, insertRow, updateRows } from '../shared/serv-client.mjs';

export async function handle(req) {
  const { userInput, workflowRunId, callback } = req.body ?? {};
  const traceId = req.traceId ?? req.correlationId;

  // --- Input validation ---
  if (!userInput?.trim()) {
    if (req.source === 'sqs' && callback) {
      await enqueueCallback(callback, {
        type:    'DESIGN_DOMAIN_ERROR',
        traceId,
        result:  { success: false, error: 'Usage: /create-domain <description>' },
      });
      return;
    }
    return err(400, 'userInput is required', req.correlationId);
  }

  const startedAt = new Date();

  try {
    const result = await runDesignDomain({
      userInput:     userInput.trim(),
      workflowRunId,
      callback,
      traceId,
      startedAt,
      source:        req.source,
    });

    if (req.source === 'http') {
      return ok(result, req.correlationId);
    }

    // SQS path — placeholder result until Block Kit is wired in next iteration
    await enqueueCallback(callback, {
      type:    'DESIGN_DOMAIN_RESULT',
      traceId,
      result,
    });

  } catch (error) {
    console.error('design-domain: unhandled error', { error: error.message, traceId });

    if (req.source === 'http') {
      return err(500, `design-domain failed: ${error.message}`, req.correlationId);
    }

    // SQS — re-throw so processSqsBatch records a batchItemFailure and SQS retries
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function runDesignDomain({ userInput, workflowRunId, callback, traceId, startedAt, source }) {

  // --- Step 1: Resolve create_domain workflow_id ---
  const workflowResp = await getRows(
    'PGC_Workflow',
    [{ column: 'name', op: 'eq', value: 'create_domain' }],
    undefined,
    1
  );
  if (!workflowResp.success || workflowResp.count === 0) {
    throw new Error('create_domain workflow not found in PGC_Workflow');
  }
  const workflowId = workflowResp.rows[0].id;

  // --- Step 2: Insert PGC_WorkflowRun row ---
  // workflowRunId may be pre-provided by SlackbotFunction (SQS path) or absent (HTTP test)
  let runId = workflowRunId ?? null;
  if (!runId) {
    const runResp = await insertRow('PGC_WorkflowRun', {
      workflow_id:  workflowId,
      trace_id:     traceId,
      triggered_by: source === 'sqs' ? 'slack' : 'api',
      status:       'running',
      input:        { userInput },
      callback:     callback ?? null,
      started_at:   startedAt.toISOString(),
    });
    if (!runResp.success) {
      throw new Error(`Failed to insert PGC_WorkflowRun: ${runResp.error}`);
    }
    runId = runResp.row.id;
    console.info('design-domain: WorkflowRun created', { runId, traceId });
  } else {
    // Run row already created by SlackbotFunction — update to running
    await updateRows(
      'PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: runId }],
      { status: 'running', started_at: startedAt.toISOString() }
    );
  }

  // --- Step 3: Load create_domain prompt ---
  const promptResp = await getRows(
    'PGC_Prompt',
    [{ column: 'intent_category', op: 'eq', value: 'create_domain' }],
    { column: 'version', direction: 'desc' },
    1
  );
  if (!promptResp.success || promptResp.count === 0) {
    throw new Error('create_domain prompt not found in PGC_Prompt');
  }
  const promptRow  = promptResp.rows[0];
  const promptText = promptRow.prompt_text.replace('{{userInput}}', userInput);

  console.info('design-domain: prompt loaded', {
    promptId: promptRow.id,
    version:  promptRow.version,
    traceId,
  });

  // --- Step 4: Call LLM ---
  const llmStart = Date.now();
  const scaffold  = await callLlm(
    promptRow.model,
    promptText,
    `Design a database domain for: "${userInput}"`,
    promptRow.output_schema,
    traceId
  );
  const llmMs = Date.now() - llmStart;

  console.info('design-domain: LLM returned scaffold', {
    domain: scaffold.domain,
    tables: scaffold.tables?.map(t => t.tableName),
    llmMs,
    traceId,
  });

  // --- Step 5: Validate scaffold ---
  const validationStart  = Date.now();
  const validationResult = await validate({
    intentCategory: 'create_domain',
    output:         scaffold,
    traceId,
  });
  const validationMs = Date.now() - validationStart;
  const totalMs      = Date.now() - llmStart;

  // --- Step 6a: Validation failed ---
  if (!validationResult.valid) {
    console.warn('design-domain: validation failed after 2 attempts', { runId, traceId });

    await updateRows(
      'PGC_WorkflowRun',
      [{ column: 'id', op: 'eq', value: runId }],
      {
        status:             'failed',
        error:              {
          type:    'validation_failed',
          message: 'Scaffold failed Ajv + semantic validation after 2 attempts',
          errors:  validationResult.errors,
        },
        step_count:         1,
        total_execution_ms: totalMs,
      }
    );

    // On SQS path — notify user via callback rather than retrying
    if (source === 'sqs' && callback) {
      await enqueueCallback(callback, {
        type:    'DESIGN_DOMAIN_ERROR',
        traceId,
        result:  {
          success: false,
          error:   '⚠️ Domain design failed — the LLM produced an invalid schema after 2 attempts. Please try again or rephrase your description.',
          runId,
        },
      });
      return { success: false, runId, validationFailed: true };
    }

    // HTTP path — return 422
    return {
      success:    false,
      runId,
      errors:     validationResult.errors,
      attempt:    validationResult.attempt,
      errorLogged: validationResult.errorLogged,
    };
  }

  // --- Step 6b: Validation passed ---
  const finalScaffold = validationResult.correctedOutput ?? scaffold;

  console.info('design-domain: validation passed', {
    attempt:      validationResult.attempt,
    validationMs,
    traceId,
  });

  await updateRows(
    'PGC_WorkflowRun',
    [{ column: 'id', op: 'eq', value: runId }],
    {
      status:             'awaiting_human_gate',
      state:              { proposed_scaffold: finalScaffold },
      step_count:         1,
      total_execution_ms: totalMs,
    }
  );

  console.info('design-domain: WorkflowRun updated to awaiting_human_gate', { runId, traceId });

  return {
    success:      true,
    runId,
    domain:       finalScaffold.domain,
    tables:       finalScaffold.tables.map(t => ({
      tableName:   t.tableName,
      description: t.description,
    })),
    attempt:      validationResult.attempt,
    validatedAt:  new Date().toISOString(),
  };
}
