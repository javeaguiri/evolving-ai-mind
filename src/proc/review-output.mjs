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
 * @returns {Promise<ValidationResult>}
 */
export async function validate({ intentCategory, output, traceId }) {
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

  console.info('review-output: attempt 1 failed, attempting correction', {
    intentCategory,
    errorCount: attempt1Errors.length,
    traceId,
  });

  // --- Attempt 2 — inject errors into correction prompt ---
  let correctedOutput;
  try {
    correctedOutput = await callLlmWithCorrection(
      promptRow.model,
      promptRow.prompt_text,
      `Correct the output for intent: ${intentCategory}`,
      outputSchema,
      attempt1Errors,
      output,
      traceId
    );
  } catch (error) {
    // LLM call itself failed — log and return invalid
    await logPromptError(promptRow.id, {
      error_type:     'llm_correction_failed',
      error_message:  error.message,
      recovery_action: 'halt',
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
      traceId,
    };
  }

  // --- Both attempts failed — log and return invalid ---
  console.warn('review-output: both attempts failed', {
    intentCategory,
    attempt2ErrorCount: attempt2Errors.length,
    traceId,
  });

  await logPromptError(promptRow.id, {
    error_type:      'json_schema_validation',
    error_message:   `Validation failed after 2 attempts — ${attempt2Errors.length} error(s)`,
    ajv_errors:      attempt2Errors,
    recovery_action: 'halt',
  });

  return {
    valid:       false,
    intentCategory,
    attempt:     2,
    errors:      attempt2Errors,
    errorLogged: true,
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

  // Pass 2b — Routing value rules (only for outputs that carry a steps array)
  // Runs independently of output.tables — workflow generation prompts produce
  // steps arrays without tables. Does not run on create_domain output.
  if (errors.length === 0 && Array.isArray(output.steps)) {
    errors.push(...runRoutingValueRules(output.steps));
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
// Pass 2b — Routing value rules (workflow step arrays)
// ---------------------------------------------------------------------------

/**
 * Validate routing values in a steps array.
 * Called when LLM output contains a steps array — i.e. workflow generation
 * prompts (generate_workflow_steps, classify_workflow_intent, etc.).
 * Not called for create_domain output (which has tables, not steps).
 *
 * Checks:
 *   1. Every on_success / on_failure / on_select value is a known routing token
 *   2. Every step:N routing target exists as a step key in the array
 *   3. Every human_gate has at least one option with action: "cancel"
 *
 * Returns errors as { type: 'semantic', rule, message, step } — same shape
 * as runSemanticRules so the correction loop formats them identically.
 */
function runRoutingValueRules(steps) {
  const errors = [];

  // Valid routing token: next, end, cancel, human_feedback, or step:<key>
  const ROUTING_TOKEN_RE = /^(next|end|cancel|human_feedback|step:.+)$/;
  const stepKeys = new Set(steps.map(s => String(s.step)));

  function checkToken(stepKey, fieldName, value) {
    if (value == null) return;
    const v = String(value);
    if (!ROUTING_TOKEN_RE.test(v)) {
      errors.push({
        type:    'semantic',
        rule:    'unknown_routing_value',
        message: `Step "${stepKey}" field "${fieldName}" has unknown routing value "${v}". ` +
                 `Valid values: next, end, cancel, human_feedback, step:<key>`,
        step:    stepKey,
      });
      return;
    }
    if (v.startsWith('step:')) {
      const target = v.slice(5);
      if (!stepKeys.has(target)) {
        errors.push({
          type:    'semantic',
          rule:    'dead_routing_target',
          message: `Step "${stepKey}" field "${fieldName}" routes to "step:${target}" ` +
                   `but no step with key "${target}" exists in this steps array`,
          step:    stepKey,
        });
      }
    }
  }

  for (const s of steps) {
    const key = String(s.step);

    checkToken(key, 'on_success',  s.on_success);
    checkToken(key, 'on_failure',  s.on_failure);
    checkToken(key, 'on_complete', s.on_complete);

    for (const opt of s.options ?? []) {
      checkToken(key, `options[${opt.action}].on_select`, opt.on_select);
    }

    // Ensure every human_gate has a cancel option
    if (s.type === 'human_gate') {
      const hasCancel = (s.options ?? []).some(o => o.action === 'cancel');
      if (!hasCancel) {
        errors.push({
          type:    'semantic',
          rule:    'missing_cancel_option',
          message: `human_gate step "${key}" has no option with action "cancel" — ` +
                   `every gate must give the user a way to cancel`,
          step:    key,
        });
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Error logging
// ---------------------------------------------------------------------------

/**
 * Append a structured error entry to PGC_Prompt.error_log.
 * Non-fatal — if this fails we log to CloudWatch but don't throw.
 */
async function logPromptError(promptId, errorEntry) {
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
