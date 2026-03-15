// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/step-orchestrator.mjs
// SQS-triggered Lambda — consumes SYSSQSWorkflow messages.
// For ping-sqs:      receives hop 1, sends hop 2 to SYSSQSCallbackResults.
// For ping-e2e:      receives hop 1, invokes ServFunction (ping-db), sends result.
// For create-domain: reads prompt from PGC_Prompt, calls LLM, creates PGD tables.
// For future workflows: routes to the appropriate workflow executor.
//
// This is the PROC layer's async backbone — every workflow step
// passes through here.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, InvokeCommand }   from '@aws-sdk/client-lambda';

const AGENT_API_URL = 'https://api.perplexity.ai/v1/agent';

const sqs    = new SQSClient({});
const lambda = new LambdaClient({});

export async function handler(event) {
  const results = [];

  for (const record of event.Records) {
    const result = await processRecord(record);
    results.push(result);
  }

  // ReportBatchItemFailures — only failed records return to queue
  const failures = results
    .filter(r => !r.success)
    .map(r => ({ itemIdentifier: r.messageId }));

  return { batchItemFailures: failures };
}

async function processRecord(record) {
  const messageId = record.messageId;

  let message;
  try {
    message = JSON.parse(record.body);
  } catch (error) {
    console.error('step-orchestrator: invalid JSON in SQS message', {
      messageId,
      error: error.message,
    });
    // Don't retry unparseable messages — return success to discard
    return { success: true, messageId };
  }

  console.info('step-orchestrator received', {
    type:       message.type,
    workflowId: message.workflowId,
    hop:        message.hop,
    messageId,
  });

  try {
    switch (message.type) {

      case 'PING_SQS':
        await handlePingSqs(message);
        break;
      case 'PING_E2E':
        await handlePingE2e(message);
        break;
      case 'CREATE_DOMAIN':
        await handleCreateDomain(message);
        break;

      // Future workflow types added here:
      // case 'RUN_FLOW': await handleRunFlow(message); break;

      default:
        console.warn('step-orchestrator: unknown message type', message.type);
    }

    return { success: true, messageId };

  } catch (error) {
    console.error('step-orchestrator: processing error', {
      type:       message.type,
      workflowId: message.workflowId,
      error:      error.message,
    });
    return { success: false, messageId };
  }
}

// ---------------------------------------------------------------------------
// CREATE_DOMAIN
// Phase 2c: reads prompt from PGC_Prompt, calls Perplexity Agent API,
// parses LLM JSON response into scaffold, creates PGD tables.
// ---------------------------------------------------------------------------

