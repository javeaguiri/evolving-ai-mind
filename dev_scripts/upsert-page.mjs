// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
//
// dev_scripts/upsert-page.mjs
//
// Writes web app pages to PGC_Page (docs/arch-web-app.md §2.3) until the page editor exists.
//
//   node dev_scripts/upsert-page.mjs                        the system seed: the generic, empty Home
//   node dev_scripts/upsert-page.mjs household/pages.json   the household's own pages
//   add --check to check the pages against the live registry and write nothing
//
// Every page is checked against the live registry first (src/proc/page-config.mjs) and nothing is
// written if any page fails. A household page that differs from its latest version is written as
// the next version, created_by 'user'; one that matches prints "no changes — already current".
// The seed only ever creates a page that does not exist yet, so it can never overwrite the
// household's Home.

import { readFileSync }        from 'fs';
import { resolve }             from 'path';
import { getRows, insertRow }  from '../src/shared/serv-client.mjs';
import { pageProblems }        from '../src/proc/page-config.mjs';

if (!process.env.SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');
const fileArg   = process.argv.slice(2).find(a => a !== '--check') ?? null;
const createdBy = fileArg ? 'user' : 'seed';
const path      = fileArg
  ? resolve(process.cwd(), fileArg)
  : new URL('../src/serv/templates/pgc/seeds/seed_PGC_Page.json', import.meta.url);
const pages = JSON.parse(readFileSync(path, 'utf8'));

async function loadRegistry() {
  const [schemas, entities, workflows] = await Promise.all([
    getRows('PGC_Schema', [{ column: 'target', op: 'eq', value: 'pgd' }], undefined, 1000, undefined, ['table_name', 'type', 'domain', 'columns']),
    getRows('PGC_EntitySchema', [], undefined, 1000, undefined, ['entity_name', 'root_table']),
    getRows('PGC_Workflow', [{ column: 'domain', op: 'not_null' }], undefined, 1000, undefined, ['name', 'domain']),
  ]);
  for (const r of [schemas, entities, workflows]) {
    if (r.truncated) throw new Error('registry read was cut short — refusing to check pages against part of it');
  }
  return {
    sources:   new Map(schemas.rows.map(s => [s.table_name, { type: s.type === 'view' ? 'view' : 'table', columns: new Set((s.columns ?? []).map(c => c.name)) }])),
    entities:  new Map(entities.rows.map(e => [e.entity_name, e.root_table])),
    workflows: new Set(workflows.rows.map(w => w.name)),
    domains:   new Set([...workflows.rows.map(w => w.domain), ...schemas.rows.map(s => s.domain)].filter(Boolean)),
  };
}

const registry = await loadRegistry();
const problems = pages.flatMap(p => pageProblems(p, registry).map(m => `${p.page_key ?? '?'} — ${m}`));
if (problems.length) {
  console.error(`REFUSED — nothing written. ${problems.length} problem(s):`);
  for (const m of problems) console.error(`  ${m}`);
  process.exit(1);
}

if (checkOnly) {
  console.log(`OK — ${pages.length} page(s) pass against the live registry. Nothing written (--check).`);
  process.exit(0);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const page of pages) {
  const latestResp = await getRows('PGC_Page', [{ column: 'page_key', op: 'eq', value: page.page_key }],
    'version DESC', 1, undefined, ['version', 'title', 'position', 'panels']);
  const latest = latestResp.rows?.[0];

  if (latest && (createdBy === 'seed' || (same(latest.title, page.title) && latest.position === page.position && same(latest.panels, page.panels)))) {
    console.log(`${page.page_key}: no changes — already current (v${latest.version})`);
    continue;
  }
  const version = (latest?.version ?? 0) + 1;
  await insertRow('PGC_Page', {
    page_key: page.page_key, version, title: page.title, position: page.position, panels: page.panels, created_by: createdBy,
  });
  console.log(`${page.page_key}: wrote v${version} (${page.panels.length} panel(s), created_by ${createdBy})`);
}
