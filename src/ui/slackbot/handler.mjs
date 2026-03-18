// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/slackbot/handler.mjs
// Lambda entry point for the UI / Slackbot layer.
// Owns: /api/v1/ui/slack/{proxy+}
//
// Sub-route switching lives here — NOT in template.yaml.
// Add a new case for each new Slack command.
//
// Security: ALL requests are verified against the Slack signing secret before
// any routing or business logic runs. Requests that fail verification are
// rejected with 401. Ping routes are exempt (no Slack signature on direct curl calls).

import { createHmac, timingSafeEqual } from 'crypto';
import { parseEvent, err } from '../../shared/lambda-utils.mjs';
import { handle as pingApi  } from './ping.mjs';
import { handle as pingSqs  } from './ping-sqs.mjs';
import { handle as pingLlm  } from './ping-llm.mjs';
import { handle as pingE2e  } from './ping-e2e.mjs';   
import { handle as createDomain } from './create-domain.mjs';
import { handle as interactive  } from './interactive.mjs';

// ---------------------------------------------------------------------------
// Slack signature verification
// Implements https://api.slack.com/authentication/verifying-requests-from-slack
// ---------------------------------------------------------------------------

// Routes that bypass signature verification — direct curl calls for health checks.
// These never carry a Slack signature and pose no injection risk (read-only, no SQS).
const EXEMPT_ROUTES = new Set(['ping-api', 'ping-sqs', 'ping-llm', 'ping-e2e']);

/**
 * Verify the Slack request signature.
 * Returns null on success, or an error response object on failure.
 *
 * @param {object} event  Raw API Gateway event — needs headers + raw body
 * @returns {object|null}
 */
function verifySlackSignature(event) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error('slackbot: SLACK_SIGNING_SECRET not set — rejecting request');
    return err(500, 'Server misconfiguration — signing secret not configured');
  }

  const signature = event.headers?.['x-slack-signature']
                 || event.headers?.['X-Slack-Signature'];
  const timestamp  = event.headers?.['x-slack-request-timestamp']
                  || event.headers?.['X-Slack-Request-Timestamp'];
  const rawBody    = event.body || '';

  if (!signature || !timestamp) {
    console.warn('slackbot: missing Slack signature headers');
    return err(401, 'Unauthorized — missing Slack signature headers');
  }

  // Reject requests older than 5 minutes — replay attack protection
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) {
    console.warn('slackbot: request timestamp too old', { age });
    return err(401, 'Unauthorized — request timestamp too old');
  }

  // Compute expected signature: v0=HMAC-SHA256(secret, "v0:{timestamp}:{body}")
  const sigBase   = `v0:${timestamp}:${rawBody}`;
  const expected  = 'v0=' + createHmac('sha256', signingSecret)
                              .update(sigBase, 'utf8')
                              .digest('hex');

  // timingSafeEqual prevents timing attacks — always compare same-length buffers
  const sigBuf      = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);

  if (sigBuf.length !== expectedBuf.length ||
      !timingSafeEqual(sigBuf, expectedBuf)) {
    console.warn('slackbot: invalid Slack signature');
    return err(401, 'Unauthorized — invalid Slack signature');
  }

  return null;  // verified
}

// ---------------------------------------------------------------------------
// Lambda entry point
// ---------------------------------------------------------------------------

/**
 * AWS Lambda handler — called by API Gateway for every
 * /api/v1/ui/slack/* request.
 */
export async function handler(event) {
  const req   = parseEvent(event);
  const route = req.route;

  // Verify Slack signature on all non-exempt routes
  if (!EXEMPT_ROUTES.has(route)) {
    const authError = verifySlackSignature(event);
    if (authError) return authError;
  } 
  switch (route) {
    case 'ping-api': return pingApi(req);
    case 'ping-sqs': return pingSqs(req);
    case 'ping-llm': return pingLlm(req);
    case 'ping-e2e': return pingE2e(req);
    case 'create-domain': return createDomain(req);
    case 'interactive':   return interactive(req);

    default:
      return err(404, `Slackbot route "${route}" not found`, req.correlationId);
  }
}
