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
import { assembleInstructions, buildStepUserMessage, STEP_TYPE_CONTRACT_COLUMNS, describeStateDrift } from '../../src/proc/llm-harness.mjs';
import { computeFingerprint }                               from '../../src/proc/fingerprint.mjs';

// A6 (diagnostic) — the local_state diff reads local_state_keys off the candidate fingerprint,
// mirroring describeInputDrift over input_keys. Broader than input drift, never gates a break.
describe('describeStateDrift', () => {
  it('reads local_state_keys from the candidate and sizes the keys that moved', () => {
    const current      = { gap_analysis: { h: 'h1', n: 101 }, domain: { h: 'hd', n: 8 } };
    const candidateFp  = { local_state_keys: { domain: { h: 'hd', n: 8 } } };  // gap_analysis is new state
    const d = describeStateDrift(current, candidateFp);
    assert.deepEqual(d.added, [{ key: 'gap_analysis', chars: 101 }]);
    assert.deepEqual(d.unchanged, ['domain']);
  });

  it('returns null when the candidate predates the snapshot (no local_state_keys)', () => {
    assert.equal(describeStateDrift({ a: { h: 'x', n: 1 } }, { input_keys: {} }), null);
    assert.equal(describeStateDrift({ a: { h: 'x', n: 1 } }, null), null);
  });
});

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
    const { instructions: result } = assembleInstructions(
      promptRow, { name: 'Alice' }, [], [], 'test_intent'
    );
    assert.equal(result, 'Hello Alice.');
  });

  it('substitutes inject_always context rows', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Rules: {{global_rule}}' });
    const contextRow = makeContextRow('global_rule', 'No harm.', { inject_always: true });
    const { instructions: result }     = assembleInstructions(promptRow, {}, [contextRow], [], 'anything');
    assert.equal(result, 'Rules: No harm.');
  });

  it('substitutes inject_for context rows matching intentCategory', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Ctx: {{routing}}' });
    const contextRow = makeContextRow('routing', 'Use step:N format.', {
      inject_for: ['generate_workflow_steps'],
    });
    const { instructions: result } = assembleInstructions(
      promptRow, {}, [contextRow], [], 'generate_workflow_steps'
    );
    assert.equal(result, 'Ctx: Use step:N format.');
  });

  it('does not inject inject_for row for non-matching intentCategory', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Ctx: {{routing}}.' });
    const contextRow = makeContextRow('routing', 'Use step:N format.', {
      inject_for: ['other_intent'],
    });
    const { instructions: result } = assembleInstructions(
      promptRow, {}, [contextRow], [], 'generate_workflow_steps'
    );
    // {{routing}} placeholder remains unresolved (no substitution found)
    assert.ok(result.includes('{{routing}}'));
  });

  it('resolvedInput takes precedence over contextMap for same key', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Val: {{key}}.' });
    const contextRow = makeContextRow('key', 'from_context', { inject_always: true });
    // resolvedInput also has 'key' — should win
    const { instructions: result } = assembleInstructions(
      promptRow, { key: 'from_input' }, [contextRow], [], 'test_intent'
    );
    assert.equal(result, 'Val: from_input.');
  });

  it('JSON-stringifies object context values', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Data: {{obj}}.' });
    const contextRow = makeContextRow('obj', { a: 1, b: 2 }, { inject_always: true });
    const { instructions: result }     = assembleInstructions(promptRow, {}, [contextRow], [], 'test_intent');
    assert.equal(result, 'Data: {"a":1,"b":2}.');
  });

  it('null contextRows is handled gracefully', () => {
    const promptRow = makePromptRow({ prompt_text: 'No context.' });
    const { instructions: result }    = assembleInstructions(promptRow, {}, null, [], 'test_intent');
    assert.equal(result, 'No context.');
  });

  it('replaces all occurrences of the same placeholder', () => {
    const promptRow = makePromptRow({ prompt_text: '{{x}} and {{x}} again.' });
    const { instructions: result }    = assembleInstructions(promptRow, { x: 'hello' }, [], [], 'test_intent');
    assert.equal(result, 'hello and hello again.');
  });
});

