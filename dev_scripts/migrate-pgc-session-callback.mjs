// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-pgc-session-callback.mjs
//
// Migration: Sprint 18 item 1 (docs/sprints/sprint-18.md, decisions O and Q) — data only.
// The columns are added with SERV addColumn and slack_thread_ts dropped with dropColumn, so the
// registry stays in step; this script fills the new columns from what the database already holds:
//
//   PGC_Session.callback    ← { provider: 'slack', channel, threadId: slack_thread_ts } for every
//                             session with a thread and no callback. channel is taken from an
//                             inbox row on the same Slack thread when one exists (the inbox began
//                             2026-11-15), else null — a Slack message carries its own channel,
//                             and the session's callback is only the fallback.
//   PGC_UiMessage.session_id ← payload.sessionId, for every row that carries one and has none.
//
// Idempotent: only rows still unfilled are written. Run it before the deploy and again after it,
// to catch sessions the old code created in between; then drop slack_thread_ts.
//
// Usage:
//   node dev_scripts/migrate-pgc-session-callback.mjs           # report, then write
//   node dev_scripts/migrate-pgc-session-callback.mjs --check   # report only, writes nothing

import pg from 'pg';

const { Client } = pg;

const PGC_DATABASE_URL = process.env.PGC_DATABASE_URL;
if (!PGC_DATABASE_URL) {
  console.error('ERROR: PGC_DATABASE_URL env var not set');
  process.exit(1);
}
const check = process.argv.includes('--check');

// A session's Slack channel, from any inbox row on its thread.
const SESSION_CALLBACK_FROM = `
  FROM "PGC_Session" s
  LEFT JOIN LATERAL (
    SELECT m.channel FROM "PGC_UiMessage" m
     WHERE m.provider = 'slack' AND m.thread_id = s.slack_thread_ts AND m.channel IS NOT NULL
     LIMIT 1
  ) ch ON true
  WHERE s.slack_thread_ts IS NOT NULL AND s.callback IS NULL`;

const SESSION_CALLBACK_COUNT = `
  SELECT count(*)::int AS sessions, count(ch.channel)::int AS with_channel ${SESSION_CALLBACK_FROM}`;

const SESSION_CALLBACK_UPDATE = `
  UPDATE "PGC_Session" t
     SET callback = jsonb_build_object('provider', 'slack', 'channel', f.channel, 'threadId', f.thread_ts)
    FROM (SELECT s.id, s.slack_thread_ts AS thread_ts, ch.channel ${SESSION_CALLBACK_FROM}) f
   WHERE t.id = f.id`;

const INBOX_WHERE = `
  WHERE session_id IS NULL AND payload ? 'sessionId' AND (payload->>'sessionId') ~ '^[0-9]+$'`;

const INBOX_COUNT  = `SELECT count(*)::int AS rows FROM "PGC_UiMessage" ${INBOX_WHERE}`;
const INBOX_UPDATE = `UPDATE "PGC_UiMessage" SET session_id = (payload->>'sessionId')::int ${INBOX_WHERE}`;

const client = new Client({
  connectionString: PGC_DATABASE_URL,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  const { rows: [sess] }  = await client.query(SESSION_CALLBACK_COUNT);
  const { rows: [inbox] } = await client.query(INBOX_COUNT);
  console.log(`PGC_Session:   ${sess.sessions} to fill (${sess.with_channel} with a channel from the inbox)`);
  console.log(`PGC_UiMessage: ${inbox.rows} to fill`);

  if (check) {
    console.log('--check: nothing written');
  } else if (sess.sessions === 0 && inbox.rows === 0) {
    console.log('no changes — already current');
  } else {
    await client.query('BEGIN');
    const s = await client.query(SESSION_CALLBACK_UPDATE);
    const m = await client.query(INBOX_UPDATE);
    await client.query('COMMIT');
    console.log(`written: ${s.rowCount} sessions, ${m.rowCount} inbox rows`);
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('ERROR:', error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
