// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/handler.mjs
// Lambda entry point for the SERV (Service) layer.
// Owns: /api/v1/serv/{proxy+}
//
// Bootstrap is NOT called on cold start — it is an explicit install-time
// operation invoked via POST /api/v1/serv/bootstrap (see README.md).
// Running bootstrap on cold start caused concurrent-update races when
// multiple Lambda containers initialised simultaneously.
//
// Sub-route switching lives here — NOT in template.yaml.

import { parseEvent, err } from '../shared/lambda-utils.mjs';
import { handle as pingDb } from './ping-db.mjs';
import { handle as schema }   from './schema.mjs';
import { bootstrap }          from './init-brain.mjs';
import { handle as table }   from './table.mjs';
import { handle as entity } from './entity.mjs';
import { handle as sandbox, sandboxRefusal } from './sandbox.mjs';
import { inSandbox }      from './sandbox-context.mjs';

/**
 * AWS Lambda handler — called by API Gateway for every
 * /api/v1/serv/* request.
 */
export async function handler(event) {
  const req      = parseEvent(event);
  const segments = req.path.split('/').filter(Boolean);
  req.subRoute   = segments.pop();
  const parent   = segments.pop();
  req.route      = parent === 'serv' ? req.subRoute : parent;

  // A request carrying x-sandbox runs against the test sandbox (docs/arch-sandbox.md): checked
  // first, then every connection it opens has its search_path pointed there.
  const sandboxName = Object.entries(req.headers ?? {})
    .find(([name]) => name.toLowerCase() === 'x-sandbox')?.[1];
  if (sandboxName) {
    const refusal = await sandboxRefusal(req, sandboxName);
    if (refusal) return err(refusal.status, refusal.message, req.correlationId);
    return inSandbox(sandboxName, () => route(req));
  }
  return route(req);
}

function route(req) {
  switch (req.route) {
    case 'ping-db': return pingDb(req);
    case 'schema':  return schema(req);
    case 'table':   return table(req);
    case 'entity':  return entity(req);
    case 'bootstrap': return bootstrap(req);
    case 'sandbox': return sandbox(req);

    default:
      return err(404, `SERV route "${req.route}" not found`, req.correlationId);
  }
}
