// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-continue-gate.test.mjs
//
// Session 1367, 2026-11-18. Two defects at the end of a round:
//   - the continue gate re-posted after her reply to a follow-up said "I've reached my turn
//     limit" — /proc never said why it posted the gate, so Slack guessed. It now sends `reason`.
//   - twice a turn was cut off at the output ceiling and the round's time ran out before the
//     re-ask. The notice lived in the round, so after Continue she wrote the same over-long
//     response again. A round that ends owing the notice now hands it on (`afterTruncation`).

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { continueGateReason }                          from '../../src/proc/minds-eye.mjs';
import { CONTINUE_GATE_TEXT, mindsEyeContinueButtons } from '../../src/ui/slackbot/callback.mjs';

describe('continueGateReason — why a round ended on a continue gate', () => {
  it('after a reply to a follow-up, the gate is for the earlier task', () => {
    assert.equal(continueGateReason({ responded: true, budgetExhausted: false }), 'after_followup');
  });

  it('a round that ran out of time says so, else it ran out of turns', () => {
    assert.equal(continueGateReason({ responded: false, budgetExhausted: true }), 'round_budget');
    assert.equal(continueGateReason({ responded: false, budgetExhausted: false }), 'turn_limit');
  });
});

describe('CONTINUE_GATE_TEXT — what Slack says for each reason', () => {
  it('has a text for every reason /proc sends', () => {
    for (const reason of ['turn_limit', 'action_limit', 'round_budget', 'after_followup']) {
      assert.ok(CONTINUE_GATE_TEXT[reason], reason);
    }
  });

  it('after a follow-up, no limit is claimed', () => {
    assert.doesNotMatch(CONTINUE_GATE_TEXT.after_followup, /limit|time/);
  });
});

describe('mindsEyeContinueButtons — the cut-off notice travels with the click', () => {
  const values = opts => mindsEyeContinueButtons({ sessionId: 7, atSeq: 44, ...opts }).map(b => JSON.parse(b.value));

  it('Continue and Follow-up carry afterTruncation when the round owes the notice', () => {
    const [cont, follow] = values({ afterTruncation: true });
    assert.equal(cont.afterTruncation, true);
    assert.equal(follow.afterTruncation, true);
  });

  it('and nothing when it does not', () => {
    for (const v of values({})) assert.equal('afterTruncation' in v, false);
  });
});

describe('the wiring', () => {
  const proc  = readFileSync('src/proc/minds-eye.mjs', 'utf8');
  const slack = readFileSync('src/ui/slackbot/interactive.mjs', 'utf8');

  it('a round ending with the notice still pending posts afterTruncation', () => {
    assert.match(proc, /afterTruncation: truncationNotice !== null,/);
  });

  it('the next round opens with the notice', () => {
    assert.match(proc, /let truncationNotice = afterTruncation \? TRUNCATION_NOTICE : null;/);
  });

  it('both resume paths, Continue and follow-up, hand it to the loop', () => {
    assert.match(proc, /const \{ sessionId, approved, resumeType, test, atSeq, afterTruncation = false \} = body;/);
    assert.equal((proc.match(/\n\s*afterTruncation,\n\s*\}\);/g) ?? []).length, 2);
  });

  it('Slack forwards it from the Continue click and through the follow-up modal', () => {
    assert.match(slack, /\.\.\.\(buttonValue\.afterTruncation \? \{ afterTruncation: true \} : \{\}\),/);
    assert.match(slack, /followupText: inputValue,\n\s*\.\.\.\(afterTruncation \? \{ afterTruncation: true \} : \{\}\),/);
  });
});
