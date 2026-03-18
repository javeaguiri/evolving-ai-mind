// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/ping-llm.mjs
// Handles POST /api/v1/ui/slack/ping-llm
// Validates: Slack → SlackbotFunction → ProcFunction (HTTP fetch) → Perplexity → Slack
// If ping-api passes but this fails → PROC_API_URL env var or ProcFunction issue

import { ok, err } from '../../shared/lambda-utils.mjs';

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed', req.correlationId);
  }

  console.info('ping-llm-slack invoke', { correlationId: req.correlationId });

  let body;
  try {
    const url      = `${process.env.PROC_API_URL}/api/v1/proc/ping-llm`;
    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-correlation-id': req.correlationId,
      },
      body: JSON.stringify({
        source:        'slack',
        correlationId: req.correlationId,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ProcFunction HTTP ${response.status}: ${text}`);
    }

    body = await response.json();

  } catch (error) {
    console.error('ping-llm-slack error:', error.message);
    return err(500, `LLM ping failed: ${error.message}`, req.correlationId);
  }

  return ok({
    success:       true,
    message:       `🔮 ${body.message}`,
    model:         body.model,
    correlationId: req.correlationId,
    timestamp:     new Date().toISOString(),
  }, req.correlationId);
}
