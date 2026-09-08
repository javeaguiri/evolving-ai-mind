// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/serv-query-truncation.test.mjs
//
// getRows has defaulted to limit 100 since it was written, and reported `count` as the
// number of rows RETURNED — which reads exactly like a total. A serv_query step that
// stated no limit therefore read the first 100 rows of any table and nothing anywhere
// said so: not the response, not the step output, not the gate downstream.
//
// Measured 2026-09-08 against live rows: 23 serv_query steps across the registered
// workflows declare no input.limit. None exceeds the default TODAY once its own filters
// are applied — the closest are help over PGC_IntentMap (91 of a 96-row table) and
// budget_vs_expense_report over PGD_Expenses (92). Both cross 100 with ordinary use, and
// on the day they did the result would have been quietly short rather than wrong-looking.
//
// A bounded view must carry its own provenance (architecture.md §1.5). local_state holds
// a plain array and cannot carry it, so the bound is surfaced by failing the step.
//
// Running: node --test tests/unit/serv-query-truncation.test.mjs

import { readFileSync }  from 'node:fs';
import { describe, it }  from 'node:test';
import assert            from 'node:assert/strict';

import { describeSilentTruncation } from '../../src/proc/step-executor.mjs';

const tableSrc    = readFileSync('src/serv/table.mjs', 'utf8');
const executorSrc = readFileSync('src/proc/step-executor.mjs', 'utf8');

describe('describeSilentTruncation — only the bound nobody asked for is a failure', () => {

  it('fails a read cut by the default limit, naming the total that matched', () => {
    const msg = describeSilentTruncation(
      { count: 100, limit: 100, limit_applied: 'default', truncated: true, total_matching: 132 },
      '2', 'PGD_Inventory',
    );

    assert.ok(msg, 'a silently cut read must fail the step');
    assert.match(msg, /read 100 rows/);
    assert.match(msg, /132 match/);
    assert.match(msg, /input\.limit/, 'the message must name the fix, not just the fault');
  });

  it('says nothing when the step chose the limit itself', () => {
    // "Give me the top 10" that returns 10 is the step getting what it asked for.
    assert.equal(describeSilentTruncation(
      { count: 10, limit: 10, limit_applied: 'caller', truncated: true }, '2', 'PGD_Inventory',
    ), null);
  });

  it('says nothing when the read was complete', () => {
    assert.equal(describeSilentTruncation(
      { count: 31, limit: 100, limit_applied: 'default' }, '1', 'PGC_Schema',
    ), null);
  });

  it('still reports when SERV could not supply an exact total', () => {
    const msg = describeSilentTruncation(
      { count: 100, limit: 100, limit_applied: 'default', truncated: true }, '2', 'PGD_Inventory',
    );
    assert.match(msg, /more match/, 'an unknown total must not silence the finding');
  });

  it('tolerates a response shape it does not recognise rather than throwing on it', () => {
    assert.equal(describeSilentTruncation(undefined, '1', 'T'), null);
    assert.equal(describeSilentTruncation({}, '1', 'T'), null);
  });
});

describe('the two ends of the contract stay wired together', () => {

  it('SERV reports which side chose the limit', () => {
    assert.match(tableSrc, /limitApplied\s*=\s*req\.body\.limit === undefined \? 'default' : 'caller'/,
      'PROC can only tell a chosen bound from an inherited one if SERV says which it was');
    assert.match(tableSrc, /limit_applied:\s*limitApplied/);
  });

  it('SERV counts what it withheld, on the boundary case only', () => {
    assert.match(tableSrc, /const truncated = result\.rows\.length === effectiveLimit;/);
    assert.match(tableSrc, /SELECT COUNT\(\*\)::int AS total FROM/,
      'the total is what makes the report actionable rather than merely alarming');
  });

  it('the count runs before the connection is closed', () => {
    const countAt = tableSrc.indexOf('SELECT COUNT(*)::int AS total FROM');
    const closeAt = tableSrc.indexOf("if (target === 'pgd') await dbClient.end();");
    assert.ok(countAt > -1 && closeAt > -1);
    assert.ok(countAt < closeAt, 'counting after the client is ended throws on every truncated PGD read');
  });

  it('executeServQuery acts on the finding rather than logging it', () => {
    assert.match(executorSrc, /const cut = describeSilentTruncation\(resp, step\.step, tableName\);\s*\n\s*if \(cut\) throw new Error\(cut\);/,
      'a warning nobody reads is the silence this replaces');
  });
});
