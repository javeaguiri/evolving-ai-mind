// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-progress.test.mjs
//
// B3 — the per-turn progress line (Sprint 9).
//
// A build runs for many turns whose only visible output is a gate or the final
// reply, so from Slack it reads as silence. Each successful turn now reports what
// it did, using the `reasoning` the decision already carries — no second model
// call. Failed tool calls are skipped: an attempt the agent is about to correct
// describes flailing, not progress.
//
// Run: node --test tests/unit/minds-eye-progress.test.mjs

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { turnSucceeded, describeTurnAction } from '../../src/proc/minds-eye.mjs';

const procSrc = readFileSync('src/proc/minds-eye.mjs', 'utf8');

describe('which turns get reported', () => {

  it('reports a tool that returned data', () => {
    assert.equal(turnSucceeded({ count: 3, rows: [{ id: 1 }] }), true);
  });

  it('reports a successful write', () => {
    assert.equal(turnSucceeded({ success: true, workflow_id: 42 }), true);
  });

  it('skips a malformed request the agent is about to correct', () => {
    assert.equal(turnSucceeded({ error: 'tableName is required' }), false);
  });

  it('skips a write that reached the database and failed there', () => {
    assert.equal(turnSucceeded({ success: false, error: 'duplicate key' }), false);
  });

  it('skips a bare success:false even with no error string', () => {
    assert.equal(turnSucceeded({ success: false }), false);
  });

  it('reports an empty but valid result — no rows found is an answer', () => {
    assert.equal(turnSucceeded({ count: 0, rows: [] }), true);
  });

  it('treats a non-object result as nothing having failed', () => {
    assert.equal(turnSucceeded(null), true);
    assert.equal(turnSucceeded(undefined), true);
    assert.equal(turnSucceeded('ok'), true);
  });
});

describe('where the progress line is emitted', () => {

  const branch = name => {
    const re = new RegExp(`console\\.info\\('proc/minds-eye: ${name} executed'`);
    const idx = procSrc.search(re);
    assert.ok(idx > -1, `branch "${name}" not found`);
    return procSrc.slice(Math.max(0, idx - 400), idx);
  };

  for (const name of ['read tool', 'housekeeping tool', 'write tool', 'trigger tool']) {
    it(`reports after a ${name} runs`, () => {
      assert.match(branch(name), /notifyTurnProgress/);
    });
  }

  it('does not report before the final reply — respond already posts its own message', () => {
    const respondBlock = procSrc.match(/if \(action === 'respond'\) \{[\s\S]*?break;/)?.[0] ?? '';
    assert.ok(respondBlock.length > 0);
    // A CALL, not a mention — the block is allowed to explain why it does not report.
    assert.doesNotMatch(respondBlock, /notifyTurnProgress\(/);
  });

  it('does not report before a gated write — the gate is the message', () => {
    const gatedBlock = procSrc.match(/\} else if \(GATED_WRITE_TOOLS\.has\(action\)\) \{[\s\S]*?break;/)?.[0] ?? '';
    assert.ok(gatedBlock.length > 0);
    assert.doesNotMatch(gatedBlock, /notifyTurnProgress\(/);
  });

  it('costs no extra model call — the line is built from the decision already returned', () => {
    const fn = procSrc.match(/async function notifyTurnProgress[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(fn.length > 0);
    assert.doesNotMatch(fn, /callLlm/);
    assert.match(fn, /reasoning/);
  });
});

// Session 1211: two pages of a stored PGC_StepType query were reported as
// "`read_session_entry` — Read the human_gate step type contract". Both halves were true, and
// together they read as a contradiction, because the tool name says nothing about what the
// entry holds.
describe('what a progress line names', () => {

  it('names an ordinary tool as itself', () => {
    assert.equal(describeTurnAction('query_table', { count: 3, rows: [] }), '`query_table`');
  });

  it('names what a recall page is paging, and where', () => {
    const label = describeTurnAction('read_session_entry', {
      sequence: 7, tool: 'query_table', total_chars: 55512, offset: 27000, returned_chars: 12000, remaining: 16512,
    });
    assert.equal(label, '`read_session_entry` · saved `query_table` result (entry 7), characters 27,000–39,000 of 55,512');
  });

  it('names a recalled user message as a message, not a tool result', () => {
    const label = describeTurnAction('read_session_entry', {
      sequence: 1, tool: null, total_chars: 296, offset: 0, returned_chars: 296, remaining: 0,
    });
    assert.match(label, /saved message \(entry 1\), characters 0–296 of 296/);
  });

  it('falls back to the tool name when the page shape is not the one it knows', () => {
    assert.equal(describeTurnAction('read_session_entry', { error: 'No entry' }), '`read_session_entry`');
  });

  it('the progress line uses the label rather than the bare action', () => {
    const fn = procSrc.match(/async function notifyTurnProgress[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(fn, /describeTurnAction\(action, result\)/);
  });
});
