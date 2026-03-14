// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/step-orchestrator.mjs
// SQS-triggered Lambda — consumes SYSSQSWorkflow messages.
// For ping-sqs:      receives hop 1, sends hop 2 to SYSSQSCallbackResults.
// For ping-e2e:      receives hop 1, invokes ServFunction (ping-db), sends result.
// For create-domain: loads scaffold, invokes ServFunction (schema + table), sends result.
// For future workflows: routes to the appropriate workflow executor.
//
// This is the PROC layer's async backbone — every workflow step
// passes through here.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, InvokeCommand }   from '@aws-sdk/client-lambda';

const sqs = new SQSClient({});
// Phase 2b scaffold — replaced by LLM call in Phase 2c
import recipesScaffold from './scaffolds/recipes.json' with { type: 'json' };

const SCAFFOLDS = {
  recipes: recipesScaffold,
};

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
// Phase 2b: loads scaffold JSON — Phase 2c replaces this with LLM call.
// ---------------------------------------------------------------------------

async function handleCreateDomain(message) {
  const { domainName, workflowId, callback } = message;

  // Phase 2b — load scaffold. Phase 2c: replace with LLM call reading
  // from PGC_Prompt via SERV-Table getRows.
  const scaffold = SCAFFOLDS[domainName];
  if (!scaffold) {
    await sendCallbackResult(callback, {
      type:       'CREATE_DOMAIN_RESULT',
      workflowId,
      result: {
        success: false,
        message: `❌ No scaffold found for domain "${domainName}" — Phase 2c will add LLM generation`,
      },
    });
    return;
  }

  console.info('create-domain: scaffold loaded', { domainName, workflowId });

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
      httpMethod: 'GET',
      path:       '/api/v1/serv/ping-db',
      pathParameters: { proxy: 'ping-db' },
      headers:    {},
      body:       null,
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