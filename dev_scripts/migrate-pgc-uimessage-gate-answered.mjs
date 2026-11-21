// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-pgc-uimessage-gate-answered.mjs
//
// Migration: Sprint 18 decision W — the inbox keeps GATE_ANSWERED. Brings a PGC database
// bootstrapped before the change up to its template: PGC_UiMessage's chk_uimessage_type, read
// from PGC_UiMessage.json, never typed here. A database bootstrapped after it needs nothing.
//
// Through SERV's modifyConstraint, which replaces the CHECK and keeps the PGC_Schema registry in
// step; then the registry row is checked against the database (upsert-schema-registry.mjs
// --check). A rerun finds nothing to do.
//
// Usage:
//   node dev_scripts/migrate-pgc-uimessage-gate-answered.mjs --check   # report only, writes nothing
//   node dev_scripts/migrate-pgc-uimessage-gate-answered.mjs

import { spawnSync }     from 'child_process';
import { fileURLToPath } from 'url';
import { servPost }      from '../src/shared/serv-client.mjs';
import PGC_UiMessage     from '../src/serv/templates/pgc/PGC_UiMessage.json' with { type: 'json' };

if (!process.env.SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}
const CHECK = process.argv.includes('--check');
const NAME  = 'chk_uimessage_type';

const wanted = PGC_UiMessage.constraints.find(c => c.name === NAME);
if (!wanted?.expression.includes("'GATE_ANSWERED'")) {
  console.error(`ERROR: the template's ${NAME} does not allow GATE_ANSWERED — nothing to migrate to`);
  process.exit(1);
}

const live = (await servPost('/api/v1/serv/table/runSql', { target: 'pgc', selectSql:
  `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = '${NAME}'` })).rows?.[0]?.def ?? '';

if (live.includes("'GATE_ANSWERED'")) {
  console.log(`${NAME}: already allows GATE_ANSWERED — no changes`);
} else if (CHECK) {
  console.log(`${NAME}: would be replaced\n  live:     ${live || '(none)'}\n  template: ${wanted.expression}`);
} else {
  const resp = await servPost('/api/v1/serv/schema/modifyConstraint',
    { tableName: 'PGC_UiMessage', constraintName: NAME, expression: wanted.expression });
  if (!resp.success) {
    console.error(`ERROR: modifyConstraint refused: ${resp.error ?? JSON.stringify(resp)}`);
    process.exit(1);
  }
  console.log(`${NAME}: replaced — ${wanted.expression}`);
}

const registry = spawnSync('node', [fileURLToPath(new URL('./upsert-schema-registry.mjs', import.meta.url)), 'PGC_UiMessage', '--check'],
  { stdio: 'inherit' });
process.exit(registry.status ?? 1);
