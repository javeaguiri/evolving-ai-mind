// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/ping-utils.mjs
// Shared utilities for all Lambda handlers.
// Parses the incoming API Gateway event into a normalised payload,
// and formats responses consistently across all layers.

import { randomUUID } from 'crypto';

/**
 * Parse an API Gateway v1 proxy event into a normalised shape.
 * All handlers call this first — it is the single place that
 * knows about API Gateway's event structure.
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
    // Last path segment — used for sub-route switching inside a layer handler
    route:         (event.pathParameters?.proxy || '').split('/').filter(Boolean).pop() || '',
    headers:       event.headers || {},
    body,
    correlationId: event.headers?.['x-correlation-id']
                || event.headers?.['X-Correlation-Id']
                || randomUUID(),
  };
}

/**
 * Build a standard Lambda / API Gateway response.
 * All handlers return the result of this function.
 */
export function respond(statusCode, data, correlationId) {
  return {
    statusCode,
    headers: {
      'Content-Type':    'application/json',
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
