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

/**
 * AWS Lambda handler — called by API Gateway for every
 * /api/v1/serv/* request.
 */
export async function handler(event) {
  const req = parseEvent(event);

  switch (req.route) {
    case 'ping-db':
      return pingDb(req);

    // Future routes added here:
    // case 'table':  return table(req);
    // case 'entity': return entity(req);
    // case 'schema': return schema(req);

    default:
      return err(404, `SERV route "${req.route}" not found`, req.correlationId);
  }
}
