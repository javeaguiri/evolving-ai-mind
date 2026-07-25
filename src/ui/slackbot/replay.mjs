// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/replay.mjs
// Handles POST /api/v1/ui/slack/replay
//
// Accepts:
//   /replay                  — list recent runs (which run to replay)
//   /replay <runId>          — replay that run (breakPolicy: on_miss)
//   /replay <runId> record   — replay, breaking at every llm_call (breakPolicy: always)
//
// Flow: SlackbotFunction → enqueue REPLAY to WorkflowQueue → ProcFunction → proc/replay.mjs.
// Break notifications and the run's replies thread under the ACK message posted here.
// Payload-free resolutions (abort / call_live / use_recorded) are buttons on the break
// notification (A11); `supplied` carries a response body and stays an HTTP curl. See
// docs/arch-replay.md §5, §9.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WebClient }                     from '@slack/web-api';
import { err }                           from '../../shared/lambda-utils.mjs';

const sqs   = new SQSClient({});
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — replay expects POST', req.correlationId);
  }

  const text         = (req.body?.text || '').trim();
  const slackChannel = req.body?.channel_id || 'unknown';
  const traceId      = req.correlationId;
  const tokens       = text ? text.split(/\s+/) : [];

  // /replay <runId> [record] — validate the run id if one was given
  let sourceRunId;
  let breakPolicy = 'on_miss';
  if (tokens.length > 0) {
    const parsed = parseInt(tokens[0], 10);
    if (isNaN(parsed) || String(parsed) !== tokens[0]) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          response_type: 'ephemeral',
          text: `❌ Invalid run ID "${tokens[0]}" — usage: \`/replay\`, \`/replay <runId>\`, or \`/replay <runId> record\``,
        }),
      };
    }
    sourceRunId = parsed;
    if (tokens[1] === 'record') breakPolicy = 'always';
  }

  const ackText = sourceRunId === undefined
    ? '🔁 Fetching recent runs…'
    : `🔁 Replaying run *${sourceRunId}* (${breakPolicy === 'always' ? 'record — breaks at every step' : 'replay — breaks only on drift'}) — watch this thread`;

  // Post ACK — becomes the thread root for the list / run replies and break notifications
  let ackTs;
  try {
    const ack = await slack.chat.postMessage({ channel: slackChannel, text: ackText });
    ackTs = ack.ts;
  } catch (error) {
    console.error('replay: Slack ACK failed', error.message);
    return err(500, `Slack ACK failed: ${error.message}`, req.correlationId);
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    process.env.SQS_WORKFLOW_URL,
      MessageBody: JSON.stringify({
        type:     'REPLAY',
        traceId,
        ...(sourceRunId !== undefined && { sourceRunId }),
        breakPolicy,
        callback: { provider: 'slack', channel: slackChannel, threadId: ackTs },
        enqueuedAt: new Date().toISOString(),
      }),
    }));
  } catch (error) {
    console.error('replay: SQS enqueue failed', error.message);
    return err(500, `SQS enqueue failed: ${error.message}`, req.correlationId);
  }

  return { statusCode: 200, body: '' };
}