// ---------------------------------------------------------------------------
// inlinedKeys — which input keys the prompt already consumed
//
// Run 780: `Rustic Sliced Bread` appeared once in the system entry and once in the
// user entry of session 1163. assembleInstructions substitutes {{tokens}} into the
// prompt, then the caller sent JSON.stringify(resolvedInput) as the user message —
// the same bytes twice, on every llm_call whose prompt inlines the tokens it is
// passed, which is what the authoring convention encourages.
// ---------------------------------------------------------------------------

describe('assembleInstructions — inlinedKeys', () => {
  it('reports an input key whose token was substituted', () => {
    const promptRow = makePromptRow({ prompt_text: 'Hello {{name}}.' });
    const { inlinedKeys } = assembleInstructions(promptRow, { name: 'Alice' }, [], [], 'test_intent');
    assert.deepEqual(inlinedKeys, ['name']);
  });

  it('omits an input key the prompt never declares', () => {
    const promptRow = makePromptRow({ prompt_text: 'Hello {{name}}.' });
    const { inlinedKeys } = assembleInstructions(
      promptRow, { name: 'Alice', extra: 'unused' }, [], [], 'test_intent'
    );
    assert.deepEqual(inlinedKeys, ['name'], 'a key the prompt did not consume must still reach the model');
  });

  it('does not report context keys — only input keys are candidates for removal', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Rules: {{global_rule}}' });
    const contextRow = makeContextRow('global_rule', 'No harm.', { inject_always: true });
    const { inlinedKeys } = assembleInstructions(promptRow, {}, [contextRow], [], 'anything');
    assert.deepEqual(inlinedKeys, []);
  });

  it('reports a key inlined via a context value that itself carries the token', () => {
    // Detection happens during substitution, not by scanning prompt_text up front:
    // contextMap is substituted first, so a context value containing {{item}} puts
    // the token into the text before the input pass reaches it.
    const promptRow  = makePromptRow({ prompt_text: 'Ctx: {{wrapper}}' });
    const contextRow = makeContextRow('wrapper', 'Match against {{item}}.', { inject_always: true });
    const { instructions, inlinedKeys } = assembleInstructions(
      promptRow, { item: 'olive oil' }, [contextRow], [], 'anything'
    );
    assert.equal(instructions, 'Ctx: Match against olive oil.');
    assert.deepEqual(inlinedKeys, ['item'], 'scanning raw prompt_text would miss this one');
  });

  it('returns an empty list when the prompt declares no tokens', () => {
    const promptRow = makePromptRow({ prompt_text: 'Static prompt.' });
    const { inlinedKeys } = assembleInstructions(promptRow, { a: 1, b: 2 }, [], [], 'test_intent');
    assert.deepEqual(inlinedKeys, []);
  });
});

// ---------------------------------------------------------------------------
// buildStepUserMessage — the residue, and only the residue
// ---------------------------------------------------------------------------

describe('buildStepUserMessage', () => {
  it('an explicit user_input always wins', () => {
    const msg = buildStepUserMessage('what is the total?', { a: 1 }, []);
    assert.equal(msg, 'what is the total?', 'user_input is a real contract, not a fallback');
  });

  it('drops the keys the prompt inlined', () => {
    const msg = buildStepUserMessage('', { name: 'Alice', extra: 'keep' }, ['name']);
    assert.deepEqual(JSON.parse(msg), { extra: 'keep' });
  });

  it('sends an empty object when every key was inlined', () => {
    const msg = buildStepUserMessage('', { name: 'Alice' }, ['name']);
    assert.equal(msg, '{}', 'the gateway still needs a valid input string');
  });

  it('sends the whole input when the prompt inlined nothing', () => {
    const input = { a: 1, b: 2 };
    const msg   = buildStepUserMessage('', input, []);
    assert.deepEqual(JSON.parse(msg), input, 'a prompt with no tokens must lose nothing');
  });

  it('treats a missing inlinedKeys as nothing inlined', () => {
    const msg = buildStepUserMessage('', { a: 1 }, undefined);
    assert.deepEqual(JSON.parse(msg), { a: 1 });
  });

  it('no input key is lost — inlined plus residue is the whole input', () => {
    const input  = { one: 1, two: 2, three: 3 };
    const inlined = ['two'];
    const residue = JSON.parse(buildStepUserMessage('', input, inlined));
    assert.deepEqual(
      [...Object.keys(residue), ...inlined].sort(),
      Object.keys(input).sort(),
      'every key either reached the prompt or reaches the user message'
    );
  });
});

