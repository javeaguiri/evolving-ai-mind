// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/step-output-snapshot.test.mjs
//
// PGC_WorkflowRunStep.output_snapshot was a 200-character prefix of the serialised output
// (100 for iterator items). The per-step audit record could say a step ran and never what it
// produced: step 8c of process_receipt emits 35 candidate sets and the snapshot held the first
// row and a half. That is what forced every real diagnosis into local_state, a flat bag with
// no step attribution where a derived key is indistinguishable from a recorded one.
//
// A prefix is the wrong primitive. Shape is the answer, and the record has to say what the
// bound withheld.
//
// Run: node --test tests/unit/step-output-snapshot.test.mjs

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

process.env.SERV_API_URL = 'https://example.execute-api.us-east-2.amazonaws.com/Prod';

const { summariseStepOutput } = await import('../../src/proc/run-workflow.mjs');

describe('summariseStepOutput', () => {

  it('records nothing for a step that produced nothing', () => {
    assert.equal(summariseStepOutput(undefined), null);
    assert.equal(summariseStepOutput(null), null);
  });

  it('keeps summary a bounded string, because readers select output_snapshot->>summary', () => {
    const snap = summariseStepOutput({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i })) });
    assert.equal(typeof snap.summary, 'string');
    assert.ok(snap.summary.length < 1200, 'summary stays bounded');
  });

  it('says how much the bound withheld', () => {
    const value = { rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}` })) };
    const snap  = summariseStepOutput(value);
    assert.equal(snap.chars, JSON.stringify(value).length);
    assert.ok(snap.chars > snap.summary.length, 'chars is the full size, not the stored size');
  });

  // The 8c case: 35 candidate sets, of which the old snapshot showed one and a half rows.
  it('answers how many rows an array step produced, and of what shape', () => {
    const candidateSets = Array.from({ length: 35 }, () => ([
      { id: 44, alias_name: 'BARRA DE PAN', similarity: 1 },
    ]));
    const snap = summariseStepOutput(candidateSets);
    assert.equal(snap.structure.type, 'array[35]');
    assert.equal(snap.structure.length, 35);
    assert.equal(snap.structure.item, 'array[1]');
  });

  it('names an array of rows by its columns, not by its first bytes', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i, name: 'x', similarity: 0.42 }));
    const snap = summariseStepOutput(rows);
    assert.deepEqual(snap.structure.item_keys, ['id', 'name', 'similarity']);
  });

  it('names an object step by its fields and their shapes', () => {
    const snap = summariseStepOutput({ matched: [1, 2, 3], plan: { a: 1 }, count: 3, label: 'ok' });
    assert.deepEqual(snap.structure.fields, {
      matched: 'array[3]', plan: 'object{1}', count: 'number', label: 'string(2)',
    });
  });

  it('drops the per-field detail rather than store an unbounded structure', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`a_very_long_field_name_number_${i}`, i])
    );
    const snap = summariseStepOutput(wide);
    assert.equal(snap.structure.fields, undefined);
    assert.equal(snap.structure.detail, 'omitted — too wide to record');
    assert.ok(JSON.stringify(snap).length < 3000, 'and stays bounded when it does');
  });

  it('handles a scalar output without inventing structure for it', () => {
    const snap = summariseStepOutput(42);
    assert.equal(snap.structure.type, 'number');
    assert.equal(snap.summary, '42');
  });
});
