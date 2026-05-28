// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/memory-writer.test.mjs
//
// Unit tests for src/proc/memory-writer.mjs.
// All external I/O injected via optional _getRows / _insertRow parameters.
//
// Run: node --test tests/unit/memory-writer.test.mjs

import { describe, it }  from 'node:test';
import assert            from 'node:assert/strict';
import { shouldWriteEpisodicMemory, handle } from '../../src/proc/memory-writer.mjs';

// ---------------------------------------------------------------------------
// shouldWriteEpisodicMemory
// ---------------------------------------------------------------------------

describe('shouldWriteEpisodicMemory', () => {
  it('returns true for a domain workflow run', () => {
    const run = { workflow_name: 'flashcard_quiz_session', input: { domain: 'flashcards' } };
    assert.equal(shouldWriteEpisodicMemory(run), true);
  });

  it('returns false when input.domain is null', () => {
    const run = { workflow_name: 'flashcard_quiz_session', input: { domain: null } };
    assert.equal(shouldWriteEpisodicMemory(run), false);
  });

  it('returns false when input.domain is missing', () => {
    const run = { workflow_name: 'flashcard_quiz_session', input: {} };
    assert.equal(shouldWriteEpisodicMemory(run), false);
  });

  it('returns false when input is null', () => {
    const run = { workflow_name: 'flashcard_quiz_session', input: null };
    assert.equal(shouldWriteEpisodicMemory(run), false);
  });

  it('returns false for create_domain', () => {
    const run = { workflow_name: 'create_domain', input: { domain: 'flashcards' } };
    assert.equal(shouldWriteEpisodicMemory(run), false);
  });

  it('returns false for create_workflow', () => {
    const run = { workflow_name: 'create_workflow', input: { domain: 'flashcards' } };
    assert.equal(shouldWriteEpisodicMemory(run), false);
  });

  it('returns false for fix_workflow', () => {
    const run = { workflow_name: 'fix_workflow', input: { domain: 'flashcards' } };
    assert.equal(shouldWriteEpisodicMemory(run), false);
  });

  it('returns false for ping_core', () => {
    const run = { workflow_name: 'ping_core', input: { domain: 'flashcards' } };
    assert.equal(shouldWriteEpisodicMemory(run), false);
  });

  it('returns false for troubleshoot_workflow', () => {
    const run = { workflow_name: 'troubleshoot_workflow', input: { domain: 'flashcards' } };
    assert.equal(shouldWriteEpisodicMemory(run), false);
  });
});

// ---------------------------------------------------------------------------
// handle
// ---------------------------------------------------------------------------

function makeReq(body = {}) {
  return { body, traceId: 'test-trace-001', source: 'sqs' };
}

describe('handle', () => {
  it('inserts episodic memory row with correct fields', async () => {
    let inserted = null;
    const _getRows   = async () => ({ success: true, rows: [{ id: 42 }], count: 1 });
    const _insertRow = async (table, row) => { inserted = { table, row }; return { success: true }; };

    await handle(makeReq({ runId: 42, workflowName: 'flashcard_quiz_session', domain: 'flashcards' }),
      { _getRows, _insertRow });

    assert.ok(inserted, '_insertRow was called');
    assert.equal(inserted.table, 'PGC_Memory');
    assert.equal(inserted.row.memory_type, 'episodic');
    assert.equal(inserted.row.source_run_id, 42);
    assert.equal(inserted.row.source_workflow, 'flashcard_quiz_session');
    assert.deepEqual(inserted.row.scope, { domain: 'flashcards', workflow: 'flashcard_quiz_session' });
    assert.ok(Array.isArray(inserted.row.tags));
    assert.ok(inserted.row.tags.includes('run_complete'));
    assert.ok(inserted.row.tags.includes('flashcard_quiz_session'));
    assert.ok(inserted.row.tags.includes('flashcards'));
    assert.ok(inserted.row.token_estimate > 0);
    assert.ok(typeof inserted.row.content === 'string' && inserted.row.content.length > 0);
  });

  it('scope omits domain key when domain is null', async () => {
    let inserted = null;
    const _getRows   = async () => ({ success: true, rows: [{ id: 1 }], count: 1 });
    const _insertRow = async (table, row) => { inserted = { table, row }; return { success: true }; };

    await handle(makeReq({ runId: 1, workflowName: 'some_workflow', domain: null }),
      { _getRows, _insertRow });

    assert.ok(inserted);
    assert.deepEqual(inserted.row.scope, { workflow: 'some_workflow' });
    assert.ok(!inserted.row.tags.includes(null));
  });

  it('does not throw when _insertRow fails', async () => {
    const _getRows   = async () => ({ success: true, rows: [{ id: 1 }], count: 1 });
    const _insertRow = async () => { throw new Error('DB connection lost'); };

    await assert.doesNotReject(() =>
      handle(makeReq({ runId: 1, workflowName: 'flashcard_quiz_session', domain: 'flashcards' }),
        { _getRows, _insertRow })
    );
  });

  it('does not call _insertRow when runId is missing', async () => {
    let called = false;
    const _getRows   = async () => ({ success: true, rows: [], count: 0 });
    const _insertRow = async () => { called = true; };

    await handle(makeReq({ workflowName: 'flashcard_quiz_session', domain: 'flashcards' }),
      { _getRows, _insertRow });

    assert.equal(called, false);
  });

  it('does not call _insertRow when workflowName is missing', async () => {
    let called = false;
    const _getRows   = async () => ({ success: true, rows: [], count: 0 });
    const _insertRow = async () => { called = true; };

    await handle(makeReq({ runId: 1, domain: 'flashcards' }),
      { _getRows, _insertRow });

    assert.equal(called, false);
  });

  it('token_estimate is ceil(content.length / 4)', async () => {
    let inserted = null;
    const _getRows   = async () => ({ success: true, rows: [{ id: 5 }], count: 1 });
    const _insertRow = async (table, row) => { inserted = { table, row }; return { success: true }; };

    await handle(makeReq({ runId: 5, workflowName: 'add_recipe', domain: 'recipes' }),
      { _getRows, _insertRow });

    const expected = Math.ceil(inserted.row.content.length / 4);
    assert.equal(inserted.row.token_estimate, expected);
  });
});
