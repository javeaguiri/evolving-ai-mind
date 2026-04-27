// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/ping.mjs
// Handles POST /api/v1/ui/slack/ping
//
// Unified ping dispatcher — reads type from Slack text body field.
// Exempt from Slack signature verification — all types are curl-accessible.
//
// Usage (Slack):  /ping [api|sqs|llm|e2e|db|core]  (defaults to api)
// Usage (curl):   curl -X POST .../ui/slack/ping -d "text=sqs&user_id=U1&channel_id=C1"
//
// Synchronous types (return immediately):
//   api  — SlackbotFunction alive check — no downstream calls
//   llm  — exp → proc (HTTP) → Perplexity → response
//   db   — exp → proc (HTTP) → serv → RDS → response
//
// Async types (ACK message posted, threaded reply arrives via SQS callback):
//   sqs  — exp → SQS → proc → SQS → SlackCallback
//   e2e  — exp → SQS → proc → serv → SQS → SlackCallback
//   core — exp → SQS → proc → Step Processor → ping_core workflow (interactive)

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient } from '@slack/web-api';
import { ok, err } from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const VALID_TYPES = ['api', 'sqs', 'llm', 'e2e', 'db', 'core'];
const USAGE       = `Valid types: ${VALID_TYPES.join(', ')} — e.g. /ping sqs`;

const SQS_TYPE_MAP = {
  sqs:  'PING_SQS',
  e2e:  'PING_E2E',
  core: 'PING_CORE',
};

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — ping expects POST', req.correlationId);
  }

  const type    = (req.body?.text ?? '').trim().toLowerCase() || 'api';
  const traceId = req.correlationId;
  const userId  = req.body?.user_id    || 'unknown';
  const channel = req.body?.channel_id || 'unknown';

  if (!VALID_TYPES.includes(type)) {
    return ok({ success: false, message: `Unknown ping type "${type}". ${USAGE}` }, traceId);
  }

  console.info('ping', { type, traceId, userId, channel });

  if (type === 'api') return pingApi(traceId, userId, channel);
  if (type === 'llm') return pingSync('proc/ping-llm', traceId, 'LLM');
  if (type === 'db')  return pingSync('proc/ping-db',  traceId, 'DB');
  return pingAsync(type, traceId, userId, channel);
}

// ---------------------------------------------------------------------------
// api — synchronous, no downstream calls
// ---------------------------------------------------------------------------

function pingApi(traceId, userId, channel) {
  return ok({
    success:   true,
    message:   'pong-api — slackbot Lambda is alive',
    user:      userId,
    channel,
    traceId,
    timestamp: new Date().toISOString(),
  }, traceId);
}

// ---------------------------------------------------------------------------
// llm / db — synchronous HTTP to PROC (exp → proc is the correct tier path)
// proc/ping-llm calls Perplexity; proc/ping-db calls serv/ping-db
// ---------------------------------------------------------------------------

async function pingSync(procRoute, traceId, label) {
  try {
    const url = `${process.env.PROC_API_URL}/api/v1/${procRoute}`;
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-correlation-id': traceId },
      body:    JSON.stringify({ source: 'slack', correlationId: traceId }),
    });
    if (!res.ok) throw new Error(`Proc HTTP ${res.status}: ${await res.text()}`);
    const body = await res.json();
    return ok({ success: true, traceId, ...body }, traceId);
  } catch (error) {
    console.error(`ping ${label} error:`, error.message);
    return err(500, `${label} ping failed: ${error.message}`, traceId);
  }
}

// ---------------------------------------------------------------------------
// sqs / e2e / core — async: post ACK, enqueue to WorkflowQueue, return empty 200
// ---------------------------------------------------------------------------

async function pingAsync(type, traceId, userId, channel) {
  let ackTs;
  try {
    const ack = await slack.chat.postMessage({
      channel,
      text: `ping-${type} started — watch this thread for results`,
    });
    ackTs = ack.ts;
  } catch (error) {
    console.error(`ping-${type}: Slack ACK failed`, error.message);
    return err(500, `Slack ACK failed: ${error.message}`, traceId);
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:       SQS_TYPE_MAP[type],
        traceId,
        slackUser:  userId,
        callback:   { provider: 'slack', channel, threadId: ackTs },
        enqueuedAt: new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error(`ping-${type} enqueue error:`, error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, traceId);
  }

  return { statusCode: 200, body: '' };
}
