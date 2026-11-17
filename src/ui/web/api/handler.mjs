// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/api/handler.mjs
// Lambda entry point for WebApiFunction — the web's experience layer, HTTP only.
// Owns: /api/v1/ui/web/{proxy+}
//
// API Gateway's Cognito authorizer has already verified the access token (docs/arch-web-app.md
// §1); the user is its `sub`, never a request field. Each allowed route (routes.mjs) calls its
// PROC route as that principal and returns PROC's body unchanged, except /me, joined with
// Cognito, and /inbox, whose WORKFLOW_ERRORs are summarised. Errors are WebError bodies.

import { randomUUID }           from 'node:crypto';
import { respond }              from '../../../shared/lambda-utils.mjs';
import { matchRoute, pickQuery } from './routes.mjs';
import { callProc, WebError }   from './proc-client.mjs';
import { readMe }               from './me.mjs';
import { summariseInbox }       from './inbox.mjs';

const header = (event, name) => {
  const key = Object.keys(event.headers ?? {}).find(k => k.toLowerCase() === name);
  return key ? event.headers[key] : undefined;
};

/**
 * The request's JSON body, or invalid_body.
 */
function readBody(event) {
  const text = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body;
  try {
    const body = JSON.parse(text ?? '');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* falls through */ }
  throw new WebError(400, 'invalid_body');
}

async function serve(event, correlationId) {
  const matched = matchRoute(event.httpMethod, event.pathParameters?.proxy);
  if (!matched) throw new WebError(404, 'route_not_found');
  const { route, procPath } = matched;
  const sub = event.requestContext?.authorizer?.claims?.sub;

  if (route.operationId === 'webGetMe') {
    const accessToken = String(header(event, 'authorization') ?? '').replace(/^Bearer\s+/i, '');
    return { status: 200, body: await readMe({ sub, accessToken, correlationId }) };
  }

  const { status, body } = await callProc({
    method: route.method,
    procPath,
    query:  pickQuery(route, event.queryStringParameters),
    ...(route.body ? { body: readBody(event) } : {}),
    sub,
    correlationId,
  });
  return { status, body: route.operationId === 'webReadInbox' ? summariseInbox(body) : body };
}

export async function handler(event) {
  const correlationId = header(event, 'x-correlation-id') ?? randomUUID();
  try {
    const { status, body } = await serve(event, correlationId);
    return respond(status, body, correlationId);
  } catch (e) {
    if (!(e instanceof WebError)) throw e;
    return respond(e.status, e.toBody(), correlationId);
  }
}