async function handleCreateDomain(message) {
  const { domainName, workflowId, callback } = message;

  // Step 0 — read create_domain prompt from PGC_Prompt via SERV-Table
  const promptResp = await invokeServ('POST', '/api/v1/serv/table/getRows', {
    tableName: 'PGC_Prompt',
    filters:   [{ column: 'intent_category', op: 'eq', value: 'create_domain' }],
    orderBy:   { column: 'version', direction: 'desc' },
    limit:     1,
  });

  if (!promptResp.success || promptResp.count === 0) {
    throw new Error('create_domain prompt not found in PGC_Prompt — run migration first');
  }

  const promptRow  = promptResp.rows[0];
  const promptText = promptRow.prompt_text.replace('{{domainName}}', domainName);

  console.info('create-domain: prompt loaded', {
    promptId: promptRow.id,
    version:  promptRow.version,
    model:    promptRow.model,
    workflowId,
  });

  // Step 0b — call LLM via Perplexity Agent API
  const scaffold = await callLlm(promptRow.model, promptText, domainName);

  console.info('create-domain: LLM returned scaffold', {
    domainName,
    tables: scaffold.tables?.map(t => t.tableName),
    workflowId,
  });

  // Step 1 — create each PGD table via SERV-Schema createTable
  const createdTables = [];
  for (const table of scaffold.tables) {
    const resp = await invokeServ('POST', '/api/v1/serv/schema/createTable', table);
    if (!resp.success) {
      // If table already exists (409) treat as success — idempotent
      if (resp.statusCode === 409) {
        console.info('create-domain: table already exists, skipping', { tableName: table.tableName });
        createdTables.push({ tableName: table.tableName, status: 'already_existed' });
        continue;
      }
      throw new Error(`createTable failed for ${table.tableName}: ${resp.error}`);
    }
    createdTables.push({ tableName: table.tableName, status: 'created' });
    console.info('create-domain: table created', { tableName: table.tableName, workflowId });
  }

  // Step 2 — register domain help via SERV-Table insertRow
  const helpResp = await invokeServ('POST', '/api/v1/serv/table/insertRow', {
    tableName: 'PGC_DomainHelp',
    row:       scaffold.domainHelp,
  });

  if (!helpResp.success && helpResp.statusCode !== 409) {
    throw new Error(`insertRow PGC_DomainHelp failed: ${helpResp.error}`);
  }
  if (helpResp.statusCode === 409) {
    console.info('create-domain: PGC_DomainHelp already exists, skipping', { domainName });
  }

  // Step 3 — send result to CallbackResults queue
  const tableList = createdTables.map(t =>
    `• \`${t.tableName}\` — ${t.status === 'created' ? 'created ✅' : 'already existed'}`
  ).join('\n');

  await sendCallbackResult(callback, {
    type:       'CREATE_DOMAIN_RESULT',
    workflowId,
    result: {
      success:     true,
      message:     `🧠 Domain *${domainName}* is ready!\n\n${tableList}`,
      domainName,
      tables:      createdTables,
      workflowId,
      completedAt: new Date().toISOString(),
    },
  });

  console.info('create-domain: complete', { domainName, workflowId, tables: createdTables });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Invoke ServFunction synchronously and return the parsed response body.
 * Attaches statusCode to the parsed body so callers can check it.
 */
async function invokeServ(method, path, body) {
  const invokeResp = await lambda.send(new InvokeCommand({
    FunctionName:   process.env.SERV_FUNCTION_NAME,
    InvocationType: 'RequestResponse',
    Payload:        JSON.stringify({
      httpMethod:     method,
      path,
      pathParameters: { proxy: path.split('/').pop() },
      headers:        {},
      body:           JSON.stringify(body),
    }),
  }));

  const lambdaResp = JSON.parse(Buffer.from(invokeResp.Payload).toString());
  const parsed     = JSON.parse(lambdaResp.body);
  parsed.statusCode = lambdaResp.statusCode;
  return parsed;
}

/**
 * Call Perplexity Agent API and return parsed JSON scaffold.
 * Uses response_format json_schema for guaranteed structured output.
 * Note: first request with a new schema takes 10-30s to prepare —
 * subsequent requests are fast. SQS will retry if first call times out.
 */
async function callLlm(model, promptText, domainName) {
  const llmKey = process.env.LLM_API_KEY;
  if (!llmKey) throw new Error('LLM_API_KEY env var not set');

  const response = await fetch(AGENT_API_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${llmKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model,
      input:        `Create a database domain called "${domainName}"`,
      instructions: promptText,
      temperature:  0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'domain_scaffold',
          schema: {
            type: 'object',
            required: ['domain', 'tables', 'domainHelp'],
            properties: {
              domain: { type: 'string' },
              tables: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['tableName', 'target', 'description', 'columns', 'foreignKeys', 'constraints', 'triggers'],
                  properties: {
                    tableName:   { type: 'string' },
                    target:      { type: 'string', enum: ['pgd'] },
                    description: { type: 'string' },
                    columns: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['name', 'type'],
                        properties: {
                          name:       { type: 'string' },
                          type:       { type: 'string' },
                          primaryKey: { type: 'boolean' },
                          nullable:   { type: 'boolean' },
                          unique:     { type: 'boolean' },
                          default:    { type: 'string' },
                        },
                      },
                    },
                    foreignKeys: { type: 'array', items: { type: 'object' } },
                    constraints: { type: 'array', items: { type: 'object' } },
                    triggers:    { type: 'array', items: { type: 'object' } },
                  },
                },
              },
              domainHelp: {
                type: 'object',
                required: ['domain', 'aliases', 'description', 'commands'],
                properties: {
                  domain:      { type: 'string' },
                  aliases:     { type: 'array', items: { type: 'string' } },
                  description: { type: 'string' },
                  commands:    { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent API error ${response.status}: ${text}`);
  }

  const data = await response.json();

  // Extract text from output array — find the message block
  const messageBlock = data.output?.find(o => o.type === 'message');
  const rawText      = messageBlock?.content?.[0]?.text ?? '';

  if (!rawText) throw new Error('LLM returned empty response');

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

/**
 * Send a result message to SYSSQSCallbackResults.
 */
async function sendCallbackResult(callback, payload) {
  await sqs.send(new SendMessageCommand({
    QueueUrl:    process.env.SQS_SLACK_RESULTS_URL,
    MessageBody: JSON.stringify({ ...payload, callback }),
  }));
}

// ---------------------------------------------------------------------------
// Ping handlers
// ---------------------------------------------------------------------------

async function handlePingSqs(message) {
  // Hop 2 — forward result to CallbackResults queue
  // A UI CallbackListenerFunction will pick this up and post to UI
  await sendCallbackResult(message.callback, {
    type:       'PING_SQS_RESULT',
    workflowId: message.workflowId,
    hop:        2,
    result: {
      success:         true,
      message:         '📬 ping-sqs complete — 2 SQS hops confirmed ✅',
      workflowId:      message.workflowId,
      hop1EnqueuedAt:  message.enqueuedAt,
      hop2ProcessedAt: new Date().toISOString(),
    },
  });
  console.info('ping-sqs hop 2 enqueued', { workflowId: message.workflowId });
}

async function handlePingE2e(message) {
  // Invoke ServFunction synchronously — ping-db returns RDS version string
  const invokeResp = await lambda.send(new InvokeCommand({
    FunctionName:   process.env.SERV_FUNCTION_NAME,
    InvocationType: 'RequestResponse',
    Payload:        JSON.stringify({
      httpMethod:     'GET',
      path:           '/api/v1/serv/ping-db',
      pathParameters: { proxy: 'ping-db' },
      headers:        {},
      body:           null,
    }),
  }));

  const body    = JSON.parse(Buffer.from(invokeResp.Payload).toString());
  const payload = JSON.parse(body.body);

  // payload.pgc.version is the full version string from RDS
  const version = payload?.pgc?.version ?? payload?.pgd?.version ?? 'unknown';

  await sendCallbackResult(message.callback, {
    type:       'PING_E2E_RESULT',
    workflowId: message.workflowId,
    result: {
      success:     true,
      message:     `🔁 ping-e2e complete — full round trip confirmed ✅\n\`${version}\``,
      workflowId:  message.workflowId,
      enqueuedAt:  message.enqueuedAt,
      completedAt: new Date().toISOString(),
    },
  });
  console.info('ping-e2e result enqueued', { workflowId: message.workflowId, version });
}