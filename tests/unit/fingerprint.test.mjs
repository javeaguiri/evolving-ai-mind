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

import { createHash }                          from 'crypto';
import { computeFingerprint, stableStringify, hashInputKeys, diffInputKeys } from '../../src/proc/fingerprint.mjs';
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

// A6 (diagnostic) — the local_state snapshot backing the local_state diff. Reuses hashInputKeys,
// rides alongside the components, and MUST NOT touch the composite hash (it never gates a break).
describe('computeFingerprint — local_state snapshot (A6, diagnostic)', () => {
  it('emits stateKeys as a per-key size+hash map of localState', () => {
    const fp = computeFingerprint({ ...baseCall(), localState: { thing: 'workflow', draft: 'BIG PAYLOAD' } });
    assert.deepEqual(Object.keys(fp.stateKeys).sort(), ['draft', 'thing']);
    assert.equal(typeof fp.stateKeys.draft.h, 'string');
    assert.equal(fp.stateKeys.draft.n, stableStringify('BIG PAYLOAD').length);
  });

  it('localState does NOT change the composite hash — diagnostic, not a component', () => {
    const a = computeFingerprint({ ...baseCall(), localState: { x: 1 } });
    const b = computeFingerprint({ ...baseCall(), localState: { x: 2, y: 'more state' } });
    assert.equal(a.hash, b.hash);
  });

  it('stateKeys is empty when localState is absent', () => {
    assert.deepEqual(computeFingerprint(baseCall()).stateKeys, {});
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

// A6 — per-key hashes of `input`. A single `input` hash cannot be decomposed, so the
// distinction the disposition (A9) depends on has to be WRITTEN, not recovered by reading harder.
describe('hashInputKeys / diffInputKeys', () => {
  it('hashes each key independently and records its serialised size', () => {
    const k = hashInputKeys({ a: 'x', b: { deep: 1 } });
    assert.deepEqual(Object.keys(k).sort(), ['a', 'b']);
    assert.equal(typeof k.a.h, 'string');
    assert.equal(k.a.n, JSON.stringify('x').length);
    assert.notEqual(k.a.h, k.b.h);
  });

  it('is stable across key order — object ordering must not read as drift', () => {
    assert.deepEqual(hashInputKeys({ a: 1, b: 2 }), hashInputKeys({ b: 2, a: 1 }));
  });

  it('is NOT part of the composite — recordings predating A6 must keep hitting', () => {
    const args = { promptRow: { version: 1, prompt_text: 'p', output_schema: null }, userInput: '', model: 'm', memoryBlock: '', injectedContext: {} };
    const a = computeFingerprint({ ...args, resolvedInput: { x: 1 } });
    // Composite is derived from the seven components only; inputKeys rides alongside.
    assert.equal(a.hash, createHash('sha256').update(
      ['prompt', 'input', 'user_input', 'model', 'schema', 'memory', 'system_context'].map(c => a.components[c]).join(':'), 'utf8').digest('hex'));
    assert.ok(a.inputKeys.x, 'inputKeys is returned');
    assert.equal(a.components.input_keys, undefined, 'inputKeys must not be a component');
  });

  // The step-23 pass-2 case: a repair pass carrying draft + feedback the first pass never had.
  it('names keys that arrived, with sizes', () => {
    const d = diffInputKeys(hashInputKeys({ step_type_contracts: 'c', draft_workflow: 'BIG' }), hashInputKeys({ step_type_contracts: 'c' }));
    assert.deepEqual(d.added, ['draft_workflow']);
    assert.deepEqual(d.unchanged, ['step_type_contracts']);
    assert.deepEqual(d.changed, []);
  });

  // The step-11 case: action_key landed, so an injected contract changed — benign.
  it('distinguishes a changed contract from a changed question', () => {
    const d = diffInputKeys(hashInputKeys({ step_type_contracts: 'v2', process_spec: 'same' }), hashInputKeys({ step_type_contracts: 'v1', process_spec: 'same' }));
    assert.deepEqual(d.changed, ['step_type_contracts']);
    assert.deepEqual(d.unchanged, ['process_spec']);
  });

  it('reports a vanished key', () => {
    assert.deepEqual(diffInputKeys(hashInputKeys({}), hashInputKeys({ gone: 1 })).removed, ['gone']);
  });

  // Absent per-key hashes are unknowable. Reporting them as "unchanged" would assert agreement
  // that was never measured -- the same error as calling an unfingerprinted recording hard_drift.
  it('returns null when either side predates A6, rather than implying agreement', () => {
    assert.equal(diffInputKeys(hashInputKeys({ a: 1 }), null), null);
    assert.equal(diffInputKeys(null, hashInputKeys({ a: 1 })), null);
  });
});
