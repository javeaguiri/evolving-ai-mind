// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/serv-query-vector-search.test.mjs
//
// serv_query → getRows vectorSearch pass-through contract.
//
// pgvector cosine matching was implemented at the SERV boundary (table.mjs) and exposed
// through getRows, but executeServQuery destructured only { tableName, filters, orderBy,
// limit } and dropped it. A step that asked for vectorSearch got unranked rows back and NO
// error — which is the whole reason this is a contract test rather than a behavioural one.
// Lazy name matching is entirely the ranking, so silently losing it returns wrong matches
// that look like right ones.
//
// getRows is called positionally — getRows(tableName, filters, orderBy, limit, vectorSearch,
// columns) — so a reordered signature would hand `columns` in as `vectorSearch` without any
// type error. Both ends are pinned here.
//
// Running: node --test tests/unit/serv-query-vector-search.test.mjs

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const executorSrc = readFileSync('src/proc/step-executor.mjs', 'utf8');
const clientSrc   = readFileSync('src/shared/serv-client.mjs', 'utf8');
const stepTypes   = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_StepType.json', 'utf8'));

const servQuery = stepTypes.find(r => r.step_type === 'serv_query');

describe('executeServQuery — vectorSearch reaches SERV', () => {
  it('destructures vectorSearch from the resolved input', () => {
    assert.match(
      executorSrc,
      /const \{ tableName, filters, orderBy, limit, vectorSearch \} = resolvedInput;/,
      'executeServQuery must destructure vectorSearch — dropping it loses the ranking silently'
    );
  });

  it('passes vectorSearch to getRows in the 5th position', () => {
    assert.match(
      executorSrc,
      /getRows\(tableName, filters \?\? \[\], orderBy, limit, vectorSearch\)/,
      'the 5th positional argument of getRows is vectorSearch'
    );
  });

  it('getRows still takes vectorSearch 5th — a reorder would silently pass columns instead', () => {
    assert.match(
      clientSrc,
      /export async function getRows\(tableName, filters = \[\], orderBy, limit, vectorSearch, columns\)/,
      'serv-client getRows signature changed; the positional call in step-executor must change with it'
    );
  });
});

describe('serv_query contract — vectorSearch is declared, and L0 is unaffected', () => {
  it('declares input.vectorSearch', () => {
    const field = servQuery.input_contract.find(f => f.field === 'input.vectorSearch');
    assert.ok(field, 'a capability the contract does not declare is invisible to the generator');
    assert.equal(field.type, 'object');
  });

  it('declares it OPTIONAL — L0 enforces presence of required fields only', () => {
    const field = servQuery.input_contract.find(f => f.field === 'input.vectorSearch');
    assert.equal(field.required, false, 'making it required would fail every existing serv_query step');
  });

  it('leaves the required set exactly as it was', () => {
    const required = servQuery.input_contract.filter(f => f.required).map(f => f.field).sort();
    assert.deepEqual(required, ['input.tableName', 'output_key']);
  });

  it('names threshold as calibrated per use case, not inherited', () => {
    // PGC_DomainHelp's 0.40 was calibrated against domain nouns and arch-data.md is explicit
    // that it does not carry to a different kind of text. A contract that states a default
    // without stating that would hand the next use case a number that looks authoritative.
    const field = servQuery.input_contract.find(f => f.field === 'input.vectorSearch');
    assert.match(field.description, /CALIBRATED PER USE CASE/);
  });

  it('says vectorSearch combines with filters rather than replacing them', () => {
    const field = servQuery.input_contract.find(f => f.field === 'input.vectorSearch');
    assert.match(field.description, /[Cc]ombines with filters/);
  });
});
