// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/ping-db.mjs
// Handles GET /api/v1/serv/ping-db
//
// Validates: ServFunction Lambda + PostgreSQL connectivity (PGC + PGD).
// No LLM, SQS, or Slack calls.
// Safe to invoke directly via curl.
// If this fails → DB connection string in SSM, VPC/security group,
// or ServFunction config issue.

import { ok, err } from '../shared/ping-utils.mjs';
import pg from 'pg';

const { Client } = pg;

/**
 * Open a connection, run SELECT version(), close it.
 * Returns { reachable, version } — never throws.
 */
async function checkDb(connectionString, label) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    ssl: {
      rejectUnauthorized: false   // accepts RDS self-signed cert
    }
  });
  try {
    await client.connect();
    const result = await client.query('SELECT version()');
    await client.end();
    return { reachable: true, version: result.rows[0].version };
  } catch (error) {
    console.error(`ping-db ${label} error:`, error.message);
    return { reachable: false, error: error.message };
  }
}

/**
 * @param {ReturnType<import('../../shared/ping-utils.mjs').parseEvent>} req
 */
export async function handle(req) {
  
  console.info('ping-db', { correlationId: req.correlationId });

  const [pgc, pgd] = await Promise.all([
    checkDb(process.env.PGC_DATABASE_URL, 'PGC'),
    checkDb(process.env.PGD_DATABASE_URL, 'PGD'),
  ]);

  const allReachable = pgc.reachable && pgd.reachable;
  const statusCode   = allReachable ? 200 : 500;

  return respond(statusCode, {
    success:          allReachable,
    pgc:              pgc,
    pgd:              pgd,
    // Convenience top-level field for quick curl checks
    postgresVersion:  pgc.version || pgd.version || null,
    correlationId:    req.correlationId,
    timestamp:        new Date().toISOString(),
  }, req.correlationId);
}

// ping-db needs respond directly (not just ok/err) because statusCode varies
function respond(statusCode, data, correlationId) {
  return {
    statusCode,
    headers: {
      'Content-Type':     'application/json',
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify(data),
  };
}
