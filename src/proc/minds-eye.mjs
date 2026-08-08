// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/minds-eye.mjs
// Handles MINDS_EYE and MINDS_EYE_RESUME SQS messages.
//
// Agentic reasoning loop:
//   1. Load preferences (model, turn_limit, max_actions_per_session) from PGC_SystemContext
//   2. Load or create PGC_Session (session_type = 'minds_eye')
//   3. Assemble Layer 1 context (PGC_Workflow summaries)
//   4. Assemble Layer 2 context (relevant PGC_Memory entries)
//   5. Reason loop: callLlm → { action, params, reasoning } | { action: "respond", message }
//      - Read tool          → execute → append result → continue loop
//      - Inline write tool  → execute directly → append result → continue loop (no gate)
//      - Gated write tool   → store __pending__ entry → post HUMAN_GATE → end turn
//      - "respond"          → post to Slack → end turn
//      - turn_count >= turn_limit → post turn-limit notification → end
//
// Write tool gate policy:
//   update_data, insert_data — inline, no confirmation gate
//   propose_workflow_fix — gated (shows step diff for human review before writing)
//   delete_data — gated (destructive; requires explicit approval)
//
// MINDS_EYE_RESUME — gate approval:
//   Load session → find __pending__ entry → execute (approved) or record cancel → continue loop
//
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { ok, err }                                         from '../shared/lambda-utils.mjs';
import { getRows, insertRow, insertRows, updateRows, deleteRows, upsertRows } from '../shared/serv-client.mjs';
import { callLlm }                                         from '../shared/llm-client.mjs';
import { enqueueCallback, enqueueWorkflow }                from '../shared/sqs-callback.mjs';
import { runSimulation }                                  from './simulation-engine.mjs';
import { loadStepTypeContracts }                          from './step-type-registry.mjs';

const ACTION_SCHEMA = {
  type: 'object',
  required: ['action', 'reasoning'],
  properties: {
    action:   { type: 'string' },
    params:   { type: 'object' },
    reasoning:{ type: 'string' },
    message:  { type: 'string' },
    advisory: { type: 'string' },
  },
};

const DEFAULT_PREFERENCES = {
  name:                   'Agent',
  model:                  'anthropic/claude-sonnet-4-6',
  max_output_tokens:      8192,
  // Wall clock for one round, sized under ProcFunction's Lambda timeout with room left for
  // the session writes and the continue gate that follow the last turn. It is a fallback:
  // the live value lives in minds_eye_preferences, where it can be tuned without a deploy.
  round_budget_ms:        195_000,
  turn_limit:             8,
  max_actions_per_session:5,
  max_lifetime_turns:     100,
  tone:                   'concise but friendly',
  advisory_level:         'proactive',
  response_format:        'structured',
  technical_level:        'high',
};

const READ_TOOLS = new Set([
  'query_table', 'query_entity', 'read_memory',
  'read_workflow', 'read_prompt', 'simulate_workflow',
  'search_domain_help', 'list_tables', 'list_physical_tables',
  'run_sql',
]);

// Inline write tools — execute immediately, no confirmation gate required.
const INLINE_WRITE_TOOLS = new Set([
  'update_data', 'insert_data', 'upsert_data',
]);

// Gated write tools — post a HUMAN_GATE before executing.
const GATED_WRITE_TOOLS = new Set([
  'register_workflow',
  'propose_workflow_fix', 'propose_schema_fix', 'delete_data', 'drop_table',
  'create_view', 'drop_view',
]);

// Trigger tools — dispatch a registered workflow to the step-executor engine.
const TRIGGER_TOOLS = new Set([
  'run_workflow',
]);

// Housekeeping tools — execute immediately, no gate, do not count against action limit.
const HOUSEKEEPING_TOOLS = new Set([
  'write_memory',
]);

// Every name the loop can actually dispatch. The Sets above stay the authority on that —
// a schema is only sent to the gateway if there is code behind it, because a tool the model
// can call and the loop cannot run is worse than a tool it never sees.
export const DISPATCHABLE_TOOLS = new Set([
  ...READ_TOOLS, ...INLINE_WRITE_TOOLS, ...GATED_WRITE_TOOLS,
  ...TRIGGER_TOOLS, ...HOUSEKEEPING_TOOLS, 'respond',
]);

/**
 * Reconcile the stored tool schemas against what the loop can dispatch.
 *
 * The schemas live in PGC_SystemContext (minds_eye_tool_schemas) so a description can be
 * retuned without a deploy — triggering quality is mostly description quality. The cost of
 * that is drift: a row can describe a tool the code does not have, or miss one it does.
 * Both directions are reported rather than silently tolerated.
 *
 * `type: 'function'` is added here rather than stored 23 times in the row.
 *
 * @param {object|null} content       The row's content — expects { tools: [{name, description, parameters}] }
 * @param {Set<string>} dispatchable  Names the loop can execute
 * @returns {{tools: Array, undispatchable: string[], undescribed: string[]}}
 */
export function selectToolDefinitions(content, dispatchable = DISPATCHABLE_TOOLS) {
  const declared = Array.isArray(content?.tools) ? content.tools : [];

  const named          = declared.filter(t => typeof t?.name === 'string' && t.name);
  const undispatchable = named.filter(t => !dispatchable.has(t.name)).map(t => t.name);

  const tools = named
    .filter(t => dispatchable.has(t.name))
    .map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters }));

  const describedNames = new Set(tools.map(t => t.name));
  const undescribed    = [...dispatchable].filter(n => !describedNames.has(n));

  return { tools, undispatchable, undescribed };
}

/**
 * Load the tool catalog for a round.
 *
 * Returns null — never [] — when the row cannot be read. An empty array is a valid state
 * meaning "no tools", and sending it would leave Novia mute with no error to explain why;
 * null lets the caller end the round with a real message instead.
 *
 * @returns {Promise<Array|null>} Tool definitions ready for callLlmWithTools, or null
 */
async function loadToolDefinitions(traceId) {
  const resp = await getRows('PGC_SystemContext', [
    { column: 'key', op: 'eq', value: 'minds_eye_tool_schemas' },
  ]);

  if (!resp.success || !resp.rows?.length) {
    console.error('proc/minds-eye: minds_eye_tool_schemas row not readable', { traceId });
    return null;
  }

  const { tools, undispatchable, undescribed } = selectToolDefinitions(resp.rows[0].content);

  if (undispatchable.length > 0) {
    console.warn('proc/minds-eye: tool schemas describe undispatchable tools — dropped', { undispatchable, traceId });
  }
  if (undescribed.length > 0) {
    console.warn('proc/minds-eye: dispatchable tools have no schema — invisible to the model', { undescribed, traceId });
  }
  if (tools.length === 0) {
    console.error('proc/minds-eye: tool schema row yielded no usable tools', { traceId });
    return null;
  }

  return tools;
}

export async function handle(req) {
  const body     = req.body ?? {};
  const callback = req.callback ?? body.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;

  // MINDS_EYE_RESUME — gate approval/rejection routes here
  if (req.route === 'minds-eye-resume') {
    return handleGateResume(body, callback, traceId, req);
  }

  const { prompt, sessionId: existingSessionId, slackUser } = body;

  if (!prompt?.trim()) {
    if (req.source === 'http') return err(400, 'prompt is required', req.correlationId);
    return;
  }

  console.info('proc/minds-eye: received', { traceId, slackUser, existingSessionId });

  const { prefs, systemPrompt } = await loadPrefsAndPrompt();

  // ── Load or create session ────────────────────────────────────────────────
  const threadTs = callback?.threadId ?? null;
  let session;
  let existingEntries = [];

  if (existingSessionId) {
    const sessResp = await getRows('PGC_Session', [
      { column: 'id', op: 'eq', value: existingSessionId },
    ]);
    session = sessResp.rows?.[0] ?? null;
    if (!session) {
      console.warn('proc/minds-eye: session not found', { existingSessionId, traceId });
      if (callback) await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: 'Session not found. Start a new conversation.' });
      return;
    }
    const entriesResp = await getRows(
      'PGC_SessionEntry',
      [{ column: 'session_id', op: 'eq', value: session.id }],
      { column: 'sequence_number', direction: 'asc' }
    );
    existingEntries = entriesResp.rows ?? [];
  } else {
    const sessResp = await insertRow('PGC_Session', {
      session_type:           'minds_eye',
      slack_thread_ts:        threadTs,
      minds_eye_turn_count:   0,
      minds_eye_action_count: 0,
    });
    if (!sessResp.success) throw new Error(`PGC_Session insert failed: ${sessResp.error}`);
    session = sessResp.row;
    console.info('proc/minds-eye: session created', { sessionId: session.id, traceId });
  }

  const { layer1Context, layer2Context } = await assembleContext();

  // Save user message
  const nextSeq = existingEntries.length > 0
    ? Math.max(...existingEntries.map(e => e.sequence_number)) + 1
    : 1;

  await insertRow('PGC_SessionEntry', {
    session_id:      session.id,
    sequence_number: nextSeq,
    role:            'user',
    content:         prompt.trim(),
  });

  const workingHistory = [
    ...existingEntries,
    { role: 'user', content: prompt.trim(), sequence_number: nextSeq },
  ];

  await runReasoningLoop({
    session,
    prefs,
    systemPrompt,
    layer1Context,
    layer2Context,
    workingHistory,
    callback,
    traceId,
    currentTurnCount:   session.minds_eye_turn_count   ?? 0,
    currentActionCount: session.minds_eye_action_count ?? 0,
    currentSeq:         nextSeq + 1,
    threadTs:           threadTs ?? session.slack_thread_ts,
  });

  if (req.source === 'http') {
    return ok({ success: true, sessionId: session.id }, req.correlationId);
  }
}

