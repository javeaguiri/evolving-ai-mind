// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/expected-run-input.test.mjs
//
// expectedRunInput — the input contract PGC_Workflow does not declare.
//
// Run 762: Novia dispatched create_domain with { domain, description }. Step 1 read
// input.userInput, which was undefined, so candidate_domain became '' and eleven steps
// later the run reached a human gate asking approval for `daily_journaling` — a domain
// nobody had requested. Neither end errored: an unread key is discarded in silence and an
// unsupplied one resolves to undefined.
//
// The contract is derived from the steps rather than declared alongside them, so it cannot
// drift from what the workflow actually reads.
//
// Run: node --test tests/unit/expected-run-input.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expectedRunInput } from '../../src/proc/simulation-engine.mjs';

describe('expectedRunInput — template tokens', () => {
  it('finds {{input.key}} at the top level of a step input', () => {
    assert.deepEqual(expectedRunInput([
      { step: '1', type: 'serv_query', input: { tableName: 'PGD_X', limit: '{{input.limit}}' } },
    ]), ['limit']);
  });

  it('finds them at any depth — the L1 template-walk lesson', () => {
    // Sprint 9's D4: a walk that took only Object.values(step.input) missed a token
    // nested in input.filters[0].value. Same trap here.
    assert.deepEqual(expectedRunInput([
      { step: '1', type: 'serv_query', input: { filters: [{ column: 'id', op: 'eq', value: '{{input.recordId}}' }] } },
    ]), ['recordId']);
  });

  it('reduces a dotted or indexed path to its top-level key', () => {
    assert.deepEqual(expectedRunInput([
      { step: '1', type: 'notify', input: { message: '{{input.user.name}} and {{input.items[0].id}}' } },
    ]), ['items', 'user']);
  });

  it('ignores tokens that are not input references', () => {
    assert.deepEqual(expectedRunInput([
      { step: '1', type: 'notify', input: { message: '{{results.count}} of {{total}}' } },
    ]), []);
  });

  it('de-duplicates and sorts', () => {
    assert.deepEqual(expectedRunInput([
      { step: '1', type: 'notify', input: { a: '{{input.zebra}}', b: '{{input.alpha}}' } },
      { step: '2', type: 'notify', input: { c: '{{input.zebra}}' } },
    ]), ['alpha', 'zebra']);
  });
});

describe('expectedRunInput — js_transform bound to the whole input', () => {
  it('finds items.<key> when input_key is "input"', () => {
    // This is create_domain step 1 exactly, and it is not template syntax — a walk that
    // only understands {{...}} cannot see it.
    assert.deepEqual(expectedRunInput([
      {
        step: '1', type: 'js_transform', input_key: 'input', output_key: 'candidate',
        expression: "(function() { return (items.userInput || '').trim(); })()",
      },
    ]), ['userInput']);
  });

  it('does NOT treat items.<key> as an input read when input_key is something else', () => {
    // There `items` is the previous step's output, not the run input.
    assert.deepEqual(expectedRunInput([
      {
        step: '2', type: 'js_transform', input_key: 'domain_research', output_key: 'x',
        expression: '(function() { return items.findings.length; })()',
      },
    ]), []);
  });

  it('merges both patterns across a workflow', () => {
    assert.deepEqual(expectedRunInput([
      { step: '1', type: 'js_transform', input_key: 'input', expression: '(function(){ return items.userInput; })()' },
      { step: '2', type: 'notify', input: { message: 'domain {{input.domain}}' } },
    ]), ['domain', 'userInput']);
  });
});

describe('expectedRunInput — degenerate input', () => {
  it('returns an empty list for a workflow that reads no input', () => {
    assert.deepEqual(expectedRunInput([{ step: '1', type: 'end' }]), []);
  });

  it('tolerates a missing or non-array steps value', () => {
    assert.deepEqual(expectedRunInput(undefined), []);
    assert.deepEqual(expectedRunInput(null), []);
    assert.deepEqual(expectedRunInput('not an array'), []);
  });
});

describe('the run 762 specimen', () => {
  // Reduced to the two steps that decide the outcome.
  const createDomainish = [
    {
      step: '1', type: 'js_transform', input_key: 'input', output_key: 'candidate_domain',
      expression: "(function() { return (items.userInput || '').toLowerCase().trim(); })()",
    },
    { step: '4', type: 'notify', input: { message: 'checking {{input.domain}}' } },
  ];

  it('names both keys the workflow reads', () => {
    assert.deepEqual(expectedRunInput(createDomainish), ['domain', 'userInput']);
  });

  it('would have refused the dispatch that produced daily_journaling', () => {
    const supplied = { domain: 'inventory', description: 'Track household inventory items.' };
    const expected = expectedRunInput(createDomainish);

    const missing = expected.filter(k => !(k in supplied));
    const ignored = Object.keys(supplied).filter(k => !expected.includes(k));

    assert.deepEqual(missing, ['userInput'], 'the key step 1 needed, and never got');
    assert.deepEqual(ignored, ['description'], 'the key she supplied that nothing reads');
    assert.ok(missing.length > 0, 'a non-empty missing list is what refuses the call');
  });
});
