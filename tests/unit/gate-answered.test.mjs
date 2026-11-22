// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/gate-answered.test.mjs
//
// Sprint 18 items 6 and 7, decision W (docs/arch-web-app.md §8): once resumeGate accepts an answer
// it sends GATE_ANSWERED — the option's label, a form's changes, where it was answered. The inbox
// keeps it, so the web draws the answer under its question; Slack takes the buttons off a gate
// answered elsewhere, finding its message in the run's thread by the gate_id its buttons carry.
// Real functions throughout — gateAnsweredMessage, dispatchSqs, answerGate, the callback listener —
// with SERV, SQS and Slack stubbed.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert                                  from 'node:assert/strict';
import { SQSClient }                           from '@aws-sdk/client-sqs';
import { WebClient }                           from '@slack/web-api';

import { gateAnsweredMessage, dispatchSqs }    from '../../src/proc/run-workflow.mjs';
import { answerGate }                          from '../../src/proc/gates.mjs';
import { handler as callbackListener, gateAnsweredText, carriesGate } from '../../src/ui/slackbot/callback.mjs';
import { countChanges }                        from '../../src/shared/form-changes.mjs';

const SLACK = { provider: 'slack', channel: 'C1', threadId: '1.0' };
const realSend = SQSClient.prototype.send, realFetch = globalThis.fetch, realRequest = WebClient.prototype.makeRequest;
afterEach(() => { SQSClient.prototype.send = realSend; globalThis.fetch = realFetch; WebClient.prototype.makeRequest = realRequest; });

const options = [{ action: 'save', label: 'Save' }, { action: 'cancel', label: 'Cancel', on_select: 'cancel' }];
const formStep = { step: '3', gate_type: 'form', message_template: 'Edit', options,
  fields: [{ name: 'a', type: 'number', default: 5 }, { name: 'b', default: '{{x}}' }, { name: 'c', type: 'multi_select', options: [{ value: 'p', label: 'P' }], default: ['p'] }] };
const frameOf = (step, extra = {}) => ({ type: 'human_gate', gate_id: 'g-1', gate_type: step.gate_type, step_ref: step, local_state: { x: 'hi' }, step_number: 3, ...extra });

describe('gateAnsweredMessage — the answer, as the person\'s surfaces are told it', () => {
  const run = { id: 9, callback: SLACK };

  it('names the gate, the option\'s label and where it was answered', () => {
    assert.deepEqual(gateAnsweredMessage(run, frameOf({ gate_type: 'confirm', message_template: 'Go?', options }), { option: options[0], userResponse: 'save', answeredIn: 'web', traceId: 't' }),
      { type: 'GATE_ANSWERED', workflowRunId: 9, gateId: 'g-1', label: 'Save', answeredIn: 'web', traceId: 't' });
  });

  it('a form counts the inputs that moved from where they opened, as the web does', () => {
    const msg = gateAnsweredMessage(run, frameOf(formStep), { option: options[0], userResponse: 'save',
      responseData: { formValues: { a: 7, b: 'hi', c: ['p'] } }, answeredIn: 'slack' });
    assert.equal(msg.changes, 1);
    assert.equal(gateAnsweredMessage(run, frameOf(formStep), { option: options[0], userResponse: 'save', responseData: { formValues: { a: 5, b: ' hi ', c: ['p'] } }, answeredIn: 'web' }).changes, undefined);
    assert.equal(gateAnsweredMessage(run, frameOf(formStep), { option: options[1], userResponse: 'cancel', responseData: { formValues: { a: 1 } }, answeredIn: 'web' }).changes, undefined, 'a cancel changed nothing');
  });

  it('an empty multi-select answered as null is unchanged from one that opened empty', () => {
    const inputs = [{ name: 'c', input_type: 'multi_select' }];
    assert.equal(countChanges(inputs, { c: null }), 0);
    assert.equal(countChanges(inputs, { c: ['q'] }), 1);
  });

  it('no option matched: the response itself is the label', () => {
    assert.equal(gateAnsweredMessage(run, frameOf({ gate_type: 'confirm', options }), { option: null, userResponse: 'drill', answeredIn: 'web' }).label, 'drill');
  });

  it('only a person\'s run is told — never a test run\'s, nor a gate without an id', () => {
    const frame = frameOf({ gate_type: 'confirm', options });
    assert.equal(gateAnsweredMessage({ id: 9, callback: { provider: 'novia', sessionId: 4 } }, frame, { userResponse: 'save' }), null);
    assert.equal(gateAnsweredMessage({ id: 9, callback: null }, frame, { userResponse: 'save' }), null);
    assert.equal(gateAnsweredMessage(run, { ...frame, gate_id: undefined }, { userResponse: 'save' }), null);
  });
});

