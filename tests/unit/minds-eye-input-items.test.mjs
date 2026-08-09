// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-input-items.test.mjs
//
// Covers toInputItems — persisted PGC_SessionEntry rows to the canonical item array.
//
// The gate case carries the most weight: a gated action spans two entries (the __pending__
// that posted the gate, and whatever resolved it) and must come back as ONE call with one
// output. Emitting two calls would show the model the same destructive action requested
// twice, which is how a re-approval loop starts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toInputItems } from '../../src/proc/minds-eye.mjs';

const user      = (seq, content) => ({ role: 'user', content, sequence_number: seq });
const assistant = (seq, message) => ({ role: 'assistant', sequence_number: seq, content: JSON.stringify({ action: 'respond', message, reasoning: 'r', advisory: 'a' }) });
const tool      = (seq, t, params, result) => ({ role: 'tool', sequence_number: seq, content: JSON.stringify({ tool: t, params, result }) });
const pendingE  = (seq, action, params) => ({ role: 'tool', sequence_number: seq, content: JSON.stringify({ tool: '__pending__', action, params }) });
const cancelled = (seq, action, params) => ({ role: 'tool', sequence_number: seq, content: JSON.stringify({ tool: '__cancelled__', action, params }) });

describe('toInputItems — plain entries', () => {
  it('returns nothing for an empty history', () => {
    assert.deepEqual(toInputItems([]), []);
    assert.deepEqual(toInputItems(), []);
  });

  it('carries a user entry through as raw text', () => {
    assert.deepEqual(toInputItems([user(1, 'fix the flashcards count')]),
      [{ role: 'user', content: 'fix the flashcards count' }]);
  });

  it('renders a respond entry as an assistant message, dropping per-turn scratch', () => {
    const items = toInputItems([assistant(2, 'Here is what I found.')]);
    assert.deepEqual(items, [{ role: 'assistant', content: 'Here is what I found.' }]);
  });

  it('falls back to raw content when an assistant entry will not parse', () => {
    const items = toInputItems([{ role: 'assistant', sequence_number: 3, content: 'not json' }]);
    assert.deepEqual(items, [{ role: 'assistant', content: 'not json' }]);
  });

  it('expands a tool entry into a call and its output', () => {
    const items = toInputItems([tool(4, 'list_tables', { domain: 'flashcards' }, { tables: ['PGD_Cards'] })]);
    assert.deepEqual(items, [
      { type: 'function_call',        call_id: 'call_4', name: 'list_tables', arguments: '{"domain":"flashcards"}' },
      { type: 'function_call_output', call_id: 'call_4', output: '{"tables":["PGD_Cards"]}' },
    ]);
  });

  it('pairs every call with an output of the same call_id', () => {
    const items = toInputItems([
      user(1, 'go'), tool(2, 'list_tables', {}, { ok: 1 }), tool(3, 'query_table', {}, { ok: 2 }),
    ]);
    const calls   = items.filter(i => i.type === 'function_call');
    const outputs = items.filter(i => i.type === 'function_call_output');
    assert.equal(calls.length, outputs.length);
    assert.deepEqual(calls.map(c => c.call_id), outputs.map(o => o.call_id));
  });

  it('skips an unreadable tool entry rather than emitting a malformed call', () => {
    const items = toInputItems([{ role: 'tool', sequence_number: 5, content: '{{{' }, user(6, 'hi')]);
    assert.deepEqual(items, [{ role: 'user', content: 'hi' }]);
  });

  it('tolerates a tool entry with no params or result', () => {
    const items = toInputItems([{ role: 'tool', sequence_number: 7, content: JSON.stringify({ tool: 'list_tables' }) }]);
    assert.deepEqual(items, [
      { type: 'function_call',        call_id: 'call_7', name: 'list_tables', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_7', output: 'null' },
    ]);
  });
});

describe('toInputItems — the gate, which spans two entries', () => {
  it('an approved gate is ONE call whose output is the execution result', () => {
    const items = toInputItems([
      pendingE(10, 'delete_data', { tableName: 'PGD_Cards' }),
      tool(11, 'delete_data', { tableName: 'PGD_Cards' }, { deleted: 3 }),
    ]);

    assert.equal(items.filter(i => i.type === 'function_call').length, 1,
      'the same destructive action must not appear as two separate calls');
    assert.deepEqual(items, [
      { type: 'function_call',        call_id: 'call_10', name: 'delete_data', arguments: '{"tableName":"PGD_Cards"}' },
      { type: 'function_call_output', call_id: 'call_10', output: '{"deleted":3}' },
    ]);
  });

  it('a cancelled gate closes the same call with a cancellation', () => {
    const items = toInputItems([
      pendingE(10, 'drop_table', { tableName: 'PGD_Orphan' }),
      cancelled(11, 'drop_table', { tableName: 'PGD_Orphan' }),
    ]);
    assert.deepEqual(items, [
      { type: 'function_call',        call_id: 'call_10', name: 'drop_table', arguments: '{"tableName":"PGD_Orphan"}' },
      { type: 'function_call_output', call_id: 'call_10', output: '{"cancelled":true}' },
    ]);
  });

  it('an unanswered gate is still closed — the user can ignore it and just say something else', () => {
    const items = toInputItems([
      pendingE(10, 'delete_data', { tableName: 'PGD_Cards' }),
      user(11, 'actually, look at the recipes instead'),
    ]);
    assert.deepEqual(items, [
      { type: 'function_call',        call_id: 'call_10', name: 'delete_data', arguments: '{"tableName":"PGD_Cards"}' },
      { type: 'function_call_output', call_id: 'call_10', output: '{"status":"awaiting_approval"}' },
      { role: 'user', content: 'actually, look at the recipes instead' },
    ]);
  });

  it('a gate left open at the end of the history is closed too', () => {
    const items = toInputItems([user(1, 'go'), pendingE(2, 'drop_view', { tableName: 'V' })]);
    assert.equal(items.at(-1).type, 'function_call_output');
    assert.equal(items.at(-1).output, '{"status":"awaiting_approval"}');
  });

  it('a different tool after a gate does not steal the pending call', () => {
    const items = toInputItems([
      pendingE(10, 'delete_data', { tableName: 'PGD_Cards' }),
      tool(11, 'list_tables', {}, { tables: [] }),
    ]);
    const calls = items.filter(i => i.type === 'function_call');
    assert.deepEqual(calls.map(c => c.name), ['delete_data', 'list_tables']);
    assert.equal(items[1].output, '{"status":"awaiting_approval"}', 'the gate is closed on its own terms');
  });

  it('a stray cancellation with no open gate is dropped', () => {
    const items = toInputItems([user(1, 'go'), cancelled(2, 'delete_data', {})]);
    assert.deepEqual(items, [{ role: 'user', content: 'go' }]);
  });
});

describe('toInputItems — truncation', () => {
  it('caps a large tool result', () => {
    const huge  = 'x'.repeat(40000);
    const items = toInputItems([tool(1, 'run_sql', {}, { rows: huge })]);
    const out   = items.find(i => i.type === 'function_call_output').output;
    assert.ok(out.length < 20000, 'output must be capped');
    assert.ok(out.endsWith('...[truncated]'), 'and say so, rather than ending mid-value');
  });

  it('NEVER caps a call arguments — that is Novia\'s own submitted work', () => {
    // Sprint 9's largest defect was her losing sight of step arrays she had submitted.
    const steps = Array.from({ length: 400 }, (_, i) => ({ step: String(i), type: 'serv_query', input: { tableName: 'PGD_X' } }));
    const items = toInputItems([tool(1, 'register_workflow', { name: 'w', steps }, { ok: true })]);
    const args  = JSON.parse(items.find(i => i.type === 'function_call').arguments);
    assert.equal(args.steps.length, 400, 'every submitted step must survive the rebuild');
  });
});

describe('toInputItems — a whole round', () => {
  it('rebuilds a realistic session in order', () => {
    const items = toInputItems([
      user(1, 'the flashcard count is wrong'),
      tool(2, 'search_domain_help', { query: 'flashcards' }, { domain: 'flashcards' }),
      tool(3, 'list_tables', { domain: 'flashcards' }, { tables: ['PGD_Cards'] }),
      pendingE(4, 'propose_schema_fix', { operation: 'dropColumn', tableName: 'PGD_Cards' }),
      tool(5, 'propose_schema_fix', { operation: 'dropColumn', tableName: 'PGD_Cards' }, { applied: true }),
      assistant(6, 'Dropped the denormalised column.'),
    ]);

    assert.deepEqual(items.map(i => i.type ?? i.role), [
      'user',
      'function_call', 'function_call_output',
      'function_call', 'function_call_output',
      'function_call', 'function_call_output',
      'assistant',
    ]);
    assert.equal(items.filter(i => i.type === 'function_call').length, 3);
  });
});

// ---------------------------------------------------------------------------
// Replayed gateway items — what earns the prefix-cache credit on a resume
//
// A resumed round has to reproduce the previous round's items byte for byte or the
// credit is lost at the first divergence. Reconstructing a call from {tool, params}
// cannot do that: params has already had reasoning/message/advisory stripped out of
// the arguments string the model actually sent. So the raw items are persisted and
// replayed. These tests pin the replay, and pin the fallback for every entry written
// before `items` existed.
// ---------------------------------------------------------------------------

const gwCall = (id, name, args) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: args, status: 'completed' });

