// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/review-output.mjs
// Handles POST /api/v1/proc/review-output
// Also exported as validate() for direct intra-proc calls (proc-to-proc rule).
//
// Right-brain output validation — repeat-until-correct loop (max 2 attempts).
// See architecture Section 6.10 for full design rationale.
//
// Two validation passes per attempt:
//   Pass 1 — Ajv JSON Schema validation against PGC_Prompt.output_schema
//   Pass 2 — Semantic rules (trigger check, upsert_key constraint, FK parent)
//
// On failure after 2 attempts:
//   - Writes structured error to PGC_Prompt.error_log
//   - Returns { valid: false, errors, attempt: 2, errorLogged: true }
//
// Transport-agnostic for HTTP path. Direct import for intra-proc callers.

import Ajv                                    from 'ajv';
import { ok, err }                            from '../shared/lambda-utils.mjs';
import { getRows, updateRows }                from '../shared/serv-client.mjs';
import { callLlm, callLlmWithCorrection }     from '../shared/llm-client.mjs';
import { monitorPromptQuality }               from './monitor-prompt-quality.mjs';

const ajv = new Ajv({ allErrors: true });

// ---------------------------------------------------------------------------
// HTTP entry point — POST /proc/review-output
// ---------------------------------------------------------------------------

export async function handle(req) {
  const { intentCategory, output, outputType = 'json', traceId } = req.body;

  if (!intentCategory) return err(400, 'intentCategory is required', req.correlationId);
  if (!output)         return err(400, 'output is required', req.correlationId);
  if (outputType !== 'json') {
    return err(400, `outputType "${outputType}" not yet supported — only json is implemented`, req.correlationId);
  }

  const result = await validate({ intentCategory, output, traceId: traceId ?? req.correlationId });

  return ok(result, req.correlationId);
}

// ---------------------------------------------------------------------------
// Core validate() — called directly by intra-proc modules (proc-to-proc rule)
// ---------------------------------------------------------------------------

/**
 * Validate LLM output against PGC_Prompt.output_schema + semantic rules.
 * Maximum 2 LLM correction attempts.
 *
 * @param {object} params
 * @param {string} params.intentCategory  e.g. 'create_domain'
 * @param {object} params.output          The LLM-generated object to validate
 * @param {string} params.traceId
 * @param {string} [params.priorErrorType] Error type from the calling context
 *   (e.g. 'token_truncation') — forwarded to error_log so the root cause is
 *   preserved even when the resumed output then fails schema validation.
 * @returns {Promise<ValidationResult>}
 */
