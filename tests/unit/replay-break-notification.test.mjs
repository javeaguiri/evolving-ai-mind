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

const { buildBreakNotification, summariseInputDrift, computeBlastRadius, buildBreakActions } = await import('../../src/proc/run-workflow.mjs');

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

// A12 — the reach of a drifted key across the workflow definition. The notification promises
// use_recorded "keeps the suffix free"; that is false whenever a drifted local_state value
// also feeds later llm_call steps. Proven live on run 723: user_design_notes is read by 21/21r/21t.
describe('computeBlastRadius', () => {
  // A miniature of create_workflow's shape: user_design_notes set at a gate, read by 11/21/21r/21t.
  const steps = [
    { step: '3',  type: 'llm_call', input: { prompt: 'research', domain: '{{domain}}' } },
    { step: '11', type: 'llm_call', input: { prompt: 'gaps', user_design_notes: '{{user_design_notes}}', domain: '{{domain}}' } },
    { step: '21', type: 'llm_call', input: { prompt: 'design', user_design_notes: '{{user_design_notes}}' } },
    { step: '21r', type: 'llm_call', input: { prompt: 'review', notes: '{{user_design_notes}}' } },
    { step: '21t', type: 'llm_call', input: { prompt: 'redesign', user_design_notes: '{{user_design_notes}}' } },
    { step: '22', type: 'js_transform', input: { x: '{{user_design_notes}}' } },   // not an llm_call → excluded
  ];

  it('names the other llm_call steps that read the same source, in array order, excluding self', () => {
    const br = computeBlastRadius(steps, '11', ['user_design_notes']);
    assert.deepEqual(br, { user_design_notes: ['21', '21r', '21t'] });
  });

  it('follows the source root, not the input-key name — 21r reads it under a different key', () => {
    // 21r references {{user_design_notes}} via input.notes; it is still a reader.
    assert.ok(computeBlastRadius(steps, '11', ['user_design_notes']).user_design_notes.includes('21r'));
  });

  it('a key another llm_call reads is reported (domain → step 3)', () => {
    assert.deepEqual(computeBlastRadius(steps, '11', ['domain']), { domain: ['3'] });
  });

  it('omits a drifted key no other step reads', () => {
    // step 11 alone reads a made-up key; no other step references its source.
    const s2 = [...steps, { step: '99', type: 'llm_call', input: { prompt: 'x', solo: '{{only_here}}' } }];
    assert.deepEqual(computeBlastRadius(s2, '99', ['solo']), {});
  });

  it('returns {} when there is no per-key drift to trace', () => {
    assert.deepEqual(computeBlastRadius(steps, '11', []), {});
    assert.deepEqual(computeBlastRadius(steps, '11', null), {});
  });
});

// A9 + A12 in the notification: use_recorded framing reflects what moved, and names downstream cost.
describe('the break notification governs use_recorded by disposition and blast radius', () => {
  const cand = { ...payload, candidate_session_id: 5501, candidate_ids: [5501] };

  it('renders the disposition headline for a refused (different-question) drift', () => {
    const { message } = buildBreakNotification(run, {
      ...cand, disposition: { verdict: 'refused', headline: '⛔ a DIFFERENT question was asked — use_recorded would answer the wrong one; call_live or supply' },
    }, 't');
    assert.match(message, /DIFFERENT question was asked/);
    assert.match(message, /"resolution":"use_recorded"\}/); // still offered, but now framed
  });

  it('names downstream readers so "keeps the suffix free" is not promised falsely', () => {
    const { message } = buildBreakNotification(run, {
      ...cand,
      disposition: { verdict: 'intended', headline: '✅ use_recorded is the intended resolution here — accepting keeps this step free' },
      blast_radius: { user_design_notes: ['21', '21r', '21t'] },
    }, 't');
    assert.match(message, /user_design_notes is also read by steps 21, 21r, 21t/);
    assert.match(message, /defers that decision/);
  });

  it('no longer promises "keeps the suffix free" unconditionally', () => {
    const { message } = buildBreakNotification(run, cand, 't');
    assert.ok(!message.includes('keeps the suffix free'), 'the unconditional promise A12 disproved must be gone');
  });
});

// A11 — payload-free resolutions become Slack buttons so a break is resolvable without a shell.
// The procedure tier decides WHICH are offered (A9-governed); `supplied` is never one (it carries
// a payload). buildBreakActions is that decision, pure and testable.
describe('buildBreakActions', () => {
  const resolutions = (acts) => acts.map(a => a.resolution);

  it('always offers call_live and abort, never supplied (it carries a payload)', () => {
    const acts = buildBreakActions({});
    assert.ok(resolutions(acts).includes('call_live'));
    assert.ok(resolutions(acts).includes('abort'));
    assert.ok(!resolutions(acts).includes('supplied'), 'supplied is a curl, never a button');
  });

  it('abort is styled danger', () => {
    assert.equal(buildBreakActions({}).find(a => a.resolution === 'abort').style, 'danger');
  });

  it('offers no use_recorded when there is no candidate to accept', () => {
    assert.ok(!resolutions(buildBreakActions({ candidate_session_id: null })).includes('use_recorded'));
  });

  it('offers use_recorded (primary) when the disposition is intended', () => {
    const acts = buildBreakActions({ candidate_session_id: 5501, disposition: { verdict: 'intended' } });
    const ur   = acts.find(a => a.resolution === 'use_recorded');
    assert.ok(ur, 'intended → offer the recording');
    assert.equal(ur.style, 'primary');
  });

  // The point of A9: when a different question was asked, the easy accept is withheld.
  it('WITHHOLDS use_recorded when the disposition is refused (curl remains, button does not)', () => {
    const acts = buildBreakActions({ candidate_session_id: 5501, disposition: { verdict: 'refused' } });
    assert.ok(!resolutions(acts).includes('use_recorded'), 'a refused drift must not offer the accept button');
    assert.ok(resolutions(acts).includes('call_live') && resolutions(acts).includes('abort'), 'the escapes remain');
  });

  it('offers use_recorded but not primary on a cautionary disposition', () => {
    const ur = buildBreakActions({ candidate_session_id: 5501, disposition: { verdict: 'caution' } }).find(a => a.resolution === 'use_recorded');
    assert.ok(ur && ur.style === undefined, 'caution offers the button but does not push it');
  });

  // A5b — a step recorded more than once: one button per candidate, each naming its recording.
  it('offers one named use_recorded per candidate when a step recorded more than once', () => {
    const acts = buildBreakActions({ candidate_session_id: 1067, candidate_ids: [1067, 1064], disposition: { verdict: 'intended' } });
    const urs  = acts.filter(a => a.resolution === 'use_recorded');
    assert.equal(urs.length, 2);
    assert.deepEqual(urs.map(a => a.sessionId).sort(), [1064, 1067]);
  });
});

describe('the break notification carries breakActions for the experience tier', () => {
  it('attaches the payload-free resolutions to the notification', () => {
    const n = buildBreakNotification(run, { ...payload, candidate_session_id: 5501, disposition: { verdict: 'intended' } }, 't');
    assert.ok(Array.isArray(n.breakActions));
    assert.ok(n.breakActions.some(a => a.resolution === 'abort'));
    assert.ok(n.breakActions.some(a => a.resolution === 'use_recorded'));
  });
});
