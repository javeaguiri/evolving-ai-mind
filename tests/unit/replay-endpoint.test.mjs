// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/replay-endpoint.test.mjs
//
// Sprint 8 A5 — replay endpoint route parsing (docs/arch-replay.md §9). The three routes
// use path params / sub-actions that the last-segment route model can't express, so the
// mapping from (method, proxy segments) → action is the part worth locking down.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { parseReplayRoute, validateResumeBody, validateNamedRecording } from '../../src/proc/replay.mjs';

describe('parseReplayRoute', () => {
  it('POST /replay → start', () => {
    assert.deepEqual(parseReplayRoute('POST', ['replay']), { action: 'start' });
  });

  it('GET /replay/{runId} → get with runId', () => {
    assert.deepEqual(parseReplayRoute('GET', ['replay', '812']), { action: 'get', runId: '812' });
  });

  it('POST /replay/{runId}/resume → resume with runId', () => {
    assert.deepEqual(parseReplayRoute('POST', ['replay', '812', 'resume']), { action: 'resume', runId: '812' });
  });

  it('GET /replay (no runId) → no match', () => {
    assert.equal(parseReplayRoute('GET', ['replay']).action, null);
  });

  it('POST /replay/{runId} without /resume → no match (never a bare runId POST)', () => {
    assert.equal(parseReplayRoute('POST', ['replay', '812']).action, null);
  });

  it('GET on the resume sub-path → no match (resume is POST-only)', () => {
    assert.equal(parseReplayRoute('GET', ['replay', '812', 'resume']).action, null);
  });

  it('an unknown sub-action → no match', () => {
    assert.equal(parseReplayRoute('POST', ['replay', '812', 'bogus']).action, null);
  });
});

describe('validateResumeBody', () => {
  it('accepts each resolution', () => {
    for (const r of ['use_recorded', 'call_live', 'abort']) {
      assert.equal(validateResumeBody({ resolution: r }), null, r);
    }
    assert.equal(validateResumeBody({ resolution: 'supplied', response: {} }), null);
  });

  it('rejects an unknown or missing resolution', () => {
    assert.match(validateResumeBody({ resolution: 'bogus' }), /resolution must be one of/);
    assert.match(validateResumeBody({}),                      /resolution must be one of/);
  });

  it('supplied requires a response', () => {
    assert.match(validateResumeBody({ resolution: 'supplied' }), /requires a response/);
  });

  it('accepts a named recording on use_recorded', () => {
    assert.equal(validateResumeBody({ resolution: 'use_recorded', sessionId: 1064 }), null);
  });

  it('rejects sessionId on any other resolution — it would be silently ignored', () => {
    assert.match(validateResumeBody({ resolution: 'call_live', sessionId: 1064 }), /only to resolution=use_recorded/);
  });

  it('rejects a non-positive-integer sessionId', () => {
    for (const s of [0, -1, 1.5, '1064', null]) {
      assert.match(validateResumeBody({ resolution: 'use_recorded', sessionId: s }), /positive integer/, String(s));
    }
  });
});

describe('validateNamedRecording', () => {
  it('accepts an id the break offered', () => {
    assert.equal(validateNamedRecording(1064, [1067, 1064]), null);
  });

  it('rejects an id the break did not offer, and lists what was offered', () => {
    assert.match(validateNamedRecording(999, [1067, 1064]), /not a recording of this step — offered: 1067, 1064/);
  });

  it('no sessionId → nothing to check', () => {
    assert.equal(validateNamedRecording(undefined, [1067]), null);
  });

  // breakPolicy: always reads no candidate set, so naming one is an explicit assertion.
  it('accepts a named id when the break offered no candidates', () => {
    assert.equal(validateNamedRecording(1064, null),      null);
    assert.equal(validateNamedRecording(1064, undefined), null);
  });
});
