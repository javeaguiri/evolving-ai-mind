// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/handler.mjs
// Lambda entry point for the SERV (Service) layer.
// Owns: /api/v1/serv/{proxy+}
//
// On every cold start, bootstrap() is called to ensure all PGC system
// tables exist. The bootstrap report is attached to req so route handlers
// and PROC can see whether a fresh environment was initialised.
//
// Sub-route switching lives here — NOT in template.yaml.

import { parseEvent, err } from '../shared/ping-utils.mjs';
import { handle as pingDb } from './ping-db.mjs';
import { handle as schema }   from './schema.mjs';
import { bootstrap }          from './init-brain.mjs';
import { handle as table }   from './table.mjs';

// Bootstrap runs once per cold start — warm containers return cached result.
let bootstrapResult = null;

async function ensureBootstrap() {
  if (bootstrapResult) return bootstrapResult;
  bootstrapResult = await bootstrap();
  return bootstrapResult;
}

/**
 * AWS Lambda handler — called by API Gateway for every
 * /api/v1/serv/* request.
 */
export async function handler(event) {
  // Run bootstrap on every cold start — idempotent, skipped on warm containers
  const boot = await ensureBootstrap();

  if (!boot.ok) {
    console.error('serv: bootstrap failed, rejecting request', boot.error);
    return err(503, `Service unavailable — PGC bootstrap failed: ${boot.error}`, 'boot-failure');
  }

  if (boot.report?.freshEnvironment) {
    console.info('serv: fresh environment — PGC tables were just created', {
      tables:         boot.report.tables,
      bootstrappedAt: boot.report.bootstrappedAt,
    });
  }

  const req      = parseEvent(event);
  const segments = req.path.split('/').filter(Boolean);
  req.subRoute   = segments.pop();
  const parent   = segments.pop();
  req.route      = parent === 'serv' ? req.subRoute : parent;  

  // Attach bootstrap report so PROC can read it from invoke responses
  req.bootstrapReport = boot.report;

  switch (req.route) {
    case 'ping-db': return pingDb(req);
    case 'schema':  return schema(req);
    case 'table':   return table(req);
    default:
      return err(404, `SERV route "${req.route}" not found`, req.correlationId);
  }
}
