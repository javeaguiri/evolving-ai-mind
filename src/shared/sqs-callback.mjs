// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/sqs-callback.mjs
// Enqueues a result message to SYSSQSCallbackResults so the
// SlackCallbackListenerFunction can route it back to the originating UI.
//
// This is the ONLY place @aws-sdk/client-sqs is imported in ProcFunction.
// Isolated here so all PROC endpoint modules remain AWS-agnostic.
//
// Called by: PROC endpoint modules when req.source === 'sqs'
// Never called on the HTTP path — HTTP responses go directly to API Gateway.

import { SQSClient, SendMessageCommand, DeleteMessageBatchCommand } from '@aws-sdk/client-sqs';
import { randomUUID }                    from 'crypto';

const sqs = new SQSClient({});

/**
 * Enqueue a result to SYSSQSCallbackResults.
 * SlackCallbackListenerFunction consumes this queue and routes on callback.provider.
 *
 * @param {{ provider: string, channel: string, threadId: string }} callback
 *   Provider-agnostic UI routing — carried end-to-end from the originating Slack message.
 * @param {object} payload
 *   The result body — merged with callback for the outbound SQS message.
 *   Must include at minimum: { type, traceId }.
 * @returns {Promise<void>}
 */
export async function enqueueCallback(callback, payload) {
  await sqs.send(new SendMessageCommand({
    QueueUrl:    process.env.SQS_SLACK_RESULTS_URL,
    MessageBody: JSON.stringify({
      ...payload,
      callback,
    }),
  }));

  console.info('sqs-callback: result enqueued', {
    type:     payload.type,
    traceId:  payload.traceId,
    provider: callback?.provider,
    channel:  callback?.channel,
  });
}

/**
 * Enqueue a WORKFLOW_STEP message to SYSSQSWorkflowQueue.
 * Used by the Step Processor to continue execution after each step,
 * and by resume_gate to advance after a human_gate response.
 *
 * @param {object} payload  Must include { type, action, workflowRunId, traceId }
 * @returns {Promise<void>}
 */
export async function enqueueWorkflow(payload) {
  // Stamp every execute_top message with a unique stepExecutionId so the
  // idempotency check can distinguish SQS redeliveries from legitimate loop
  // re-entries (same step key, different iteration).
  const enriched = (payload.action === 'execute_top' && !payload.stepExecutionId)
    ? { ...payload, stepExecutionId: randomUUID() }
    : payload;
  await sqs.send(new SendMessageCommand({
    QueueUrl:    process.env.SQS_WORKFLOW_URL,
    MessageBody: JSON.stringify(enriched),
  }));

  console.info('sqs-callback: workflow message enqueued', {
    type:    payload.type,
    action:  payload.action,
    traceId: payload.traceId,
  });
}

/**
 * Immediately delete a batch of received SQS records from WorkflowQueue.
 * Called at the top of processSqsBatch before any processing so SQS is freed
 * regardless of how long the Lambda runs or whether it crashes mid-step.
 * DB state (PGC_WorkflowRun) is the source of truth for recovery.
 *
 * @param {object[]} records  Lambda SQS event Records (each has .messageId, .receiptHandle)
 * @returns {Promise<void>}
 */
export async function deleteReceivedBatch(records) {
  if (!records.length) return;
  await sqs.send(new DeleteMessageBatchCommand({
    QueueUrl: process.env.SQS_WORKFLOW_URL,
    Entries:  records.map((r, i) => ({ Id: String(i), ReceiptHandle: r.receiptHandle })),
  }));
  console.info('sqs-callback: batch pre-deleted from queue', { count: records.length });
}
