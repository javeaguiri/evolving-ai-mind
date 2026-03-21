// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/sqs-callback.mjs
// SQS enqueue helpers for ProcFunction.
//
// This is the ONLY place @aws-sdk/client-sqs is imported in ProcFunction.
// Isolated here so all PROC endpoint modules remain AWS-agnostic.
//
// enqueueCallback() — writes to SYSSQSSlackResults (EXP tier consumer)
// enqueueWorkflow() — writes to SYSSQSWorkflow (PROC tier consumer)
//
// Called by: PROC endpoint modules when req.source === 'sqs'
// Never called on the HTTP path — HTTP responses go directly to API Gateway.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});

/**
 * Enqueue a result to SYSSQSSlackResults.
 * SlackCallbackListenerFunction consumes this queue and routes on callback.provider.
 *
 * @param {{ provider: string, channel: string, threadId: string }} callback
 * @param {object} payload  Must include at minimum: { type, traceId }
 */
export async function enqueueCallback(callback, payload) {
  await sqs.send(new SendMessageCommand({
    QueueUrl:    process.env.SQS_SLACK_RESULTS_URL,
    MessageBody: JSON.stringify({ ...payload, callback }),
  }));

  console.info('sqs-callback: result enqueued', {
    type:     payload.type,
    traceId:  payload.traceId,
    provider: callback?.provider,
    channel:  callback?.channel,
  });
}

/**
 * Enqueue a workflow message to SYSSQSWorkflow.
 * ProcFunction consumes this queue — used to hand off to the next workflow step.
 *
 * @param {object} payload  Must include at minimum: { type, traceId }
 */
export async function enqueueWorkflow(payload) {
  await sqs.send(new SendMessageCommand({
    QueueUrl:    process.env.SQS_WORKFLOW_URL,
    MessageBody: JSON.stringify(payload),
  }));

  console.info('sqs-callback: workflow message enqueued', {
    type:    payload.type,
    traceId: payload.traceId,
  });
}