// ---------------------------------------------------------------------------
// MINDS_EYE_RESUME — execute an approved gated write tool and continue the loop
// ---------------------------------------------------------------------------

async function handleGateResume(body, callback, traceId, req) {
  const { sessionId, approved, resumeType } = body;

  const sessResp = await getRows('PGC_Session', [{ column: 'id', op: 'eq', value: sessionId }]);
  const session  = sessResp.rows?.[0] ?? null;
  if (!session) {
    console.warn('proc/minds-eye: resume session not found', { sessionId, traceId });
    if (callback) await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: 'Session not found — cannot resume.' });
    return;
  }

  const entriesResp = await getRows(
    'PGC_SessionEntry',
    [{ column: 'session_id', op: 'eq', value: session.id }],
    { column: 'sequence_number', direction: 'asc' }
  );
  const entries = entriesResp.rows ?? [];

  // Follow-up question — add user message, reset turns and actions (a human just
  // engaged with the session), run loop, re-post continue gate after response.
  if (resumeType === 'followup') {
    const { followupText } = body;
    if (!followupText?.trim()) {
      console.warn('proc/minds-eye: followup missing text', { sessionId, traceId });
      return;
    }
    const newSeq = Math.max(...entries.map(e => e.sequence_number), 0) + 1;
    await insertRow('PGC_SessionEntry', {
      session_id:      session.id,
      sequence_number: newSeq,
      role:            'user',
      content:         followupText.trim(),
    });
    // minds_eye_turn_count is a cumulative lifetime tally — never reset here,
    // only minds_eye_action_count (a human just engaged with the session).
    await updateRows('PGC_Session', [{ column: 'id', op: 'eq', value: session.id }], {
      minds_eye_action_count: 0,
    });
    const { prefs, systemPrompt } = await loadPrefsAndPrompt();
    const { layer1Context, layer2Context } = await assembleContext();
    await runReasoningLoop({
      session,
      prefs,
      systemPrompt,
      layer1Context,
      layer2Context,
      workingHistory:               [...entries, { role: 'user', content: followupText.trim(), sequence_number: newSeq }],
      callback,
      traceId,
      currentTurnCount:             session.minds_eye_turn_count ?? 0,
      currentActionCount:           0,
      currentSeq:                   newSeq + 1,
      threadTs:                     callback?.threadId ?? session.slack_thread_ts,
      postContinueGateAfterRespond: true,
    });
    if (req?.source === 'http') return ok({ success: true, sessionId: session.id }, req.correlationId);
    return;
  }

  // Turn-limit or action-limit continue — a human just reviewed and explicitly
  // authorized more budget. Only minds_eye_action_count resets (a human
  // touchpoint); minds_eye_turn_count is a cumulative lifetime tally that never
  // resets — it's checked against max_lifetime_turns inside runReasoningLoop.
  if (resumeType === 'continue') {
    if (!approved) {
      console.info('proc/minds-eye: continue gate cancelled', { sessionId, traceId });
      return;
    }
    await updateRows('PGC_Session', [{ column: 'id', op: 'eq', value: session.id }], {
      minds_eye_action_count: 0,
    });
    const { prefs, systemPrompt } = await loadPrefsAndPrompt();
    const { layer1Context, layer2Context } = await assembleContext();
    await runReasoningLoop({
      session,
      prefs,
      systemPrompt,
      layer1Context,
      layer2Context,
      workingHistory:     [...entries],
      callback,
      traceId,
      currentTurnCount:   session.minds_eye_turn_count ?? 0,
      currentActionCount: 0,
      currentSeq:         Math.max(...entries.map(e => e.sequence_number), 0) + 1,
      threadTs:           callback?.threadId ?? session.slack_thread_ts,
    });
    if (req?.source === 'http') return ok({ success: true, sessionId: session.id }, req.correlationId);
    return;
  }

  // Action gate — find the most recent __pending__ entry and execute or cancel it.
  const pendingEntry = [...entries].reverse().find(e => {
    if (e.role !== 'tool') return false;
    try { return JSON.parse(e.content)?.tool === '__pending__'; }
    catch { return false; }
  });

  if (!pendingEntry) {
    console.warn('proc/minds-eye: no pending action found for resume', { sessionId, traceId });
    if (callback) await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: 'No pending action to resume.' });
    return;
  }

  let pendingData;
  try { pendingData = JSON.parse(pendingEntry.content); }
  catch { pendingData = {}; }

  const { action, params } = pendingData;
  const currentSeq    = Math.max(...entries.map(e => e.sequence_number)) + 1;
  const workingHistory = [...entries];

  if (!approved) {
    const cancelEntry = JSON.stringify({ tool: '__cancelled__', action, params });
    await insertRow('PGC_SessionEntry', {
      session_id:      session.id,
      sequence_number: currentSeq,
      role:            'tool',
      content:         cancelEntry,
    });
    // A rejection is still a human touchpoint — reset the action count same as approval.
    await updateRows('PGC_Session', [{ column: 'id', op: 'eq', value: session.id }], {
      minds_eye_action_count: 0,
    });
    if (callback) {
      await enqueueCallback(callback, {
        type:      'HUMAN_NOTIFICATION',
        format:    'markdown',
        traceId,
        message:   'Action cancelled.',
        sessionId: session.id,
      });
    }
    console.info('proc/minds-eye: action cancelled', { sessionId, action, traceId });
    return;
  }

  // Execute the approved gated action
  const result    = await executeWriteTool(action, params, traceId);
  const resultStr = JSON.stringify({ tool: action, params, result });
  await insertRow('PGC_SessionEntry', {
    session_id:      session.id,
    sequence_number: currentSeq,
    role:            'tool',
    content:         resultStr,
  });
  workingHistory.push({ role: 'tool', content: resultStr, sequence_number: currentSeq });

  await writeFactualMemory(action, params, result, session.id, traceId);

  // Any gate resumption is a human touchpoint, so the action count resets here
  // rather than accumulating across approvals — this action becomes the first
  // of a fresh count, not the Nth of a running session total. This means the
  // action limit only ever fires on a streak of INLINE (ungated) writes with no
  // human involved in between; a fully human-supervised sequence of gated
  // actions never artificially hits the ceiling.
  const newActionCount = 1;
  await updateRows('PGC_Session', [{ column: 'id', op: 'eq', value: session.id }], {
    minds_eye_action_count: newActionCount,
  });

  console.info('proc/minds-eye: gated action executed', { sessionId, action, traceId });

  const { prefs, systemPrompt } = await loadPrefsAndPrompt();
  const { layer1Context, layer2Context } = await assembleContext();

  await runReasoningLoop({
    session,
    prefs,
    systemPrompt,
    layer1Context,
    layer2Context,
    workingHistory,
    callback,
    traceId,
    currentTurnCount:   session.minds_eye_turn_count ?? 0,
    currentActionCount: newActionCount,
    currentSeq:         currentSeq + 1,
    threadTs:           callback?.threadId ?? session.slack_thread_ts,
  });

  if (req?.source === 'http') {
    return ok({ success: true, sessionId: session.id }, req.correlationId);
  }
}

// ---------------------------------------------------------------------------
// Shared reasoning loop — called from both handle() and handleGateResume()
// ---------------------------------------------------------------------------

// Cumulative, never-reset lifetime turn ceiling — a defense-in-depth guard
// against a runaway session, distinct from turn_limit (a per-invocation budget
// that always starts fresh). Checked both before starting a round (cheapest —
// refuses before spending an LLM call) and after a round ends without a
// response (so a session can't slip past it one continue-gate at a time).
/**
 * The notification for a round that ended on a failed reasoning turn.
 *
 * A failure exit skips the loop-exit block, so no continue gate is posted and the thread
 * ends on an error with no way back in — twice the user has had to hunt an older message to
 * resume. `format: 'markdown'` plus a `sessionId` is all the renderer needs to attach the
 * follow-up button it already builds (`callback.mjs:437`), so the session stays reachable
 * without a second gate type or a new mechanism. The session itself was never damaged: every
 * completed turn is already written to PGC_SessionEntry.
 */
function buildFailureNotification(sessionId, traceId, llmError) {
  return {
    type:      'HUMAN_NOTIFICATION',
    format:    'markdown',
    sessionId,
    traceId,
    message:   `Agent reasoning failed: ${llmError.message}\n\nEverything up to this point is saved — use **Ask follow-up** to pick the session back up.`,
  };
}

