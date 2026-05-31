// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/llm-harness.test.mjs
//
// Unit tests for the pure assembleInstructions() export of llm-harness.mjs.
// executeLlmCall() is async and network-dependent — not tested here.
//
// Run: node --test tests/unit/llm-harness.test.mjs

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { assembleInstructions } from '../../src/proc/llm-harness.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePromptRow(overrides = {}) {
  return {
    intent_category: overrides.intent_category ?? 'test_intent',
    prompt_text:     overrides.prompt_text ?? 'Hello {{name}}. Rules: {{rules}}.',
    model:           overrides.model ?? 'smart',
    version:         overrides.version ?? 1,
    ...overrides,
  };
}

function makeContextRow(key, content, opts = {}) {
  return {
    key,
    content,
    inject_always: opts.inject_always ?? false,
    inject_for:    opts.inject_for    ?? [],
  };
}

// ---------------------------------------------------------------------------
// assembleInstructions — context injection
// ---------------------------------------------------------------------------

describe('assembleInstructions — context injection', () => {
  it('substitutes resolvedInput tokens into prompt_text', () => {
    const promptRow = makePromptRow({ prompt_text: 'Hello {{name}}.' });
    const result = assembleInstructions(
      promptRow, { name: 'Alice' }, [], [], 'test_intent'
    );
    assert.equal(result, 'Hello Alice.');
  });

  it('substitutes inject_always context rows', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Rules: {{global_rule}}' });
    const contextRow = makeContextRow('global_rule', 'No harm.', { inject_always: true });
    const result     = assembleInstructions(promptRow, {}, [contextRow], [], 'anything');
    assert.equal(result, 'Rules: No harm.');
  });

  it('substitutes inject_for context rows matching intentCategory', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Ctx: {{routing}}' });
    const contextRow = makeContextRow('routing', 'Use step:N format.', {
      inject_for: ['generate_workflow_steps'],
    });
    const result = assembleInstructions(
      promptRow, {}, [contextRow], [], 'generate_workflow_steps'
    );
    assert.equal(result, 'Ctx: Use step:N format.');
  });

  it('does not inject inject_for row for non-matching intentCategory', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Ctx: {{routing}}.' });
    const contextRow = makeContextRow('routing', 'Use step:N format.', {
      inject_for: ['other_intent'],
    });
    const result = assembleInstructions(
      promptRow, {}, [contextRow], [], 'generate_workflow_steps'
    );
    // {{routing}} placeholder remains unresolved (no substitution found)
    assert.ok(result.includes('{{routing}}'));
  });

  it('resolvedInput takes precedence over contextMap for same key', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Val: {{key}}.' });
    const contextRow = makeContextRow('key', 'from_context', { inject_always: true });
    // resolvedInput also has 'key' — should win
    const result = assembleInstructions(
      promptRow, { key: 'from_input' }, [contextRow], [], 'test_intent'
    );
    assert.equal(result, 'Val: from_input.');
  });

  it('JSON-stringifies object context values', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Data: {{obj}}.' });
    const contextRow = makeContextRow('obj', { a: 1, b: 2 }, { inject_always: true });
    const result     = assembleInstructions(promptRow, {}, [contextRow], [], 'test_intent');
    assert.equal(result, 'Data: {"a":1,"b":2}.');
  });

  it('null contextRows is handled gracefully', () => {
    const promptRow = makePromptRow({ prompt_text: 'No context.' });
    const result    = assembleInstructions(promptRow, {}, null, [], 'test_intent');
    assert.equal(result, 'No context.');
  });

  it('replaces all occurrences of the same placeholder', () => {
    const promptRow = makePromptRow({ prompt_text: '{{x}} and {{x}} again.' });
    const result    = assembleInstructions(promptRow, { x: 'hello' }, [], [], 'test_intent');
    assert.equal(result, 'hello and hello again.');
  });
});

// ---------------------------------------------------------------------------
// assembleInstructions — memory block injection
// ---------------------------------------------------------------------------

describe('assembleInstructions — memory block injection', () => {
  it('appends memory block when memories provided', () => {
    const promptRow = makePromptRow({ prompt_text: 'Base prompt.' });
    const memories  = [{ memory_type: 'semantic', content: 'Design decision A.' }];
    const result    = assembleInstructions(promptRow, {}, [], memories, 'test_intent');
    assert.ok(result.includes('--- MEMORY ---'));
    assert.ok(result.includes('--- END MEMORY ---'));
    assert.ok(result.includes('Design decision A.'));
  });

  it('omits memory block when memories array is empty', () => {
    const promptRow = makePromptRow({ prompt_text: 'Base prompt.' });
    const result    = assembleInstructions(promptRow, {}, [], [], 'test_intent');
    assert.ok(!result.includes('--- MEMORY ---'));
    assert.equal(result, 'Base prompt.');
  });

  it('memory block appears after context substitution', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Rules: {{rule}}.' });
    const contextRow = makeContextRow('rule', 'Be concise.', { inject_always: true });
    const memories   = [{ memory_type: 'procedural', content: 'Preserve gate at step 3.' }];
    const result     = assembleInstructions(promptRow, {}, [contextRow], memories, 'test_intent');
    const rulesIdx   = result.indexOf('Rules: Be concise.');
    const memIdx     = result.indexOf('--- MEMORY ---');
    assert.ok(rulesIdx < memIdx, 'rules appear before memory block');
  });

  it('null memories is handled gracefully', () => {
    const promptRow = makePromptRow({ prompt_text: 'Base.' });
    const result    = assembleInstructions(promptRow, {}, [], null, 'test_intent');
    assert.equal(result, 'Base.');
  });
});
