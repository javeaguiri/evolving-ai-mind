// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-parallel-turn.test.mjs
//
// A turn that makes several calls sits in the loop's own input as every call, then every
// output: input.push(...turnItems), then one recordToolOutput per call. It is stored one entry
// per call, and the rebuild used to close each call as it read it, giving call, output, call,
// output. Session 1307's call 28 began a new round mid-request after the parallel turn in
// entries 30 and 31, and read back only 28,870 of 54,030 tokens.
//
// Run: node --test tests/unit/minds-eye-parallel-turn.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toInputItems, capOutput } from '../../src/proc/minds-eye.mjs';

const call = (id, name, args = '{}') => ({ type: 'function_call', call_id: id, name, arguments: args });
const out  = (id, result, seq, tool) => ({ type: 'function_call_output', call_id: id, output: capOutput(JSON.stringify(result), seq, tool) });

// Entries as the loop persists them: the turn's leading items ride on its first call.
const toolEntry = (seq, tool, result, items, turn) => ({
  role: 'tool', sequence_number: seq,
  content: JSON.stringify({ tool, params: {}, result, items, turn }),
});
const pendingEntry = (seq, action, items, turn) => ({
  role: 'tool', sequence_number: seq,
  content: JSON.stringify({ tool: '__pending__', action, params: {}, items, turn }),
});
const respondEntry = (seq, items, turn) => ({
  role: 'assistant', sequence_number: seq,
  content: JSON.stringify({ action: 'respond', message: 'done', items, turn }),
});
const user = (seq, content) => ({ role: 'user', sequence_number: seq, content });

describe('toInputItems — a turn with several calls', () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] };
  const a = call('toolu_A', 'update_data');
  const b = call('toolu_B', 'update_data');

  it('renders the calls first, then the outputs, as the loop holds them', () => {
    const items = toInputItems([
      user(1, 'set the targets'),
      toolEntry(2, 'update_data', { n: 1 }, [reasoning, a], 19),
      toolEntry(3, 'update_data', { n: 2 }, [b], 19),
    ]);
    assert.deepEqual(items, [
      { role: 'user', content: 'set the targets' },
      reasoning, a, b,
      out('toolu_A', { n: 1 }, 2, 'update_data'),
      out('toolu_B', { n: 2 }, 3, 'update_data'),
    ]);
  });

  it('keeps one call per turn as call, output, call, output', () => {
    const items = toInputItems([
      toolEntry(2, 'update_data', { n: 1 }, [a], 19),
      toolEntry(3, 'update_data', { n: 2 }, [b], 20),
    ]);
    assert.deepEqual(items, [a, out('toolu_A', { n: 1 }, 2, 'update_data'), b, out('toolu_B', { n: 2 }, 3, 'update_data')]);
  });

  it('holds the outputs of a turn whose last call was gated, until the gate resolves', () => {
    const g = call('toolu_G', 'propose_schema_fix');
    const items = toInputItems([
      toolEntry(2, 'run_sql', { rows: 1 }, [a], 7),
      pendingEntry(3, 'propose_schema_fix', [g], 7),
      toolEntry(4, 'propose_schema_fix', { success: true }, undefined, undefined),
    ]);
    assert.deepEqual(items, [
      a, g,
      out('toolu_A', { rows: 1 }, 2, 'run_sql'),
      { type: 'function_call_output', call_id: 'toolu_G', output: '{"success":true}' },
    ]);
  });

  it('puts a respond made in the same turn among its calls, closed by the reply after', () => {
    const r = call('toolu_R', 'respond', '{"message":"done"}');
    const items = toInputItems([
      toolEntry(2, 'write_memory', { ok: 1 }, [a], 9),
      respondEntry(3, [r], 9),
      user(4, 'thanks'),
    ]);
    assert.deepEqual(items, [
      a, r,
      out('toolu_A', { ok: 1 }, 2, 'write_memory'),
      { type: 'function_call_output', call_id: 'toolu_R', output: capOutput(JSON.stringify({ user_reply: 'thanks' }), 4) },
    ]);
  });

  it('leaves entries written without a turn in the order they were read', () => {
    const items = toInputItems([
      toolEntry(2, 'update_data', { n: 1 }, [a], undefined),
      toolEntry(3, 'update_data', { n: 2 }, [b], undefined),
    ]);
    assert.deepEqual(items, [a, out('toolu_A', { n: 1 }, 2, 'update_data'), b, out('toolu_B', { n: 2 }, 3, 'update_data')]);
  });

  it('carries the turn onto a respond entry, so a rebuild can group it', () => {
    const loopSrc = readFileSync('src/proc/minds-eye.mjs', 'utf8');
    assert.match(loopSrc, /action: 'respond', message, reasoning, advisory, items: entryItems, turn: turnCount/);
  });
});