/**
 * Whether there is room for another turn inside this round's wall-clock budget.
 *
 * The loop runs its turns inside ONE Lambda invocation, so `turn_limit` is not the budget
 * that binds — wall clock is. Session 1121 spent 7s, 85s and 46s on three turns and the
 * fourth was still running when the invocation hit its ceiling. A Lambda timeout is not an
 * exception: nothing catches it, no notification is posted, the turn in flight writes
 * nothing, and the SQS message was deleted on receipt so there is no retry. The round
 * simply vanishes, which from Slack is indistinguishable from hanging.
 *
 * The estimate is the longest turn already seen this round, because that is the only
 * evidence this round offers about what the next one costs. Early turns are cheap and the
 * expensive ones cluster late, as the transcript grows — so the estimate rises exactly when
 * caution starts to matter. It cannot be a guarantee: a turn may always exceed every turn
 * before it. A guarantee would need the invocation's real remaining time, and PROC endpoint
 * modules must not learn they are running on Lambda (architecture.md §3.5) — hence a
 * configured budget rather than getRemainingTimeInMillis.
 *
 * With no turn observed yet the estimate is 0, so the first turn of a round always runs.
 */
export function roundBudgetExhausted(elapsedMs, longestTurnMs, budgetMs) {
  if (!budgetMs) return false;
  return elapsedMs + longestTurnMs > budgetMs;
}

/**
 * What a failed `callLlm` gets: another try, a correction, or the end of the round.
 *
 * `reask` — the response was severed at the output ceiling, not malformed. Feeding the raw
 * output back for correction is exactly wrong here: that output IS what exhausted the
 * budget, so re-sending it guarantees a second truncation. The same question is asked
 * again instead, with the cut-off stated, and the pacing instruction does the rest.
 *
 * Once only. A second truncation in a row means the notice did not land, and looping on it
 * would spend the whole round generating responses nobody ever sees.
 *
 * `correct` — the content was complete but the JSON escaping was not, which the raw output
 * is exactly what is needed to fix.
 */
export function classifyLlmFailure(llmError, lastTurnTruncated) {
  if (llmError?.isTruncated)  return lastTurnTruncated ? 'fail' : 'reask';
  if (llmError?.isParseError && llmError.rawOutput) return 'correct';
  return 'fail';
}

// Sent in place of the cut-off response, not alongside it — the severed text is never
// echoed back, since its length is the problem. States what happened, what survived, and
// that the work can be split; how to split it is the pacing instruction's business.
const TRUNCATION_NOTICE =
  'Your previous response reached the output limit before it was finished, so none of it ' +
  'was recorded and this is the same question again. Nothing else was lost — the ' +
  'conversation above is intact, and only that one unfinished response is gone. Keep this ' +
  'response short enough to complete. If what you were producing does not fit, produce the ' +
  'part that does, say what remains, and take the rest on the next turn.';

async function notifyLifetimeCeiling(session, callback, traceId, count) {
  console.warn('proc/minds-eye: session at/over lifetime turn ceiling', { sessionId: session.id, count, traceId });
  if (callback) {
    await enqueueCallback(callback, {
      type:      'HUMAN_NOTIFICATION',
      traceId,
      message:   `This session has run ${count} turns in total — that's unusually long. Please start a fresh session rather than continuing this one.`,
      sessionId: session.id,
    });
  }
}

