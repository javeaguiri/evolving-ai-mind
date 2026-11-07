// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-test-plan-gate.test.mjs
//
// The test plan rides on the change's approval gate, so one click (Apply and test) approves
// the change and the plan together. In session 1308 the click was followed by a second stop
// to approve a plan she wrote afterwards. Also: a schema operation's default on the gate.
//
// Run: node --test tests/unit/minds-eye-test-plan-gate.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { withTestPlan, testPlanRefusal, withTestRequest, gateButtonConfig } from '../../src/proc/minds-eye.mjs';

const plan = '**Paths:** the receipt with one new item, and one with none.';

describe('withTestPlan', () => {
  it('puts the plan under the change, saying the test button approves it too', () => {
    const { testLabel } = gateButtonConfig('propose_workflow_fix');
    const text = withTestPlan('**Proposed workflow fix: `w`**', { testPlan: plan }, testLabel);
    assert.equal(text, `**Proposed workflow fix: \`w\`**\n\n**Test plan** — *Apply and test* approves this plan too, and the test starts straight away.\n\n${plan}`);
  });

  it('names the register gate\'s own button', () => {
    const { testLabel } = gateButtonConfig('register_workflow');
    assert.match(withTestPlan('g', { testPlan: plan }, testLabel), /\*Register and test\* approves this plan too/);
  });

  it('leaves a gate with no test button, or no plan, as it was', () => {
    assert.equal(withTestPlan('g', { testPlan: plan }, undefined), 'g');
    assert.equal(withTestPlan('g', {}, 'Apply and test'), 'g');
  });
});

describe('testPlanRefusal', () => {
  it('accepts no plan, and a plan the gate can show whole', () => {
    assert.equal(testPlanRefusal({}), null);
    assert.equal(testPlanRefusal({ testPlan: plan }), null);
  });

  it('refuses a plan too long to read on the gate, before anything is sent for approval', () => {
    const r = testPlanRefusal({ testPlan: 'x'.repeat(3001) });
    assert.match(r.error, /3001 characters/);
    assert.match(r.error, /nothing was sent for approval/);
  });

  it('refuses a plan that is not text', () => {
    assert.ok(testPlanRefusal({ testPlan: '  ' }));
    assert.ok(testPlanRefusal({ testPlan: { paths: [] } }));
  });
});

describe('withTestRequest — what the click tells her', () => {
  const applied = { success: true, newVersion: 18 };

  it('Apply and test with a plan: approved together, start now', () => {
    const r = withTestRequest(applied, true, plan);
    assert.equal(r.test_plan_approved, true);
    assert.match(r.next, /approved this change and the test plan on its gate together/);
    assert.match(r.next, /without asking for approval again/);
  });

  it('Apply and test without a plan: write one and ask, as before', () => {
    const r = withTestRequest(applied, true, undefined);
    assert.equal(r.test_plan_approved, undefined);
    assert.match(r.next, /respond with a test plan for their approval/);
  });

  it('Apply alone with a plan on the gate: do not run it', () => {
    const r = withTestRequest(applied, false, plan);
    assert.equal(r.test_requested, false);
    assert.match(r.next, /Do not run the plan/);
  });

  it('nothing to test after a refusal, whatever was clicked', () => {
    assert.deepEqual(withTestRequest({ error: 'moved' }, true, plan), { error: 'moved' });
    assert.deepEqual(withTestRequest({ success: false }, true, plan), { success: false });
  });
});

describe('the seeds offer it', () => {
  const rows  = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json', 'utf8'));
  const tools = rows.find(r => r.key === 'minds_eye_tool_schemas').content.tools;

  it('testPlan on both workflow tools that have a test button', () => {
    for (const name of ['propose_workflow_fix', 'register_workflow']) {
      assert.equal(tools.find(t => t.name === name).parameters.properties.testPlan.type, 'string', name);
    }
  });

  it('default and dropDefault on propose_schema_fix', () => {
    const props = tools.find(t => t.name === 'propose_schema_fix').parameters.properties;
    assert.equal(props.default.type, 'string');
    assert.equal(props.dropDefault.type, 'boolean');
  });

  it('sop_test_cycle says where the plan goes and that the click approves it', () => {
    const sop = rows.find(r => r.key === 'sop_test_cycle').content;
    assert.match(sop, /send the plan as testPlan on that call/);
    assert.match(sop, /Apply and test approves the change and the plan together/);
  });
});
