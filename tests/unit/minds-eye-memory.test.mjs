// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-memory.test.mjs
//
// The path a memory takes from one Novia session to the next. Five gaps sat between the
// write and the read, and a design approved in session 1189 was reported as never having
// existed in session 1195 — while the row sat intact in PGC_Memory the whole time.
//
//   1. deriveScope let the LAST search_domain_help win, so a session that read up on two
//      domains before designing against the first filed its work under the second.
//   2. The harness replaced the scope she passed, and cannot derive a subject that does not
//      exist yet — which is exactly what an unbuilt workflow's design is.
//   3. Both of her memory reads sorted priority DESC. The scale is 1-10 with LOWER meaning
//      more important (arch-memory.md 4.4, and the direction memory-client.mjs has always
//      read it in), so this ranked the least important band first and filled every page with
//      fire-and-forget run_complete rows.
//   4. The read tools reshaped getRows to { count, rows } and dropped the bounding
//      provenance SERV reports, so a ten-row page read as the whole table.
//
// Run: node --test tests/unit/minds-eye-memory.test.mjs

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { deriveScope, mergeMemoryScope, withReadProvenance } from '../../src/proc/minds-eye.mjs';

const procSrc = readFileSync('src/proc/minds-eye.mjs', 'utf8');

const toolEntry = (tool, params, result = {}) =>
  ({ role: 'tool', content: JSON.stringify({ tool, params, result }) });

const helpHit = domain => ({ results: [{ domain }] });

describe('deriveScope — exploration fills a gap, it does not overwrite', () => {

  it('keeps the first domain searched when a session reads up on a second', () => {
    // Session 1189, seq 2 and seq 4: "inventory groceries", then "recipes meal planning".
    // The design was for inventory; the stored scope said recipes.
    const history = [
      toolEntry('search_domain_help', { query: 'inventory groceries' }, helpHit('inventory')),
      toolEntry('search_domain_help', { query: 'recipes meal planning' }, helpHit('recipes')),
    ];
    assert.equal(deriveScope(history).domain, 'inventory');
  });

  it('still takes a domain from a help search when nothing has named one', () => {
    const history = [toolEntry('search_domain_help', { query: 'inventory' }, helpHit('inventory'))];
    assert.equal(deriveScope(history).domain, 'inventory');
  });

  it('lets an authoritative write override an earlier guess', () => {
    // register_workflow states the domain; a help search only guessed at it.
    const history = [
      toolEntry('search_domain_help', { query: 'recipes' }, helpHit('recipes')),
      toolEntry('register_workflow', { name: 'review_inventory', domain: 'inventory' }),
    ];
    assert.deepEqual(deriveScope(history), { domain: 'inventory', workflow: 'review_inventory' });
  });

  it('cannot name a workflow that does not exist yet — which is why she must', () => {
    const history = [
      toolEntry('search_domain_help', { query: 'inventory' }, helpHit('inventory')),
      toolEntry('list_tables', { domain: 'inventory' }),
    ];
    assert.equal(deriveScope(history).workflow, undefined);
  });
});

describe('mergeMemoryScope — derived is the floor, hers is the authority', () => {

  it('adds the subject the harness could not derive', () => {
    assert.deepEqual(
      mergeMemoryScope({ domain: 'inventory' }, { workflow: 'review_inventory' }),
      { domain: 'inventory', workflow: 'review_inventory' }
    );
  });

  it('lets her correct a derived key rather than being overruled by it', () => {
    assert.deepEqual(
      mergeMemoryScope({ domain: 'recipes' }, { domain: 'inventory' }),
      { domain: 'inventory' }
    );
  });

  it('falls back to the derived scope when she passes none', () => {
    assert.deepEqual(mergeMemoryScope({ domain: 'inventory' }, undefined), { domain: 'inventory' });
    assert.deepEqual(mergeMemoryScope({ domain: 'inventory' }, null), { domain: 'inventory' });
  });

  it('ignores a non-object rather than spreading it into the scope', () => {
    // Spreading a string would scatter its characters across the scope as numbered keys.
    assert.deepEqual(mergeMemoryScope({ domain: 'inventory' }, 'inventory'), { domain: 'inventory' });
    assert.deepEqual(mergeMemoryScope({ domain: 'inventory' }, ['inventory']), { domain: 'inventory' });
  });

  it('returns an empty scope when there is nothing on either side', () => {
    assert.deepEqual(mergeMemoryScope({}, undefined), {});
  });
});

