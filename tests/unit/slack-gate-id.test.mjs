// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/slack-gate-id.test.mjs
//
// Sprint 16 scope 6 (docs/arch-web-app.md §2.2, §8): Slack's buttons name the gate they were drawn
// for, the click carries it into resume_gate, and a click resumeGate refuses is told to the person
// who made it, privately. Real functions throughout — dialogToBlocks, interactive.handle,
// gateMovedNotice — with SQS, Slack and the network stubbed.

import { describe, it, afterEach } from 'node:test';
import assert                      from 'node:assert/strict';
import { SQSClient }               from '@aws-sdk/client-sqs';
import { WebClient }               from '@slack/web-api';

import { dialogToBlocks, GATE_MOVED_TEXT } from '../../src/ui/slackbot/callback.mjs';
import { handle as interactive }           from '../../src/ui/slackbot/interactive.mjs';
import { gateMovedNotice }                 from '../../src/proc/run-workflow.mjs';
import { buildDialog }                     from '../../src/proc/step-executor.mjs';

const realSend  = SQSClient.prototype.send;
const realFetch = globalThis.fetch;
const realRequest = WebClient.prototype.makeRequest;
afterEach(() => { SQSClient.prototype.send = realSend; globalThis.fetch = realFetch; WebClient.prototype.makeRequest = realRequest; });

const values = blocks => blocks.flatMap(b => (b.elements ?? []).filter(e => e.type === 'button').map(e => JSON.parse(e.value)));

describe('every workflow-gate button names its gate', () => {
  const options = [{ action: 'save', label: 'Save' }, { action: 'cancel', label: 'Cancel', on_select: 'cancel' }];
  const dialog  = (step, gateId) => ({ ...buildDialog({ message_template: 'Pick', ...step }, {}), ...(gateId ? { gate_id: gateId } : {}) });

  it('an options button row', () => {
    const blocks = dialogToBlocks(dialog({ gate_type: 'confirm', options }, 'g-1'), 9, 'confirm');
    const all = values(blocks);
    assert.equal(all.length, 2);
    assert.ok(all.every(v => v.gateId === 'g-1' && v.workflowRunId === 9));
  });

  it('a choice drawn as a dropdown: its Select and its Cancel', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ value: `m${i}`, label: `Month ${i}` })).concat([{ value: 'cancel', label: 'Cancel', on_select: 'cancel' }]);
    const blocks = dialogToBlocks(dialog({ gate_type: 'choice', option_source: 'dynamic', options: many }, 'g-2'), 9, 'choice');
    const all = values(blocks);
    assert.ok(all.length >= 2);
    assert.ok(all.every(v => v.gateId === 'g-2'));
  });

  it('a gate drawn without an id draws buttons without one, as before', () => {
    const blocks = dialogToBlocks(dialog({ gate_type: 'confirm', options }), 9, 'confirm');
    assert.ok(values(blocks).every(v => !('gateId' in v)));
  });
});

describe('a click carries the gate into resume_gate', () => {
  it('interactive.handle puts the button\'s gateId and the clicker on the message', async () => {
    const sent = [];
    SQSClient.prototype.send = async function (command) { sent.push(command.input); return {}; };
    globalThis.fetch = async () => new Response('ok', { status: 200 });   // response_url update
    WebClient.prototype.makeRequest = async () => ({ status: 200, headers: {}, data: { ok: true }, request: { path: '/api/chat.update' } }); // no call leaves the test
    process.env.SQS_WORKFLOW_URL = 'workflow-queue';

    const payload = {
      type: 'block_actions', user: { id: 'U1' }, channel: { id: 'C1' }, container: { message_ts: '1.2' },
      response_url: 'https://hooks.test/r', message: { text: 'Save?', blocks: [] },
      actions: [{ action_id: 'workflow_action_save_0', value: JSON.stringify({ workflowRunId: 9, gateId: 'g-1', action: 'save', label: 'Save' }) }],
      state: { values: {} },
    };
    await interactive({ method: 'POST', body: { payload: JSON.stringify(payload) }, correlationId: 'c' });

    const resume = sent.map(s => JSON.parse(s.MessageBody)).find(m => m.action === 'resume_gate');
    assert.equal(resume.gateId, 'g-1');
    assert.equal(resume.slackUserId, 'U1');
    assert.equal(resume.workflowRunId, 9);
  });
});

describe('a refused click is told to the person who made it', () => {
  const run = { id: 9, callback: { provider: 'slack', channel: 'C1', threadId: '1.0' } };

  it('a Slack click that named its gate gets a GATE_MOVED notice for that user', () => {
    assert.deepEqual(gateMovedNotice(run, { gateId: 'g-1', slackUserId: 'U1', traceId: 't' }),
      { type: 'GATE_MOVED', workflowRunId: 9, gateId: 'g-1', slackUserId: 'U1', traceId: 't' });
  });

  it('no notice for a click that named no gate, carried no user, or a run that is not Slack\'s', () => {
    assert.equal(gateMovedNotice(run, { gateId: undefined, slackUserId: 'U1' }), null);
    assert.equal(gateMovedNotice(run, { gateId: 'g-1', slackUserId: undefined }), null);
    assert.equal(gateMovedNotice({ id: 9, callback: { provider: 'web', channel: 'sub-a' } }, { gateId: 'g-1', slackUserId: 'U1' }), null);
  });

  it('the notice says the click was not applied', () => {
    assert.match(GATE_MOVED_TEXT, /Already answered/);
    assert.match(GATE_MOVED_TEXT, /not applied/);
  });
});
