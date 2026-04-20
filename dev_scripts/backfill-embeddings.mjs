// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/backfill-embeddings.mjs
//
// Backfill: re-embeds ALL PGC_DomainHelp rows unconditionally.
// Run any time embeddings need to be recomputed — after model changes,
// normalisation fixes, or new domains added outside the normal workflow.
//
// Run after:
//   1. pgvector extension enabled on RDS
//   2. embedding column added via addColumn endpoint
//   3. SAM deploy with updated embed-client.mjs + table.mjs
//
// Usage:
//   set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/backfill-embeddings.mjs
//
// The updateRows call includes `description` in the update payload — this ensures
// at least one embed_source field is present, triggering SERV's read-before-write
// embedding logic without actually changing the row's data.

const SERV_API_URL = process.env.SERV_API_URL;
if (!SERV_API_URL) {
  console.error('SERV_API_URL env var is required');
  process.exit(1);
}

async function servPost(path, body) {
  const resp = await fetch(`${SERV_API_URL}/api/v1${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SERV ${path} returned ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function main() {
  console.info('backfill-embeddings: reading all PGC_DomainHelp rows...');

  const listResp = await servPost('/serv/table/getRows', {
    tableName: 'PGC_DomainHelp',
    limit:     1000,
  });

  const rows = listResp.rows ?? [];
  console.info(`backfill-embeddings: found ${rows.length} row(s) to embed`);

  if (rows.length === 0) {
    console.info('backfill-embeddings: nothing to do');
    return;
  }

  let success = 0;
  let failed  = 0;

  for (const row of rows) {
    try {
      // Pass description in updates — this is an embed_source field, triggering
      // SERV's read-before-write merge + embedding computation for this row.
      // The description value is unchanged; only the embedding column is written.
      await servPost('/serv/table/updateRows', {
        tableName: 'PGC_DomainHelp',
        filters:   [{ column: 'domain', op: 'eq', value: row.domain }],
        updates:   { description: row.description ?? '' },
      });
      console.info(`backfill-embeddings: embedded domain "${row.domain}"`);
      success++;
    } catch (e) {
      console.error(`backfill-embeddings: FAILED for domain "${row.domain}"`, e.message);
      failed++;
    }
  }

  console.info(`backfill-embeddings: complete — ${success} succeeded, ${failed} failed`);
}

main().catch(e => {
  console.error('backfill-embeddings: fatal error', e.message);
  process.exit(1);
});
