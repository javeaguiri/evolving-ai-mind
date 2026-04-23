// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/monitor-prompt-quality.mjs
//
// Right-brain prompt quality monitor.
// Called fire-and-forget from review-output.mjs after every 2-attempt validation failure.
// Also available as POST /proc/monitor-prompt-quality for manual HTTP triggering.
//
// Analyses PGC_Prompt.error_log for recurring failure patterns and applies
// autonomous fixes where safe to do so without human confirmation:
//
//   token_truncation (2+ consecutive): auto-raise max_output_tokens × 1.5.
//     No LLM required. The ceiling was wrong; raising it costs nothing and
//     cannot produce a worse outcome than the current failure.
//     Guard: skips if a version bump was already applied in the last 24h.
//
//   schema_violation / schema_contract: logs advisory to CloudWatch only.
//     These require right-brain prompt improvement (Phase 3). The error_log
//     is the accumulation surface — the improvement loop reads it when ready.
//
// Transport-agnostic — no AWS SDK, no Slack SDK.
// handler.mjs addition needed:
//   HTTP:  case 'monitor-prompt-quality': return handle(req)
//   SQS:   case 'MONITOR_PROMPT_QUALITY': return handle(buildReq(message))

import { ok, err }           from '../shared/lambda-utils.mjs';
import { getRows, insertRow } from '../shared/serv-client.mjs';

// How far back to look when counting consecutive failures of the same type.
const LOOK_BACK_ATTEMPTS = 5;
// Minimum hours between auto-patches for the same prompt to prevent runaway version inflation.
const AUTO_PATCH_COOLDOWN_HOURS = 24;
// Token ceiling multiplier — conservative 1.5× avoids wasting tokens on prompts that were
// only marginally truncated while giving enough headroom for complex domain inputs.
const CEILING_MULTIPLIER = 1.5;
// Hard upper bound: no single prompt should need more than this.
const CEILING_MAX = 8000;
// Minimum useful ceiling — never drop below this even for tiny prompts.
const CEILING_MIN = 2000;

// ---------------------------------------------------------------------------
// HTTP entry point — POST /proc/monitor-prompt-quality
// ---------------------------------------------------------------------------

export async function handle(req) {
  const { intentCategory, promptId, traceId } = req.body ?? {};
  if (!intentCategory || !promptId) {
    return err(400, 'intentCategory and promptId are required', req.correlationId);
  }
  const result = await monitorPromptQuality({ intentCategory, promptId, traceId: traceId ?? req.correlationId });
  return ok(result, req.correlationId);
}

// ---------------------------------------------------------------------------
// Core monitor — called directly from review-output.mjs (intra-proc import)
// ---------------------------------------------------------------------------

/**
 * Analyse PGC_Prompt.error_log for the given prompt and apply autonomous fixes
 * where the failure pattern is deterministic and the fix carries no risk.
 *
 * @param {object} params
 * @param {string} params.intentCategory  e.g. 'analyze_workflow_gaps'
 * @param {number} params.promptId        PGC_Prompt.id of the failing row
 * @param {string} params.traceId
 * @returns {Promise<MonitorResult>}
 */
