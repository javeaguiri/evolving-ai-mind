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
import { turnSucceeded } from '../../src/proc/minds-eye.mjs';

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
    assert.doesNotMatch(respondBlock, /notifyTurnProgress/);
  });

  it('does not report before a gated write — the gate is the message', () => {
    const gatedBlock = procSrc.match(/\} else if \(GATED_WRITE_TOOLS\.has\(action\)\) \{[\s\S]*?break;/)?.[0] ?? '';
    assert.ok(gatedBlock.length > 0);
    assert.doesNotMatch(gatedBlock, /notifyTurnProgress/);
  });

  it('costs no extra model call — the line is built from the decision already returned', () => {
    const fn = procSrc.match(/async function notifyTurnProgress[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(fn.length > 0);
    assert.doesNotMatch(fn, /callLlm/);
    assert.match(fn, /reasoning/);
  });
});
