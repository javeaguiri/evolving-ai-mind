// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/handler.mjs
// Lambda entry point for the SERV (Service) layer.
// Owns: /api/v1/serv/{proxy+}
//
// Sub-route switching lives here — NOT in template.yaml.

import { parseEvent, err } from '../shared/ping-utils.mjs';
import { handle as pingDb } from './ping-db.mjs';
import { handle as schema }   from './schema.mjs';
import { bootstrap }          from './init-brain.mjs';

/**
 * AWS Lambda handler — called by API Gateway for every
 * /api/v1/serv/* request.
 */
export async function handler(event) {
  await bootstrap();

  const req      = parseEvent(event);
  const segments = req.path.split('/').filter(Boolean);
  req.subRoute   = segments.pop();          // 'listTables'
  req.route      = segments.pop() || req.subRoute;  // 'schema' or 'ping-db'
  
  switch (req.route) {
    case 'ping-db': return pingDb(req);
    case 'schema':  return schema(req);
    default:
      return err(404, `SERV route "${req.route}" not found`, req.correlationId);
  }
}