async function runReasoningLoop({ session, prefs, systemPrompt, layer1Context, layer2Context, workingHistory, callback, traceId, currentTurnCount, currentActionCount, currentSeq, threadTs, postContinueGateAfterRespond = false }) {
  if (currentTurnCount >= prefs.max_lifetime_turns) {
    await notifyLifetimeCeiling(session, callback, traceId, currentTurnCount);
    return;
  }

  let turnCount      = currentTurnCount;  // cumulative lifetime tally — never reset, persisted
  let turnsThisRound  = 0;                // per-invocation budget — always starts fresh
  let actionCount     = currentActionCount;
  let seq             = currentSeq;
  let responded       = false;
  let earlyExit       = false;
  let truncationNotice = null;            // carried into the next message when a turn was cut off
  let lastTurnTruncated = false;
  const roundStart   = Date.now();
  let longestTurnMs  = 0;
  let budgetExhausted = false;

  while (turnsThisRound < prefs.turn_limit) {
    // Stop before starting a turn there is no room to finish. Ending here is a clean exit
    // down the same path the turn limit uses — turnCount persisted, continue gate posted —
    // rather than the invocation dying mid-call with nothing written.
    if (roundBudgetExhausted(Date.now() - roundStart, longestTurnMs, prefs.round_budget_ms)) {
      console.info('proc/minds-eye: round budget reached — ending round', {
        sessionId:     session.id,
        turnsThisRound,
        elapsedMs:     Date.now() - roundStart,
        longestTurnMs,
        budgetMs:      prefs.round_budget_ms,
        traceId,
      });
      budgetExhausted = true;
      break;
    }

    const turnStart   = Date.now();
    const userMessage = buildUserMessage(layer1Context, layer2Context, workingHistory, prefs, truncationNotice);
    truncationNotice  = null;

    let decision;
    try {
      decision = await callLlm(prefs.model, systemPrompt, userMessage, ACTION_SCHEMA, traceId, prefs.max_output_tokens);
      lastTurnTruncated = false;
    } catch (llmError) {
      const failureAction = classifyLlmFailure(llmError, lastTurnTruncated);

      if (failureAction === 'reask') {
        console.warn('proc/minds-eye: response truncated at output ceiling — re-asking', {
          traceId,
          maxOutputTokens: prefs.max_output_tokens,
        });
        truncationNotice  = TRUNCATION_NOTICE;
        lastTurnTruncated = true;
        longestTurnMs   = Math.max(longestTurnMs, Date.now() - turnStart);
        turnCount      += 1;
        turnsThisRound += 1;
        continue;
      }

      if (failureAction === 'correct') {
        // Generation fault: LLM produced valid content but invalid JSON escaping.
        // The correction call is a real extra LLM call — counts as its own turn.
        try {
          const correctionMsg = `Your previous response was not valid JSON. Here is what you returned:\n\n${llmError.rawOutput}\n\nReturn the same content as a valid JSON object. Escape all special characters in string values: \\n for newlines, \\" for double quotes, \\\\ for backslashes. Return the JSON only — no prose, no fences.`;
          decision = await callLlm(prefs.model, systemPrompt, correctionMsg, ACTION_SCHEMA, traceId, prefs.max_output_tokens);
          turnCount += 1;
          turnsThisRound += 1;
          console.info('proc/minds-eye: JSON parse corrected', { traceId });
        } catch (corrErr) {
          // The correction's OWN failure was previously terminal — no classification, no
          // retry — so a transport blip while repairing a recoverable parse error ended the
          // session (`fetch failed`, session 1122 11:06:53, after two corrections in the
          // same round had succeeded). Classify it the same way as any other failed call:
          // a truncated correction gets re-asked, and anything else still ends the round.
          if (classifyLlmFailure(corrErr, lastTurnTruncated) === 'reask') {
            console.warn('proc/minds-eye: correction truncated — re-asking', { traceId });
            truncationNotice  = TRUNCATION_NOTICE;
            lastTurnTruncated = true;
            longestTurnMs     = Math.max(longestTurnMs, Date.now() - turnStart);
            turnCount      += 1;
            turnsThisRound += 1;
            continue;
          }
          console.error('proc/minds-eye: JSON correction failed', { traceId, error: corrErr.message });
          if (callback) await enqueueCallback(callback, buildFailureNotification(session.id, traceId, llmError));
          earlyExit = true;
          break;
        }
      } else {
        console.error('proc/minds-eye: LLM call failed', { traceId, error: llmError.message });
        if (callback) await enqueueCallback(callback, buildFailureNotification(session.id, traceId, llmError));
        earlyExit = true;
        break;
      }
    }

    // Measured across the whole turn, correction call included — the budget check cares
    // what a turn costs in wall clock, not how many API calls it took to get there.
    longestTurnMs = Math.max(longestTurnMs, Date.now() - turnStart);

    // Every turn costs exactly 1, regardless of which tool ran or whether it
    // errored — a tool call and a direct respond are the same cost; only the
    // JSON-correction retry above adds an extra turn, since it's an extra LLM call.
    turnCount += 1;
    turnsThisRound += 1;

    // The top-of-function check only stops a *new* round from starting — a
    // round already in progress could still push turnCount past the ceiling
    // before turn_limit naturally ends it. Stop here too, before any of this
    // iteration's branches try to persist turnCount (chk_pgc_session_turn_ceiling
    // would reject anything over 100).
    if (turnCount >= prefs.max_lifetime_turns) {
      await notifyLifetimeCeiling(session, callback, traceId, turnCount);
      earlyExit = true;
      break;
    }

    const { action, params = {}, reasoning, message, advisory } = decision;

    if (action === 'respond') {
      const assistantContent = JSON.stringify({ action: 'respond', message, reasoning, advisory });
      await insertRow('PGC_SessionEntry', {
        session_id:      session.id,
        sequence_number: seq,
        role:            'assistant',
        content:         assistantContent,
      });

      await updateRows('PGC_Session',
        [{ column: 'id', op: 'eq', value: session.id }],
        { minds_eye_turn_count: turnCount, slack_thread_ts: threadTs ?? session.slack_thread_ts }
      );

      if (callback) {
        let replyText = message ?? '(no message)';
        // Slack requires ``` to be on its own line; normalize before sending.
        replyText = replyText.replace(/([^\n])(`{3})/g, '$1\n$2').replace(/(`{3})([^\n])/g, '$1\n$2');
        if (advisory && prefs.advisory_level !== 'off') {
          replyText += `\n\n---\n_Advisory: ${advisory}_`;
        }
        replyText += `\n\n_Session ${session.id}_`;
        await enqueueCallback(callback, {
          type:      'HUMAN_NOTIFICATION',
          format:    'markdown',
          traceId,
          message:   replyText,
          queryId:   session.query_id,
          sessionId: session.id,
        });
      }

      responded = true;
      console.info('proc/minds-eye: responded', { sessionId: session.id, traceId, turns: turnCount });
      break;

    } else if (READ_TOOLS.has(action)) {
      const toolResult = await executeReadTool(action, params, traceId);
      const toolEntry  = JSON.stringify({ tool: action, params, result: toolResult });

      await insertRow('PGC_SessionEntry', {
        session_id:      session.id,
        sequence_number: seq,
        role:            'tool',
        content:         toolEntry,
      });

      workingHistory.push({ role: 'tool', content: toolEntry, sequence_number: seq });
      seq += 1;

      await notifyTurnProgress({ callback, traceId, turn: turnCount, action, reasoning, result: toolResult });
      console.info('proc/minds-eye: read tool executed', { action, sessionId: session.id, traceId });

    } else if (HOUSEKEEPING_TOOLS.has(action)) {
      const enrichedParams = action === 'write_memory'
        ? { ...params, scope: deriveScope(workingHistory) }
        : params;
      const hkResult = await executeWriteTool(action, enrichedParams, traceId);
      const hkEntry  = JSON.stringify({ tool: action, params: enrichedParams, result: hkResult });

      await insertRow('PGC_SessionEntry', {
        session_id:      session.id,
        sequence_number: seq,
        role:            'tool',
        content:         hkEntry,
      });

      workingHistory.push({ role: 'tool', content: hkEntry, sequence_number: seq });
      seq += 1;

      await notifyTurnProgress({ callback, traceId, turn: turnCount, action, reasoning, result: hkResult });
      console.info('proc/minds-eye: housekeeping tool executed', { action, sessionId: session.id, traceId });

    } else if (INLINE_WRITE_TOOLS.has(action)) {
      if (actionCount >= prefs.max_actions_per_session) {
        await postTurnLimitGate(session.id, callback, traceId, true);
        earlyExit = true;
        break;
      }

      const writeResult = await executeWriteTool(action, params, traceId);
      const writeEntry  = JSON.stringify({ tool: action, params, result: writeResult });

      await insertRow('PGC_SessionEntry', {
        session_id:      session.id,
        sequence_number: seq,
        role:            'tool',
        content:         writeEntry,
      });

      actionCount += 1;
      await updateRows('PGC_Session',
        [{ column: 'id', op: 'eq', value: session.id }],
        { minds_eye_action_count: actionCount }
      );

      workingHistory.push({ role: 'tool', content: writeEntry, sequence_number: seq });
      seq += 1;

      await notifyTurnProgress({ callback, traceId, turn: turnCount, action, reasoning, result: writeResult });
      console.info('proc/minds-eye: write tool executed', { action, sessionId: session.id, traceId });

    } else if (GATED_WRITE_TOOLS.has(action)) {
      // Refused before the gate, not at it — the loop continues so the next turn can
      // correct, instead of ending the round on a decision nobody gets to make.
      const refusal = await preGateRefusal(action, params, traceId);
      if (refusal) {
        const refusalEntry = JSON.stringify({ tool: action, params, result: refusal });

        await insertRow('PGC_SessionEntry', {
          session_id:      session.id,
          sequence_number: seq,
          role:            'tool',
          content:         refusalEntry,
        });

        workingHistory.push({ role: 'tool', content: refusalEntry, sequence_number: seq });
        seq += 1;

        // No progress line: this is a failed attempt about to be corrected, which is the
        // case notifyTurnProgress deliberately stays quiet about.
        console.info('proc/minds-eye: gated write refused before gate', {
          action,
          sessionId: session.id,
          issueCount: refusal.issues?.length ?? 0,
          traceId,
        });
        continue;
      }

      if (actionCount >= prefs.max_actions_per_session) {
        await postTurnLimitGate(session.id, callback, traceId, true);
        earlyExit = true;
        break;
      }

      await postActionGate({ session, action, params, callback, traceId, currentTurnCount: turnCount, currentSeq: seq });
      earlyExit = true;
      break;

    } else if (TRIGGER_TOOLS.has(action)) {
      const triggerResult = await executeTriggerTool(action, params, callback, traceId, threadTs);
      const triggerEntry  = JSON.stringify({ tool: action, params, result: triggerResult });

      await insertRow('PGC_SessionEntry', {
        session_id:      session.id,
        sequence_number: seq,
        role:            'tool',
        content:         triggerEntry,
      });

      workingHistory.push({ role: 'tool', content: triggerEntry, sequence_number: seq });
      seq += 1;

      await notifyTurnProgress({ callback, traceId, turn: turnCount, action, reasoning, result: triggerResult });
      console.info('proc/minds-eye: trigger tool executed', { action, sessionId: session.id, traceId });

    } else {
      console.warn('proc/minds-eye: unknown action', { action, traceId });
      if (callback) {
        await enqueueCallback(callback, {
          type:    'HUMAN_NOTIFICATION',
          traceId,
          message: `Agent returned unknown action: ${action}. Reasoning: ${reasoning ?? '(none)'}`,
        });
      }
      earlyExit = true;
      break;
    }
  }

  if ((!responded && !earlyExit) || (responded && postContinueGateAfterRespond)) {
    // A round that ends WITHOUT responding never persisted its turns: minds_eye_turn_count
    // is written on respond and at the action gate, and neither happens here. So every
    // turn-limit and budget exit was invisible to max_lifetime_turns — a session could
    // burn turns the lifetime ceiling never counted, one continue at a time, which is the
    // exact leak that ceiling exists to stop. Safe to write: the in-loop ceiling check
    // breaks with earlyExit before turnCount could exceed the DB constraint.
    await updateRows('PGC_Session',
      [{ column: 'id', op: 'eq', value: session.id }],
      { minds_eye_turn_count: turnCount, slack_thread_ts: threadTs ?? session.slack_thread_ts }
    );

    if (turnCount >= prefs.max_lifetime_turns) {
      await notifyLifetimeCeiling(session, callback, traceId, turnCount);
    } else {
      await postTurnLimitGate(session.id, callback, traceId, false, budgetExhausted);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-turn progress line
//
// A build runs for many turns during which the only visible tool output is a
// gate or the final reply — from Slack it reads as silence. Every decision
// already carries `reasoning`, which until now went only to CloudWatch, so
// surfacing it costs no extra tokens: one notification per turn, no second
// model call.
//
// Only successful turns are reported. A tool call that came back with an error
// is an attempt the agent is about to correct, and narrating both the malformed
// request and the corrected one describes flailing rather than progress. The
// error still reaches the model through the tool result, which is what has to
// act on it.
//
// `respond` and gated writes post nothing here — each already produces the
// message the user is meant to read, and a progress line in front of it is noise.
// ---------------------------------------------------------------------------

export function turnSucceeded(result) {
  if (!result || typeof result !== 'object') return true;   // no result object = nothing failed
  if (result.error) return false;
  if (result.success === false) return false;
  return true;
}

async function notifyTurnProgress({ callback, traceId, turn, action, reasoning, result }) {
  if (!callback) return;
  if (!turnSucceeded(result)) {
    console.info('proc/minds-eye: turn not reported — tool returned an error', { action, turn, traceId });
    return;
  }

  const detail = String(reasoning ?? '').trim();
  const line   = detail
    ? `_Turn ${turn} · \`${action}\`_ — ${detail}`
    : `_Turn ${turn} · \`${action}\`_`;

  await enqueueCallback(callback, {
    type:    'HUMAN_NOTIFICATION',
    format:  'markdown',
    traceId,
    message: line,
  });
}

// ---------------------------------------------------------------------------
// Post an action gate — stores __pending__ entry, posts HUMAN_GATE
// ---------------------------------------------------------------------------

function gateButtonConfig(action, params = {}) {
  if (action === 'delete_data')          return { confirmLabel: 'Delete', confirmStyle: 'danger' };
  if (action === 'drop_table')           return { confirmLabel: 'Drop',   confirmStyle: 'danger' };
  if (action === 'drop_view')            return { confirmLabel: 'Drop',   confirmStyle: 'danger' };
  if (action === 'create_view')          return { confirmLabel: 'Create', confirmStyle: null };
  if (action === 'register_workflow')    return { confirmLabel: 'Register', confirmStyle: null };
  if (action === 'propose_workflow_fix') return { confirmLabel: 'Apply',  confirmStyle: null };
  if (action === 'propose_schema_fix') {
    const isDrop = params.operation === 'dropColumn';
    return { confirmLabel: isDrop ? 'Drop' : 'Apply', confirmStyle: isDrop ? 'danger' : null };
  }
  return                                        { confirmLabel: 'Approve', confirmStyle: null };
}

async function postActionGate({ session, action, params, callback, traceId, currentTurnCount, currentSeq }) {
  const gateText = await buildGateText(action, params, traceId);
  const { confirmLabel, confirmStyle } = gateButtonConfig(action, params);

  await insertRow('PGC_SessionEntry', {
    session_id:      session.id,
    sequence_number: currentSeq,
    role:            'tool',
    content:         JSON.stringify({ tool: '__pending__', action, params }),
  });

  await updateRows('PGC_Session',
    [{ column: 'id', op: 'eq', value: session.id }],
    { minds_eye_turn_count: currentTurnCount }
  );

  if (callback) {
    await enqueueCallback(callback, {
      type:         'HUMAN_GATE',
      gate_type:    'minds_eye_gate',
      sessionId:    session.id,
      dialog:       { fields: [{ type: 'typography', value: gateText }] },
      confirmLabel,
      confirmStyle,
      traceId,
    });
  }

  console.info('proc/minds-eye: gated action posted', { action, sessionId: session.id, traceId });
}

// ---------------------------------------------------------------------------
// PGC_IntentMap rows for a newly registered workflow — one row per phrase
// (the Sprint 7 shape), plus the workflow's own name, since the phrase a user is
// most likely to type is the thing the workflow is called. `source` records which
// of the two a row came from. Pure — exported for test.
// ---------------------------------------------------------------------------

export function buildIntentMapRows(name, intentPhrases = [], workflowId = null) {
  const seen    = new Set([name]);
  const phrases = [{ pattern: name, source: 'name' }];

  for (const raw of Array.isArray(intentPhrases) ? intentPhrases : []) {
    if (typeof raw !== 'string') continue;
    const pattern = raw.trim();
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    phrases.push({ pattern, source: 'auto' });
  }

  return phrases.map(({ pattern, source }) => ({
    pattern,
    intent_category: name,
    action_type:     'workflow',
    workflow_id:     workflowId,
    source,
  }));
}

// ---------------------------------------------------------------------------
// Validation shared by the register_workflow gate and its write
//
// The gate tells the user whether the array validates; the write refuses if it
// does not. Both need the same verdict, and deriving it twice is how a gate ends
// up promising something the write then declines to do.
// ---------------------------------------------------------------------------

async function simulateForRegistration(steps, traceId) {
  const result = runSimulation({
    steps,
    mockOutputs:       null,
    simulationPaths:   null,
    stepTypeContracts: await loadStepTypeContracts(traceId),
    traceId,
  });
  return {
    passed:        result.passed,
    error_summary: result.error_summary,
    // Every level that can fail the verdict contributes its issues. The smoke test was
    // missing, so a run whose ONLY failure was L2b reported `issues: []` — the narrative
    // in error_summary carried the defect while the structured field said there wasn't
    // one. Seen live: session 1121 at 10:12:13, routing matrix green, smoke test red,
    // issueCount 0.
    issues: [
      ...(result.shape_analysis?.issues  ?? []),
      ...(result.static_analysis?.issues ?? []),
      ...(result.routing_matrix?.issues  ?? []),
      ...(result.smoke_test?.issues      ?? []),
    ],
  };
}

/**
 * A refusal that is already decided does not need a human to confirm it.
 *
 * `register_workflow` re-runs the same simulation at execution and refuses anything that
 * fails, so a failing array can only ever produce one outcome. Posting the gate anyway
 * asked the user to approve something guaranteed to fail — and, because a gate ends the
 * round, it stopped Novia on a defect she could have corrected on the very next turn
 * (session 1121: 23 steps, every one missing its `step` key, sent for approval).
 *
 * Returning the issues as a tool result instead keeps the loop running and hands her the
 * same list the executor would have. The gate stays what it is for: deciding whether a
 * *valid* workflow should exist.
 *
 * Returns null when there is nothing decided yet — including for shape errors the executor
 * reports better than a simulation would, and for every other gated write, whose outcome
 * genuinely is the human's to determine.
 */
async function preGateRefusal(action, params, traceId) {
  if (action !== 'register_workflow') return null;
  const steps = params?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;

  const sim = await simulateForRegistration(steps, traceId);
  if (sim.passed) return null;

  return {
    error:      'Workflow failed validation — not registered, and not sent for approval. Correct the steps and simulate again.',
    validation: sim.error_summary,
    issues:     sim.issues,
  };
}

// ---------------------------------------------------------------------------
// Build human-readable gate text for gated write tools
// ---------------------------------------------------------------------------

async function buildGateText(action, params, traceId) {
  try {
    switch (action) {

      case 'register_workflow': {
        const { name, domain = null, description = '', steps = [], intentPhrases = [], intentKeywords = null } = params;

        // The gate is where a human decides whether this workflow should exist. What
        // makes that decision possible is not the step JSON — it is whether the array
        // validates and what the workflow will answer to. Both go in the message.
        const sim = await simulateForRegistration(steps, traceId);

        const lines = [
          `**Register workflow: \`${name}\`**`,
          domain ? `Domain: \`${domain}\`` : 'Domain: _(none — standalone workflow)_',
          `${steps.length} steps`,
          '',
          description ? `${description}\n` : '',
          sim.passed
            ? `Validation: **passed** (L0 shape, L1 static, L2 routing + data flow)`
            : `Validation: **FAILED** — registration will be refused:\n${sim.error_summary}`,
          '',
          intentPhrases.length
            ? `Invoked by: ${intentPhrases.map(p => `\`${p}\``).join(', ')}`
            : '_No invocation phrases supplied — the workflow will only be reachable by its exact name._',
          intentKeywords?.length
            ? `Routing keywords: ${intentKeywords.map(k => `\`${k}\``).join(', ')}`
            : '_No intent_keywords — Pass 2 keyword routing will not match this workflow._',
        ].filter(l => l !== '');

        return lines.join('\n');
      }

      case 'propose_workflow_fix': {
        const { workflowName, steps: proposedSteps = [] } = params;
        let currentSteps = [];
        try {
          const resp = await getRows('PGC_Workflow', [{ column: 'name', op: 'eq', value: workflowName }], { column: 'version', direction: 'desc' }, 1);
          currentSteps = resp.rows?.[0]?.steps ?? [];
        } catch { /* best-effort */ }

        const currentMap  = Object.fromEntries(currentSteps.map(s => [String(s.step), s]));
        const proposedMap = Object.fromEntries(proposedSteps.map(s => [String(s.step), s]));
        const allKeys     = [...new Set([...Object.keys(currentMap), ...Object.keys(proposedMap)])].sort();

        const added   = allKeys.filter(k => !currentMap[k]);
        const removed = allKeys.filter(k => !proposedMap[k]);
        const changed = allKeys.filter(k => currentMap[k] && proposedMap[k] && JSON.stringify(currentMap[k]) !== JSON.stringify(proposedMap[k]));

        const lines = [
          `**Proposed workflow fix: \`${workflowName}\`**`,
          `${currentSteps.length} steps → ${proposedSteps.length} steps\n`,
        ];
        if (added.length)   lines.push(`Added steps: ${added.join(', ')}`);
        if (removed.length) lines.push(`Removed steps: ${removed.join(', ')}`);

        const DIFF_FIELDS = ['type', 'expression', 'on_success', 'on_else', 'message', 'description'];
        for (const key of changed) {
          const cur  = currentMap[key];
          const prop = proposedMap[key];
          lines.push(`\n**Step ${key}** — ${cur.description ?? cur.type}:`);
          for (const field of DIFF_FIELDS) {
            if (JSON.stringify(cur[field]) !== JSON.stringify(prop[field])) {
              lines.push(`  \`${field}\`: \`${JSON.stringify(cur[field])}\` → \`${JSON.stringify(prop[field])}\``);
            }
          }
        }

        if (!added.length && !removed.length && !changed.length) {
          lines.push('_(No differences detected — proposed steps match current version.)_');
        }

        return lines.join('\n');
      }

      case 'propose_schema_fix': {
        const { operation, tableName } = params;
        if (!operation || !tableName) {
          return `**Proposed schema fix** — missing operation or tableName`;
        }
        const lines = [`**Proposed schema fix: \`${tableName}\`** — \`${operation}\``];
        switch (operation) {
          case 'addColumn': {
            const { column = {} } = params;
            lines.push(`Add column: \`${column.name}\` (${column.type}${column.nullable === false ? ', NOT NULL' : ''})`);
            break;
          }
          case 'modifyColumn': {
            const { columnName, newType, nullable, using: usingExpr } = params;
            if (newType)               lines.push(`Change \`${columnName}\` type → \`${newType}\`${usingExpr ? ` USING ${usingExpr}` : ''}`);
            if (nullable !== undefined) lines.push(`Set \`${columnName}\` nullable: ${nullable}`);
            break;
          }
          case 'dropColumn': {
            const { columnName } = params;
            lines.push(`Drop column \`${columnName}\` — irreversible, cascades to dependent constraints.`);
            break;
          }
          case 'modifyConstraint': {
            const { constraintName, expression } = params;
            lines.push(`Replace constraint \`${constraintName}\` with: \`CHECK (${expression})\``);
            break;
          }
          case 'dropConstraint': {
            const { constraintName } = params;
            lines.push(`Drop constraint \`${constraintName}\` — irreversible, removes from DB and PGC_Schema.`);
            break;
          }
          default:
            lines.push(`\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``);
        }
        return lines.join('\n');
      }

      case 'delete_data': {
        const { tableName, filters = [] } = params;
        let count = '?';
        try {
          const resp = await getRows(tableName, filters, null, 100);
          count = resp.count ?? resp.rows?.length ?? '?';
        } catch { /* best-effort */ }
        const filterDesc = filters.map(f => `${f.column} ${f.op} ${JSON.stringify(f.value)}`).join(' AND ');
        return `**Proposed deletion:** \`${tableName}\`\nFilter: \`${filterDesc || '(all rows)'}\`\n\nThis will permanently delete **${count}** row(s).`;
      }

      case 'drop_table': {
        const { tableName } = params;
        if (!tableName) return '**Drop table** — missing tableName';
        let registered = false;
        try {
          const { servPost } = await import('../shared/serv-client.mjs');
          const resp = await servPost('/api/v1/serv/schema/listPhysicalTables', { prefix: tableName });
          const match = (resp.tables ?? []).find(t => t.table_name === tableName);
          registered = match?.registered ?? false;
        } catch { /* best-effort */ }
        const regNote = registered
          ? 'This table is registered in PGC_Schema — the registration row will also be removed.'
          : 'This table is **not registered** in PGC_Schema (orphaned) — physical table only will be dropped.';
        return `**Drop table: \`${tableName}\`** (force=true, CASCADE)\n\n${regNote}\n\nThis is irreversible.`;
      }

      case 'create_view': {
        const { tableName, selectSql } = params;
        if (!tableName || !selectSql) return '**Create view** — missing tableName or selectSql';
        return `**Create view: \`${tableName}\`**\n\n\`\`\`sql\n${selectSql}\n\`\`\``;
      }

      case 'drop_view': {
        const { tableName } = params;
        if (!tableName) return '**Drop view** — missing tableName';
        return `**Drop view: \`${tableName}\`**\n\nThis is irreversible.`;
      }

      default:
        return `**Proposed action:** \`${action}\`\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``;
    }
  } catch (error) {
    console.warn('proc/minds-eye: buildGateText error', { action, traceId, error: error.message });
    return `**Proposed action:** \`${action}\``;
  }
}

// ---------------------------------------------------------------------------
// Execute a write tool (inline or gated)
// ---------------------------------------------------------------------------

async function executeWriteTool(action, params, traceId) {
  try {
    switch (action) {

      case 'update_data': {
        const { tableName, filters = [], updates = {} } = params;
        if (!tableName) return { error: 'tableName is required' };
        return await updateRows(tableName, filters, updates);
      }

      case 'insert_data': {
        const { tableName, row, rows } = params;
        if (!tableName) return { error: 'tableName is required' };
        if (Array.isArray(rows) && rows.length > 0) {
          const CHUNK = 100;
          let inserted = 0;
          for (let i = 0; i < rows.length; i += CHUNK) {
            const resp = await insertRows(tableName, rows.slice(i, i + CHUNK));
            inserted += resp.rows?.length ?? 0;
          }
          return { success: true, count: inserted };
        }
        const resp = await insertRow(tableName, row ?? {});
        return { success: resp.success, row: resp.row };
      }

      case 'upsert_data': {
        const { tableName, matchColumns, rows } = params;
        if (!tableName)                                    return { error: 'tableName is required' };
        if (!Array.isArray(matchColumns) || !matchColumns.length) return { error: 'matchColumns must be a non-empty array' };
        if (!Array.isArray(rows) || !rows.length)           return { error: 'rows must be a non-empty array' };
        const resp = await upsertRows(tableName, matchColumns, rows);
        return {
          success:  resp.success,
          inserted: resp.inserted?.length ?? 0,
          updated:  resp.updated?.length ?? 0,
        };
      }

      case 'delete_data': {
        const { tableName, filters = [] } = params;
        if (!tableName) return { error: 'tableName is required' };
        return await deleteRows(tableName, filters);
      }

      case 'write_memory': {
        const { content, memory_type = 'episodic', scope = {}, tags = [], priority = 5 } = params;
        if (!content) return { error: 'content is required' };
        const resp = await insertRow('PGC_Memory', {
          memory_type,
          scope,
          content,
          tags,
          priority,
          token_estimate: Math.ceil(content.length / 4),
        });
        return { success: resp.success, scope };
      }

      case 'register_workflow': {
        const { name, domain = null, description = '', steps, intentPhrases = [], intentKeywords = null } = params;
        if (!name || !Array.isArray(steps) || steps.length === 0) {
          return { error: 'name and a non-empty steps array are required' };
        }

        // Registration creates a workflow; changing one is propose_workflow_fix. Keeping
        // them separate means neither tool can silently do the other's job — a name
        // collision here is a mistake to report, not an update to perform.
        const existing = await getRows('PGC_Workflow', [{ column: 'name', op: 'eq', value: name }], null, 1);
        if (existing.rows?.length > 0) {
          return {
            error: `A workflow named "${name}" already exists (id ${existing.rows[0].id}, v${existing.rows[0].version}). ` +
                   'Use propose_workflow_fix to change it, or register under a different name.',
          };
        }

        // The pre-write guard. dev_scripts/upsert-workflow.mjs refuses to ship a seed
        // that fails validation; a workflow arriving from a conversation gets the same
        // gate. An approved-but-broken registration is worse than a refused one: it is
        // discovered by a user running it.
        const sim = await simulateForRegistration(steps, traceId);
        if (!sim.passed) {
          return {
            error: 'Workflow failed validation — not registered.',
            validation: sim.error_summary,
            issues: sim.issues,
          };
        }

        const wfResp = await insertRow('PGC_Workflow', {
          name,
          domain,
          description,
          steps,
          version: 1,
          state_strategy: 'sequential_with_confirmation',
          intent_keywords: intentKeywords,
        });
        if (!wfResp.success) return { error: `PGC_Workflow insert failed: ${wfResp.error}` };

        const workflowId = wfResp.row?.id ?? wfResp.rows?.[0]?.id ?? null;

        const intentRows = buildIntentMapRows(name, intentPhrases, workflowId);
        const imResp     = await insertRows('PGC_IntentMap', intentRows);

        return {
          success:            wfResp.success,
          workflow_id:        workflowId,
          name,
          domain,
          version:            1,
          step_count:         steps.length,
          intent_rows_written: imResp.success ? intentRows.length : 0,
          // A failed intent map write leaves a registered workflow that routing cannot
          // reach by phrase. Reported rather than swallowed, so the next turn can fix it.
          intent_map_error:   imResp.success ? null : imResp.error,
          validation:         'passed',
        };
      }

      case 'propose_workflow_fix': {
        const { workflowName, steps } = params;
        if (!workflowName || !steps) return { error: 'workflowName and steps are required' };
        const wfResp = await getRows('PGC_Workflow', [{ column: 'name', op: 'eq', value: workflowName }], { column: 'version', direction: 'desc' }, 1);
        const wf = wfResp.rows?.[0];
        if (!wf) return { error: `Workflow "${workflowName}" not found` };

        const currentSteps = wf.steps ?? [];
        const currentMap   = Object.fromEntries(currentSteps.map(s => [String(s.step), s]));
        const proposedMap  = Object.fromEntries(steps.map(s => [String(s.step), s]));
        const allKeys      = [...new Set([...Object.keys(currentMap), ...Object.keys(proposedMap)])].sort();
        const DIFF_FIELDS  = ['type', 'expression', 'on_success', 'on_else', 'message', 'description'];

        const diff = {};
        for (const key of allKeys) {
          if (!currentMap[key]) {
            diff[key] = { change: 'added' };
          } else if (!proposedMap[key]) {
            diff[key] = { change: 'removed' };
          } else {
            const fieldChanges = {};
            for (const field of DIFF_FIELDS) {
              if (JSON.stringify(currentMap[key][field]) !== JSON.stringify(proposedMap[key][field])) {
                fieldChanges[field] = { from: currentMap[key][field], to: proposedMap[key][field] };
              }
            }
            if (Object.keys(fieldChanges).length > 0) diff[key] = fieldChanges;
          }
        }

        const resp = await updateRows('PGC_Workflow', [{ column: 'id', op: 'eq', value: wf.id }], { steps, version: wf.version + 1 });
        return {
          success:          resp.success,
          newVersion:       wf.version + 1,
          stepCountBefore:  currentSteps.length,
          stepCountAfter:   steps.length,
          stepCountMismatch: currentSteps.length !== steps.length,
          diff,
          steps_written:    steps,
        };
      }

      case 'propose_schema_fix': {
        const { operation, tableName, ...rest } = params;
        if (!operation || !tableName) return { error: 'operation and tableName are required' };
        const allowed = new Set(['addColumn', 'modifyColumn', 'dropColumn', 'modifyConstraint', 'dropConstraint']);
        if (!allowed.has(operation)) return { error: `Unknown schema operation: ${operation}` };
        const { servPost } = await import('../shared/serv-client.mjs');
        return await servPost(`/api/v1/serv/schema/${operation}`, { tableName, ...rest });
      }

      case 'drop_table': {
        const { tableName } = params;
        if (!tableName) return { error: 'tableName is required' };
        const { servPost } = await import('../shared/serv-client.mjs');
        return await servPost('/api/v1/serv/schema/deleteTable', { tableName, force: true });
      }

      case 'create_view': {
        const { tableName, selectSql, target = 'pgd', domain = null, description = '' } = params;
        if (!tableName || !selectSql) return { error: 'tableName and selectSql are required' };
        const { servPost } = await import('../shared/serv-client.mjs');
        return await servPost('/api/v1/serv/schema/createView', { tableName, selectSql, target, domain, description });
      }

      case 'drop_view': {
        const { tableName } = params;
        if (!tableName) return { error: 'tableName is required' };
        const { servPost } = await import('../shared/serv-client.mjs');
        return await servPost('/api/v1/serv/schema/deleteTable', { tableName });
      }

      default:
        return { error: `Unknown write tool: ${action}` };
    }
  } catch (error) {
    console.error('proc/minds-eye: executeWriteTool error', { action, traceId, error: error.message });
    return { error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Execute a trigger tool — dispatches a registered workflow to the step executor
// ---------------------------------------------------------------------------

async function executeTriggerTool(action, params, callback, traceId, threadTs) {
  try {
    switch (action) {

      case 'run_workflow': {
        const { workflowName, input = {} } = params;
        if (!workflowName) return { error: 'workflowName is required' };

        const wfResp = await getRows('PGC_Workflow', [{ column: 'name', op: 'eq', value: workflowName }], { column: 'version', direction: 'desc' }, 1);
        const wf = wfResp.rows?.[0];
        if (!wf) return { error: `Workflow "${workflowName}" not found` };

        // Ensure the workflow runs in the Novia session thread. The raw SQS
        // callback may have threadId null (e.g. first-message invocation), but
        // threadTs is resolved from session.slack_thread_ts by the caller.
        const workflowCallback = (callback && threadTs)
          ? { ...callback, threadId: threadTs }
          : callback;

        const runResp = await insertRow('PGC_WorkflowRun', {
          workflow_id:  wf.id,
          trace_id:     traceId,
          triggered_by: 'minds_eye',
          status:       'pending',
          input:        input,
          stack:        [],
          state:        {},
          callback:     workflowCallback,
        });
        if (!runResp.success) return { error: `Failed to create workflow run: ${runResp.error}` };

        await enqueueWorkflow({
          type:          'WORKFLOW_STEP',
          action:        'execute_top',
          workflowRunId: runResp.row.id,
          traceId,
        });

        return { triggered: true, workflowName, workflowRunId: runResp.row.id };
      }

      default:
        return { error: `Unknown trigger tool: ${action}` };
    }
  } catch (error) {
    console.error('proc/minds-eye: executeTriggerTool error', { action, traceId, error: error.message });
    return { error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Derive memory scope from session tool call history (pure — no I/O)
// ---------------------------------------------------------------------------

export function deriveScope(workingHistory) {
  const scope = {};
  for (const entry of workingHistory) {
    if (entry.role !== 'tool') continue;
    let parsed;
    try { parsed = JSON.parse(entry.content); } catch { continue; }
    const { tool, params = {}, result = {} } = parsed;
    if (tool === 'register_workflow'    && params.name)                   scope.workflow = params.name;
    if (tool === 'register_workflow'    && params.domain)                 scope.domain   = params.domain;
    if (tool === 'propose_workflow_fix' && params.workflowName)           scope.workflow = params.workflowName;
    if (tool === 'read_workflow'         && params.workflowName && !scope.workflow) scope.workflow = params.workflowName;
    if (tool === 'search_domain_help'   && result.results?.[0]?.domain)  scope.domain   = result.results[0].domain;
    if (tool === 'list_tables'          && params.domain && !scope.domain) scope.domain  = params.domain;
    if (tool === 'propose_schema_fix'   && params.tableName)              scope.table    = params.tableName;
    if (tool === 'drop_table'           && params.tableName)              scope.table    = params.tableName;
    if (tool === 'create_view'          && params.tableName)              scope.table    = params.tableName;
    if (tool === 'drop_view'            && params.tableName)              scope.table    = params.tableName;
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Write a harness-authored factual memory row after a successful gated write
// ---------------------------------------------------------------------------

async function writeFactualMemory(action, params, result, sessionId, traceId) {
  try {
    let scope   = {};
    let content = '';

    if (action === 'propose_workflow_fix') {
      const { workflowName } = params;
      scope = { workflow: workflowName };
      const diffSummary = result.diff
        ? Object.entries(result.diff).map(([step, changes]) => {
            if (changes.change === 'added')   return `step ${step}: added`;
            if (changes.change === 'removed') return `step ${step}: removed`;
            return Object.entries(changes)
              .map(([field, { from, to }]) => `step ${step} ${field}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`)
              .join('; ');
          }).join('. ')
        : 'diff unavailable';
      const countNote = result.stepCountMismatch
        ? ` (step count changed: ${result.stepCountBefore} → ${result.stepCountAfter})`
        : '';
      content = `Session ${sessionId}: fixed ${workflowName} v${(result.newVersion ?? 1) - 1}→v${result.newVersion ?? '?'}. ${diffSummary}${countNote}. Outcome: ${result.success ? 'success' : 'failed'}.`;

    } else if (action === 'register_workflow') {
      const { name, domain = null } = params;
      scope   = domain ? { workflow: name, domain } : { workflow: name };
      content = `Session ${sessionId}: registered workflow ${name}` +
                `${domain ? ` in domain ${domain}` : ' (standalone)'} — ` +
                `${result.step_count ?? '?'} steps, ${result.intent_rows_written ?? 0} intent phrase(s). ` +
                `Outcome: ${result.success ? 'success' : 'failed'}` +
                `${result.intent_map_error ? `; intent map write failed: ${result.intent_map_error}` : ''}.`;

    } else if (action === 'propose_schema_fix') {
      const { operation, tableName } = params;
      let domain = null;
      try {
        const schemaResp = await getRows('PGC_Schema', [{ column: 'table_name', op: 'eq', value: tableName }], null, 1);
        domain = schemaResp.rows?.[0]?.domain ?? null;
      } catch { /* best-effort */ }
      scope   = domain ? { domain, table: tableName } : { table: tableName };
      content = `Session ${sessionId}: schema fix on ${tableName} — ${operation}. Outcome: ${result.success ? 'success' : 'failed'}.`;
    }

    if (!content) return;

    await insertRow('PGC_Memory', {
      memory_type:    'episodic',
      scope,
      content,
      tags:           ['novia_fix'],
      priority:       5,
      token_estimate: Math.ceil(content.length / 4),
    });
    console.info('proc/minds-eye: factual memory written', { action, scope, traceId });
  } catch (error) {
    console.warn('proc/minds-eye: writeFactualMemory failed (non-fatal)', { traceId, error: error.message });
  }
}

// ---------------------------------------------------------------------------
// Load preferences and system prompt from PGC_SystemContext
// ---------------------------------------------------------------------------

async function loadPrefsAndPrompt() {
  const [prefResp, sysCtxResp, formattingResp] = await Promise.all([
    getRows('PGC_SystemContext', [{ column: 'key', op: 'eq', value: 'minds_eye_preferences' }]),
    getRows('PGC_SystemContext', [{ column: 'key', op: 'eq', value: 'minds_eye_system_prompt' }]),
    getRows('PGC_SystemContext', [{ column: 'key', op: 'eq', value: 'markdown_formatting_syntax' }]),
  ]);

  const prefContent = prefResp.rows?.[0]?.content ?? {};
  const prefs       = { ...DEFAULT_PREFERENCES, ...prefContent };

  const rawSysPrompt     = sysCtxResp.rows?.[0]?.content;
  const baseSystemPrompt = (typeof rawSysPrompt === 'object' ? rawSysPrompt?.text : rawSysPrompt)
    ?? 'You are a helpful AI assistant for evolving-mind-ai. Respond in JSON: { action, params, reasoning } or { action: "respond", message, reasoning }.';

  // Shared with generate_workflow_steps/design_workflow_prompts/design_workflow_dialogs
  // (PGC_SystemContext.markdown_formatting_syntax, injected there via inject_for) so
  // formatting guidance has one source of truth instead of drifting copies.
  const formattingGuidance = formattingResp.rows?.[0]?.content ?? '';

  const systemPrompt = `${baseSystemPrompt}\n\n${formattingGuidance}\n\nYour name is ${prefs.name}. Style guide — tone: ${prefs.tone} | format: ${prefs.response_format} | technical level: ${prefs.technical_level}.`;

  return { prefs, systemPrompt };
}

// ---------------------------------------------------------------------------
// Assemble Layer 1 (workflows) and Layer 2 (memory) context
// ---------------------------------------------------------------------------

async function assembleContext() {
  const [workflowsResp, memResp] = await Promise.all([
    getRows('PGC_Workflow', [], { column: 'name', direction: 'asc' }, 50),
    getRows('PGC_Memory',   [], { column: 'priority', direction: 'desc' }, 5),
  ]);

  const workflowSummary = (workflowsResp.rows ?? [])
    .map(w => `- ${w.name}${w.domain ? ` (domain: ${w.domain})` : ''} v${w.version}`)
    .join('\n');
  const layer1Context = `REGISTERED WORKFLOWS:\n${workflowSummary || '(none)'}`;

  const memSummary = (memResp.rows ?? [])
    .map(m => `[${m.memory_type}] ${m.content}`)
    .join('\n');
  const layer2Context = memSummary ? `RECENT MEMORIES:\n${memSummary}` : '';

  return { layer1Context, layer2Context };
}

// ---------------------------------------------------------------------------
// Build the user-facing LLM input: context blocks + conversation transcript
// ---------------------------------------------------------------------------

/**
 * Which history entry holds the step array currently being worked on.
 *
 * Tool entries are recorded with their `params`, so every array Novia has submitted is
 * already persisted — but the transcript renders only `result`, so she has been reading
 * verdicts about arrays she cannot see, naming step keys absent from her context. With no
 * copy of her own work in front of her she rebuilds all of it from reasoning each turn,
 * which is why session 1121 drifted 19 → 21 → 23 steps and why `step_label` returned two
 * turns after she had corrected it.
 *
 * One array is rendered, never all of them: the latest is the draft, and the earlier ones
 * are the same workflow in a worse state. `sequence_number` already orders them, so the
 * newest submission IS the current version — no version column, no separate draft store.
 *
 * `__pending__` and `__cancelled__` are skipped. A pending entry carries a copy of the
 * array too, but it is awaiting a human decision rather than a correction, and treating it
 * as the draft would mark the last correctable array superseded.
 */
export function latestDraftIndex(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role !== 'tool') continue;
    try {
      const parsed = JSON.parse(entry.content);
      if (parsed?.tool === '__pending__' || parsed?.tool === '__cancelled__') continue;
      if (Array.isArray(parsed?.params?.steps) && parsed.params.steps.length > 0) return i;
    } catch { /* not a readable tool entry */ }
  }
  return -1;
}

export function buildUserMessage(layer1Context, layer2Context, history, prefs, notice) {
  const parts = [];

  parts.push(layer1Context);
  if (layer2Context) parts.push(layer2Context);

  if (history.length > 0) {
    const draftIndex = latestDraftIndex(history);

    const transcript = history.map((e, i) => {
      if (e.role === 'user')      return `User: ${e.content}`;
      if (e.role === 'assistant') {
        try {
          const parsed = JSON.parse(e.content);
          return parsed.message ? `Assistant: ${parsed.message}` : `Assistant: ${e.content}`;
        } catch { return `Assistant: ${e.content}`; }
      }
      if (e.role === 'tool') {
        try {
          const parsed = JSON.parse(e.content);
          if (parsed.tool === '__pending__')   return `[Awaiting approval for: ${parsed.action}]`;
          if (parsed.tool === '__cancelled__') return `[Action cancelled: ${parsed.action}]`;

          const result = JSON.stringify(parsed.result).slice(0, 15000);

          // A submitted step array is shown once, on the newest submission, because that
          // is the draft; the same array in an older state is not worth its tokens and is
          // reduced to the verdict it earned. Not truncated when it is shown — half a step
          // array is not a thing anyone can correct.
          if (Array.isArray(parsed?.params?.steps) && parsed.params.steps.length > 0) {
            return i === draftIndex
              ? `Tool (${parsed.tool}) — CURRENT DRAFT, ${parsed.params.steps.length} steps. This is the array you last submitted; correct THIS array rather than composing a new one from scratch.\nSubmitted steps: ${JSON.stringify(parsed.params.steps)}\nResult: ${result}`
              : `Tool (${parsed.tool}): submitted ${parsed.params.steps.length} steps, since superseded. Result: ${result}`;
          }

          return `Tool (${parsed.tool}): ${result}`;
        } catch { return `Tool: ${e.content.slice(0, 15000)}`; }
      }
      return '';
    }).filter(Boolean).join('\n\n');

    parts.push(`CONVERSATION:\n${transcript}`);
  }

  // Tool names, params, and gating are documented once in minds_eye_system_prompt
  // (the instructions/system message) — not re-enumerated here. A second,
  // hand-maintained copy in this per-turn message previously drifted stale
  // (missing run_sql, upsert_data, create_view, drop_view) while still telling
  // the model to use ONLY the tools listed here; removed rather than patched,
  // since two copies of the same catalog will drift again.
  parts.push(
    'Based on the context and conversation above, decide your next action. ' +
    'Respond with exactly one JSON object per the tool catalog and output format in your instructions.'
  );

  // Last, so it is the nearest instruction to the response it constrains.
  if (notice) parts.push(notice);

  return parts.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Execute a read tool and return the result object
// ---------------------------------------------------------------------------

async function executeReadTool(action, params, traceId) {
  try {
    switch (action) {

      case 'query_table': {
        const { tableName, filters = [], orderBy, limit } = params;
        if (!tableName) return { error: 'tableName is required' };
        const resp = await getRows(tableName, filters, orderBy, limit ?? 20);
        return { count: resp.count, rows: resp.rows ?? [] };
      }

      case 'run_sql': {
        const { selectSql, target } = params;
        if (!selectSql) return { error: 'selectSql is required' };
        const { servPost } = await import('../shared/serv-client.mjs');
        const resp = await servPost('/api/v1/serv/table/runSql', { selectSql, target });
        return { count: resp.count, rows: resp.rows ?? [] };
      }

      case 'query_entity': {
        const { entityName, filters = [], limit } = params;
        if (!entityName) return { error: 'entityName is required' };
        const { servPost } = await import('../shared/serv-client.mjs');
        const resp = await servPost('/api/v1/serv/entity/listEntities', {
          entityName,
          ...(filters.length && { filters }),
          ...(limit          && { limit }),
        });
        return { count: resp.count, entities: resp.entities ?? [] };
      }

      case 'read_memory': {
        const { filters = [], limit } = params;
        const resp = await getRows('PGC_Memory', filters, { column: 'priority', direction: 'desc' }, limit ?? 10);
        return { count: resp.count, rows: resp.rows ?? [] };
      }

      case 'read_workflow': {
        const { workflowName } = params;
        if (!workflowName) return { error: 'workflowName is required' };
        const resp = await getRows(
          'PGC_Workflow',
          [{ column: 'name', op: 'eq', value: workflowName }],
          { column: 'version', direction: 'desc' },
          1
        );
        const wf = resp.rows?.[0];
        if (!wf) return { error: `Workflow "${workflowName}" not found` };
        return { name: wf.name, version: wf.version, domain: wf.domain, description: wf.description ?? null, steps: wf.steps };
      }

      case 'read_prompt': {
        const { intentCategory } = params;
        if (!intentCategory) return { error: 'intentCategory is required' };
        const resp = await getRows(
          'PGC_Prompt',
          [{ column: 'intent_category', op: 'eq', value: intentCategory }],
          { column: 'version', direction: 'desc' },
          1
        );
        const p = resp.rows?.[0];
        if (!p) return { error: `Prompt "${intentCategory}" not found` };
        return { id: p.id, intent_category: p.intent_category, version: p.version, domain: p.domain, prompt_text: p.prompt_text, output_schema: p.output_schema, max_output_tokens: p.max_output_tokens ?? null, error_log: p.error_log ?? null };
      }

      case 'simulate_workflow': {
        const { steps, level } = params;
        if (!steps) return { error: 'steps is required' };
        const { servPost } = await import('../shared/serv-client.mjs');
        const resp = await servPost('/api/v1/proc/simulate-workflow', { steps, ...(level !== undefined ? { level } : {}) });
        return resp;
      }

      case 'search_domain_help': {
        const { query } = params;
        if (!query) return { error: 'query is required' };
        const resp = await getRows(
          'PGC_DomainHelp',
          [],
          null,
          5,
          { column: 'embedding', queryText: query, threshold: 0.4 }
        );
        return {
          count: resp.count,
          results: (resp.rows ?? []).map(r => ({
            domain:      r.domain,
            description: r.description,
            aliases:     r.aliases,
            commands:    r.commands,
            similarity:  r.similarity,
          })),
        };
      }

      case 'list_tables': {
        const { domain, prefix } = params;
        const filters = [];
        if (domain) filters.push({ column: 'domain',     op: 'eq',   value: domain });
        if (prefix) filters.push({ column: 'table_name', op: 'like', value: `${prefix}%` });
        const resp = await getRows('PGC_Schema', filters, { column: 'table_name', direction: 'asc' }, 100);
        return {
          tables: (resp.rows ?? []).map(r => ({
            name:    r.table_name,
            domain:  r.domain,
            columns: (r.columns ?? []).map(c => c.name),
          })),
        };
      }

      case 'list_physical_tables': {
        const { prefix = 'PGD_' } = params;
        const { servPost } = await import('../shared/serv-client.mjs');
        const resp = await servPost('/api/v1/serv/schema/listPhysicalTables', { prefix });
        return { count: resp.count, tables: resp.tables ?? [] };
      }

      default:
        return { error: `Unknown tool: ${action}` };
    }
  } catch (error) {
    console.error('proc/minds-eye: tool error', { action, traceId, error: error.message });
    return { error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Post a turn-limit notification
// ---------------------------------------------------------------------------

async function postTurnLimitGate(sessionId, callback, traceId, resetActionCount = false, budgetExhausted = false) {
  if (!callback) return;
  await enqueueCallback(callback, {
    type:             'HUMAN_GATE',
    gate_type:        'minds_eye_continue_gate',
    sessionId,
    traceId,
    resetActionCount,
    // Which limit was hit. The gate is identical either way — only what the user is told
    // differs, and a round that stopped on time reads very differently from one that ran
    // out of turns: it means nothing is wrong and continuing costs nothing but a click.
    budgetExhausted,
  });
}
