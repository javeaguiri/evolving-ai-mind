// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/memory-client.test.mjs
//
// Unit tests for src/proc/memory-client.mjs.
// All functions under test are pure or injectable — no network calls.
//
// Run: node --test tests/unit/memory-client.test.mjs

import { describe, it }  from 'node:test';
import assert            from 'node:assert/strict';
import { expandScope, formatMemoryBlock, retrieveMemories } from '../../src/proc/memory-client.mjs';

// ---------------------------------------------------------------------------
// expandScope
// ---------------------------------------------------------------------------

describe('expandScope', () => {
  it('empty scope returns [conventions, global]', () => {
    const result = expandScope({});
    // {} is deduplicated with the explicit global add, so we get [{}, {topic:'conventions'}, {}]
    // deduped → [{}, {topic:'conventions'}] — but {} is added first, then {topic:conventions}, then {}
    // actually: add({}) → seen; add({topic:conventions}) → seen; add({}) → deduplicated
    // Result: [{}, {topic:'conventions'}]
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {});
    assert.deepEqual(result[1], { topic: 'conventions' });
  });

  it('domain-only scope expands to [domain, conventions, global]', () => {
    const result = expandScope({ domain: 'Recipes' });
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], { domain: 'Recipes' });
    assert.deepEqual(result[1], { topic: 'conventions' });
    assert.deepEqual(result[2], {});
  });

  it('domain+workflow scope expands to 4 levels', () => {
    const result = expandScope({ domain: 'Recipes', workflow: 'add_recipe' });
    assert.equal(result.length, 4);
    assert.deepEqual(result[0], { domain: 'Recipes', workflow: 'add_recipe' });
    assert.deepEqual(result[1], { domain: 'Recipes' });
    assert.deepEqual(result[2], { topic: 'conventions' });
    assert.deepEqual(result[3], {});
  });

  it('domain+topic scope strips to domain level', () => {
    const result = expandScope({ domain: 'Recipes', topic: 'schema_design' });
    assert.equal(result.length, 4);
    assert.deepEqual(result[0], { domain: 'Recipes', topic: 'schema_design' });
    assert.deepEqual(result[1], { domain: 'Recipes' });
    assert.deepEqual(result[2], { topic: 'conventions' });
    assert.deepEqual(result[3], {});
  });

  it('conventions topic scope does not duplicate conventions', () => {
    const result = expandScope({ topic: 'conventions' });
    // {topic:conventions} added first, then conventions would be deduplicated
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { topic: 'conventions' });
    assert.deepEqual(result[1], {});
  });

  it('includePersona adds persona level before conventions', () => {
    const result = expandScope({ domain: 'Recipes' }, true);
    assert.equal(result.length, 4);
    assert.deepEqual(result[0], { domain: 'Recipes' });
    assert.deepEqual(result[1], { topic: 'persona' });
    assert.deepEqual(result[2], { topic: 'conventions' });
    assert.deepEqual(result[3], {});
  });

  it('persona topic scope does not duplicate when includePersona=true', () => {
    const result = expandScope({ topic: 'persona' }, true);
    // {topic:persona} added first; then includePersona tries to add it again → deduplicated
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], { topic: 'persona' });
    assert.deepEqual(result[1], { topic: 'conventions' });
    assert.deepEqual(result[2], {});
  });
});

// ---------------------------------------------------------------------------
// formatMemoryBlock
// ---------------------------------------------------------------------------

