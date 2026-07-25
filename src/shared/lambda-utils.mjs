// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/lambda-utils.mjs
// Shared utilities for all Lambda handlers.
// Parses incoming events (API Gateway or SQS) into a normalised req shape,
// and formats HTTP responses consistently across all layers.

import { randomUUID } from 'crypto';

/**
 * Parse an API Gateway v1 proxy event into a normalised req shape.
 * All HTTP handlers call this first — it is the single place that
 * knows about API Gateway's event structure.
 *
 * @param {object} event  API Gateway v1 proxy event
 * @returns {object}      Normalised req
 */
export function parseEvent(event) {
  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      // Slack sends application/x-www-form-urlencoded for slash commands
      body = Object.fromEntries(new URLSearchParams(event.body));
    }
  }

  return {
    method:        event.httpMethod || 'POST',
    path:          event.path || '/',
    // Full {proxy+} capture — used by routes with path params or sub-actions (e.g.
    // /replay/{runId}/resume) that the last-segment `route` model below cannot express.
    proxy:         event.pathParameters?.proxy || '',
    // Last path segment — used for sub-route switching inside a layer handler
    route:         (event.pathParameters?.proxy || '').split('/').filter(Boolean).pop() || '',
    headers:       event.headers || {},
    body,
    source:        'http',
    correlationId: event.headers?.['x-correlation-id']
                || event.headers?.['X-Correlation-Id']
                || randomUUID(),
  };
}

/**
 * Build a normalised req from an SQS WorkflowQueue message body.
 * Produces the same shape as parseEvent() so PROC endpoint modules
 * are called identically regardless of transport.
 *
 * SQS message envelope:
 *   { type, traceId, callback: { provider, channel, threadId }, ...payload }
 *
 * type is mapped to route by lowercasing and replacing underscores with hyphens:
 *   CREATE_DOMAIN → create-domain
 *   PING_SQS      → ping-sqs
 *
 * @param {object} message  Parsed SQS message body
 * @returns {object}        Normalised req
 */
export function buildReqFromSqs(message) {
  const { type, traceId, callback, ...rest } = message;

  return {
    method:        'POST',
    path:          `/api/v1/proc/${typeToRoute(type)}`,
    route:         typeToRoute(type),
    headers:       {},
    body:          rest,
    source:        'sqs',
    callback:      callback ?? null,
    traceId:       traceId  ?? randomUUID(),
    correlationId: traceId  ?? randomUUID(),
  };
}

/**
 * Build a standard Lambda / API Gateway response.
 * All HTTP handlers return the result of this function.
 */
export function respond(statusCode, data, correlationId) {
  return {
    statusCode,
    headers: {
      'Content-Type':     'application/json',
      'x-correlation-id': correlationId || randomUUID(),
    },
    body: JSON.stringify(data),
  };
}

/**
 * Convenience wrapper — always 200.
 */
export function ok(data, correlationId) {
  return respond(200, data, correlationId);
}

/**
 * Convenience wrapper — 4xx / 5xx errors.
 */
export function err(statusCode, message, correlationId) {
  return respond(statusCode, { success: false, error: message }, correlationId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map an SQS message type to a PROC route name.
 * CREATE_DOMAIN → create-domain
 */
function typeToRoute(type = '') {
  return type.toLowerCase().replace(/_/g, '-');
}