describe('resumeGate sends it once the answer is accepted', () => {
  let serv, sqs;
  const run = status => ({ id: 9, status, callback: SLACK, stack: [
    { type: 'workflow', frame_id: 'f-0', workflow_name: 'w', current_step: '3', local_state: {} },
    frameOf({ gate_type: 'confirm', message_template: 'Go?', options }, { frame_id: 'f-1' }),
  ] });

  beforeEach(() => {
    serv = []; sqs = [];
    process.env.SERV_API_URL = 'https://serv.test';
    process.env.SQS_SLACK_RESULTS_URL = 'slack-results';
    process.env.SQS_WORKFLOW_URL = 'workflow-queue';
    SQSClient.prototype.send = async function (command) { sqs.push({ queue: command.input.QueueUrl, body: JSON.parse(command.input.MessageBody) }); return {}; };
  });
  const stubServ = row => {
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      serv.push({ path: new URL(url).pathname, body });
      const rows = /getRows/.test(url) && body.tableName === 'PGC_WorkflowRun' ? [row] : [];
      return new Response(JSON.stringify({ success: true, rows, count: rows.length }), { status: 200 });
    };
  };
  const inboxRows = () => serv.filter(c => /insertRow/.test(c.path) && c.body.tableName === 'PGC_UiMessage').map(c => c.body.row);

  it('a web answer: kept in the inbox, and sent to Slack to take the buttons off', async () => {
    stubServ(run('awaiting_human_gate'));
    await dispatchSqs({ action: 'resume_gate', workflowRunId: 9, gateId: 'g-1', userResponse: 'cancel', answeredIn: 'web', traceId: 't' });
    const [answer] = inboxRows();
    assert.equal(answer.message_type, 'GATE_ANSWERED');
    assert.deepEqual([answer.payload.gateId, answer.payload.label, answer.payload.answeredIn], ['g-1', 'Cancel', 'web']);
    const toSlack = sqs.filter(m => m.queue === 'slack-results').map(m => m.body.type);
    assert.deepEqual(toSlack, ['GATE_ANSWERED', 'HUMAN_NOTIFICATION'], 'the answer before what followed it');
  });

  it('a Slack click is answered in Slack', async () => {
    stubServ(run('awaiting_human_gate'));
    await dispatchSqs({ action: 'resume_gate', workflowRunId: 9, gateId: 'g-1', userResponse: 'cancel', slackUserId: 'U1', message_ts: '1.5', traceId: 't' });
    assert.equal(inboxRows()[0].payload.answeredIn, 'slack');
  });

  it('a refused answer sends none', async () => {
    stubServ(run('awaiting_human_gate'));
    await dispatchSqs({ action: 'resume_gate', workflowRunId: 9, gateId: 'g-old', userResponse: 'cancel', answeredIn: 'web', traceId: 't' });
    assert.deepEqual(inboxRows(), []);
  });

  it('answerGate says where it was answered — the web, or her', async () => {
    stubServ(run('awaiting_human_gate'));
    await answerGate(9, { gateId: 'g-1', action: 'save' }, 't');
    await answerGate(9, { gateId: 'g-1', action: 'save' }, 't', 'minds_eye');
    assert.deepEqual(sqs.filter(m => m.body.action === 'resume_gate').map(m => m.body.answeredIn), ['web', 'minds_eye']);
  });
});

describe('Slack takes the buttons off a gate answered elsewhere', () => {
  const button = gateId => ({ type: 'button', value: JSON.stringify({ workflowRunId: 9, gateId, action: 'save', label: 'Save' }) });
  const gateMessage = (ts, gateId) => ({ ts, text: 'Go?', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Go?' } }, { type: 'actions', elements: [button(gateId)] }] });
  let calls;
  const stubSlack = (replies) => {
    calls = [];
    WebClient.prototype.makeRequest = async function (url, options) {
      const method = String(url).split('/api/').pop();
      calls.push({ method, options });
      if (method === 'conversations.replies') {
        if (replies instanceof Error) throw replies;
        return { status: 200, headers: {}, data: { ok: true, messages: replies }, request: { path: `/api/${method}` } };
      }
      return { status: 200, headers: {}, data: { ok: true }, request: { path: `/api/${method}` } };
    };
  };
  const deliver = message => callbackListener({ Records: [{ messageId: 'm', body: JSON.stringify({ callback: SLACK, workflowRunId: 9, gateId: 'g-1', label: 'Save', traceId: 't', type: 'GATE_ANSWERED', ...message }) }] });

  it('the line that takes the buttons\' place', () => {
    assert.equal(gateAnsweredText({ label: 'Save', answeredIn: 'web' }), '✅ Save — answered on the web');
    assert.equal(gateAnsweredText({ label: 'Save', changes: 3, answeredIn: 'minds_eye' }), '✅ Save — answered elsewhere · 3 changes');
    assert.equal(gateAnsweredText({ label: 'Save', changes: 1, answeredIn: 'web' }), '✅ Save — answered on the web · 1 change');
  });

  it('finds the gate\'s message by the gate_id its buttons carry, and keeps its content', async () => {
    assert.equal(carriesGate(gateMessage('1.1', 'g-1'), 'g-1'), true);
    assert.equal(carriesGate(gateMessage('1.1', 'g-10'), 'g-1'), false);
    stubSlack([{ ts: '1.0', text: 'Started' }, gateMessage('1.1', 'g-0'), gateMessage('1.2', 'g-1')]);
    const result = await deliver({ answeredIn: 'web' });
    assert.deepEqual(result, { batchItemFailures: [] });
    const updates = calls.filter(c => c.method === 'chat.update');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].options.ts, '1.2');
    const blocks = JSON.parse(typeof updates[0].options.blocks === 'string' ? updates[0].options.blocks : JSON.stringify(updates[0].options.blocks));
    assert.deepEqual(blocks.map(b => b.type), ['section', 'context']);
    assert.match(JSON.stringify(blocks[1]), /✅ Save — answered on the web/);
  });

  it('one answered in Slack needs nothing: its click already did it', async () => {
    stubSlack([gateMessage('1.2', 'g-1')]);
    await deliver({ answeredIn: 'slack' });
    assert.deepEqual(calls, []);
  });

  it('a thread the bot cannot read leaves the message as it is, without a retry', async () => {
    const refused = Object.assign(new Error('An API error occurred: missing_scope'), { data: { ok: false, error: 'missing_scope' } });
    stubSlack(refused);
    WebClient.prototype.makeRequest = async function (url) {
      calls.push({ method: String(url).split('/api/').pop() });
      throw refused;
    };
    const result = await deliver({ answeredIn: 'web' });
    assert.deepEqual(result, { batchItemFailures: [] });
    assert.deepEqual(calls.map(c => c.method), ['conversations.replies']);
  });
});