export async function validate({ intentCategory, output, traceId, priorErrorType, allowLlmCorrection = true }) {
  // --- Load prompt row for output_schema and model ---
  const promptResp = await getRows(
    'PGC_Prompt',
    [{ column: 'intent_category', op: 'eq', value: intentCategory }],
    { column: 'version', direction: 'desc' },
    1
  );

  if (!promptResp.success || promptResp.count === 0) {
    throw new Error(`No PGC_Prompt row found for intent_category "${intentCategory}"`);
  }

  const promptRow    = promptResp.rows[0];
  const outputSchema = promptRow.output_schema;

  // --- Attempt 1 ---
  const attempt1Errors = runValidation(output, outputSchema);

  if (attempt1Errors.length === 0) {
    console.info('review-output: valid on attempt 1', { intentCategory, traceId });
    return { valid: true, intentCategory, attempt: 1, traceId };
  }

  // Replay serve path (allowLlmCorrection: false) — a recorded response must never
  // trigger a correction LLM call (AC2: zero spend on replay). A hit means schema
  // matched, so a valid recorded response re-validates on attempt 1; reaching here
  // means review-output's own routing/semantic rules (code, not fingerprinted)
  // changed since the response was recorded. Surface it, do not spend to correct it.
  if (!allowLlmCorrection) {
    console.warn('review-output: attempt 1 failed, correction disabled (replay serve)', { intentCategory, traceId });
    return { valid: false, intentCategory, attempt: 1, errors: attempt1Errors, correctionSkipped: true, traceId };
  }

  console.info('review-output: attempt 1 failed, attempting correction', {
    intentCategory,
    errorCount: attempt1Errors.length,
    traceId,
  });

  // --- Attempt 2 — inject errors into correction prompt ---
  // Double the token budget — correction rewrites the full JSON and needs at least as
  // much headroom as attempt 1. Without this the response truncates before the closing
  // fence and the fence-strip regex fails, causing a spurious parse error.
  const correctionTokenBudget = promptRow.max_output_tokens
    ? Math.min(parseInt(promptRow.max_output_tokens, 10) * 2, 8000)
    : undefined;

  let correctedOutput;
  try {
    correctedOutput = await callLlmWithCorrection(
      promptRow.model,
      promptRow.prompt_text,
      `Correct the output for intent: ${intentCategory}`,
      outputSchema,
      attempt1Errors,
      output,
      traceId,
      correctionTokenBudget,
    );
  } catch (error) {
    // LLM call itself failed — log attempt1 context so we can inspect what went wrong
    await logPromptError(promptRow.id, {
      error_type:              'llm_correction_failed',
      error_message:           error.message,
      attempt1_errors:         attempt1Errors,
      failing_values:          resolveFailingValues(attempt1Errors, output),
      attempt1_output_excerpt: JSON.stringify(output).slice(0, 800),
      recovery_action:         'halt',
    });
    return {
      valid:       false,
      intentCategory,
      attempt:     2,
      errors:      attempt1Errors,
      errorLogged: true,
      traceId,
    };
  }

  const attempt2Errors = runValidation(correctedOutput, outputSchema);

  if (attempt2Errors.length === 0) {
    console.info('review-output: valid on attempt 2 after correction', { intentCategory, traceId });
    return {
      valid:            true,
      intentCategory,
      attempt:          2,
      correctedOutput,
      attempt1Errors,
      traceId,
    };
  }

  // --- Both attempts failed — log and return invalid ---
  console.warn('review-output: both attempts failed', {
    intentCategory,
    attempt2ErrorCount: attempt2Errors.length,
    traceId,
  });

  const errorType = priorErrorType ?? classifyAjvErrors(attempt2Errors);
  await logPromptError(promptRow.id, {
    error_type:              errorType,
    error_message:           `Validation failed after 2 attempts — ${attempt2Errors.length} error(s)`,
    ajv_errors:              attempt2Errors,
    failing_values:          resolveFailingValues(attempt2Errors, output),
    attempt1_output_excerpt: JSON.stringify(output).slice(0, 800),
    recovery_action:         'halt',
  });

  // Fire-and-forget — prompt_quality_monitor analyses the error_log and auto-patches
  // token ceilings or flags patterns for right-brain improvement. Does not block.
  monitorPromptQuality({ intentCategory, promptId: promptRow.id, traceId })
    .catch(e => console.error('review-output: monitor fire-and-forget failed', { error: e.message, traceId }));

  return {
    valid:           false,
    intentCategory,
    attempt:         2,
    errors:          attempt2Errors,
    attempt1Errors,
    correctedOutput, // expose attempt 2 output for diagnostic recording even on failure
    errorLogged:     true,
    traceId,
  };
}

// ---------------------------------------------------------------------------
// Validation passes
// ---------------------------------------------------------------------------

/**
 * Run Ajv + semantic validation.
 * Returns array of error objects — empty array means valid.
 */
function runValidation(output, outputSchema) {
  const errors = [];

  // Pass 1 — Ajv JSON Schema
  if (outputSchema) {
    const validate = ajv.compile(outputSchema);
    const valid    = validate(output);
    if (!valid) {
      errors.push(...(validate.errors || []).map(e => ({
        type:         'ajv',
        instancePath: e.instancePath,
        schemaPath:   e.schemaPath,
        keyword:      e.keyword,
        message:      e.message,
        params:       e.params,
      })));
    }
  }

  // Pass 2 — Semantic rules (only run if Ajv passed — malformed output
  // makes semantic checks unreliable)
  if (errors.length === 0 && output.tables) {
    errors.push(...runSemanticRules(output));
  }

  return errors;
}

/**
 * Semantic validation rules for create_domain scaffold.
 * See architecture Section 6.10 for full rule definitions.
 */
