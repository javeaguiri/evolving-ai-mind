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

const { buildBreakNotification, summariseInputDrift } = await import('../../src/proc/run-workflow.mjs');

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

  // A step that ran twice records twice under one step_id. Offering one unqualified
  // use_recorded would present the newest pick as though it were the considered one.
  describe('when a step recorded more than once', () => {
    const ambiguous = { ...payload, reason: 'unfingerprinted', drift: null, candidate_session_id: 1067, candidate_ids: [1067, 1064] };

    it('warns that the default pick is arbitrary', () => {
      const { message } = buildBreakNotification(run, ambiguous, 't');
      assert.match(message, /2 recordings for this step/);
      assert.match(message, /not necessarily the one this pass corresponds to/);
    });

    it('offers a named, runnable curl for every candidate', () => {
      const { message } = buildBreakNotification(run, ambiguous, 't');
      assert.match(message, /"resolution":"use_recorded","sessionId":1067/);
      assert.match(message, /"resolution":"use_recorded","sessionId":1064/);
    });

    it('never offers the unqualified use_recorded that would hide the choice', () => {
      const { message } = buildBreakNotification(run, ambiguous, 't');
      assert.ok(!message.includes(`'{"resolution":"use_recorded"}'`), 'the ambiguous pick must not be a default');
    });

    it('a single candidate keeps the plain resolution — nothing to choose between', () => {
      const { message } = buildBreakNotification(run, { ...payload, candidate_ids: [5501] }, 't');
      assert.match(message, /"resolution":"use_recorded"\}/);
      assert.ok(!message.includes('recordings for this step'), 'no ambiguity warning when there is no ambiguity');
    });
  });
});

// A6 — "drift: input" is not actionable on its own. These are the two cases from
// 2026-07-16, which look identical at component level and have opposite right answers.
describe('summariseInputDrift', () => {
  it('says nothing when there is nothing to say — the line is omitted, not blank', () => {
    assert.equal(summariseInputDrift(null), '');
    assert.equal(summariseInputDrift({ added: [], removed: [], changed: [], unchanged: ['a'] }), '');
  });

  // step 23 pass 2: a repair pass carrying draft + feedback the recording never had.
  it('names arrived keys with sizes, and what held still', () => {
    const s = summariseInputDrift({
      added: [{ key: 'draft_workflow', chars: 10405 }, { key: 'skeleton_error_summary', chars: 416 }],
      removed: [], changed: [], unchanged: ['step_type_contracts', 'process_spec'],
    });
    assert.match(s, /added: draft_workflow \(10405 chars\), skeleton_error_summary \(416 chars\)/);
    assert.match(s, /unchanged: step_type_contracts, process_spec/);
  });

  // step 11: action_key landed, so an injected contract changed -- benign, accept the recording.
  it('shows a changed key as was→now, so a contract edit is legible as a contract edit', () => {
    const s = summariseInputDrift({
      added: [], removed: [], changed: [{ key: 'step_type_contracts', chars: 38322, was_chars: 39445 }],
      unchanged: ['process_spec'],
    });
    assert.match(s, /changed: step_type_contracts \(39445→38322 chars\)/);
    assert.match(s, /unchanged: process_spec/);
  });

  it('reports a removed key', () => {
    assert.match(summariseInputDrift({ added: [], removed: [{ key: 'gone', chars: 12 }], changed: [], unchanged: [] }), /removed: gone \(12 chars\)/);
  });
});

describe('the break notification carries the input drift', () => {
  it('renders an input line naming the keys, not just the component', () => {
    const { message } = buildBreakNotification(run, {
      ...payload, reason: 'hard_drift', drift: ['input'],
      input_diff: { added: [{ key: 'draft_workflow', chars: 10405 }], removed: [], changed: [], unchanged: ['step_type_contracts'] },
    }, 't');
    assert.match(message, /drift: input/);
    assert.match(message, /input\s+added: draft_workflow \(10405 chars\)/);
    assert.match(message, /unchanged: step_type_contracts/);
  });

  it('omits the line when there is no per-key detail (recording predates A6)', () => {
    const { message } = buildBreakNotification(run, { ...payload, input_diff: null }, 't');
    assert.ok(!/^\s+input\s+/m.test(message), 'no empty input line');
  });
});
