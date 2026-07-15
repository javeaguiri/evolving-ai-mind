// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/fingerprint.test.mjs
//
// Sprint 8 A2 — request fingerprint for the LLM replay harness (docs/arch-replay.md §3).
//
// Guards the two properties the whole scheme rests on:
//   1. Determinism + order-independence — an identical request always hashes the same,
//      regardless of object key ordering, so a hit is reliable.
//   2. Component isolation — a change to one input moves only its own component (and the
//      composite), so a break report can attribute drift to a cause.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { computeFingerprint, stableStringify } from '../../src/proc/fingerprint.mjs';
import { selectInjectedContext }               from '../../src/proc/llm-harness.mjs';

const baseCall = () => ({
  promptRow:       { prompt_text: 'Design a {{thing}}.', version: 3, output_schema: { type: 'object' } },
  resolvedInput:   { thing: 'workflow', domain: 'budget' },
  userInput:       'make it good',
  model:           'anthropic/claude-sonnet-4-6',
  memoryBlock:     '',
  injectedContext: { workflow_constraints: 'no loops' },
});

describe('stableStringify', () => {
  it('is independent of object key order', () => {
    assert.equal(
      stableStringify({ a: 1, b: 2 }),
      stableStringify({ b: 2, a: 1 })
    );
  });

  it('sorts keys recursively in nested objects', () => {
    assert.equal(
      stableStringify({ outer: { z: 1, a: 2 } }),
      stableStringify({ outer: { a: 2, z: 1 } })
    );
  });

  it('preserves array order (arrays are ordered)', () => {
    assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  });
});

describe('computeFingerprint — determinism', () => {
  it('same request → same hash and components', () => {
    const a = computeFingerprint(baseCall());
    const b = computeFingerprint(baseCall());
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a.components, b.components);
  });

  it('key order in resolvedInput does not change the fingerprint', () => {
    const a = computeFingerprint(baseCall());
    const reordered = baseCall();
    reordered.resolvedInput = { domain: 'budget', thing: 'workflow' };
    assert.equal(computeFingerprint(reordered).hash, a.hash);
  });

  it('emits all seven components', () => {
    const { components } = computeFingerprint(baseCall());
    assert.deepEqual(
      Object.keys(components).sort(),
      ['input', 'memory', 'model', 'prompt', 'schema', 'system_context', 'user_input']
    );
  });

  it("memoryBlock undefined and '' hash identically", () => {
    const a = baseCall(); a.memoryBlock = '';
    const b = baseCall(); delete b.memoryBlock;
    assert.equal(computeFingerprint(a).components.memory, computeFingerprint(b).components.memory);
  });
});

describe('computeFingerprint — component isolation', () => {
  const assertOnlyMoved = (mutate, movedKey) => {
    const base = computeFingerprint(baseCall());
    const call = baseCall(); mutate(call);
    const next = computeFingerprint(call);
    assert.notEqual(next.hash, base.hash, 'composite hash must move');
    for (const k of Object.keys(base.components)) {
      if (k === movedKey) assert.notEqual(next.components[k], base.components[k], `${k} should have moved`);
      else                assert.equal(next.components[k], base.components[k], `${k} should NOT have moved`);
    }
  };

  it('editing prompt_text moves only prompt', () => {
    assertOnlyMoved(c => { c.promptRow = { ...c.promptRow, prompt_text: 'Design a great {{thing}}.' }; }, 'prompt');
  });

  it('bumping version moves only prompt', () => {
    assertOnlyMoved(c => { c.promptRow = { ...c.promptRow, version: 4 }; }, 'prompt');
  });

  it('changing resolvedInput moves only input', () => {
    assertOnlyMoved(c => { c.resolvedInput = { ...c.resolvedInput, thing: 'report' }; }, 'input');
  });

  it('changing an injected system-context row moves only system_context', () => {
    assertOnlyMoved(c => { c.injectedContext = { workflow_constraints: 'loops allowed' }; }, 'system_context');
  });

  it('changing the model moves only model', () => {
    assertOnlyMoved(c => { c.model = 'anthropic/claude-opus-4-8'; }, 'model');
  });

  it('changing output_schema moves only schema', () => {
    assertOnlyMoved(c => { c.promptRow = { ...c.promptRow, output_schema: { type: 'array' } }; }, 'schema');
  });
});

describe('selectInjectedContext — the reuse contract', () => {
  const rows = [
    { key: 'always_on',  content: 'A', inject_always: true },
    { key: 'for_design', content: 'B', inject_for: ['design_workflow_process'] },
    { key: 'other',      content: 'C', inject_for: ['unrelated_intent'] },
  ];

  it('includes inject_always and matching inject_for, excludes non-matching', () => {
    const map = selectInjectedContext(rows, {}, 'design_workflow_process');
    assert.deepEqual(map, { always_on: 'A', for_design: 'B' });
  });

  it('step input (resolvedInput) shadows a context row of the same key', () => {
    const map = selectInjectedContext(rows, { always_on: 'override' }, 'design_workflow_process');
    assert.ok(!('always_on' in map), 'resolvedInput key must not be injected from context');
    assert.equal(map.for_design, 'B');
  });
});
