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
// Corrected 2026-09-16, after the check itself misreported twice. Run 815: a similarity
// search's own vectorSearch.limit was reported as SERV's default, so a top-5 search that
// found 5 rows failed as cut. And a read that matched exactly its limit was reported as
// truncated with "100 match" beside "read 100" — /help's intent-map read stood at 99.
// `truncated` now means the count found more, and the vector path is counted too.
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

  it('fails a read cut by SERV\'s ceiling, which the step asked past but did not choose', () => {
    const msg = describeSilentTruncation(
      { count: 1000, limit: 1000, limit_applied: 'ceiling', truncated: true, total_matching: 1400 },
      '5', 'PGD_Expenses',
    );
    assert.ok(msg, 'a larger limit than SERV will return is not a bound the step chose');
    assert.match(msg, /at most 1000 rows/);
    assert.match(msg, /1400 match/);
    assert.doesNotMatch(msg, /declares no limit/, 'the step did declare one');
  });

  it('says nothing when a similarity search found the nearest N it asked for (run 815)', () => {
    // SERV attributes vectorSearch.limit to the caller; see resolveReadLimit.
    assert.equal(describeSilentTruncation(
      { count: 5, limit: 5, limit_applied: 'caller', truncated: true, total_matching: 12 }, undefined, 'PGD_InventoryAlias',
    ), null);
  });

  it('names an iterator item_step without inventing a key for it', () => {
    const msg = describeSilentTruncation(
      { count: 100, limit: 100, limit_applied: 'default', truncated: true, total_matching: 140 },
      undefined, 'PGD_InventoryAlias',
    );
    assert.match(msg, /^serv_query item_step read 100 rows/);
    assert.doesNotMatch(msg, /undefined/);
  });

  it('names both remedies for a default-bounded read, since a similarity search has its own limit', () => {
    const msg = describeSilentTruncation(
      { count: 100, limit: 100, limit_applied: 'default', truncated: true, total_matching: 101 }, '2', 'T',
    );
    assert.match(msg, /input\.limit \(or vectorSearch\.limit on a similarity search\)/);
  });

  it('tolerates a response shape it does not recognise rather than throwing on it', () => {
    assert.equal(describeSilentTruncation(undefined, '1', 'T'), null);
    assert.equal(describeSilentTruncation({}, '1', 'T'), null);
  });
});

describe('the two ends of the contract stay wired together', () => {

  it('SERV reports which side chose the limit, from the shared attribution', () => {
    assert.match(tableSrc, /const \{ limit: effectiveLimit, chosenBy: limitApplied \} = resolveReadLimit\(req\.body\);/,
      'PROC can only tell a chosen bound from an inherited one if SERV says which it was');
    assert.match(tableSrc, /limit_applied:\s*limitApplied/);
    assert.doesNotMatch(tableSrc, /req\.body\.limit === undefined/,
      'a second attribution rule beside resolveReadLimit is how vectorSearch.limit was misread');
  });

  it('both read paths apply the one resolved limit', () => {
    assert.equal((tableSrc.match(/LIMIT \$\{effectiveLimit\}/g) ?? []).length, 2,
      'the vector and standard SELECTs must both be bounded by the attributed limit');
  });

  it('SERV counts on the boundary, and truncated means the count found more', () => {
    assert.match(tableSrc, /if \(result\.rows\.length === effectiveLimit\) \{/);
    assert.match(tableSrc, /SELECT COUNT\(\*\)::int AS total FROM "\$\{tableName\}" \$\{matchWhere\}`, matchValues/,
      'the count must ask the question the read asked — including the similarity threshold');
    assert.match(tableSrc, /const truncated = totalMatching > result\.rows\.length;/,
      'a read that matched exactly its limit is complete, not cut');
    assert.doesNotMatch(tableSrc, /truncated && !vectorSearch/,
      'an uncounted vector read left the failure message asserting rows nobody had counted');
  });

  it('the vector path records the same WHERE and values it queried with', () => {
    assert.match(tableSrc, /matchWhere\s*=\s*combinedWhere;\s*\n\s*matchValues = \[\.\.\.filterVals, JSON\.stringify\(queryVec\), threshold\];\s*\n\s*result = await dbClient\.query\(sql, matchValues\);/);
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
