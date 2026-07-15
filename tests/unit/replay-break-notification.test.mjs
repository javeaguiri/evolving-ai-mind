// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/replay-break-notification.test.mjs
//
// Sprint 8 A4 — the break notification is the developer interface (docs/arch-replay.md §5).
// It must be runnable as printed and must never render key material.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

process.env.SERV_API_URL = 'https://example.execute-api.us-east-2.amazonaws.com/Prod';

const { buildBreakNotification } = await import('../../src/proc/run-workflow.mjs');

const run = { id: 812, workflow_name: 'create_workflow', replay_source_run_id: 719 };
const payload = {
  step_id: '21', intent_category: 'design_workflow_process', policy: 'on_miss',
  reason: 'hard_drift', drift: ['input', 'prompt'], candidate_session_id: 5501,
};

describe('buildBreakNotification', () => {
  it('is a HUMAN_NOTIFICATION addressed to the replay run', () => {
    const n = buildBreakNotification(run, payload, 'trace-1');
    assert.equal(n.type, 'HUMAN_NOTIFICATION');
    assert.equal(n.workflowRunId, 812);
  });

  it('labels both run IDs — replay (812) and source (719)', () => {
    const { message } = buildBreakNotification(run, payload, 'trace-1');
    assert.match(message, /Run 812/);
    assert.match(message, /run 719/);
  });

  it('renders runnable curls against SERV_API_URL /proc/replay, never a bare host', () => {
    const { message } = buildBreakNotification(run, payload, 'trace-1');
    assert.match(message, /https:\/\/example\.execute-api\.us-east-2\.amazonaws\.com\/Prod\/api\/v1\/proc\/replay\/812/);
    assert.match(message, /\/proc\/replay\/812\/resume/);
    assert.ok(!message.includes('$BASE'), 'must not leave a placeholder host');
  });

  it('references the API key only as an env var — never key material', () => {
    const { message } = buildBreakNotification(run, payload, 'trace-1');
    assert.match(message, /\$INTERNAL_API_KEY/);
    assert.ok(!/x-api-key:\s*[A-Za-z0-9]{8,}/.test(message), 'no literal key value rendered');
  });

  it('offers use_recorded only when a candidate recording exists', () => {
    const withCand = buildBreakNotification(run, payload, 't').message;
    assert.match(withCand, /"resolution":"use_recorded"/);

    const miss = buildBreakNotification(run, { ...payload, reason: 'miss', candidate_session_id: null }, 't').message;
    assert.ok(!miss.includes('use_recorded'), 'a miss has no recording to accept');
    assert.match(miss, /"resolution":"call_live"/); // but live/supplied/abort always offered
  });

  it('shows record mode when there is no source run', () => {
    const rec = buildBreakNotification({ ...run, replay_source_run_id: null }, payload, 't').message;
    assert.match(rec, /record — no source run/);
  });
});