export async function monitorPromptQuality({ intentCategory, promptId, traceId }) {
  try {
    // Load the prompt row — need error_log, max_output_tokens, version, model
    const promptResp = await getRows(
      'PGC_Prompt',
      [{ column: 'id', op: 'eq', value: promptId }],
      undefined,
      1
    );
    if (!promptResp.success || promptResp.count === 0) {
      console.warn('monitor-prompt-quality: prompt row not found', { promptId, traceId });
      return { action: 'skipped', reason: 'prompt_not_found' };
    }
    const promptRow = promptResp.rows[0];
    const attempts  = promptRow.error_log?.attempts ?? [];

    if (attempts.length === 0) {
      return { action: 'skipped', reason: 'no_error_log' };
    }

    // Take the last LOOK_BACK_ATTEMPTS entries and classify the pattern
    const recent = attempts.slice(-LOOK_BACK_ATTEMPTS);
    const pattern = classifyPattern(recent);

    console.info('monitor-prompt-quality: analysing', {
      intentCategory,
      promptId,
      recentCount: recent.length,
      pattern,
      traceId,
    });

    if (pattern === 'token_truncation') {
      return applyTokenCeilingPatch({ intentCategory, promptRow, traceId });
    }

    if (pattern === 'schema_violation' || pattern === 'schema_contract') {
      console.info('monitor-prompt-quality: schema pattern detected — advisory only (right-brain improvement loop required)', {
        intentCategory, pattern, traceId,
      });
      return { action: 'advisory', pattern, intentCategory };
    }

    return { action: 'skipped', reason: 'no_actionable_pattern', pattern };

  } catch (error) {
    // Monitor failures must never propagate — they are fire-and-forget
    console.error('monitor-prompt-quality: unexpected error', { error: error.message, promptId, traceId });
    return { action: 'error', error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Pattern classification
// ---------------------------------------------------------------------------

/**
 * Classify the dominant failure pattern in a recent attempts array.
 * Returns 'token_truncation', 'schema_violation', 'schema_contract', or 'mixed'.
 * Requires 2+ consecutive matching entries to count as a pattern — a single
 * occurrence may be a one-off; consecutive failures indicate a structural issue.
 */
function classifyPattern(attempts) {
  if (attempts.length < 2) return 'insufficient_data';

  // Count consecutive matching types from the end (most recent first)
  const reversedTypes = [...attempts].reverse().map(a => a.error_type);
  const latestType    = reversedTypes[0];
  let   consecutiveCount = 0;

  for (const type of reversedTypes) {
    if (type === latestType) consecutiveCount++;
    else break;
  }

  if (consecutiveCount >= 2) return latestType;
  return 'mixed';
}

// ---------------------------------------------------------------------------
// Auto-patch: token ceiling
// ---------------------------------------------------------------------------

/**
 * Insert a new PGC_Prompt version with a raised max_output_tokens ceiling.
 * The executor always loads the latest version (ORDER BY version DESC LIMIT 1),
 * so inserting a new row is the correct way to deploy a ceiling change without
 * losing the error history on the old version.
 *
 * Guard: if a ceiling-raised version was already inserted in the last
 * AUTO_PATCH_COOLDOWN_HOURS hours, skip to prevent runaway version inflation.
 */
async function applyTokenCeilingPatch({ intentCategory, promptRow, traceId }) {
  // Guard: check for a recently auto-patched version
  const latestResp = await getRows(
    'PGC_Prompt',
    [{ column: 'intent_category', op: 'eq', value: intentCategory }],
    { column: 'version', direction: 'desc' },
    1
  );

  if (latestResp.success && latestResp.count > 0) {
    const latestRow  = latestResp.rows[0];
    const patchedAt  = new Date(latestRow.created_at);
    const hoursSince = (Date.now() - patchedAt.getTime()) / (1000 * 60 * 60);

    if (latestRow.version > promptRow.version && hoursSince < AUTO_PATCH_COOLDOWN_HOURS) {
      console.info('monitor-prompt-quality: token ceiling patch skipped — already patched recently', {
        intentCategory,
        latestVersion: latestRow.version,
        hoursSince:    Math.round(hoursSince),
        traceId,
      });
      return { action: 'skipped', reason: 'cooldown', latestVersion: latestRow.version };
    }
  }

  const currentCeiling = promptRow.max_output_tokens ?? 2000;
  const newCeiling     = Math.min(
    Math.ceil(currentCeiling * CEILING_MULTIPLIER),
    CEILING_MAX
  );

  if (newCeiling <= currentCeiling) {
    console.info('monitor-prompt-quality: already at maximum ceiling', { intentCategory, currentCeiling, traceId });
    return { action: 'skipped', reason: 'at_maximum_ceiling', currentCeiling };
  }

  const newVersion = (promptRow.version ?? 1) + 1;

  // Insert new prompt version — copy everything, bump version + ceiling, clear error_log
  const newRow = {
    intent_category:  intentCategory,
    version:          newVersion,
    model:            promptRow.model,
    prompt_text:      promptRow.prompt_text,
    input_variables:  promptRow.input_variables,
    output_schema:    promptRow.output_schema,
    max_output_tokens: newCeiling,
    was_successful:   null,
    error_log:        null,
    quality_score:    null,
    parent_prompt_id: promptRow.id,
  };

  await insertRow('PGC_Prompt', newRow);

  console.info('monitor-prompt-quality: token ceiling auto-patched', {
    intentCategory,
    oldVersion:    promptRow.version,
    newVersion,
    oldCeiling:    currentCeiling,
    newCeiling,
    traceId,
  });

  return {
    action:      'auto_patched',
    pattern:     'token_truncation',
    intentCategory,
    oldVersion:  promptRow.version,
    newVersion,
    oldCeiling:  currentCeiling,
    newCeiling,
  };
}