function runSemanticRules(scaffold) {
  const errors = [];
  const tables  = scaffold.tables || [];

  // Build set of all referenced parent tables from FK definitions
  const referencedTables = new Set(
    tables.flatMap(t =>
      (t.foreignKeys || []).map(fk => fk.references?.table).filter(Boolean)
    )
  );

  for (const table of tables) {
    const tableName  = table.tableName;
    const triggers   = table.triggers   || [];
    const constraints = table.constraints || [];

    // Rule 1 — Every table must have the set_updated_at() BEFORE UPDATE trigger
    const hasUpdatedAtTrigger = triggers.some(
      t => t.function === 'set_updated_at()' && t.timing === 'BEFORE UPDATE'
    );
    if (!hasUpdatedAtTrigger) {
      errors.push({
        type:    'semantic',
        rule:    'missing_updated_at_trigger',
        message: `Table "${tableName}" is missing the set_updated_at() BEFORE UPDATE trigger`,
        table:   tableName,
      });
    }

    // Rule 2 — upsert_key columns must have a matching UNIQUE constraint
    // (only relevant if scaffold includes entity definitions)
    const entity = (scaffold.entities || []).find(e => e.root_table === tableName);
    if (entity) {
      for (const keyCol of entity.upsert_key || []) {
        const hasConstraint = constraints.some(
          c => c.type === 'unique' && (c.columns || []).includes(keyCol)
        );
        if (!hasConstraint) {
          errors.push({
            type:    'semantic',
            rule:    'upsert_key_missing_constraint',
            message: `Entity "${entity.entity_name}" upsert_key column "${keyCol}" has no matching UNIQUE constraint on "${tableName}"`,
            table:   tableName,
            entity:  entity.entity_name,
            column:  keyCol,
          });
        }
      }
    }

    // Rule 3 — FK parent tables must exist in the same scaffold
    for (const fk of table.foreignKeys || []) {
      const parentTable = fk.references?.table;
      if (parentTable && !referencedTables.has(parentTable)) {
        // Check if it's in the current scaffold's table list
        const inScaffold = tables.some(t => t.tableName === parentTable);
        if (!inScaffold) {
          errors.push({
            type:    'semantic',
            rule:    'fk_parent_missing',
            message: `Table "${tableName}" references "${parentTable}" via FK "${fk.name}" but "${parentTable}" is not in this scaffold`,
            table:   tableName,
            fk:      fk.name,
            parent:  parentTable,
          });
        }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Error logging
// ---------------------------------------------------------------------------

/**
 * Classify AJV error array into a coarse error type for the monitor.
 * The most actionable distinction is schema_contract (wrong array element shape)
 * vs schema_violation (missing fields, wrong enum, etc.).
 */
/**
 * Walk AJV instancePaths into the output object and return a map of
 * path → { actual, keyword, message, params } so each failing location
 * has both the LLM's value and the AJV error context in one place.
 */
function resolveFailingValues(errors, output) {
  if (!errors?.length || !output) return {};
  const result = {};
  for (const e of errors) {
    const path = e.instancePath;
    if (!path) continue;
    let actual = null;
    try {
      let node = output;
      for (const seg of path.split('/').filter(Boolean)) {
        if (node == null) break;
        node = node[seg];
      }
      actual = node !== undefined ? node : null;
    } catch { /* leave null */ }
    result[path] = {
      actual,
      keyword: e.keyword,
      message: e.message,
      ...(e.params && Object.keys(e.params).length ? { params: e.params } : {}),
    };
  }
  return result;
}

function classifyAjvErrors(errors) {
  if (!errors || errors.length === 0) return 'unknown';
  const firstErr = errors[0];
  // Wrong array element type (e.g. inputs: [{...}] instead of inputs: ["string"])
  if (firstErr.keyword === 'type' && firstErr.instancePath?.includes('/0')) {
    return 'schema_contract';
  }
  return 'schema_violation';
}

/**
 * Append a structured error entry to PGC_Prompt.error_log.
 * Exported so step-executor can log token_truncation errors that occur
 * before validate() is reached (e.g. when resumption also fails).
 * Non-fatal — if this fails we log to CloudWatch but don't throw.
 */
export async function logPromptError(promptId, errorEntry) {
  try {
    // Read current error_log
    const resp = await getRows(
      'PGC_Prompt',
      [{ column: 'id', op: 'eq', value: promptId }],
      undefined,
      1
    );

    if (!resp.success || resp.count === 0) return;

    const existing = resp.rows[0].error_log ?? { attempts: [] };
    existing.attempts.push({
      at: new Date().toISOString(),
      ...errorEntry,
    });

    await updateRows(
      'PGC_Prompt',
      [{ column: 'id', op: 'eq', value: promptId }],
      { error_log: existing }
    );

    console.info('review-output: error logged to PGC_Prompt', { promptId });
  } catch (error) {
    console.error('review-output: failed to log error to PGC_Prompt', {
      promptId,
      error: error.message,
    });
  }
}
