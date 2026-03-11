// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/step-orchestrator.mjs
// SQS-triggered Lambda — consumes SYSSQSWorkflow messages.
// For ping-sqs: receives hop 1, sends hop 2 to SYSSQSSlackResults.
// For ping-e2e: receives hop 1, invokes ServFunction (ping-db), sends result to SYSSQSSlackResults.
// For future workflows: routes to the appropriate workflow executor.
//
// This is the PROC layer's async backbone — every workflow step
// passes through here.
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, InvokeCommand }   from '@aws-sdk/client-lambda';

const sqs = new SQSClient({});
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

async function handlePingSqs(message) {
  // Hop 2 — forward result to SlackResults queue
  // SlackCallbackListenerFunction picks this up and posts to Slack thread
  await sqs.send(new SendMessageCommand({
    QueueUrl:    process.env.SQS_SLACK_RESULTS_URL,
    MessageBody: JSON.stringify({
      type:          'PING_SQS_RESULT',
      workflowId:    message.workflowId,
      slackChannel:  message.slackChannel,
      slackUser:     message.slackUser,
      slackThreadTs: message.slackThreadTs,
      hop:           2,
      result: {
        success:     true,
        message:     '📬 ping-sqs complete — 2 SQS hops confirmed ✅',
        workflowId:  message.workflowId,
        hop1EnqueuedAt: message.enqueuedAt,
        hop2ProcessedAt: new Date().toISOString(),
      },
    }),
  }));
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

  await sqs.send(new SendMessageCommand({
    QueueUrl:    process.env.SQS_SLACK_RESULTS_URL,
    MessageBody: JSON.stringify({
      type:          'PING_E2E_RESULT',
      workflowId:    message.workflowId,
      slackChannel:  message.slackChannel,
      slackUser:     message.slackUser,
      slackThreadTs: message.slackThreadTs,
      result: {
        success:        true,
        message:        `🔁 ping-e2e complete — full round trip confirmed ✅\n\`${version}\``,
        workflowId:     message.workflowId,
        enqueuedAt:     message.enqueuedAt,
        completedAt:    new Date().toISOString(),
      },
    }),
  }));
  console.info('ping-e2e result enqueued', { workflowId: message.workflowId, version });
}