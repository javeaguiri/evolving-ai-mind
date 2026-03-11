// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/ping-llm.mjs
// Handles POST /api/v1/ui/slack/ping-llm
// Validates: Slack → SlackbotFunction → ProcFunction (direct invoke) → Perplexity → Slack
// If ping-api passes but this fails → Lambda invoke IAM or PROC_FUNCTION_NAME env var issue

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ok, err } from '../../shared/ping-utils.mjs';

const lambda = new LambdaClient({});

export async function handle(req) {
  if (req.method !== 'POST') {
    return err(405, 'Method not allowed', req.correlationId);
  }

  console.info('ping-llm-slack invoke', {
    correlationId: req.correlationId,
    procFunction:  process.env.PROC_FUNCTION_NAME,
  });

  let body;
  try {
    const response = await lambda.send(new InvokeCommand({
      FunctionName:   process.env.PROC_FUNCTION_NAME,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify({
        httpMethod:     'POST',
        path:           '/api/v1/proc/ping-llm',
        pathParameters: { proxy: 'ping-llm' },
        headers:        { 'x-correlation-id': req.correlationId },
        body:           JSON.stringify({
          source:        'slack',
          correlationId: req.correlationId,
        }),
      }),
    }));

    const result = JSON.parse(Buffer.from(response.Payload).toString());

    // Lambda invoke errors (function crashed) surface here, not as thrown errors
    if (result.FunctionError) {
      throw new Error(`ProcFunction error: ${result.FunctionError} — ${result.Payload}`);
    }

    body = JSON.parse(result.body);

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
