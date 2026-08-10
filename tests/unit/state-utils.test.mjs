// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/state-utils.test.mjs
//
// Unit tests for resolveOutputWrites — the single output_key rule shared by the
// Step Processor (run-workflow.mjs) and the simulation engine, so the simulator
// cannot model a local_state the engine would never produce.
//
// Reproduces the run 763 bug class: create_domain v58 declared one output_key over
// an expression returning an object keyed by that same name, so local_state held
// { domain_request: { domain_request: "inventory" } } and {{domain_request}}
// resolved to an object where a string was required.
//
// Run: node --test tests/unit/state-utils.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutputWrites } from '../../src/proc/state-utils.mjs';

describe('resolveOutputWrites — single output_key', () => {
  it('nests an object return under its own key (run 763 reproduction)', () => {
    const writes = resolveOutputWrites('domain_request', { domain_request: 'inventory' });
    assert.deepEqual(writes, [{ key: 'domain_request', value: { domain_request: 'inventory' } }]);
  });

  it('writes a string return whole', () => {
    assert.deepEqual(
      resolveOutputWrites('domain_request', 'inventory'),
      [{ key: 'domain_request', value: 'inventory' }],
    );
  });

  it('preserves null as a value, not an absence (create_workflow step 20a)', () => {
    assert.deepEqual(
      resolveOutputWrites('user_workflow_feedback', null),
      [{ key: 'user_workflow_feedback', value: null }],
    );
  });

  it('trims surrounding whitespace on the key', () => {
    assert.deepEqual(resolveOutputWrites('  results  ', [1]), [{ key: 'results', value: [1] }]);
  });

  it('keeps a dot-path key intact for the caller to expand', () => {
    assert.deepEqual(
      resolveOutputWrites('loop_state.defs', ['a']),
      [{ key: 'loop_state.defs', value: ['a'] }],
    );
  });
});

describe('resolveOutputWrites — comma-separated output_key', () => {
  it('destructures an object return into one write per key', () => {
    const writes = resolveOutputWrites('schema_summary,table_review_items', {
      schema_summary:     'two tables',
      table_review_items: [{ id: 1 }],
    });
    assert.deepEqual(writes, [
      { key: 'schema_summary',     value: 'two tables' },
      { key: 'table_review_items', value: [{ id: 1 }] },
    ]);
  });

  it('does not write a declared key the object does not carry', () => {
    const writes = resolveOutputWrites('sorted_tables,ddl_items', { sorted_tables: ['t'] });
    assert.deepEqual(writes, [{ key: 'sorted_tables', value: ['t'] }]);
  });

  it('writes a key the object carries as null', () => {
    const writes = resolveOutputWrites('routing_skeleton,skeleton_error_summary', {
      routing_skeleton:       [{ step: '1' }],
      skeleton_error_summary: null,
    });
    assert.deepEqual(writes, [
      { key: 'routing_skeleton',       value: [{ step: '1' }] },
      { key: 'skeleton_error_summary', value: null },
    ]);
  });

  it('tolerates whitespace around each key', () => {
    const writes = resolveOutputWrites('a , b', { a: 1, b: 2 });
    assert.deepEqual(writes, [{ key: 'a', value: 1 }, { key: 'b', value: 2 }]);
  });

  it('writes nothing when an array return carries none of the declared keys', () => {
    assert.deepEqual(resolveOutputWrites('a,b', [{ id: 1 }]), []);
  });
});

describe('resolveOutputWrites — nothing to write', () => {
  it('returns no writes for a non-string output_key', () => {
    assert.deepEqual(resolveOutputWrites(undefined, 'v'), []);
    assert.deepEqual(resolveOutputWrites(null, 'v'), []);
    assert.deepEqual(resolveOutputWrites(['a'], 'v'), []);
  });

  it('returns no writes for an empty or comma-only output_key', () => {
    assert.deepEqual(resolveOutputWrites('', 'v'), []);
    assert.deepEqual(resolveOutputWrites('   ', 'v'), []);
    assert.deepEqual(resolveOutputWrites(',', 'v'), []);
  });
});
