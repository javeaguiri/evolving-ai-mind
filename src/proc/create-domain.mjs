// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/create-domain.mjs
// Handles POST /api/v1/proc/create-domain (HTTP) and
//         CREATE_DOMAIN SQS WorkflowQueue messages (async).
//
// Transport-agnostic — no AWS SDK, no Slack SDK imports.
// req.source determines response path only:
//   'http' → return ok(result) to API Gateway caller
//   'sqs'  → enqueueCallback(req.callback, result) via sqs-callback.mjs
//
// Reads create_domain prompt from PGC_Prompt via SERV-Table.
// Calls Perplexity Agent API to design domain schema.
// Creates PGD tables via SERV-Schema createTable.
// Registers domain in PGC_DomainHelp via SERV-Table insertRow.
// All SERV calls via fetch(SERV_API_URL) — no Lambda invoke.

import { ok, err }            from '../shared/ping-utils.mjs';
import { enqueueCallback }    from '../shared/sqs-callback.mjs';

/**
 * Entry point — called from proc/handler.mjs dispatch() for both
 * HTTP and SQS transports.
 *
 * @param {object} req  Normalised req from parseEvent() or buildReqFromSqs()
 */
export async function handle(req) {
  const { userInput } = req.body;
  if (!userInput) {
    return err(400, 'userInput is required', req.correlationId);
  }

  try {
    const result = await runCreateDomain(userInput, req.traceId ?? req.correlationId);

    if (req.source === 'http') {
      return ok(result, req.correlationId);
    }

    // SQS path — enqueue result for SlackCallbackListenerFunction
    await enqueueCallback(req.callback, {
      type:    'CREATE_DOMAIN_RESULT',
      traceId: req.traceId,
      result,
    });

  } catch (error) {
    console.error('create-domain: failed', { error: error.message, traceId: req.traceId });

    if (req.source === 'http') {
      return err(500, `create-domain failed: ${error.message}`, req.correlationId);
    }

    // SQS path — re-throw so processSqsBatch records a batchItemFailure
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Core logic — transport-agnostic
// ---------------------------------------------------------------------------

async function runCreateDomain(userInput, traceId) {
  // Step 0 — read create_domain prompt from PGC_Prompt via SERV-Table
  const promptResp = await servFetch('POST', '/api/v1/serv/table/getRows', {
    tableName: 'PGC_Prompt',
    filters:   [{ column: 'intent_category', op: 'eq', value: 'create_domain' }],
    orderBy:   { column: 'version', direction: 'desc' },
    limit:     1,
  });

  if (!promptResp.success || promptResp.count === 0) {
    throw new Error('create_domain prompt not found in PGC_Prompt');
  }

  const promptRow  = promptResp.rows[0];
  const promptText = promptRow.prompt_text.replace('{{userInput}}', userInput);

  console.info('create-domain: prompt loaded', {
    promptId: promptRow.id,
    version:  promptRow.version,
    model:    promptRow.model,
    traceId,
  });

  // Step 0b — call LLM via Perplexity Agent API
  const scaffold = await callLlm(promptRow.model, promptText, userInput, traceId);
  const domainName = scaffold.domain;

  console.info('create-domain: LLM returned scaffold', {
    userInput,
    domainName,
    tables: scaffold.tables?.map(t => t.tableName),
    traceId,
  });

  // Step 1 — normalise FK/constraint shape and create each PGD table via SERV-Schema
  const createdTables = [];
  for (const table of scaffold.tables) {
    // Normalise foreignKeys — LLM may return "references": "TableName(column)"
    // buildCreateTableSQL expects { table: "TableName", column: "column" }
    table.foreignKeys = (table.foreignKeys || []).map((fk, i) => {
      if (typeof fk.references === 'string') {
        const match = fk.references.match(/^([^(]+)\(([^)]+)\)$/);
        return {
          name:       fk.name || `fk_${table.tableName.toLowerCase()}_${fk.column}_${i}`,
          column:     fk.column,
          references: match
            ? { table: match[1].trim(), column: match[2].trim() }
            : { table: fk.references, column: 'id' },
          onDelete: fk.onDelete || 'RESTRICT',
        };
      }
      if (!fk.name) fk.name = `fk_${table.tableName.toLowerCase()}_${fk.column}_${i}`;
      return fk;
    });

    // Normalise constraints — LLM may return type as "UNIQUE" instead of "unique"
    table.constraints = (table.constraints || []).map((con, i) => ({
      ...con,
      type:    con.type?.toLowerCase(),
      name:    con.name || `uq_${table.tableName.toLowerCase()}_${i}`,
      columns: con.columns || [],
    }));

    const resp = await servFetch('POST', '/api/v1/serv/schema/createTable', table);
    if (!resp.success) {
      if (resp.statusCode === 409) {
        console.info('create-domain: table already exists, skipping', { tableName: table.tableName });
        createdTables.push({ tableName: table.tableName, status: 'already_existed' });
        continue;
      }
      throw new Error(`createTable failed for ${table.tableName}: ${resp.error}`);
    }
    createdTables.push({ tableName: table.tableName, status: 'created' });
    console.info('create-domain: table created', { tableName: table.tableName, traceId });
  }

  // If all tables already existed the domain was previously created — exit early
  const allExisted = createdTables.every(t => t.status === 'already_existed');
  if (allExisted) {
    return {
      success:     true,
      message:     `🧠 Domain *${domainName}* already exists — no changes made`,
      domainName,
      tables:      createdTables,
      completedAt: new Date().toISOString(),
    };
  }

  // Step 2 — register domain help via SERV-Table insertRow
  const helpResp = await servFetch('POST', '/api/v1/serv/table/insertRow', {
    tableName: 'PGC_DomainHelp',
    row:       scaffold.domainHelp,
  });

  if (!helpResp.success && helpResp.statusCode !== 409) {
    throw new Error(`insertRow PGC_DomainHelp failed: ${helpResp.error}`);
  }
  if (helpResp.statusCode === 409) {
    console.info('create-domain: PGC_DomainHelp already exists, skipping', { domainName });
  }

  const tableList = createdTables.map(t =>
    `• \`${t.tableName}\` — ${t.status === 'created' ? 'created ✅' : 'already existed'}`
  ).join('\n');

  console.info('create-domain: complete', { domainName, traceId, tables: createdTables });

  return {
    success:     true,
    message:     `🧠 Domain *${domainName}* is ready!\n\n${tableList}`,
    domainName,
    tables:      createdTables,
    completedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SERV HTTP client — replaces Lambda invoke from step-orchestrator.mjs
// ---------------------------------------------------------------------------

/**
 * Call a SERV endpoint via HTTP fetch.
 * Attaches statusCode to the parsed body so callers can check it.
 *
 * @param {string} method  HTTP method
 * @param {string} path    SERV endpoint path
 * @param {object} body    Request body
 * @returns {Promise<object>}
 */
async function servFetch(method, path, body) {
  const url  = `${process.env.SERV_API_URL}${path}`;
  const resp = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  const parsed      = await resp.json();
  parsed.statusCode = resp.status;
  return parsed;
}

// ---------------------------------------------------------------------------
// LLM client — Perplexity Agent API
// ---------------------------------------------------------------------------

/**
 * Call Perplexity Agent API and return parsed JSON scaffold.
 * Uses process.env.LLM_AGENT_URL — no hardcoded URLs.
 * Note: first request with a new schema takes 10-30s to prepare —
 * subsequent requests are fast. SQS will retry if first call times out.
 *
 * @param {string} model       LLM model name from PGC_Prompt row
 * @param {string} promptText  System prompt with {{userInput}} already substituted
 * @param {string} userInput   Original user input — passed as the user message
 * @param {string} traceId     For logging
 * @returns {Promise<object>}  Parsed scaffold { domain, tables, domainHelp }
 */
async function callLlm(model, promptText, userInput, traceId) {
  const llmKey = process.env.LLM_API_KEY;
  if (!llmKey) throw new Error('LLM_API_KEY env var not set');

  const response = await fetch(process.env.LLM_AGENT_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${llmKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model,
      input:        `Design a database domain for: "${userInput}"`,
      instructions: promptText,
      temperature:  0.2,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent API error ${response.status}: ${text}`);
  }

  const data = await response.json();

  console.info('create-domain: LLM raw response', {
    status:    response.status,
    outputLen: data.output?.length,
    usage:     data.usage,
    output:    JSON.stringify(data.output),
    traceId,
  });

  // Extract text from output array — find the message block
  const messageBlock = data.output?.find(o => o.type === 'message');
  const rawText      = messageBlock?.content?.[0]?.text ?? '';

  if (!rawText) throw new Error('LLM returned empty response');

  console.info('create-domain: LLM raw text', { rawText: rawText.slice(0, 500), traceId });

  // Strip markdown fences defensively, then parse JSON
  const clean = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let scaffold;
  try {
    scaffold = JSON.parse(clean);
  } catch (error) {
    throw new Error(`LLM returned invalid JSON: ${error.message}\nRaw: ${rawText.slice(0, 200)}`);
  }

  // Shape validation
  if (!scaffold.domain || !Array.isArray(scaffold.tables) || scaffold.tables.length === 0) {
    throw new Error(`LLM scaffold missing required fields. Got: ${JSON.stringify(scaffold).slice(0, 200)}`);
  }

  return scaffold;
}
