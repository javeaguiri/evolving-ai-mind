// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/explain.mjs
// Handles POST /api/v1/ui/slack/explain
//
// Accepts: /explain <query_id|run_id> <prompt>
// Opens a diagnostic or chat follow-up conversation anchored to an existing PGC_Session.
// A run_id (PGC_WorkflowRun.id) may have multiple llm_call diagnostic sessions —
// ProcFunction resolves it to a single session or posts a step-selection button list.
// ACKs immediately; enqueues EXPLAIN_QUERY to ProcFunction for async LLM call.
// ProcFunction loads the existing session entries and continues the conversation.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

// Slack slash command validation errors must return 200 so the message renders in-channel.
// Non-200 responses produce a generic Slack error that hides the usage hint.
function slackErr(message) {
  return {
    statusCode: 200,
    headers:    { 'Content-Type': 'application/json' },
    body:       JSON.stringify({ response_type: 'ephemeral', text: message }),
  };
}

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// query_id must be a valid UUID v4; run_id is a plain PGC_WorkflowRun.id integer
const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_RE = /^\d+$/;

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — explain expects POST', req.correlationId);
  }

  const text         = (req.body?.text || '').trim();
  const slackUser    = req.body?.user_id    || 'unknown';
  const slackChannel = req.body?.channel_id || 'unknown';
  const traceId      = req.correlationId;

  // Parse: first token is query_id or run_id, remainder is the prompt
  const spaceIdx  = text.indexOf(' ');
  const firstToken = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const prompt     = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  const isRunId   = RUN_ID_RE.test(firstToken);
  const isQueryId = UUID_RE.test(firstToken);

  if (!isRunId && !isQueryId) {
    return slackErr('Usage: /explain <query_id|run_id> <your question>');
  }
  if (!prompt) {
    return slackErr('Usage: /explain <query_id|run_id> <your question>');
  }

  console.info('slackbot/explain: received', { traceId, firstToken, isRunId, slackUser, slackChannel });

  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel: slackChannel,
      text:    `❓ ${prompt}`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error('slackbot/explain: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:      'EXPLAIN_QUERY',
        traceId,
        ...(isRunId ? { runId: Number(firstToken) } : { queryId: firstToken }),
        prompt,
        slackUser,
        callback: {
          provider: 'slack',
          channel:  slackChannel,
          threadId: ackTs,
        },
        enqueuedAt: new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('slackbot/explain: SQS enqueue failed', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
