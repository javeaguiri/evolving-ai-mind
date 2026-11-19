// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-pgc-session-last-active.mjs
//
// Migration: Sprint 18 item 2 (decision U) — brings a PGC database bootstrapped before the change
// up to its templates. A database bootstrapped after it already has this shape, from
// PGC_Session.json / PGC_SessionEntry.json and seed_PGC_Schema.json, and needs nothing.
//
// Everything goes through SERV, so the PGC_Schema registry moves with each DDL change and the
// script needs only SERV_API_URL and INTERNAL_API_KEY — never a database connection. Every
// request is built from the templates, never typed here. Needs a SERV with addTrigger.
//
//   1. Column    addColumn PGC_Session.last_active_at. Its default gives every existing session
//                the time of the migration until the backfill.
//   2. Trigger   addTrigger trg_pgc_sessionentry_last_active on PGC_SessionEntry, which installs
//                touch_session_last_active() first. From here each new entry keeps the column.
//   3. Backfill  last_active_at ← the session's latest entry's created_at, else its own
//                created_at, for each session where it differs. After the trigger, so no entry
//                written in between is missed.
//
// Then the trigger is read back from the catalogue — the registry check does not compare
// triggers — and the registry rows are written from the seed (upsert-schema-registry.mjs, --check
// when this script has it), which refuses any table the database disagrees with. A rerun finds
// nothing to do.
//
// Usage — an instance bootstrapped before Sprint 18 item 2, after the deploy that adds addTrigger:
//   node dev_scripts/migrate-pgc-session-last-active.mjs --check   # report only, writes nothing
//   node dev_scripts/migrate-pgc-session-last-active.mjs

import { spawnSync }             from 'child_process';
import { fileURLToPath }         from 'url';
import { servPost, updateRows }  from '../src/shared/serv-client.mjs';
import PGC_Session               from '../src/serv/templates/pgc/PGC_Session.json'      with { type: 'json' };
import PGC_SessionEntry          from '../src/serv/templates/pgc/PGC_SessionEntry.json' with { type: 'json' };

if (!process.env.SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}
const CHECK = process.argv.includes('--check');

const COLUMN  = PGC_Session.columns.find(c => c.name === 'last_active_at');
const TRIGGER = PGC_SessionEntry.triggers.find(t => t.name === 'trg_pgc_sessionentry_last_active');
if (!COLUMN || !TRIGGER) {
  console.error('ERROR: the templates carry no last_active_at column or trigger — nothing to migrate to');
  process.exit(1);
}

const select = async sql => (await servPost('/api/v1/serv/table/runSql', { target: 'pgc', selectSql: sql })).rows;

const hasColumn = async () => (await select(
  `SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'PGC_Session' AND column_name = '${COLUMN.name}'`)).length > 0;

const hasTrigger = async () => (await select(
  `SELECT 1 FROM information_schema.triggers
    WHERE event_object_schema = 'public' AND event_object_table = 'PGC_SessionEntry'
      AND trigger_name = '${TRIGGER.name}'`)).length > 0;

// ── 1. Column ───────────────────────────────────────────────────────────────
const column = `PGC_Session.${COLUMN.name}`;
if (await hasColumn())  console.log(`  ${column}  already exists`);
else if (CHECK)         console.log(`  ${column}  would add`);
else {
  const r = await servPost('/api/v1/serv/schema/addColumn', { tableName: 'PGC_Session', column: COLUMN });
  console.log(`  ${column}  ${r.action}`);
}

// ── 2. Trigger ──────────────────────────────────────────────────────────────
const trigger = `PGC_SessionEntry.${TRIGGER.name}`;
if (await hasTrigger()) console.log(`  ${trigger}  already exists`);
else if (CHECK)         console.log(`  ${trigger}  would add`);
else {
  const r = await servPost('/api/v1/serv/schema/addTrigger', { tableName: 'PGC_SessionEntry', trigger: TRIGGER });
  console.log(`  ${trigger}  ${r.action}`);
}

// ── 3. Backfill ─────────────────────────────────────────────────────────────
if (!(await hasColumn())) {
  console.log(`  ${column}  would fill once the column exists`);
} else {
  // As text: a JS Date keeps milliseconds, and the column holds microseconds.
  const sessions = await select(`
    SELECT s.id, coalesce(e.latest, s.created_at)::text AS last_active_at
      FROM "PGC_Session" s
      LEFT JOIN (SELECT session_id, max(created_at) AS latest FROM "PGC_SessionEntry" GROUP BY session_id) e
        ON e.session_id = s.id
     WHERE s.last_active_at IS DISTINCT FROM coalesce(e.latest, s.created_at)`);
  console.log(`  ${column}  ${sessions.length} to fill`);
  if (!CHECK) {
    for (const s of sessions) {
      await updateRows('PGC_Session', [{ column: 'id', op: 'eq', value: s.id }], { last_active_at: s.last_active_at });
    }
  }
}

// ── Read back ───────────────────────────────────────────────────────────────
let failed = false;
if (!CHECK) {
  const ok = await hasColumn() && await hasTrigger();
  console.log(`\n  column and trigger ${ok ? 'live' : 'MISSING'}`);
  failed = !ok;
}

// ── The registry, from the seed ─────────────────────────────────────────────
console.log('\nRegistry:');
const registry = fileURLToPath(new URL('./upsert-schema-registry.mjs', import.meta.url));
const result   = spawnSync(process.execPath, [registry, ...(CHECK ? ['--check'] : [])], { stdio: 'inherit' });
if (!CHECK && result.status !== 0) {
  console.error('ERROR: the registry and the database disagree');
  failed = true;
}
if (failed) process.exit(1);
