// src/proc/step-orchestrator.mjs
// SQS-triggered Lambda — consumes SYSSQSWorkflow messages.
// For ping-sqs: receives hop 1, sends hop 2 to SYSSQSSlackResults.
// For future workflows: routes to the appropriate workflow executor.
//
// This is the PROC layer's async backbone — every workflow step
// passes through here.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});

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