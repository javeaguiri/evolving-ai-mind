// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-pgc-session-callback.mjs
//
// Migration: Sprint 18 item 1 (decisions O, Q, S) — brings a PGC database bootstrapped before
// the change up to its templates. A database bootstrapped after it already has this shape, from
// PGC_Session.json / PGC_UiMessage.json and seed_PGC_Schema.json, and needs nothing.
//
// Everything goes through SERV, so the PGC_Schema registry moves with each DDL change and the
// script needs only SERV_API_URL and INTERNAL_API_KEY — never a database connection.
//
//   1. Columns   addColumn PGC_Session.callback (jsonb), .topic (text), .label (text) and
//                PGC_UiMessage.session_id (integer). A column already there is left alone.
//   2. Backfill  PGC_Session.callback ← { provider: 'slack', channel, threadId: slack_thread_ts }
//                for each session with a thread and no callback; channel from an inbox row on the
//                same Slack thread when one exists, else null (a Slack message carries its own
//                channel — the session's callback is only the fallback).
//                PGC_UiMessage.session_id ← payload.sessionId, for each row that has none.
//                Only unfilled rows are written; skipped once slack_thread_ts is gone.
//   3. Drop      (--drop only) dropColumn PGC_Session.slack_thread_ts. Run after the code that
//                reads callback is deployed, with the backfill rerun just before it.
//
// Then the registry rows are written from the seed (upsert-schema-registry.mjs, --check when
// this script has it), which refuses any table the database disagrees with. With --drop every
// table must pass, or the script fails; before the drop PGC_Session is refused for
// slack_thread_ts alone.
//
// Usage — an instance bootstrapped before Sprint 18:
//   node dev_scripts/migrate-pgc-session-callback.mjs --check   # report only, writes nothing
//   node dev_scripts/migrate-pgc-session-callback.mjs           # phases 1 and 2
//   (deploy)
//   node dev_scripts/migrate-pgc-session-callback.mjs --drop    # phases 1, 2 and 3

import { spawnSync }                        from 'child_process';
import { fileURLToPath }                    from 'url';
import { servPost, updateRows }             from '../src/shared/serv-client.mjs';

if (!process.env.SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}
const CHECK = process.argv.includes('--check');
const DROP  = process.argv.includes('--drop');

const NEW_COLUMNS = [
  { tableName: 'PGC_Session',   column: { name: 'callback',   type: 'jsonb',   nullable: true } },
  { tableName: 'PGC_Session',   column: { name: 'topic',      type: 'text',    nullable: true } },
  { tableName: 'PGC_Session',   column: { name: 'label',      type: 'text',    nullable: true } },
  { tableName: 'PGC_UiMessage', column: { name: 'session_id', type: 'integer', nullable: true } },
];

const select = async sql => (await servPost('/api/v1/serv/table/runSql', { target: 'pgc', selectSql: sql })).rows;

const liveColumns = async () => new Set((await select(
  `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('PGC_Session', 'PGC_UiMessage')`)).map(r => r.col));

// ── 1. Columns ──────────────────────────────────────────────────────────────
let live = await liveColumns();
for (const { tableName, column } of NEW_COLUMNS) {
  const name = `${tableName}.${column.name}`;
  if (live.has(name))  { console.log(`  ${name}  already exists`); continue; }
  if (CHECK)           { console.log(`  ${name}  would add`);      continue; }
  const r = await servPost('/api/v1/serv/schema/addColumn', { tableName, column });
  console.log(`  ${name}  ${r.action}`);
}
live = await liveColumns();

// ── 2. Backfill ─────────────────────────────────────────────────────────────
if (!live.has('PGC_Session.slack_thread_ts')) {
  console.log('  PGC_Session.callback  nothing to fill — slack_thread_ts is gone');
} else if (!live.has('PGC_Session.callback')) {
  console.log('  PGC_Session.callback  would fill once the column exists');
} else {
  const sessions = await select(`
    SELECT s.id, s.slack_thread_ts AS thread_ts, ch.channel
      FROM "PGC_Session" s
      LEFT JOIN LATERAL (
        SELECT m.channel FROM "PGC_UiMessage" m
         WHERE m.provider = 'slack' AND m.thread_id = s.slack_thread_ts AND m.channel IS NOT NULL
         LIMIT 1
      ) ch ON true
     WHERE s.slack_thread_ts IS NOT NULL AND s.callback IS NULL`);
  const withChannel = sessions.filter(s => s.channel).length;
  console.log(`  PGC_Session.callback  ${sessions.length} to fill (${withChannel} with a channel from the inbox)`);
  if (!CHECK) {
    for (const s of sessions) {
      await updateRows('PGC_Session', [{ column: 'id', op: 'eq', value: s.id }],
        { callback: { provider: 'slack', channel: s.channel ?? null, threadId: s.thread_ts } });
    }
  }
}

if (!live.has('PGC_UiMessage.session_id')) {
  console.log('  PGC_UiMessage.session_id  would fill once the column exists');
} else {
  const rows = await select(`
    SELECT id, (payload->>'sessionId')::int AS session_id FROM "PGC_UiMessage"
     WHERE session_id IS NULL AND payload ? 'sessionId' AND (payload->>'sessionId') ~ '^[0-9]+$'`);
  console.log(`  PGC_UiMessage.session_id  ${rows.length} to fill`);
  if (!CHECK) {
    const bySession = Map.groupBy(rows, r => r.session_id);
    for (const [sessionId, group] of bySession) {
      await updateRows('PGC_UiMessage', [{ column: 'id', op: 'in', value: group.map(r => r.id) }],
        { session_id: sessionId });
    }
  }
}

// ── 3. Drop ─────────────────────────────────────────────────────────────────
if (DROP) {
  if (!live.has('PGC_Session.slack_thread_ts')) console.log('  PGC_Session.slack_thread_ts  already dropped');
  else if (CHECK)                               console.log('  PGC_Session.slack_thread_ts  would drop');
  else {
    const r = await servPost('/api/v1/serv/schema/dropColumn', { tableName: 'PGC_Session', columnName: 'slack_thread_ts' });
    console.log(`  PGC_Session.slack_thread_ts  ${r.action}`);
  }
}

// ── The registry, from the seed ─────────────────────────────────────────────
console.log('\nRegistry:');
const registry = fileURLToPath(new URL('./upsert-schema-registry.mjs', import.meta.url));
const result   = spawnSync(process.execPath, [registry, ...(CHECK ? ['--check'] : [])], { stdio: 'inherit' });
if (DROP && !CHECK && result.status !== 0) {
  console.error('ERROR: the registry and the database still disagree after the drop');
  process.exit(1);
}
