// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-contract.test.mjs
//
// R4 — MINDS_EYE SQS payload contract test.
//
// Guards against regression where the SQS key for continuing a Novia session
// diverges between the slackbot sender and the proc consumer.
//
// Contract:
//   slackbot/interactive.mjs  → sends   { sessionId: <id>, ... }
//   proc/minds-eye.mjs        → reads   body.sessionId (aliased as existingSessionId)
//
// Running:
//   node --test tests/unit/minds-eye-contract.test.mjs

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const procSrc = readFileSync('src/proc/minds-eye.mjs', 'utf8');
const slackSrc = readFileSync('src/ui/slackbot/interactive.mjs', 'utf8');

describe('MINDS_EYE session-continuation SQS payload contract (R4)', () => {

  it('proc/minds-eye.mjs destructures body.sessionId (not body.existingSessionId)', () => {
    // The destructuring pattern aliases sessionId → existingSessionId for local clarity.
    // If someone renames the key to existingSessionId on the sender side without updating
    // this destructure, sessions will silently not be resumed.
    assert.match(
      procSrc,
      /sessionId:\s*existingSessionId/,
      'proc/minds-eye.mjs must read body.sessionId (aliased as existingSessionId)'
    );
    assert.doesNotMatch(
      procSrc,
      /body\.existingSessionId/,
      'proc/minds-eye.mjs must not read body.existingSessionId — the SQS key is sessionId'
    );
  });

  it('slackbot/interactive.mjs sends sessionId (not existingSessionId) in MINDS_EYE payload', () => {
    // Find the handleMindsEyeViewSubmission block that enqueues MINDS_EYE for session continuation.
    // The payload must use sessionId as the key so proc can resume the session.
    const mindsEyeBlock = slackSrc.match(/type:\s*['"]MINDS_EYE['"][^}]+}/s)?.[0] ?? '';
    assert.ok(
      mindsEyeBlock.length > 0,
      'interactive.mjs must contain a MINDS_EYE SQS message body'
    );
    assert.match(
      mindsEyeBlock,
      /sessionId[,\s]/,
      'MINDS_EYE SQS payload must include sessionId key'
    );
    assert.doesNotMatch(
      slackSrc,
      /existingSessionId:/,
      'interactive.mjs must not send existingSessionId as an object key — the SQS key is sessionId'
    );
  });
});
