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

import { DISPATCHABLE_TOOLS } from '../../src/proc/minds-eye.mjs';

const executorSrc = readFileSync('src/proc/step-executor.mjs', 'utf8');
const clientSrc   = readFileSync('src/shared/serv-client.mjs', 'utf8');
const stepTypes   = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_StepType.json', 'utf8'));

const servQuery = stepTypes.find(r => r.step_type === 'serv_query');

describe('executeServQuery — vectorSearch reaches SERV', () => {
  it('destructures vectorSearch from the resolved input', () => {
    assert.match(
      executorSrc,
      /const \{ tableName, filters, orderBy, limit, vectorSearch, columns \} = resolvedInput;/,
      'executeServQuery must destructure vectorSearch — dropping it loses the ranking silently'
    );
  });

  it('passes vectorSearch to getRows in the 5th position', () => {
    assert.match(
      executorSrc,
      /getRows\(tableName, filters \?\? \[\], orderBy, limit, vectorSearch, columns\)/,
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

// ---------------------------------------------------------------------------
// The same drop, one argument further along — input.columns
//
// getRows has always accepted a column whitelist; executeServQuery destructured
// only five fields and never forwarded it, so no workflow could project columns.
// That is invisible until a table carries a vector column: an embedding is 2560
// numbers per row, and a step that reads whole rows and hands them to a later
// llm_call pays for every one of them, on every run, growing with the table.
// A projection is standard SQL, so the harness accepts it rather than the prompts
// working around it.
// ---------------------------------------------------------------------------

describe('serv_query — columns reaches SERV', () => {
  it('passes columns to getRows in the 6th position', () => {
    assert.match(
      executorSrc,
      /getRows\(tableName, filters \?\? \[\], orderBy, limit, vectorSearch, columns\)/,
      'the 6th positional argument of getRows is columns'
    );
  });

  it('declares input.columns as an optional array', () => {
    const field = servQuery.input_contract.find(f => f.field === 'input.columns');
    assert.ok(field, 'a capability the contract does not declare is invisible to the generator');
    assert.equal(field.type, 'array');
    assert.equal(field.required, false, 'making it required would fail every existing serv_query step');
  });

  it('tells the author WHY to use it, not merely that it exists', () => {
    // "Omit to return every column" alone reads as a micro-optimisation. The cost is
    // the point: this is the difference between a receipt costing the same forever and
    // costing more every time the pantry grows.
    const field = servQuery.input_contract.find(f => f.field === 'input.columns');
    assert.match(field.description, /embedding/i);
    assert.match(field.description, /llm_call/);
  });

  it('still leaves the required set exactly as it was', () => {
    const required = servQuery.input_contract.filter(f => f.required).map(f => f.field).sort();
    assert.deepEqual(required, ['input.tableName', 'output_key']);
  });
});

// ---------------------------------------------------------------------------
// Novia's own query_table tool — the same pass-through, one layer up
//
// serv_query lets her BUILD a workflow that matches semantically. query_table lets
// her CHECK what a threshold actually does before committing one to a workflow.
// Both call getRows positionally, so both drop vectorSearch the same silent way if
// the argument is omitted.
// ---------------------------------------------------------------------------

const mindsEyeSrc = readFileSync('src/proc/minds-eye.mjs', 'utf8');
const contextRows = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json', 'utf8'));

const toolSchemas = contextRows.find(r => (r.key ?? r.context_key) === 'minds_eye_tool_schemas');
const queryTable  = toolSchemas.content.tools.find(t => t.name === 'query_table');

describe('query_table — vectorSearch reaches SERV', () => {
  it('destructures vectorSearch and passes it as the 5th getRows argument', () => {
    assert.match(
      mindsEyeSrc,
      /const \{ tableName, filters = \[\], orderBy, limit, vectorSearch \} = params;/,
      'the query_table dispatch must take vectorSearch'
    );
    assert.match(
      mindsEyeSrc,
      /getRows\(tableName, filters, orderBy, limit \?\? 20, vectorSearch\)/,
      'and hand it to getRows in the vectorSearch position'
    );
  });

  it('declares vectorSearch in the tool schema — an undeclared parameter is unusable', () => {
    // The loop can dispatch it, but the gateway enforces the schema: a parameter the
    // schema omits cannot be sent, so code and schema have to move together.
    assert.ok(queryTable.parameters.properties.vectorSearch, 'query_table must declare vectorSearch');
    assert.equal(queryTable.parameters.properties.vectorSearch.type, 'object');
  });

  it('leaves the required set alone', () => {
    assert.deepEqual([...queryTable.parameters.required].sort(), ['reasoning', 'tableName']);
  });

  it('tells her the score comes back, since that is what makes calibration possible', () => {
    assert.match(queryTable.parameters.properties.vectorSearch.description, /similarity score/);
  });

  it('still describes exactly the dispatchable tools, no more and no fewer', () => {
    // selectToolDefinitions drops any tool the loop cannot dispatch and warns about any
    // dispatchable tool with no schema. Editing this row is where that drift starts.
    // Asserted against the live set rather than a literal: a count goes stale every time a
    // tool is added, and a stale count fails for a reason that has nothing to do with vectorSearch.
    assert.equal(toolSchemas.content.tools.length, DISPATCHABLE_TOOLS.size);
  });
});
