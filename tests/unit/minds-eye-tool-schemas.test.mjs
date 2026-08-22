// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-tool-schemas.test.mjs
//
// Covers selectToolDefinitions and the seeded minds_eye_tool_schemas row.
//
// The schemas live in PGC_SystemContext so a description can be retuned without a deploy.
// The cost of that is drift in either direction, and the last test in this file is the guard:
// it runs the real seed row against the real dispatch sets, so a tool added to the code
// without a schema (or described without code) fails here rather than in a live round.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { selectToolDefinitions, DISPATCHABLE_TOOLS } from '../../src/proc/minds-eye.mjs';

const dispatchable = new Set(['query_table', 'delete_data', 'respond']);

describe('selectToolDefinitions', () => {
  it('keeps dispatchable tools and stamps type: function', () => {
    const { tools } = selectToolDefinitions({
      tools: [{ name: 'query_table', description: 'read rows', parameters: { type: 'object' } }],
    }, dispatchable);

    assert.deepEqual(tools, [{
      type: 'function', name: 'query_table', description: 'read rows', parameters: { type: 'object' },
    }]);
  });

  it('drops a described tool the loop cannot dispatch, and names it', () => {
    const { tools, undispatchable } = selectToolDefinitions({
      tools: [
        { name: 'query_table', description: 'ok', parameters: {} },
        { name: 'launch_missiles', description: 'not a real tool', parameters: {} },
      ],
    }, dispatchable);

    assert.deepEqual(tools.map(t => t.name), ['query_table']);
    assert.deepEqual(undispatchable, ['launch_missiles']);
  });

  it('reports a dispatchable tool that has no schema', () => {
    const { undescribed } = selectToolDefinitions({
      tools: [{ name: 'query_table', description: 'ok', parameters: {} }],
    }, dispatchable);

    assert.deepEqual(undescribed.sort(), ['delete_data', 'respond']);
  });

  it('treats malformed or absent content as no tools rather than throwing', () => {
    for (const content of [null, undefined, {}, { tools: null }, { tools: 'nope' }]) {
      const { tools, undescribed } = selectToolDefinitions(content, dispatchable);
      assert.deepEqual(tools, [], `content ${JSON.stringify(content)} should yield no tools`);
      assert.equal(undescribed.length, dispatchable.size, 'and every dispatchable tool is undescribed');
    }
  });

  it('ignores entries with no usable name', () => {
    const { tools, undispatchable } = selectToolDefinitions({
      tools: [{ description: 'nameless' }, { name: '', description: 'empty' }, { name: 'respond', parameters: {} }],
    }, dispatchable);

    assert.deepEqual(tools.map(t => t.name), ['respond']);
    assert.deepEqual(undispatchable, [], 'a nameless entry is not an undispatchable tool, it is noise');
  });
});

// ---------------------------------------------------------------------------
// The drift guard — the real seed row against the real dispatch sets
// ---------------------------------------------------------------------------

describe('seeded minds_eye_tool_schemas row', () => {
  const rows = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json', 'utf8'));
  const row  = rows.find(r => r.key === 'minds_eye_tool_schemas');

  it('exists in the seed file', () => {
    assert.ok(row, 'minds_eye_tool_schemas must be seeded');
  });

  it('is read on demand, so it targets no prompt for injection', () => {
    // inject_for only does anything when the prompt carries a matching {{key}} token.
    // This row is fetched directly by the loop, so a target here would be inert.
    assert.deepEqual(row.inject_for, []);
    assert.equal(row.inject_always, false);
  });

  it('covers every dispatchable tool and describes nothing extra', () => {
    const { tools, undispatchable, undescribed } = selectToolDefinitions(row.content);

    assert.deepEqual(undescribed, [], 'a dispatchable tool with no schema is invisible to the model');
    assert.deepEqual(undispatchable, [], 'a schema with no code behind it is a tool the loop cannot run');
    assert.equal(tools.length, DISPATCHABLE_TOOLS.size);
  });

  it('gives every tool a description and an object parameter schema', () => {
    const { tools } = selectToolDefinitions(row.content);
    for (const t of tools) {
      assert.equal(typeof t.description, 'string', `${t.name} needs a description`);
      assert.ok(t.description.length > 20, `${t.name} description is too thin to drive triggering`);
      assert.equal(t.parameters?.type, 'object', `${t.name} parameters must be an object schema`);
    }
  });

  it('requires reasoning on every tool — notifyTurnProgress has no other source for it', () => {
    const { tools } = selectToolDefinitions(row.content);
    for (const t of tools) {
      assert.ok(t.parameters.properties?.reasoning, `${t.name} must declare a reasoning parameter`);
      assert.ok(t.parameters.required?.includes('reasoning'), `${t.name} must require reasoning`);
    }
  });

  it('is ASCII-only, so the seed file needs no escape-sequence handling', () => {
    assert.ok(!/[^\x00-\x7F]/.test(JSON.stringify(row)));
  });
});
