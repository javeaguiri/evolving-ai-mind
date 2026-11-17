// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
//
// dev_scripts/upsert-domain-display.mjs
//
// Writes PGC_DomainHelp.display — how a domain is shown in the web app's Domains menu
// (docs/arch-web-app.md §3.1) — until Novia's domain tooling writes it.
//
//   node dev_scripts/upsert-domain-display.mjs                          the system seed's rows
//   node dev_scripts/upsert-domain-display.mjs household/domains.json   the household's domains
//   add --check to check the file against the live rows and write nothing
//
// Each entry is { domain, display }. Only an existing domain is written; every entry is checked
// first and nothing is written if any fails. A display that matches the live one by value prints
// "no changes — already current" (src/proc/workflow-display.mjs planDomainDisplays).

import { readFileSync }          from 'fs';
import { resolve }               from 'path';
import { getRows, updateRows }   from '../src/shared/serv-client.mjs';
import { planDomainDisplays }    from '../src/proc/workflow-display.mjs';

if (!process.env.SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');
const fileArg   = process.argv.slice(2).find(a => a !== '--check') ?? null;
const path      = fileArg
  ? resolve(process.cwd(), fileArg)
  : new URL('../src/serv/templates/pgc/seeds/seed_PGC_DomainHelp.json', import.meta.url);
const entries = JSON.parse(readFileSync(path, 'utf8')).map(({ domain, display }) => ({ domain, display: display ?? null }));

const liveResp = await getRows('PGC_DomainHelp', [], undefined, 1000, undefined, ['domain', 'display']);
if (liveResp.truncated) throw new Error('PGC_DomainHelp read was cut short — refusing to compare against part of it');

const { problems, writes, current } = planDomainDisplays(entries, liveResp.rows ?? []);
if (problems.length) {
  console.error(`REFUSED — nothing written. ${problems.length} problem(s):`);
  for (const m of problems) console.error(`  ${m}`);
  process.exit(1);
}
for (const domain of current) console.log(`${domain}: no changes — already current`);
if (checkOnly) {
  console.log(`OK — ${entries.length} domain(s) pass; ${writes.length} would be written. Nothing written (--check).`);
  process.exit(0);
}
for (const { domain, display } of writes) {
  await updateRows('PGC_DomainHelp', [{ column: 'domain', op: 'eq', value: domain }], { display });
  console.log(`${domain}: wrote display ${JSON.stringify(display)}`);
}
