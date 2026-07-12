// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/migrate-pgc-session-turn-ceiling.mjs
//
// Migration: add a hard ceiling on PGC_Session.minds_eye_turn_count.
//
// Problem: minds_eye_turn_count was being reset to 0 on every continue/followup
// gate resumption, so it never actually reflected a session's true lifetime
// turn total. Now that it's a genuine never-reset cumulative tally (checked in
// minds-eye.mjs against PGC_SystemContext.minds_eye_preferences.max_lifetime_turns,
// default 100), this migration adds a DB-level CHECK constraint as a
// defense-in-depth backstop — even if the application-level check has a bug,
// the database itself refuses to let the value exceed 100.
//
// Usage:
//   PGC_DATABASE_URL=<url> node dev_scripts/migrate-pgc-session-turn-ceiling.mjs

import pg from 'pg';

const { Client } = pg;

const PGC_DATABASE_URL = process.env.PGC_DATABASE_URL;
if (!PGC_DATABASE_URL) {
  console.error('ERROR: PGC_DATABASE_URL env var not set');
  process.exit(1);
}

const client = new Client({
  connectionString: PGC_DATABASE_URL,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  console.log('Connected to PGC database.\n');

  const check = await client.query(`
    SELECT conname FROM pg_constraint WHERE conname = 'chk_pgc_session_turn_ceiling'
  `);

  if (check.rows.length > 0) {
    console.log('chk_pgc_session_turn_ceiling already exists — nothing to do.');
    process.exit(0);
  }

  console.log('Adding chk_pgc_session_turn_ceiling check constraint...');
  await client.query(`
    ALTER TABLE "PGC_Session"
    ADD CONSTRAINT chk_pgc_session_turn_ceiling
    CHECK (minds_eye_turn_count IS NULL OR minds_eye_turn_count <= 100)
  `);
  console.log('✅ Constraint added.');

  const verify = await client.query(`
    SELECT COUNT(*) AS total,
           MAX(minds_eye_turn_count) AS max_turn_count
    FROM "PGC_Session"
  `);
  const v = verify.rows[0];
  console.log(`\nVerification: total=${v.total}  max_turn_count=${v.max_turn_count ?? '(none)'}`);
  console.log('✅ Migration complete.');

} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
} finally {
  await client.end();
}
