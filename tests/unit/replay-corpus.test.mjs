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
});
