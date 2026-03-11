// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/ping.mjs
// Handles POST /api/v1/ui/slack/ping-api
//
// Validates: Slack slash command config + SlackbotFunction Lambda only.
// No downstream calls to PROC, SERV, SQS, LLM, or DB.
// If this fails → Slack App config or Lambda IAM issue.

import { ok, err } from '../../shared/ping-utils.mjs';

/**
 * @param {ReturnType<import('../../shared/ping-utils.mjs').parseEvent>} req
 */
export async function handle(req) {
  // Slack slash commands are POST — reject anything else
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed — ping-api expects POST', req.correlationId);
  }

  const userId  = req.body?.user_id  || 'unknown';
  const channel = req.body?.channel_id || 'unknown';

  console.info('ping-api', { correlationId: req.correlationId, userId, channel });

  return ok({
    success:       true,
    message:       `🤖 pong-api — slackbot Lambda is alive`,
    user:          userId,
    channel,
    correlationId: req.correlationId,
    timestamp:     new Date().toISOString(),
  }, req.correlationId);
}