describe('formatMemoryBlock', () => {
  it('returns empty string for null', () => {
    assert.equal(formatMemoryBlock(null), '');
  });

  it('returns empty string for empty array', () => {
    assert.equal(formatMemoryBlock([]), '');
  });

  it('includes --- MEMORY --- delimiters', () => {
    const block = formatMemoryBlock([
      { memory_type: 'semantic', content: 'Design decision: junction table used.' },
    ]);
    assert.ok(block.startsWith('--- MEMORY ---'));
    assert.ok(block.includes('--- END MEMORY ---'));
  });

  it('groups semantic memories under correct label', () => {
    const block = formatMemoryBlock([
      { memory_type: 'semantic', content: 'Schema choice A.' },
    ]);
    assert.ok(block.includes('[Domain design decisions and conventions]'));
    assert.ok(block.includes('- Schema choice A.'));
  });

  it('groups procedural memories first in generation context', () => {
    const block = formatMemoryBlock([
      { memory_type: 'semantic',   content: 'Semantic content.' },
      { memory_type: 'procedural', content: 'Procedural content.' },
    ]);
    const procIdx = block.indexOf('[Workflow design intent]');
    const semIdx  = block.indexOf('[Domain design decisions and conventions]');
    assert.ok(procIdx < semIdx, 'procedural section should appear before semantic section');
  });

  it('groups episodic memories under Recent activity', () => {
    const block = formatMemoryBlock([
      { memory_type: 'episodic', content: 'User completed session with 80% accuracy.' },
    ]);
    assert.ok(block.includes('[Recent activity]'));
    assert.ok(block.includes('- User completed session with 80% accuracy.'));
  });

  it('renders multiple entries under one type heading', () => {
    const block = formatMemoryBlock([
      { memory_type: 'semantic', content: 'Design A.' },
      { memory_type: 'semantic', content: 'Design B.' },
    ]);
    const headingCount = (block.match(/\[Domain design decisions/g) ?? []).length;
    assert.equal(headingCount, 1, 'only one heading for the type');
    assert.ok(block.includes('- Design A.'));
    assert.ok(block.includes('- Design B.'));
  });
});

// ---------------------------------------------------------------------------
// retrieveMemories
// ---------------------------------------------------------------------------

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST   = new Date(Date.now() - 86_400_000).toISOString();

function makeRow(overrides) {
  return {
    id:             overrides.id ?? 1,
    memory_type:    overrides.memory_type ?? 'semantic',
    scope:          overrides.scope ?? {},
    content:        overrides.content ?? 'test content',
    tags:           overrides.tags ?? [],
    priority:       overrides.priority ?? 5,
    token_estimate: overrides.token_estimate ?? 10,
    expires_at:     overrides.expires_at ?? null,
    created_at:     overrides.created_at ?? new Date().toISOString(),
  };
}

function mockGetRows(rows) {
  return async () => ({ success: true, rows, count: rows.length });
}

describe('retrieveMemories', () => {
  it('returns empty array when budgetTokens is 0', async () => {
    const result = await retrieveMemories({ budgetTokens: 0, _getRows: mockGetRows([makeRow({})]) });
    assert.deepEqual(result, []);
  });

  it('returns empty array when _getRows returns no rows', async () => {
    const result = await retrieveMemories({
      budgetTokens: 500,
      _getRows: async () => ({ success: true, rows: [], count: 0 }),
    });
    assert.deepEqual(result, []);
  });

  it('returns empty array when _getRows fails', async () => {
    const result = await retrieveMemories({
      budgetTokens: 500,
      _getRows: async () => ({ success: false, error: 'db error' }),
    });
    assert.deepEqual(result, []);
  });

  it('filters out expired memories', async () => {
    const expired = makeRow({ expires_at: PAST, content: 'expired' });
    const valid   = makeRow({ expires_at: FUTURE, content: 'valid', id: 2 });
    const result  = await retrieveMemories({
      budgetTokens: 500,
      _getRows:     mockGetRows([expired, valid]),
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'valid');
  });

  it('filters memories by type', async () => {
    const episodic  = makeRow({ memory_type: 'episodic',  content: 'ep', id: 1 });
    const semantic  = makeRow({ memory_type: 'semantic',  content: 'sem', id: 2 });
    const result    = await retrieveMemories({
      budgetTokens: 500,
      memoryTypes:  ['semantic'],
      _getRows:     mockGetRows([episodic, semantic]),
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'sem');
  });

  it('global scope memory matches any call scope', async () => {
    const global = makeRow({ scope: {}, content: 'global pref' });
    const result = await retrieveMemories({
      scope:        { domain: 'Recipes', workflow: 'add_recipe' },
      budgetTokens: 500,
      _getRows:     mockGetRows([global]),
    });
    assert.equal(result.length, 1);
  });

  it('domain memory matches domain-level call scope', async () => {
    const domainMem = makeRow({ scope: { domain: 'Recipes' }, content: 'domain decision' });
    const result    = await retrieveMemories({
      scope:        { domain: 'Recipes', workflow: 'add_recipe' },
      budgetTokens: 500,
      _getRows:     mockGetRows([domainMem]),
    });
    assert.equal(result.length, 1);
  });

  it('domain memory does not match a different domain scope', async () => {
    const spanishMem = makeRow({ scope: { domain: 'Spanish' }, content: 'spanish only' });
    const result     = await retrieveMemories({
      scope:        { domain: 'Recipes' },
      budgetTokens: 500,
      _getRows:     mockGetRows([spanishMem]),
    });
    assert.deepEqual(result, []);
  });

  it('stops selecting when budget exceeded (greedy)', async () => {
    const big   = makeRow({ token_estimate: 400, content: 'big', id: 1, priority: 1 });
    const small = makeRow({ token_estimate: 200, content: 'small', id: 2, priority: 2 });
    const result = await retrieveMemories({
      budgetTokens: 500,
      _getRows:     mockGetRows([big, small]),
    });
    // big (400) fits; small (400+200=600) exceeds 500 → stops
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'big');
  });

  it('sorts by priority ascending', async () => {
    const low  = makeRow({ priority: 3, content: 'low priority',  id: 1, token_estimate: 10 });
    const high = makeRow({ priority: 1, content: 'high priority', id: 2, token_estimate: 10 });
    const result = await retrieveMemories({
      budgetTokens: 500,
      _getRows:     mockGetRows([low, high]),
    });
    assert.equal(result[0].content, 'high priority');
    assert.equal(result[1].content, 'low priority');
  });

  it('generation context: procedural sorted before semantic at same priority', async () => {
    const sem  = makeRow({ memory_type: 'semantic',   priority: 5, id: 1, token_estimate: 10 });
    const proc = makeRow({ memory_type: 'procedural', priority: 5, id: 2, token_estimate: 10 });
    const result = await retrieveMemories({
      budgetTokens: 500,
      callContext:  'generation',
      _getRows:     mockGetRows([sem, proc]),
    });
    assert.equal(result[0].memory_type, 'procedural');
    assert.equal(result[1].memory_type, 'semantic');
  });

  it('chat context: episodic sorted before semantic at same priority', async () => {
    const sem = makeRow({ memory_type: 'semantic',  priority: 5, id: 1, token_estimate: 10 });
    const ep  = makeRow({ memory_type: 'episodic',  priority: 5, id: 2, token_estimate: 10 });
    const result = await retrieveMemories({
      budgetTokens: 500,
      callContext:  'chat',
      _getRows:     mockGetRows([sem, ep]),
    });
    assert.equal(result[0].memory_type, 'episodic');
    assert.equal(result[1].memory_type, 'semantic');
  });

  it('tags filter — requires all specified tags', async () => {
    const withBoth = makeRow({ tags: ['schema', 'design_decision'], content: 'both', id: 1 });
    const withOne  = makeRow({ tags: ['schema'],                    content: 'one',  id: 2 });
    const result   = await retrieveMemories({
      budgetTokens: 500,
      tags:         ['schema', 'design_decision'],
      _getRows:     mockGetRows([withBoth, withOne]),
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'both');
  });

  it('chat callContext includes persona scope', async () => {
    const personaMem = makeRow({ scope: { topic: 'persona' }, content: 'User name is Javier.', id: 1 });
    const result     = await retrieveMemories({
      scope:        { domain: 'Recipes' },
      budgetTokens: 500,
      callContext:  'chat',
      _getRows:     mockGetRows([personaMem]),
    });
    // persona is reachable for chat calls
    assert.equal(result.length, 1);
  });

  it('generation callContext excludes persona scope', async () => {
    const personaMem = makeRow({ scope: { topic: 'persona' }, content: 'User name is Javier.', id: 1 });
    const result     = await retrieveMemories({
      scope:        { domain: 'Recipes' },
      budgetTokens: 500,
      callContext:  'generation',
      _getRows:     mockGetRows([personaMem]),
    });
    // persona is NOT in expanded scopes for generation → filtered out
    assert.deepEqual(result, []);
  });

  it('issues one targeted query per expanded scope candidate with memory_type + jsonb_contained_by filters', async () => {
    const calls = [];
    const _getRows = async (tableName, filters, orderBy, limit) => {
      calls.push({ tableName, filters, orderBy, limit });
      return { success: true, rows: [] };
    };
    await retrieveMemories({
      scope:        { domain: 'flashcards', workflow: 'add_entity' },
      memoryTypes:  ['semantic'],
      budgetTokens: 400,
      _getRows,
    });

    assert.equal(calls.length, 4, 'one call per expanded scope level (workflow, domain, conventions, global)');
    const expectedScopes = [
      { domain: 'flashcards', workflow: 'add_entity' },
      { domain: 'flashcards' },
      { topic: 'conventions' },
      {},
    ];
    calls.forEach((call, i) => {
      assert.equal(call.tableName, 'PGC_Memory');
      assert.deepEqual(call.filters[0], { column: 'memory_type', op: 'in', value: ['semantic'] });
      assert.deepEqual(call.filters[1], { column: 'scope', op: 'jsonb_contained_by', value: expectedScopes[i] });
    });
  });

  it('deduplicates a row returned by more than one candidate scope query', async () => {
    // A globally-scoped memory (scope: {}) is contained by every candidate,
    // so a naive per-call fetch would return it once per candidate query.
    const global = makeRow({ scope: {}, content: 'global pref', id: 7 });
    let callCount = 0;
    const _getRows = async () => {
      callCount++;
      return { success: true, rows: [global] };
    };
    const result = await retrieveMemories({
      scope:        { domain: 'flashcards', workflow: 'add_entity' },
      budgetTokens: 500,
      _getRows,
    });

    assert.equal(callCount, 4, 'still queried once per candidate scope');
    assert.equal(result.length, 1, 'but the row appears only once in the final result');
    assert.equal(result[0].content, 'global pref');
  });
});
