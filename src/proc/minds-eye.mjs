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
import { getRows, insertRow, insertRows, updateRows, deleteRows } from '../shared/serv-client.mjs';
import { callLlm }                                         from '../shared/llm-client.mjs';
import { enqueueCallback, enqueueWorkflow }                from '../shared/sqs-callback.mjs';

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
  turn_limit:             8,
  max_actions_per_session:5,
  tone:                   'concise but friendly',
  advisory_level:         'proactive',
  response_format:        'structured',
  technical_level:        'high',
};

const READ_TOOLS = new Set([
  'query_table', 'query_entity', 'read_memory',
  'read_workflow', 'read_prompt', 'simulate_workflow',
  'search_domain_help', 'list_tables',
]);

// Inline write tools — execute immediately, no confirmation gate required.
const INLINE_WRITE_TOOLS = new Set([
  'update_data', 'insert_data',
]);

// Gated write tools — post a HUMAN_GATE before executing.
const GATED_WRITE_TOOLS = new Set([
  'propose_workflow_fix', 'propose_schema_fix', 'delete_data',
]);

// Trigger tools — dispatch a registered workflow to the step-executor engine.
const TRIGGER_TOOLS = new Set([
  'run_workflow',
]);

// Housekeeping tools — execute immediately, no gate, do not count against action limit.
const HOUSEKEEPING_TOOLS = new Set([
  'write_memory',
]);

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

  // Follow-up question — add user message, reset turns, run loop, re-post continue gate after response.
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
    await updateRows('PGC_Session', [{ column: 'id', op: 'eq', value: session.id }], {
      minds_eye_turn_count: 0,
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
      currentTurnCount:             0,
      currentActionCount:           session.minds_eye_action_count ?? 0,
      currentSeq:                   newSeq + 1,
      threadTs:                     callback?.threadId ?? session.slack_thread_ts,
      postContinueGateAfterRespond: true,
    });
    if (req?.source === 'http') return ok({ success: true, sessionId: session.id }, req.correlationId);
    return;
  }

  // Turn-limit or action-limit continue — reset counts and re-enter the reasoning loop.
  if (resumeType === 'continue') {
    if (!approved) {
      console.info('proc/minds-eye: continue gate cancelled', { sessionId, traceId });
      return;
    }
    const resetFields = { minds_eye_turn_count: 0 };
    if (body.resetActionCount) resetFields.minds_eye_action_count = 0;
    await updateRows('PGC_Session', [{ column: 'id', op: 'eq', value: session.id }], resetFields);
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
      currentTurnCount:   0,
      currentActionCount: session.minds_eye_action_count ?? 0,
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

  const newActionCount = (session.minds_eye_action_count ?? 0) + 1;
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

async function runReasoningLoop({ session, prefs, systemPrompt, layer1Context, layer2Context, workingHistory, callback, traceId, currentTurnCount, currentActionCount, currentSeq, threadTs, postContinueGateAfterRespond = false }) {
  let turnCount   = currentTurnCount;
  let actionCount = currentActionCount;
  let seq         = currentSeq;
  let responded   = false;
  let earlyExit   = false;
  let turnCost    = 0;

  while (turnCost < prefs.turn_limit) {
    const userMessage = buildUserMessage(layer1Context, layer2Context, workingHistory, prefs);

    let decision;
    try {
      decision = await callLlm(prefs.model, systemPrompt, userMessage, ACTION_SCHEMA, traceId);
    } catch (llmError) {
      if (llmError.isParseError && llmError.rawOutput && !llmError.isTruncated) {
        // Generation fault: LLM produced valid content but invalid JSON escaping.
        // One correction turn (0.5 cost) — send raw output back and ask for reformat.
        try {
          const correctionMsg = `Your previous response was not valid JSON. Here is what you returned:\n\n${llmError.rawOutput}\n\nReturn the same content as a valid JSON object. Escape all special characters in string values: \\n for newlines, \\" for double quotes, \\\\ for backslashes. Return the JSON only — no prose, no fences.`;
          decision = await callLlm(prefs.model, systemPrompt, correctionMsg, ACTION_SCHEMA, traceId);
          turnCost += 0.5;
          console.info('proc/minds-eye: JSON parse corrected', { traceId });
        } catch (corrErr) {
          console.error('proc/minds-eye: JSON correction failed', { traceId, error: corrErr.message });
          if (callback) await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: `Agent reasoning failed: ${llmError.message}` });
          earlyExit = true;
          break;
        }
      } else {
        console.error('proc/minds-eye: LLM call failed', { traceId, error: llmError.message });
        if (callback) {
          await enqueueCallback(callback, {
            type:    'HUMAN_NOTIFICATION',
            traceId,
            message: `Agent reasoning failed: ${llmError.message}`,
          });
        }
        earlyExit = true;
        break;
      }
    }

    turnCount += 1;

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

      turnCost += toolResult.error ? 0.5 : 1.0;
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

      turnCost += hkResult.error ? 0.5 : 1.0;
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

      turnCost += writeResult.error ? 0.5 : 1.0;
      console.info('proc/minds-eye: write tool executed', { action, sessionId: session.id, traceId });

    } else if (GATED_WRITE_TOOLS.has(action)) {
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

      turnCost += triggerResult.error ? 0.5 : 1.0;
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
    await postTurnLimitGate(session.id, callback, traceId);
  }
}

