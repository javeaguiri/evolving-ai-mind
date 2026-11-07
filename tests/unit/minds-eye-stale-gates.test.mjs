// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-stale-gates.test.mjs
//
// A Novia gate click is acted on only while the session still stands where the gate was
// posted. Session 1307: a continue gate's Follow-up left its buttons live, a second continue
// gate was posted under her answer, and a Continue at 09:41:15 restarted a loop with nothing
// new in it, so she answered the same question twice (entries 44 and 45). The same gap let an
// Approve resolve "the latest pending action" whichever gate it came from.
//
// Run: node --test tests/unit/minds-eye-stale-gates.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { staleGateRefusal, endsOnReply, CONTINUE_AFTER_REPLY } from '../../src/proc/minds-eye.mjs';
import { mindsEyeGateButtons, mindsEyeContinueButtons } from '../../src/ui/slackbot/callback.mjs';
import { followupClosedBlocks } from '../../src/ui/slackbot/interactive.mjs';

const user      = (seq) => ({ role: 'user', sequence_number: seq, content: 'q' });
const reply     = (seq) => ({ role: 'assistant', sequence_number: seq, content: JSON.stringify({ action: 'respond', message: 'a' }) });
const tool      = (seq, t = 'query_table') => ({ role: 'tool', sequence_number: seq, content: JSON.stringify({ tool: t, params: {}, result: {} }) });
const pending   = (seq, action) => ({ role: 'tool', sequence_number: seq, content: JSON.stringify({ tool: '__pending__', action, params: {} }) });

describe('staleGateRefusal — a continue gate', () => {
  it('acts on a click while nothing has been added since the gate', () => {
    assert.equal(staleGateRefusal({ entries: [user(1), tool(2)], kind: 'continue', atSeq: 2 }), null);
  });

  it('refuses a click once the session has moved past the gate (1307\'s first gate, at 42)', () => {
    const r = staleGateRefusal({ entries: [tool(42), user(43), reply(44)], kind: 'continue', atSeq: 42 });
    assert.match(r, /out of date/);
    assert.match(r, /nothing was done/);
  });

  it('acts on a gate posted before atSeq existed', () => {
    assert.equal(staleGateRefusal({ entries: [tool(42), user(43), reply(44)], kind: 'continue' }), null);
  });
});

describe('staleGateRefusal — an action gate', () => {
  const p = pending(10, 'propose_schema_fix');

  it('acts on the gate of the pending action it showed', () => {
    assert.equal(staleGateRefusal({ entries: [tool(9), p], kind: 'action', atSeq: 10, pendingEntry: p }), null);
  });

  it('refuses a second click once the action has run', () => {
    const entries = [tool(9), p, tool(11, 'propose_schema_fix')];
    assert.ok(staleGateRefusal({ entries, kind: 'action', atSeq: 10, pendingEntry: p }));
  });

  it('refuses an older gate\'s click while a newer action waits — it would approve what it never showed', () => {
    const newer = pending(14, 'delete_data');
    const entries = [p, tool(11, 'propose_schema_fix'), tool(12), tool(13), newer];
    assert.ok(staleGateRefusal({ entries, kind: 'action', atSeq: 10, pendingEntry: newer }));
  });

  it('refuses when the latest pending entry is a test run she is waiting on, not a gated write', () => {
    const waiting = pending(20, 'answer_gate');
    assert.ok(staleGateRefusal({ entries: [tool(19), waiting], kind: 'action', pendingEntry: waiting }));
  });

  it('still holds a gate with no atSeq to its pending entry being the latest', () => {
    assert.equal(staleGateRefusal({ entries: [tool(9), p], kind: 'action', pendingEntry: p }), null);
    assert.ok(staleGateRefusal({ entries: [p, user(11)], kind: 'action', pendingEntry: p }));
  });
});

describe('endsOnReply', () => {
  it('is true when her reply is the latest entry, whatever order the rows come in', () => {
    assert.equal(endsOnReply([reply(44), user(43), tool(42)]), true);
  });

  it('is false when a round stopped mid-work', () => {
    assert.equal(endsOnReply([reply(40), tool(41)]), false);
  });

  it('tells her what the click means', () => {
    assert.match(CONTINUE_AFTER_REPLY, /^Continue/);
  });
});

describe('the gates carry atSeq back on every button', () => {
  const values = (buttons) => buttons.map(b => JSON.parse(b.value));

  it('the continue gate: Continue, Follow-up and Cancel', () => {
    const v = values(mindsEyeContinueButtons({ sessionId: 1307, atSeq: 44 }));
    assert.deepEqual(v.map(x => x.atSeq), [44, 44, 44]);
    assert.deepEqual(v.map(x => x.action), ['minds_eye_continue_gate', 'minds_eye_continue_followup', 'minds_eye_continue_gate']);
  });

  it('the action gate: Apply, Apply and test, and Cancel', () => {
    const v = values(mindsEyeGateButtons({ sessionId: 1308, testLabel: 'Apply and test', atSeq: 12 }));
    assert.deepEqual(v.map(x => x.atSeq), [12, 12, 12]);
  });

  it('a gate without atSeq renders as before', () => {
    assert.ok(values(mindsEyeContinueButtons({ sessionId: 1 })).every(x => !('atSeq' in x)));
  });
});

describe('sending a follow-up closes its gate', () => {
  it('keeps the gate text and replaces its buttons with a line', () => {
    const text = { type: 'section', text: { type: 'mrkdwn', text: "I've used up this round's time" } };
    assert.deepEqual(followupClosedBlocks([text]), [text, { type: 'context', elements: [{ type: 'mrkdwn', text: '💬 Follow-up sent.' }] }]);
  });

  it('still closes it when the content did not fit in the modal', () => {
    assert.equal(followupClosedBlocks(undefined).length, 1);
  });
});

describe('the wiring', () => {
  const proc  = readFileSync('src/proc/minds-eye.mjs', 'utf8');
  const slack = readFileSync('src/ui/slackbot/interactive.mjs', 'utf8');

  it('every continue gate is posted with the latest entry\'s sequence', () => {
    assert.equal((proc.match(/postTurnLimitGate\(session\.id, callback, traceId, [^)]*seq - 1\)/g) ?? []).length, 3);
    assert.match(proc, /gate_type:    'minds_eye_gate',\n\s*sessionId:    session\.id,\n\s*atSeq:        currentSeq,/);
  });

  it('both resume paths check before acting', () => {
    assert.match(proc, /staleGateRefusal\(\{ entries, kind: 'continue', atSeq \}\)/);
    assert.match(proc, /staleGateRefusal\(\{ entries, kind: 'action', atSeq, pendingEntry \}\)/);
  });

  it('both Slack click handlers hand atSeq back to /proc', () => {
    assert.equal((slack.match(/\.\.\.\(buttonValue\.atSeq != null \? \{ atSeq: buttonValue\.atSeq \} : \{\}\)/g) ?? []).length, 2);
  });
});
