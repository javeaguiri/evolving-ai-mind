// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-earlier-requests.test.mjs
//
// An earlier request's large results and call arguments render as stubs. Session 1293 ran seven
// requests in one session; every call of the last one re-read all six before it — 235K tokens of
// diagnosis and replay output a small checklist change did not need. A request starts at each
// typed user message, so the rendering is a pure function of the stored entries: every round of
// one request renders identically (the cache holds), and the next typed message rewrites it once.
//
// Run: node --test tests/unit/minds-eye-earlier-requests.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toInputItems, renderToolOutput, renderCallItems, capOutput } from '../../src/proc/minds-eye.mjs';

const gwCall  = (id, name, args) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: args, status: 'completed' });
const user    = (seq, content) => ({ role: 'user', content, sequence_number: seq });
const toolRow = (seq, t, params, result, items) => ({ role: 'tool', sequence_number: seq, content: JSON.stringify({ tool: t, params, result, items }) });
const pending = (seq, action, params, items) => ({ role: 'tool', sequence_number: seq, content: JSON.stringify({ tool: '__pending__', action, params, items }) });
const respond = (seq, id, message) => ({ role: 'assistant', sequence_number: seq,
  content: JSON.stringify({ action: 'respond', message, items: [gwCall(id, 'respond', JSON.stringify({ message }))] }) });

const BIG_RESULT = { steps: 'x'.repeat(5000) };
const BIG_ARGS   = JSON.stringify({ patch: 'p'.repeat(5000), reasoning: 'r' });

// Request 1: a large read, a large write call, a small result, her reply. Request 2 opens at seq 6.
const session = (extra = []) => [
  user(1, 'look at run 964'),
  toolRow(2, 'read_workflow_run', { runId: 964 }, BIG_RESULT, [gwCall('c2', 'read_workflow_run', '{"runId":964}')]),
  toolRow(3, 'propose_workflow_fix', { patch: 'p' }, { newVersion: 14 }, [gwCall('c3', 'propose_workflow_fix', BIG_ARGS)]),
  toolRow(4, 'query_table', { tableName: 'T' }, { count: 1 }, [gwCall('c4', 'query_table', '{"tableName":"T"}')]),
  respond(5, 'c5', 'Run 964: here is why. ' + 'm'.repeat(3000)),
  user(6, 'Yes'),
  ...extra,
];
const outputOf = (items, callId) => items.find(i => i.type === 'function_call_output' && i.call_id === callId)?.output;
const callOf   = (items, callId) => items.find(i => i.type === 'function_call' && i.call_id === callId);

describe('toInputItems — an earlier request is stubbed', () => {
  const items = toInputItems(session());

  it('a large result becomes a stub naming its entry', () => {
    const out = outputOf(items, 'c2');
    assert.ok(out.length < 400, out);
    assert.match(out, /read_session_entry\(\{ sequence: 2 \}\)/);
    assert.match(out, /read_workflow_run returned 5\d{3} characters/);
    assert.match(out, /before building on them/);
  });

  it('large call arguments become a stub that recalls the arguments, as valid JSON', () => {
    const args = callOf(items, 'c3').arguments;
    const parsed = JSON.parse(args);
    assert.match(parsed.earlier_request, /read_session_entry\(\{ sequence: 3, part: "arguments" \}\)/);
    assert.equal(callOf(items, 'c3').id, 'fc_c3', 'the gateway ids survive, so the call still pairs with its output');
  });

  it('small results and small arguments stay whole', () => {
    assert.equal(outputOf(items, 'c3'), JSON.stringify({ newVersion: 14 }));
    assert.equal(outputOf(items, 'c4'), JSON.stringify({ count: 1 }));
    assert.equal(callOf(items, 'c2').arguments, '{"runId":964}');
  });

  it('her reply and the typed message stay whole', () => {
    assert.match(callOf(items, 'c5').arguments, /m{3000}/);
    assert.equal(outputOf(items, 'c5'), capOutput(JSON.stringify({ user_reply: 'Yes' }), 6));
  });
});

describe('toInputItems — the current request is untouched', () => {
  it('a result after the latest typed message renders exactly as capOutput does', () => {
    const items = toInputItems(session([toolRow(7, 'read_workflow', {}, BIG_RESULT, [gwCall('c7', 'read_workflow', BIG_ARGS)])]));
    assert.equal(outputOf(items, 'c7'), capOutput(JSON.stringify(BIG_RESULT), 7, 'read_workflow'));
    assert.equal(callOf(items, 'c7').arguments, BIG_ARGS);
  });

  it('a session with one request renders as before', () => {
    const one = session().slice(0, 5);
    assert.equal(outputOf(toInputItems(one), 'c2'), capOutput(JSON.stringify(BIG_RESULT), 2, 'read_workflow_run'));
  });

  it('a gated call pending in the current request keeps its arguments', () => {
    const items = toInputItems(session([pending(7, 'register_workflow', { steps: 's' }, [gwCall('c7', 'register_workflow', BIG_ARGS)])]));
    assert.equal(callOf(items, 'c7').arguments, BIG_ARGS);
  });

  it('an earlier gated call and the result that resolved it are both stubbed', () => {
    const history = [
      user(1, 'build it'),
      pending(2, 'register_workflow', { steps: 's' }, [gwCall('c2', 'register_workflow', BIG_ARGS)]),
      toolRow(3, 'register_workflow', { steps: 's' }, BIG_RESULT),
      user(4, 'thanks'),
    ];
    const items = toInputItems(history);
    assert.match(JSON.parse(callOf(items, 'c2').arguments).earlier_request, /sequence: 2, part: "arguments"/);
    assert.match(outputOf(items, 'c2'), /sequence: 3 \}/);
  });
});

describe('toInputItems — the cache holds within a request', () => {
  it('each round of one request renders the earlier ones to the same bytes', () => {
    const roundA = toInputItems(session([toolRow(7, 'query_table', {}, BIG_RESULT, [gwCall('c7', 'query_table', '{}')])]));
    const roundB = toInputItems(session([
      toolRow(7, 'query_table', {}, BIG_RESULT, [gwCall('c7', 'query_table', '{}')]),
      toolRow(8, 'answer_gate', {}, BIG_RESULT, [gwCall('c8', 'answer_gate', '{}')]),
    ]));
    // Round B's input begins with round A's, byte for byte: an append-only prefix.
    assert.deepEqual(roundB.slice(0, roundA.length), roundA);
  });
});

describe('renderToolOutput and renderCallItems', () => {
  it('without a sequence number there is no handle, so nothing is stubbed', () => {
    assert.equal(renderToolOutput(BIG_RESULT, undefined, 't', true), capOutput(JSON.stringify(BIG_RESULT), undefined, 't'));
    const call = [gwCall('c', 't', BIG_ARGS)];
    assert.equal(renderCallItems(call, null, true), call);
  });

  it('a respond call is never stubbed', () => {
    const call = [gwCall('c', 'respond', BIG_ARGS)];
    assert.deepEqual(renderCallItems(call, 4, true), call);
  });
});
