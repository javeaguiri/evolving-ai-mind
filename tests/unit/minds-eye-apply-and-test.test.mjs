// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-apply-and-test.test.mjs
//
// Sprint 15 scope 7 — Apply and test (docs/arch-minds-eye.md §4.4): a workflow change can be
// approved with a test. /proc offers it (testLabel), Slack draws it, the click carries test: true,
// and the applied result tells Novia to plan the test.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { gateButtonConfig, withTestRequest } from '../../src/proc/minds-eye.mjs';
import { mindsEyeGateButtons }               from '../../src/ui/slackbot/callback.mjs';

describe('gateButtonConfig — which changes can be approved with a test', () => {
  it('a workflow fix and a new workflow', () => {
    assert.equal(gateButtonConfig('propose_workflow_fix').testLabel, 'Apply and test');
    assert.equal(gateButtonConfig('register_workflow').testLabel, 'Register and test');
  });

  it('nothing else', () => {
    for (const action of ['delete_data', 'drop_table', 'create_view', 'propose_schema_fix', 'schedule_workflow']) {
      assert.equal(gateButtonConfig(action).testLabel, undefined, action);
    }
  });
});

describe('mindsEyeGateButtons — the gate as Slack draws it', () => {
  const values = (buttons) => buttons.map(b => JSON.parse(b.value));

  it('approve, approve and test, cancel — the test button carries test: true', () => {
    const buttons = mindsEyeGateButtons({ sessionId: 5, confirmLabel: 'Apply', testLabel: 'Apply and test' });
    assert.deepEqual(buttons.map(b => b.text.text), ['Apply', 'Apply and test', 'Cancel']);
    assert.deepEqual(values(buttons), [
      { action: 'minds_eye_action_gate', sessionId: 5, approved: true },
      { action: 'minds_eye_action_gate', sessionId: 5, approved: true, test: true },
      { action: 'minds_eye_action_gate', sessionId: 5, approved: false },
    ]);
    assert.equal(new Set(buttons.map(b => b.action_id)).size, 3, 'action_ids are unique within the block');
  });

  it('without a testLabel, the gate is as it was', () => {
    const buttons = mindsEyeGateButtons({ sessionId: 5, confirmLabel: 'Delete', confirmStyle: 'danger' });
    assert.deepEqual(buttons.map(b => b.text.text), ['Delete', 'Cancel']);
    assert.equal(buttons[0].style, 'danger');
    assert.equal(buttons[1].style, undefined);
  });
});

describe('the click reaches Novia', () => {
  it('interactive.mjs forwards test only with an approval', () => {
    const src  = readFileSync('src/ui/slackbot/interactive.mjs', 'utf8');
    const body = src.slice(src.indexOf('async function handleMindsEyeActionGate('));
    assert.match(body, /const \{ sessionId, approved, test \} = buttonValue;/);
    assert.match(body, /\.\.\.\(approved && test \? \{ test: true \} : \{\}\),/);
  });

  it('an applied change asks her to plan the test; a refused one does not', () => {
    const applied = withTestRequest({ success: true, newVersion: 4 }, true);
    assert.equal(applied.test_requested, true);
    assert.match(applied.next, /sop_test_cycle/);
    assert.equal(withTestRequest({ error: 'fails validation' }, true).test_requested, undefined);
    assert.equal(withTestRequest({ success: false }, true).test_requested, undefined);
    assert.deepEqual(withTestRequest({ success: true }, undefined), { success: true });
  });
});
