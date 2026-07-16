// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/replay-corpus.test.mjs
//
// Sprint 8 A3 — replay corpus classification + seam decision (docs/arch-replay.md §4, §8).
// Pure logic only; the SERV reads in lookupRecording are exercised end-to-end at replay time.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { diffComponents, classifyDrift, decideReplayAction } from '../../src/proc/replay-corpus.mjs';

// Seven-component fingerprint; helper to build a candidate that differs in named components.
const BASE = {
  prompt: 'p', input: 'i', user_input: 'u', model: 'm', schema: 's', memory: 'x', system_context: 'c',
};
const withDiffs = (...changed) => {
  const c = { ...BASE };
  for (const k of changed) c[k] = c[k] + '_DIFF';
  return { request_fingerprint: c };
};

describe('diffComponents', () => {
  it('returns [] when identical', () => {
    assert.deepEqual(diffComponents(BASE, { ...BASE }), []);
  });
  it('lists only the differing components, sorted', () => {
    assert.deepEqual(diffComponents(BASE, withDiffs('memory', 'input').request_fingerprint), ['input', 'memory']);
  });
});

describe('classifyDrift', () => {
  it('miss when no candidates', () => {
    assert.equal(classifyDrift(BASE, []).status, 'miss');
  });

  it('soft_drift when only memory differs — the reuse case', () => {
    const v = classifyDrift(BASE, [withDiffs('memory')]);
    assert.equal(v.status, 'soft_drift');
    assert.deepEqual(v.drift, ['memory']);
  });

  it('hard_drift when a hard component differs', () => {
    const v = classifyDrift(BASE, [withDiffs('input')]);
    assert.equal(v.status, 'hard_drift');
    assert.deepEqual(v.drift, ['input']);
  });

  it('hard_drift when memory AND a hard component differ (not soft)', () => {
    const v = classifyDrift(BASE, [withDiffs('memory', 'prompt')]);
    assert.equal(v.status, 'hard_drift');
    assert.deepEqual(v.drift, ['memory', 'prompt']);
  });

  // A recording made before the fingerprint seam existed has no components to compare.
  // Reporting that as hard_drift asserts every component moved — it never measured them.
  it('unfingerprinted (not hard_drift) when the candidate has no fingerprint', () => {
    const v = classifyDrift(BASE, [{ id: 1069, request_fingerprint: null }]);
    assert.equal(v.status, 'unfingerprinted');
    assert.equal(v.drift, undefined, 'must not fabricate a drift list');
    assert.equal(v.row.id, 1069);
  });

  it('unfingerprinted when the candidate fingerprint is an empty object', () => {
    assert.equal(classifyDrift(BASE, [{ id: 7, request_fingerprint: {} }]).status, 'unfingerprinted');
  });

  // The ambiguity that makes an arbitrary pick dangerous: two passes through one step
  // are indistinguishable without a fingerprint, so every id is reported.
  it('unfingerprinted reports every candidate id when a step recorded more than once', () => {
    const v = classifyDrift(BASE, [{ id: 1067, request_fingerprint: null }, { id: 1064, request_fingerprint: null }]);
    assert.equal(v.status, 'unfingerprinted');
    assert.deepEqual(v.candidateIds, [1067, 1064]);
  });

  it('prefers a comparable candidate over an unfingerprinted one', () => {
    const v = classifyDrift(BASE, [{ id: 9, request_fingerprint: null }, withDiffs('input')]);
    assert.equal(v.status, 'hard_drift');
    assert.deepEqual(v.drift, ['input']);
  });

  it('an unfingerprinted candidate never dilutes a real hit', () => {
    const v = classifyDrift(BASE, [{ id: 9, request_fingerprint: null }, { request_fingerprint: { ...BASE } }]);
    assert.equal(v.status, 'hit');
    assert.deepEqual(v.drift, []);
  });

  it('prefers a soft candidate over a hard one (iterator: many recordings for a step)', () => {
    const v = classifyDrift(BASE, [withDiffs('input'), withDiffs('memory')]);
    assert.equal(v.status, 'soft_drift');
  });

  it('among hard candidates, reports the most similar (fewest drifting)', () => {
    const near = withDiffs('input');                 // 1 drift
    const far  = withDiffs('input', 'prompt', 'model'); // 3 drifts
    const v = classifyDrift(BASE, [far, near]);
    assert.equal(v.status, 'hard_drift');
    assert.deepEqual(v.drift, ['input']);
  });
});

describe('decideReplayAction — policy × status', () => {
  it('never/null → always call live regardless of status', () => {
    for (const p of ['never', null, undefined]) {
      for (const s of ['hit', 'soft_drift', 'hard_drift', 'miss']) {
        assert.equal(decideReplayAction(p, s), 'call', `${p}/${s}`);
      }
    }
  });

  it('always → always break (never call)', () => {
    for (const s of ['hit', 'soft_drift', 'hard_drift', 'miss']) {
      assert.equal(decideReplayAction('always', s), 'break', `always/${s}`);
    }
  });

  it('on_miss → serve hit and soft_drift, break hard_drift and miss', () => {
    assert.equal(decideReplayAction('on_miss', 'hit'),        'serve');
    assert.equal(decideReplayAction('on_miss', 'soft_drift'), 'serve');
    assert.equal(decideReplayAction('on_miss', 'hard_drift'), 'break');
    assert.equal(decideReplayAction('on_miss', 'miss'),       'break');
  });

  // An uncomparable recording must never be served silently — it breaks for a human.
  it('on_miss → break on unfingerprinted (never serve)', () => {
    assert.equal(decideReplayAction('on_miss', 'unfingerprinted'), 'break');
  });
});

// A6 — a stored request_fingerprint carries input_keys alongside the seven components.
// It is a finer view of `input`, not an eighth component: diffing the raw key union would
// report it as drift and pollute every drift list.
describe('diffComponents judges COMPONENT_ORDER, not whatever keys are present', () => {
  it('ignores input_keys entirely', () => {
    const rec = { ...BASE, input_keys: { a: { h: 'zzz', n: 1 } } };
    assert.deepEqual(diffComponents(BASE, rec), [], 'input_keys must not read as a drifting component');
  });

  it('still detects real drift when input_keys is present and differs', () => {
    const cur = { ...BASE, input: 'i2', input_keys: { a: { h: 'p', n: 1 } } };
    const rec = { ...BASE,               input_keys: { a: { h: 'q', n: 9 } } };
    assert.deepEqual(diffComponents(cur, rec), ['input']);
  });

  it('an unknown extra key never invents a component', () => {
    assert.deepEqual(diffComponents({ ...BASE, future_field: 'x' }, BASE), []);
  });
});
