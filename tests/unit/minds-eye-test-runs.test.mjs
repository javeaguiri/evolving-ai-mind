// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-test-runs.test.mjs
//
// Sprint 15 scopes 5 and 6 (docs/arch-minds-eye.md §4.4): a test run reports to Novia's
// session, never to a person; run_workflow { test: true } and answer_gate wait for the run's
// next gate, completion or failure, which becomes the call's result.

import { describe, it, afterEach } from 'node:test';
import assert                      from 'node:assert/strict';
import { readFileSync }            from 'node:fs';
import { SQSClient }               from '@aws-sdk/client-sqs';

import { describeRunEvent, isOwnTestRun, countTestEvents, toInputItems } from '../../src/proc/minds-eye.mjs';
import { enqueueCallback }                                             from '../../src/shared/sqs-callback.mjs';

const gateStep = { step: '3', type: 'human_gate', gate_type: 'confirm', message_template: 'Save {{month}}?',
  options: [{ action: 'confirm', label: 'Save' }, { action: 'cancel', label: 'Cancel', on_select: 'cancel' }] };
const atGate = {
  id: 9, workflow_id: 2, status: 'awaiting_human_gate', sandbox: 'sandbox_1',
  stack: [{ type: 'workflow', current_step: '3', local_state: { month: 'May' } },
          { type: 'human_gate', gate_id: 'g-2', gate_type: 'confirm', step_ref: gateStep, step_number: '3', local_state: { month: 'May' } }],
};
const rows = [
  { id: 11, step_number: 2, step_type: 'notify', status: 'completed', input_snapshot: { step: '2' }, output_snapshot: { chars: 20, summary: 'Saved May' } },
  { id: 12, step_number: 3, step_type: 'human_gate', status: 'completed', input_snapshot: { step: '3' }, output_snapshot: null },
];

describe('describeRunEvent — what ends her wait', () => {
  it('a gate ends it, with the dialog as it was sent and the steps run since', () => {
    const sentDialog = { title: '', fields: [{ type: 'typography', value: '⚠️ Please complete: Amount.' }], gate_id: 'g-2' };
    const out = describeRunEvent({ message: { type: 'HUMAN_GATE', dialog: sentDialog }, run: atGate, stepRows: rows });
    assert.equal(out.event, 'HUMAN_GATE');
    assert.equal(out.waiting_gate.gate_id, 'g-2');
    assert.deepEqual(out.waiting_gate.dialog, sentDialog, 'a redrawn form carries its warning');
    assert.deepEqual(out.steps_since.map(s => s.step), ['2', '3']);
    assert.equal(out.steps_since[0].notified, 'Saved May', 'what a notify step said reaches her');
    assert.equal(out.test_run, true);
  });

  it('a notification on the way to the next gate does not end it', () => {
    const running = { ...atGate, status: 'running', stack: [atGate.stack[0]] };
    assert.equal(describeRunEvent({ message: { type: 'HUMAN_NOTIFICATION', message: 'Saved' }, run: running, stepRows: rows }), null);
  });

  it('completion, failure and a notification after the run stopped all end it', () => {
    const done = { ...atGate, status: 'completed', stack: [], state: { local_state: {} } };
    assert.equal(describeRunEvent({ message: { type: 'WORKFLOW_COMPLETED' }, run: done }).event, 'WORKFLOW_COMPLETED');
    assert.equal(describeRunEvent({ message: { type: 'HUMAN_NOTIFICATION', message: 'Workflow cancelled.' }, run: { ...done, status: 'cancelled' } }).event, 'cancelled');
    const failed = describeRunEvent({ message: { type: 'WORKFLOW_ERROR', message: 'updateRows failed' }, run: { ...atGate, status: 'failed', error: { message: 'x' } } });
    assert.equal(failed.event, 'WORKFLOW_ERROR');
    assert.equal(failed.message, 'updateRows failed');
  });
});

