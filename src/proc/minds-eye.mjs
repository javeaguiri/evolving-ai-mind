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
//   update_data, insert_data, fix_workflow_steps — inline, no confirmation gate
//   delete_data — gated (destructive; requires explicit approval)
//
// MINDS_EYE_RESUME — gate approval:
//   Load session → find __pending__ entry → execute (approved) or record cancel → continue loop
//
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { ok, err }                                         from '../shared/lambda-utils.mjs';
import { getRows, insertRow, updateRows, deleteRows }       from '../shared/serv-client.mjs';
import { callLlm }                                         from '../shared/llm-client.mjs';
import { enqueueCallback }                                 from '../shared/sqs-callback.mjs';

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
  'update_data', 'insert_data', 'fix_workflow_steps',
]);

// Gated write tools — post a HUMAN_GATE before executing (destructive operations).
const GATED_WRITE_TOOLS = new Set([
  'delete_data',
]);

export async function handle(req) {
  const body     = req.body ?? {};
  const callback = req.callback ?? body.callback ?? null;
  const traceId  = req.traceId  ?? req.correlationId;

  // MINDS_EYE_RESUME — gate approval/rejection routes here
  if (body.type === 'MINDS_EYE_RESUME') {
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
      [
        { column: 'session_id', op: 'eq', value: session.id },
        { column: 'compressed', op: 'neq', value: true },
      ],
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
  const { sessionId, approved } = body;

  const sessResp = await getRows('PGC_Session', [{ column: 'id', op: 'eq', value: sessionId }]);
  const session  = sessResp.rows?.[0] ?? null;
  if (!session) {
    console.warn('proc/minds-eye: resume session not found', { sessionId, traceId });
    if (callback) await enqueueCallback(callback, { type: 'HUMAN_NOTIFICATION', traceId, message: 'Session not found — cannot resume.' });
    return;
  }

  const entriesResp = await getRows(
    'PGC_SessionEntry',
    [
      { column: 'session_id', op: 'eq', value: session.id },
      { column: 'compressed', op: 'neq', value: true },
    ],
    { column: 'sequence_number', direction: 'asc' }
  );
  const entries = entriesResp.rows ?? [];

  // Find the most recent __pending__ entry
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
  const currentSeq = Math.max(...entries.map(e => e.sequence_number)) + 1;
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

async function runReasoningLoop({ session, prefs, systemPrompt, layer1Context, layer2Context, workingHistory, callback, traceId, currentTurnCount, currentActionCount, currentSeq, threadTs }) {
  let turnCount   = currentTurnCount;
  let actionCount = currentActionCount;
  let seq         = currentSeq;

  for (let iteration = 0; iteration < prefs.turn_limit; iteration++) {
    if (turnCount >= prefs.turn_limit) {
      await postTurnLimitGate(session.id, callback, traceId);
      break;
    }

    const userMessage = buildUserMessage(layer1Context, layer2Context, workingHistory, prefs);

    let decision;
    try {
      decision = await callLlm(prefs.model, systemPrompt, userMessage, ACTION_SCHEMA, traceId);
    } catch (llmError) {
      console.error('proc/minds-eye: LLM call failed', { traceId, error: llmError.message });
      if (callback) {
        await enqueueCallback(callback, {
          type:    'HUMAN_NOTIFICATION',
          traceId,
          message: `Agent reasoning failed: ${llmError.message}`,
        });
      }
      break;
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
        if (advisory && prefs.advisory_level !== 'off') {
          replyText += `\n\n---\n_Advisory: ${advisory}_`;
        }
        await enqueueCallback(callback, {
          type:      'HUMAN_NOTIFICATION',
          format:    'markdown',
          traceId,
          message:   replyText,
          queryId:   session.query_id,
          sessionId: session.id,
        });
      }

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

      console.info('proc/minds-eye: read tool executed', { action, sessionId: session.id, traceId });

    } else if (INLINE_WRITE_TOOLS.has(action)) {
      if (actionCount >= prefs.max_actions_per_session) {
        if (callback) {
          await enqueueCallback(callback, {
            type:      'HUMAN_NOTIFICATION',
            format:    'markdown',
            traceId,
            message:   `Action limit reached (${prefs.max_actions_per_session} per session). Start a new session to continue.`,
            sessionId: session.id,
          });
        }
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

      console.info('proc/minds-eye: write tool executed', { action, sessionId: session.id, traceId });

    } else if (GATED_WRITE_TOOLS.has(action)) {
      if (actionCount >= prefs.max_actions_per_session) {
        if (callback) {
          await enqueueCallback(callback, {
            type:      'HUMAN_NOTIFICATION',
            format:    'markdown',
            traceId,
            message:   `Action limit reached (${prefs.max_actions_per_session} per session). Start a new session to continue.`,
            sessionId: session.id,
          });
        }
        break;
      }

      await postActionGate({ session, action, params, callback, traceId, currentTurnCount: turnCount, currentSeq: seq });
      break;

    } else {
      console.warn('proc/minds-eye: unknown action', { action, traceId });
      if (callback) {
        await enqueueCallback(callback, {
          type:    'HUMAN_NOTIFICATION',
          traceId,
          message: `Agent returned unknown action: ${action}. Reasoning: ${reasoning ?? '(none)'}`,
        });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Post an action gate — stores __pending__ entry, posts HUMAN_GATE
// ---------------------------------------------------------------------------

async function postActionGate({ session, action, params, callback, traceId, currentTurnCount, currentSeq }) {
  const gateText = await buildGateText(action, params, traceId);

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
      type:      'HUMAN_GATE',
      gate_type: 'minds_eye_gate',
      sessionId: session.id,
      dialog:    { fields: [{ type: 'typography', value: gateText }] },
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
        const { tableName, row = {} } = params;
        if (!tableName) return { error: 'tableName is required' };
        const resp = await insertRow(tableName, row);
        return { success: resp.success, row: resp.row };
      }

      case 'delete_data': {
        const { tableName, filters = [] } = params;
        if (!tableName) return { error: 'tableName is required' };
        return await deleteRows(tableName, filters);
      }

      case 'fix_workflow_steps': {
        const { workflowName, steps } = params;
        if (!workflowName || !steps) return { error: 'workflowName and steps are required' };
        const wfResp = await getRows('PGC_Workflow', [{ column: 'name', op: 'eq', value: workflowName }], { column: 'version', direction: 'desc' }, 1);
        const wf = wfResp.rows?.[0];
        if (!wf) return { error: `Workflow "${workflowName}" not found` };
        const resp = await updateRows('PGC_Workflow', [{ column: 'id', op: 'eq', value: wf.id }], { steps, version: wf.version + 1 });
        return { success: resp.success, newVersion: wf.version + 1 };
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
          return `Tool (${parsed.tool}): ${JSON.stringify(parsed.result).slice(0, 500)}`;
        } catch { return `Tool: ${e.content.slice(0, 500)}`; }
      }
      return '';
    }).filter(Boolean).join('\n\n');

    parts.push(`CONVERSATION:\n${transcript}`);
  }

  parts.push(
    'Based on the context and conversation above, decide your next action.\n' +
    'Respond with exactly one JSON object. Use ONLY these action values:\n' +
    '- Read (no gate): search_domain_help, list_tables, query_table, query_entity, read_memory, read_workflow, read_prompt, simulate_workflow\n' +
    '- Write without gate (executes immediately): update_data, insert_data, fix_workflow_steps\n' +
    '- Write with gate (requires approval — destructive): delete_data\n' +
    '- respond (final answer to user)\n' +
    'Params for write tools:\n' +
    '  update_data: { tableName, filters: [{column, op, value}], updates: {field: newValue} }\n' +
    '  insert_data: { tableName, row: {field: value} }\n' +
    '  delete_data: { tableName, filters: [{column, op, value}] }\n' +
    '  fix_workflow_steps: { workflowName, steps: [...] }\n' +
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
        return { name: wf.name, version: wf.version, domain: wf.domain, steps: wf.steps };
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
          { column: 'embedding', queryText: query, threshold: 0.5 }
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

async function postTurnLimitGate(sessionId, callback, traceId) {
  if (!callback) return;
  await enqueueCallback(callback, {
    type:    'HUMAN_NOTIFICATION',
    traceId,
    message: 'The agent has reached its turn limit. You can continue the conversation by clicking "Continue" or start fresh.',
    queryId: null,
  });
}
