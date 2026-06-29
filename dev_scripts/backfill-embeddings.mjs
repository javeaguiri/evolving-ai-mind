// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/backfill-embeddings.mjs
//
// Backfill embeddings for PGC_DomainHelp and any PGD table whose PGC_Schema
// definition has vector columns with embed_source set.
//
// Usage:
//   node dev_scripts/backfill-embeddings.mjs              # all tables
//   node dev_scripts/backfill-embeddings.mjs PGD_Expenses # one table only
//   node dev_scripts/backfill-embeddings.mjs PGC_DomainHelp
//
// How it works:
//   For each target table, every row is re-sent with its current embed_source
//   field values — this triggers SERV's read-before-write embedding logic
//   without changing any data.

const SERV_API_URL = process.env.SERV_API_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';

if (!SERV_API_URL) {
  console.error('SERV_API_URL env var is required');
  process.exit(1);
}

const targetTable = process.argv[2] ?? null;

async function servPost(path, body) {
  const resp = await fetch(`${SERV_API_URL}/api/v1${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': INTERNAL_API_KEY },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SERV ${path} returned ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Backfill PGC_DomainHelp — embed_source field is always `description`.
async function backfillDomainHelp() {
  console.info('\n[PGC_DomainHelp] reading rows...');
  const { rows = [] } = await servPost('/serv/table/getRows', { tableName: 'PGC_DomainHelp', limit: 1000 });
  console.info(`[PGC_DomainHelp] ${rows.length} row(s)`);

  let ok = 0, fail = 0;
  for (const row of rows) {
    try {
      await servPost('/serv/table/updateRows', {
        tableName: 'PGC_DomainHelp',
        filters:   [{ column: 'domain', op: 'eq', value: row.domain }],
        updates:   { description: row.description ?? '' },
      });
      console.info(`  ✓ domain "${row.domain}"`);
      ok++;
    } catch (e) {
      console.error(`  ✗ domain "${row.domain}": ${e.message}`);
      fail++;
    }
  }
  console.info(`[PGC_DomainHelp] done — ${ok} ok, ${fail} failed`);
}

// Backfill a PGD table. Discovers embed_source columns from PGC_Schema.
async function backfillPgdTable(tableName) {
  console.info(`\n[${tableName}] reading schema...`);

  const { rows: schemaRows = [] } = await servPost('/serv/table/getRows', {
    tableName: 'PGC_Schema',
    filters:   [{ column: 'table_name', op: 'eq', value: tableName }],
    limit:     1,
  });

  if (schemaRows.length === 0) {
    console.warn(`[${tableName}] not found in PGC_Schema — skipping`);
    return;
  }

  const columns = schemaRows[0].columns ?? [];
  const embedCols = columns.filter(c => c.type?.startsWith('vector') && Array.isArray(c.embed_source) && c.embed_source.length > 0);

  if (embedCols.length === 0) {
    console.info(`[${tableName}] no embed_source columns — skipping`);
    return;
  }

  const embedFields = [...new Set(embedCols.flatMap(c => c.embed_source))];
  console.info(`[${tableName}] embed columns: ${embedCols.map(c => c.name).join(', ')}`);
  console.info(`[${tableName}] embed source fields: ${embedFields.join(', ')}`);

  const { rows = [] } = await servPost('/serv/table/getRows', { tableName, limit: 5000 });
  console.info(`[${tableName}] ${rows.length} row(s) to process`);

  let ok = 0, fail = 0;
  for (const row of rows) {
    const updates = {};
    for (const field of embedFields) updates[field] = row[field] ?? '';

    try {
      await servPost('/serv/table/updateRows', {
        tableName,
        filters: [{ column: 'id', op: 'eq', value: row.id }],
        updates,
      });
      console.info(`  ✓ id=${row.id}`);
      ok++;
    } catch (e) {
      console.error(`  ✗ id=${row.id}: ${e.message}`);
      fail++;
    }
  }
  console.info(`[${tableName}] done — ${ok} ok, ${fail} failed`);
}

async function discoverPgdTablesWithEmbeddings() {
  const { rows = [] } = await servPost('/serv/table/getRows', {
    tableName: 'PGC_Schema',
    filters:   [{ column: 'target', op: 'eq', value: 'pgd' }],
    limit:     200,
  });

  return rows
    .filter(r => (r.columns ?? []).some(c => c.type?.startsWith('vector') && Array.isArray(c.embed_source) && c.embed_source.length > 0))
    .map(r => r.table_name);
}

async function main() {
  if (targetTable) {
    if (targetTable === 'PGC_DomainHelp') {
      await backfillDomainHelp();
    } else {
      await backfillPgdTable(targetTable);
    }
  } else {
    // All tables
    await backfillDomainHelp();

    console.info('\nDiscovering PGD tables with embed_source columns...');
    const pgdTables = await discoverPgdTablesWithEmbeddings();
    console.info(`Found: ${pgdTables.length > 0 ? pgdTables.join(', ') : 'none'}`);

    for (const t of pgdTables) {
      await backfillPgdTable(t);
    }
  }

  console.info('\nbackfill-embeddings: all done');
}

main().catch(e => {
  console.error('backfill-embeddings: fatal error', e.message);
  process.exit(1);
});