// ---------------------------------------------------------------------------
// Post an action gate — stores __pending__ entry, posts HUMAN_GATE
// ---------------------------------------------------------------------------

function gateButtonConfig(action, params = {}) {
  if (action === 'delete_data')          return { confirmLabel: 'Delete', confirmStyle: 'danger' };
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
// Build human-readable gate text for gated write tools
// ---------------------------------------------------------------------------

async function buildGateText(action, params, traceId) {
  try {
    switch (action) {

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
            inserted += resp.count ?? 0;
          }
          return { success: true, count: inserted };
        }
        const resp = await insertRow(tableName, row ?? {});
        return { success: resp.success, row: resp.row };
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
        const allowed = new Set(['addColumn', 'modifyColumn', 'dropColumn', 'modifyConstraint']);
        if (!allowed.has(operation)) return { error: `Unknown schema operation: ${operation}` };
        const { servPost } = await import('../shared/serv-client.mjs');
        return await servPost(`/api/v1/serv/schema/${operation}`, { tableName, ...rest });
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

function deriveScope(workingHistory) {
  const scope = {};
  for (const entry of workingHistory) {
    if (entry.role !== 'tool') continue;
    let parsed;
    try { parsed = JSON.parse(entry.content); } catch { continue; }
    const { tool, params = {}, result = {} } = parsed;
    if (tool === 'propose_workflow_fix' && params.workflowName)           scope.workflow = params.workflowName;
    if (tool === 'read_workflow'         && params.workflowName && !scope.workflow) scope.workflow = params.workflowName;
    if (tool === 'search_domain_help'   && result.results?.[0]?.domain)  scope.domain   = result.results[0].domain;
    if (tool === 'list_tables'          && params.domain && !scope.domain) scope.domain  = params.domain;
    if (tool === 'propose_schema_fix'   && params.tableName)              scope.table    = params.tableName;
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
  const [prefResp, sysCtxResp] = await Promise.all([
    getRows('PGC_SystemContext', [{ column: 'key', op: 'eq', value: 'minds_eye_preferences' }]),
    getRows('PGC_SystemContext', [{ column: 'key', op: 'eq', value: 'minds_eye_system_prompt' }]),
  ]);

  const prefContent = prefResp.rows?.[0]?.content ?? {};
  const prefs       = { ...DEFAULT_PREFERENCES, ...prefContent };

  const rawSysPrompt     = sysCtxResp.rows?.[0]?.content;
  const baseSystemPrompt = (typeof rawSysPrompt === 'object' ? rawSysPrompt?.text : rawSysPrompt)
    ?? 'You are a helpful AI assistant for evolving-mind-ai. Respond in JSON: { action, params, reasoning } or { action: "respond", message, reasoning }.';

  const systemPrompt = `${baseSystemPrompt}\n\nYour name is ${prefs.name}. Style guide — tone: ${prefs.tone} | format: ${prefs.response_format} | technical level: ${prefs.technical_level}.`;

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

function buildUserMessage(layer1Context, layer2Context, history, prefs) {
  const parts = [];

  parts.push(layer1Context);
  if (layer2Context) parts.push(layer2Context);

  if (history.length > 0) {
    const transcript = history.map(e => {
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
          return `Tool (${parsed.tool}): ${JSON.stringify(parsed.result).slice(0, 15000)}`;
        } catch { return `Tool: ${e.content.slice(0, 15000)}`; }
      }
      return '';
    }).filter(Boolean).join('\n\n');

    parts.push(`CONVERSATION:\n${transcript}`);
  }

  parts.push(
    'Based on the context and conversation above, decide your next action.\n' +
    'Respond with exactly one JSON object. Use ONLY these action values:\n' +
    '- Read (no gate): search_domain_help, list_tables, query_table, query_entity, read_memory, read_workflow, read_prompt, simulate_workflow\n' +
    '- Write without gate (executes immediately): update_data, insert_data\n' +
    '- Write with gate (requires approval): propose_workflow_fix, propose_schema_fix, delete_data\n' +
    '- Memory (no gate, no action limit): write_memory\n' +
    '- Trigger (dispatches to step-executor engine): run_workflow\n' +
    '- respond (final answer to user)\n' +
    'Params for write tools:\n' +
    '  update_data: { tableName, filters: [{column, op, value}], updates: {field: newValue} }\n' +
    '  insert_data: { tableName, row: {field: value} }                          -- single row\n' +
    '  insert_data: { tableName, rows: [{field: value}, ...] }                 -- batch (any size, counts as one action)\n' +
    '  delete_data: { tableName, filters: [{column, op, value}] }\n' +
    '  propose_workflow_fix: { workflowName, steps: [...] } — corrects workflow steps; posts a diff gate for human approval before writing.\n' +
    '  propose_schema_fix: { operation, tableName, ...opParams } — applies a schema change; posts description for human approval before executing.\n' +
    '    addColumn:        { operation: "addColumn", tableName, column: { name, type, nullable? } }\n' +
    '    modifyColumn:     { operation: "modifyColumn", tableName, columnName, newType?, nullable?, using? }\n' +
    '    dropColumn:       { operation: "dropColumn", tableName, columnName }\n' +
    '    modifyConstraint: { operation: "modifyConstraint", tableName, constraintName, expression, target? }\n' +
    '  write_memory: { content, memory_type? } — record diagnostic reasoning; call before final respond after any change or notable finding. Scope is auto-derived from your tool history — do not set scope.\n' +
    'Params for trigger tools:\n' +
    '  run_workflow: { workflowName, input: {key: value} } — dispatches the named workflow to the step-executor engine. See system prompt for which workflows you may trigger.\n' +
    'For write operations, first query_table to confirm the target row(s), then call the write tool. Never return SQL or prose — always respond with a single JSON object.'
  );

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
        return { intent_category: p.intent_category, version: p.version, domain: p.domain, prompt_text: p.prompt_text, output_schema: p.output_schema };
      }

      case 'simulate_workflow': {
        const { steps } = params;
        if (!steps) return { error: 'steps is required' };
        const { servPost } = await import('../shared/serv-client.mjs');
        const resp = await servPost('/api/v1/proc/simulate-workflow', { steps });
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

async function postTurnLimitGate(sessionId, callback, traceId, resetActionCount = false) {
  if (!callback) return;
  await enqueueCallback(callback, {
    type:             'HUMAN_GATE',
    gate_type:        'minds_eye_continue_gate',
    sessionId,
    traceId,
    resetActionCount,
  });
}
