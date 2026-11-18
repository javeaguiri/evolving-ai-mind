// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/session-callback.test.mjs
//
// Sprint 18 item 1, decision O: a session keeps the callback its messages go to
// (PGC_Session.callback), in place of the Slack-only slack_thread_ts.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { keptCallback, buildFailureNotification } from '../../src/proc/minds-eye.mjs';

describe('keptCallback — the callback a minds-eye session keeps', () => {
  const thread = { provider: 'slack', channel: 'C1', threadId: '1.2' };
  const later  = { provider: 'slack', channel: 'C1', threadId: '3.4' };
  const web    = { provider: 'web', channel: 'sub-a' };

  it('takes an incoming callback that names a thread', () => {
    assert.deepEqual(keptCallback(null, thread), thread);
    assert.deepEqual(keptCallback(thread, later), later);
  });

  it('keeps the stored one when the incoming names no thread, so the thread is never lost', () => {
    assert.deepEqual(keptCallback(thread, { provider: 'slack', channel: 'C1' }), thread);
    assert.deepEqual(keptCallback(thread, null), thread);
  });

  it('a web session, its own thread, keeps the web callback it started with', () => {
    assert.deepEqual(keptCallback(null, web), web);
    assert.deepEqual(keptCallback(web, web), web);
  });

  it('is null when there is nothing to keep', () => {
    assert.equal(keptCallback(null, null), null);
  });
});

describe('buildFailureNotification — a failed round stays reachable', () => {
  it('invites a reply, so Slack draws the follow-up button under it', () => {
    const n = buildFailureNotification(7, 't', new Error('boom'));
    assert.equal(n.sessionId, 7);
    assert.equal(n.invitesReply, true);
  });
});