describe('withReadProvenance — a bounded read says how it was bounded', () => {

  it('carries the total when more rows matched than were returned', () => {
    const out = withReadProvenance({ count: 10, limit: 10, limit_applied: 'default', truncated: true, total_matching: 34 });
    assert.deepEqual(out, { count: 10, limit: 10, limit_applied: 'default', truncated: true, total_matching: 34 });
  });

  it('says nothing about truncation on a complete read', () => {
    const out = withReadProvenance({ count: 3, limit: 10, limit_applied: 'default' });
    assert.deepEqual(out, { count: 3, limit: 10, limit_applied: 'default' });
  });

  it('reports whose limit was applied, since the default is chosen out of sight', () => {
    assert.equal(withReadProvenance({ count: 5, limit: 5, limit_applied: 'caller' }).limit_applied, 'caller');
  });

  it('survives a response that carries no provenance at all', () => {
    assert.deepEqual(withReadProvenance({ count: 2 }), { count: 2 });
  });
});

describe('the memory reads agree with the documented priority scale', () => {

  // PGC_Memory.priority is 1-10 with LOWER meaning more important. memory-client.mjs has
  // always read it that way; these two read it backwards, and every domain page Novia
  // opened was filled by the priority-8 run_complete rows the scale puts last.
  it('memory-client.mjs is the reference, and sorts ascending', () => {
    const clientSrc = readFileSync('src/proc/memory-client.mjs', 'utf8');
    assert.match(clientSrc, /column:\s*'priority',\s*direction:\s*'asc'/);
  });

  it('read_memory sorts ascending', () => {
    const body = procSrc.match(/case 'read_memory':[\s\S]*?\n      \}/)?.[0] ?? '';
    assert.match(body, /column:\s*'priority',\s*direction:\s*'asc'/);
    assert.doesNotMatch(body, /column:\s*'priority',\s*direction:\s*'desc'/);
  });

  it('read_memory breaks a priority tie by recency, not by insertion order', () => {
    const body = procSrc.match(/case 'read_memory':[\s\S]*?\n      \}/)?.[0] ?? '';
    assert.match(body, /column:\s*'created_at',\s*direction:\s*'desc'/);
  });

  it('the opening context block sorts ascending, and keeps a unique trailing term', () => {
    const body = procSrc.match(/async function assembleContext\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(body, /'PGC_Memory'[\s\S]*?column:\s*'priority',\s*direction:\s*'asc'/);
    assert.match(body, /column:\s*'id',\s*direction:\s*'desc'\s*\}\]/);
  });

  it('the opening context block no longer calls itself recent', () => {
    // It never was: sorted DESC by priority with an ascending id tiebreak, it returned the
    // oldest rows of the least important band -- the same five June one-liners every session.
    const body = procSrc.match(/async function assembleContext\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    assert.doesNotMatch(body, /RECENT MEMORIES/);
    assert.match(body, /read_memory for the rest/);
  });
});

describe('the write_memory contract matches what the harness now does', () => {

  const seed = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json', 'utf8'));
  const schemas = seed.find(r => r.key === 'minds_eye_tool_schemas').content.tools;
  const writeMemory = schemas.find(t => t.name === 'write_memory');
  const readMemory  = schemas.find(t => t.name === 'read_memory');

  it('offers the scope she is the only one who can supply', () => {
    assert.ok(writeMemory.parameters.properties.scope, 'write_memory must expose scope');
  });

  it('no longer tells her the harness owns the scope', () => {
    assert.doesNotMatch(writeMemory.description, /do not pass it/i);
  });

  it('offers tags and priority, which the tool body has always accepted', () => {
    assert.ok(writeMemory.parameters.properties.tags);
    assert.ok(writeMemory.parameters.properties.priority);
  });

  it('states which direction the priority scale runs, on both tools', () => {
    // A 1-10 scale is meaningless without it, and the wrong guess is the expensive one.
    assert.match(writeMemory.parameters.properties.priority.description, /LOWER is more important/);
    assert.match(readMemory.description, /LOWER is more important/);
  });

  it('names the fallback for a memory whose scope is unknown', () => {
    assert.match(readMemory.description, /like filter on content/);
  });

  it('keeps content the only required parameter besides reasoning', () => {
    assert.deepEqual(writeMemory.parameters.required.sort(), ['content', 'reasoning']);
  });
});

describe('the instruction layer matches the engine', () => {

  const seed = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json', 'utf8'));
  const prompt = seed.find(r => r.key === 'minds_eye_system_prompt').content.text;

  it('no longer forbids the scope the engine now accepts', () => {
    // The Sprint 11 instruction-twin pattern: a bound in code must be matched in the
    // instruction layer, or the artifact tells her not to do what the engine now allows.
    assert.doesNotMatch(prompt, /Do not include scope in params/);
  });

  it('tells her to scope work that has no row for the harness to find', () => {
    assert.match(prompt, /does not exist yet/);
  });

  it('states the priority scale where the write is described', () => {
    assert.match(prompt, /priority is 1-10 and LOWER is more important/);
  });

  it('names an approved design as a reason to write, not only a change or a defect', () => {
    assert.match(prompt, /A design the user approved/);
  });
});