// ---------------------------------------------------------------------------
// assembleInstructions — memory block injection
// ---------------------------------------------------------------------------

describe('assembleInstructions — memory block injection', () => {
  it('appends memory block when memories provided', () => {
    const promptRow = makePromptRow({ prompt_text: 'Base prompt.' });
    const memories  = [{ memory_type: 'semantic', content: 'Design decision A.' }];
    const { instructions: result }    = assembleInstructions(promptRow, {}, [], memories, 'test_intent');
    assert.ok(result.includes('--- MEMORY ---'));
    assert.ok(result.includes('--- END MEMORY ---'));
    assert.ok(result.includes('Design decision A.'));
  });

  it('omits memory block when memories array is empty', () => {
    const promptRow = makePromptRow({ prompt_text: 'Base prompt.' });
    const { instructions: result }    = assembleInstructions(promptRow, {}, [], [], 'test_intent');
    assert.ok(!result.includes('--- MEMORY ---'));
    assert.equal(result, 'Base prompt.');
  });

  it('memory block appears after context substitution', () => {
    const promptRow  = makePromptRow({ prompt_text: 'Rules: {{rule}}.' });
    const contextRow = makeContextRow('rule', 'Be concise.', { inject_always: true });
    const memories   = [{ memory_type: 'procedural', content: 'Preserve gate at step 3.' }];
    const { instructions: result }     = assembleInstructions(promptRow, {}, [contextRow], memories, 'test_intent');
    const rulesIdx   = result.indexOf('Rules: Be concise.');
    const memIdx     = result.indexOf('--- MEMORY ---');
    assert.ok(rulesIdx < memIdx, 'rules appear before memory block');
  });

  it('null memories is handled gracefully', () => {
    const promptRow = makePromptRow({ prompt_text: 'Base.' });
    const { instructions: result }    = assembleInstructions(promptRow, {}, [], null, 'test_intent');
    assert.equal(result, 'Base.');
  });
});

// Sprint 8 — step_type_contracts is injected into the prompt and hashed into the `input`
// fingerprint component, so the injection must be a function of the contracts alone.
// Run 720 broke at step 11 against run 719 because human_gate's row had been updated: the
// heap relocated it, the unordered read reshuffled the array, and updated_at moved with it.
describe('step_type_contracts injection is stable', () => {
  const contract = (step_type) => ({ step_type, description: `${step_type} does a thing`, input_contract: [] });
  const fp = (rows) => computeFingerprint({
    promptRow: { version: 1, prompt_text: 'p', output_schema: null },
    resolvedInput: { step_type_contracts: rows }, userInput: '', model: 'm', memoryBlock: '', injectedContext: {},
  }).components.input;

  it('row ORDER changes the input hash — so the read must be ordered', () => {
    const a = fp([contract('human_gate'), contract('llm_call')]);
    const b = fp([contract('llm_call'), contract('human_gate')]);
    assert.notEqual(a, b, 'arrays are order-significant: an unordered read is a moving fingerprint');
  });

  it('the same contracts in the same order hash identically', () => {
    assert.equal(fp([contract('human_gate'), contract('llm_call')]), fp([contract('human_gate'), contract('llm_call')]));
  });

  it('excludes row bookkeeping — a touched row must not look like a new request', () => {
    for (const col of ['id', 'status', 'created_at', 'updated_at']) {
      assert.ok(!STEP_TYPE_CONTRACT_COLUMNS.includes(col), `${col} is not contract and must not reach the prompt`);
    }
  });

  it('carries the fields an LLM needs to author a step', () => {
    for (const col of ['step_type', 'description', 'input_contract', 'output_contract']) {
      assert.ok(STEP_TYPE_CONTRACT_COLUMNS.includes(col), `${col} is contract`);
    }
  });
});
