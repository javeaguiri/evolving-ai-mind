// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/pgc-schema-registry.test.mjs
//
// Every PGC table is defined twice: its template (src/serv/templates/pgc/PGC_*.json), which
// creates the table, and its seed_PGC_Schema.json row, which SERV reads as the registry. The
// two drifted for a year — columns, checks and a pre-migration type — because nothing compared
// them. This does. The live database is the third copy; dev_scripts/upsert-schema-registry.mjs
// checks against it before writing a registry row.

import { describe, it }              from 'node:test';
import assert                        from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir       = new URL('../../src/serv/templates/pgc/', import.meta.url);
const templates = readdirSync(dir)
  .filter(f => /^PGC_.*\.json$/.test(f))
  .map(f => JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
const registry  = JSON.parse(readFileSync(new URL('seeds/seed_PGC_Schema.json', dir), 'utf8'));

describe('PGC templates and the seed registry describe the same tables', () => {
  it('every template has a registry row', () => {
    const missing = templates.map(t => t.table_name).filter(n => !registry.some(r => r.table_name === n));
    assert.deepEqual(missing, []);
  });

  for (const template of templates) {
    const row = registry.find(r => r.table_name === template.table_name);
    if (!row) continue;
    for (const field of ['columns', 'constraints', 'foreign_keys', 'triggers']) {
      it(`${template.table_name} — ${field}`, () => {
        assert.deepEqual(row[field] ?? [], template[field] ?? []);
      });
    }
  }
});