describe('whose gates she may answer, and how many events a session gets', () => {
  it('only a test run this session started', () => {
    const run = { sandbox: 'sandbox_1', callback: { provider: 'novia', sessionId: 5 } };
    assert.equal(isOwnTestRun(run, 5), true);
    assert.equal(isOwnTestRun(run, 6), false, 'another session\'s test run');
    assert.equal(isOwnTestRun({ ...run, sandbox: null }, 5), false, 'a run with no sandbox writes household data');
    assert.equal(isOwnTestRun({ ...run, callback: { provider: 'slack' } }, 5), false, 'a person\'s run');
    assert.equal(isOwnTestRun(undefined, 5), false);
  });

  it('counts resolved waits, not open ones or other tools', () => {
    const e = (content) => ({ role: 'tool', content: JSON.stringify(content) });
    assert.equal(countTestEvents([
      e({ tool: '__pending__', action: 'answer_gate', runId: 9 }),
      e({ tool: 'answer_gate', result: { event: 'HUMAN_GATE' } }),
      e({ tool: 'run_workflow', result: { event: 'WORKFLOW_COMPLETED' } }),
      e({ tool: 'answer_gate', result: { error: 'gate_moved' } }),
      e({ tool: 'query_table', result: { event: 'x' } }),
    ]), 2);
  });
});

describe('enqueueCallback — a test run reports to her session', () => {
  const realSend = SQSClient.prototype.send;
  afterEach(() => { SQSClient.prototype.send = realSend; });

  it('every message of a novia run becomes a wake for her session, in her own thread', async () => {
    const sent = [];
    SQSClient.prototype.send = async function (command) { sent.push(command.input); };
    process.env.SQS_WORKFLOW_URL = 'workflow-queue';
    const reply = { provider: 'slack', channel: 'C1', threadId: '1.2' };
    await enqueueCallback({ provider: 'novia', sessionId: 5, reply },
      { type: 'HUMAN_GATE', workflowRunId: 9, dialog: { fields: [] }, callback: { provider: 'novia' }, traceId: 't' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].QueueUrl, 'workflow-queue');
    assert.deepEqual(JSON.parse(sent[0].MessageBody), {
      type: 'MINDS_EYE_RESUME', resumeType: 'run_event', sessionId: 5,
      runEvent: { type: 'HUMAN_GATE', workflowRunId: 9, dialog: { fields: [] }, traceId: 't' },
      callback: reply, traceId: 't',
    });
  });

  it('completion is sent to no person', async () => {
    const sent = [];
    SQSClient.prototype.send = async function (command) { sent.push(command.input); };
    await enqueueCallback({ provider: 'slack', channel: 'C1' }, { type: 'WORKFLOW_COMPLETED', workflowRunId: 9, traceId: 't' });
    assert.equal(sent.length, 0);
  });
});

describe('nothing the run does can arrive before she is waiting', () => {
  const src = readFileSync('src/proc/minds-eye.mjs', 'utf8');

  it('a test run\'s wait is recorded after the run exists and before its first step is dispatched', () => {
    const body = src.slice(src.indexOf('async function executeTriggerTool'), src.indexOf('// Test tools — the sandbox'));
    const pendAt = body.indexOf('await test.beforeDispatch(runResp.row.id)');
    const sendAt = body.indexOf("action:        'execute_top'");
    assert.ok(pendAt > -1 && sendAt > pendAt);
  });

  it('an answer\'s wait is recorded before the answer is sent', () => {
    const body = src.slice(src.indexOf('async function startAnswerGate'), src.indexOf('async function startTestRun'));
    assert.ok(body.indexOf('await pend(') > -1 && body.indexOf('await pend(') < body.indexOf('await answerGate('));
  });

  it('a rebuilt transcript closes the wait with its event, appending only', () => {
    const call = { type: 'function_call', call_id: 'fc_1', name: 'answer_gate', arguments: '{"runId":9}' };
    const items = toInputItems([
      { role: 'tool', sequence_number: 4, content: JSON.stringify({ tool: '__pending__', action: 'answer_gate', params: { runId: 9 }, runId: 9, items: [call] }) },
      { role: 'tool', sequence_number: 5, content: JSON.stringify({ tool: 'answer_gate', params: { runId: 9 }, result: { event: 'HUMAN_GATE' } }) },
    ]);
    assert.deepEqual(items, [call, { type: 'function_call_output', call_id: 'fc_1', output: '{"event":"HUMAN_GATE"}' }]);
  });
});