const toolWithItems = (seq, t, params, result, gwItems) => ({
  role: 'tool', sequence_number: seq,
  content: JSON.stringify({ tool: t, params, result, items: gwItems }),
});

const pendingWithItems = (seq, action, params, gwItems) => ({
  role: 'tool', sequence_number: seq,
  content: JSON.stringify({ tool: '__pending__', action, params, items: gwItems }),
});

describe('toInputItems — replayed gateway items', () => {
  it('replays a persisted call verbatim rather than rebuilding it', () => {
    const raw   = gwCall('toolu_01AqHNY', 'list_tables', '{"domain":"flashcards","reasoning":"checking the registry"}');
    const items = toInputItems([toolWithItems(4, 'list_tables', { domain: 'flashcards' }, { tables: ['PGD_Cards'] }, [raw])]);

    // Verbatim: the id and status the gateway assigned survive, and `arguments` keeps
    // the reasoning key that params does not carry.
    assert.deepEqual(items[0], raw);
    assert.deepEqual(items[1], {
      type: 'function_call_output', call_id: 'toolu_01AqHNY', output: '{"tables":["PGD_Cards"]}',
    });
  });

  it('attaches the output to the gateway call_id, not the synthesised one', () => {
    const items = toInputItems([
      toolWithItems(7, 'query_table', {}, { rows: [] }, [gwCall('toolu_ZZZ', 'query_table', '{}')]),
    ]);
    assert.equal(items[1].call_id, 'toolu_ZZZ');
    assert.ok(!items.some(i => i.call_id === 'call_7'), 'no synthesised id should appear');
  });

  it('replays every item of a turn, not only the function_call', () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] };
    const raw       = gwCall('toolu_A', 'list_tables', '{}');
    const items     = toInputItems([toolWithItems(2, 'list_tables', {}, { ok: 1 }, [reasoning, raw])]);
    assert.deepEqual(items.slice(0, 2), [reasoning, raw]);
    assert.equal(items[2].call_id, 'toolu_A');
  });

  it('pairs a replayed __pending__ with its resolution as ONE call', () => {
    const raw   = gwCall('toolu_GATE', 'register_workflow', '{"name":"w","reasoning":"ready"}');
    const items = toInputItems([
      pendingWithItems(4, 'register_workflow', { name: 'w' }, [raw]),
      tool(5, 'register_workflow', { name: 'w' }, { registered: true, id: 357 }),
    ]);

    assert.equal(items.filter(i => i.type === 'function_call').length, 1, 'one call, not two');
    assert.deepEqual(items[0], raw);
    assert.deepEqual(items[1], {
      type: 'function_call_output', call_id: 'toolu_GATE', output: '{"registered":true,"id":357}',
    });
  });

  it('closes a replayed __pending__ that a cancellation resolved', () => {
    const raw   = gwCall('toolu_GATE', 'drop_table', '{"tableName":"PGD_X"}');
    const items = toInputItems([
      pendingWithItems(4, 'drop_table', { tableName: 'PGD_X' }, [raw]),
      cancelled(5, 'drop_table', { tableName: 'PGD_X' }),
    ]);
    assert.deepEqual(items, [raw, { type: 'function_call_output', call_id: 'toolu_GATE', output: '{"cancelled":true}' }]);
  });

  it('caps a replayed call output but never the replayed arguments', () => {
    const big   = 'x'.repeat(40000);
    const raw   = gwCall('toolu_B', 'run_sql', JSON.stringify({ sql: big }));
    const items = toInputItems([toolWithItems(1, 'run_sql', { sql: big }, { rows: big }, [raw])]);
    assert.equal(items[0].arguments.length, raw.arguments.length, 'arguments untouched');
    assert.ok(items[1].output.endsWith('...[truncated]'), 'output capped');
  });

  it('falls back to synthesis for entries written before items existed', () => {
    const items = toInputItems([tool(4, 'list_tables', { domain: 'flashcards' }, { tables: [] })]);
    assert.deepEqual(items, [
      { type: 'function_call',        call_id: 'call_4', name: 'list_tables', arguments: '{"domain":"flashcards"}' },
      { type: 'function_call_output', call_id: 'call_4', output: '{"tables":[]}' },
    ]);
  });

  it('falls back when items carries no function_call to attach an output to', () => {
    const items = toInputItems([toolWithItems(4, 'list_tables', {}, { ok: 1 }, [{ type: 'reasoning', id: 'rs_1' }])]);
    assert.deepEqual(items.map(i => i.type), ['function_call', 'function_call_output']);
    assert.equal(items[0].call_id, 'call_4');
  });

  it('mixes replayed and synthesised entries without a call_id collision', () => {
    const items = toInputItems([
      user(1, 'go'),
      tool(2, 'list_tables', {}, { ok: 1 }),
      toolWithItems(3, 'query_table', {}, { ok: 2 }, [gwCall('toolu_C', 'query_table', '{}')]),
    ]);
    const ids = items.filter(i => i.type === 'function_call').map(i => i.call_id);
    assert.deepEqual(ids, ['call_2', 'toolu_C']);
    assert.equal(new Set(ids).size, ids.length, 'call_ids must stay unique');
  });
});
