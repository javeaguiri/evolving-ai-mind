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

import { parseReplayRoute } from '../../src/proc/replay.mjs';

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
