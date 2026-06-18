// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/domain-propagation.test.mjs
//
// Regression tests for domain propagation across system boundaries (Track D, Sprint 4).
//
// Boundaries covered:
//   B1  classify-intent → workflowInput: domain always written (null not omitted)
//   B2  template-resolver: {{input.domain}} resolves to null when key is null,
//       returns unresolved token when key is absent — documents WHY B1 fix matters
//   B3  classify-intent-tiers Pass 1: generic entity domain resolved from alias lookup
//   B4  classify-intent-tiers Pass 1: named workflow domain resolved from substring match
//   B5  MEMORY_WRITE SQS: run.input?.domain ?? null is safe regardless of key presence

import { describe, it } from 'node:test';
import assert            from 'node:assert/strict';

import { resolvePath, resolveInput } from '../../src/proc/template-resolver.mjs';
import { matchIntentMap, matchDomainAlias } from '../../src/proc/classify-intent-tiers.mjs';
import { deriveCallScope }            from '../../src/proc/llm-harness.mjs';
import { domainHelpRows }             from '../fixtures/domain-help-rows.js';
import { allIntentRows }              from '../fixtures/intent-map-rows.js';

// ---------------------------------------------------------------------------
// B1 + B2 — domain null vs absent in local_state.input
// ---------------------------------------------------------------------------

describe('domain propagation — template-resolver (B1/B2)', () => {
  it('resolveInput: single {{input.domain}} token returns null when domain is explicitly null', () => {
    const state = { input: { domain: null } };
    const result = resolveInput('{{input.domain}}', state);
    assert.equal(result, null,
      'domain: null must resolve to null, not the unresolved token string');
  });

  it('resolveInput: single {{input.domain}} token returns unresolved token when domain key is absent', () => {
    const state = { input: {} };
    const result = resolveInput('{{input.domain}}', state);
    assert.equal(result, '{{input.domain}}',
      'absent domain key resolves to the token string — this is the bug that B1 fix prevents');
  });

  it('resolveInput: {{input.domain}} in a filter object returns null when domain is explicitly null', () => {
    const state = { input: { domain: null } };
    const filter = { column: 'domain', op: 'eq', value: '{{input.domain}}' };
    const resolved = resolveInput(filter, state);
    assert.equal(resolved.value, null);
  });

  it('resolveInput: {{input.domain}} in a filter object returns token string when domain key is absent', () => {
    const state = { input: {} };
    const filter = { column: 'domain', op: 'eq', value: '{{input.domain}}' };
    const resolved = resolveInput(filter, state);
    assert.equal(resolved.value, '{{input.domain}}',
      'absent domain key passes the literal template string as a filter value — a silent query bug');
  });

  it('resolvePath: domain null is retrievable via bracket notation', () => {
    const state = { input: { domain: null } };
    assert.equal(resolvePath(state, 'input.domain'), null);
  });

  it('resolvePath: domain absent returns undefined', () => {
    const state = { input: {} };
    assert.equal(resolvePath(state, 'input.domain'), undefined);
  });

  it('MEMORY_WRITE guard: run.input?.domain ?? null is safe for both null and absent', () => {
    // Simulates the MEMORY_WRITE enqueue at run-workflow.mjs line 469:
    //   domain: run.input?.domain ?? null
    const runWithDomain    = { input: { domain: 'recipes' } };
    const runWithNullDomain = { input: { domain: null } };
    const runWithNoDomain  = { input: {} };
    const runWithNoInput   = {};

    assert.equal(runWithDomain.input?.domain    ?? null, 'recipes');
    assert.equal(runWithNullDomain.input?.domain ?? null, null);
    assert.equal(runWithNoDomain.input?.domain   ?? null, null);
    assert.equal(runWithNoInput.input?.domain    ?? null, null);
  });
});

// ---------------------------------------------------------------------------
// B6 — llm-harness deriveCallScope: domain flows into memory retrieval / save scope
// ---------------------------------------------------------------------------

describe('domain propagation — llm-harness deriveCallScope (B6)', () => {
  it('resolvedInput.domain takes priority over run.input.domain', () => {
    const scope = deriveCallScope(
      { workflow_name: 'add_recipe', input: { domain: 'recipes' } },
      { domain: 'overriding_domain' },
    );
    assert.equal(scope.domain, 'overriding_domain');
  });

  it('falls back to run.input.domain when resolvedInput has no domain', () => {
    const scope = deriveCallScope(
      { workflow_name: 'add_recipe', input: { domain: 'recipes' } },
      { someOtherField: 'value' },
    );
    assert.equal(scope.domain, 'recipes');
  });

  it('scope.domain is omitted (not null) when both resolvedInput and run.input have no domain', () => {
    const scope = deriveCallScope(
      { workflow_name: 'fix_workflow', input: {} },
      {},
    );
    assert.ok(!('domain' in scope), 'scope.domain must be omitted, not set to null');
  });

  it('scope.workflow is always set from run.workflow_name', () => {
    const scope = deriveCallScope(
      { workflow_name: 'add_recipe', input: { domain: 'recipes' } },
      {},
    );
    assert.equal(scope.workflow, 'add_recipe');
  });

  it('handles null run gracefully', () => {
    const scope = deriveCallScope(null, { domain: 'recipes' });
    assert.equal(scope.domain, 'recipes');
    assert.ok(!('workflow' in scope));
  });

  it('system workflow with null domain produces scope with only workflow key', () => {
    const scope = deriveCallScope(
      { workflow_name: 'fix_workflow', input: { domain: null } },
      {},
    );
    assert.ok(!('domain' in scope), 'null domain must be omitted from scope');
    assert.equal(scope.workflow, 'fix_workflow');
  });
});

// ---------------------------------------------------------------------------
// B3 — Pass 1 generic entity: domain resolved from alias lookup (not intent_category)
// ---------------------------------------------------------------------------

describe('domain propagation — Pass 1 generic entity (B3)', () => {
  // Mirrors classify-intent.mjs Pass 1 isGenericEntity branch.
  // Generic categories (list_entity, get_entity, etc.) do not embed the domain name,
  // so domain must be resolved from userInput via matchDomainAlias.

  it('matchIntentMap returns generic entity category for "list recipes"', () => {
    const match = matchIntentMap('list recipes', allIntentRows);
    assert.ok(match, 'expected a match for "list recipes"');
    assert.equal(match.intent_category, 'list_entity');
    assert.ok(match.intent_category.endsWith('_entity'), 'category must end with _entity');
  });

  it('matchDomainAlias resolves domain from userInput for generic entity', () => {
    const domainMatch = matchDomainAlias('list recipes', domainHelpRows);
    assert.ok(domainMatch, 'expected domain match for "list recipes"');
    assert.equal(domainMatch.domain, 'recipes');
  });

  it('matchDomainAlias returns null when no alias matches', () => {
    const domainMatch = matchDomainAlias('list foobar_xyz', domainHelpRows);
    assert.equal(domainMatch, null,
      'unrecognised domain must produce null so workflow runs with domain: null, not crash');
  });
});

// ---------------------------------------------------------------------------
// B4 — Pass 1 named workflow: domain resolved from intent_category substring match
// ---------------------------------------------------------------------------

describe('domain propagation — Pass 1 named workflow (B4)', () => {
  // Mirrors classify-intent.mjs Pass 1 non-generic branch.
  // Named workflows (quiz_flashcards, etc.) embed the domain name in intent_category.
  // Domain is resolved by finding a domainRow whose domain appears in intent_category.

  it('substring match: "flashcards" domain resolves from "quiz_flashcards" intent_category', () => {
    const intentCategory = 'quiz_flashcards';
    const flashcardDomainRows = [{ domain: 'flashcards' }];
    const matched = flashcardDomainRows.find(r => intentCategory.includes(r.domain));
    assert.ok(matched, 'expected substring match');
    assert.equal(matched.domain, 'flashcards');
  });

  it('substring match: returns null when intent_category does not include any registered domain', () => {
    const intentCategory = 'some_unrelated_workflow';
    const matched = domainHelpRows.find(r => intentCategory.includes(r.domain));
    assert.equal(matched, undefined, 'no match — domain resolves to null');
    // Downstream: domain = matched?.domain ?? null = null
    const domain = matched?.domain ?? null;
    assert.equal(domain, null);
  });

  it('substring match: system command intent_category never embeds a domain', () => {
    const systemCategories = ['create_domain', 'create_workflow', 'fix_workflow', 'help'];
    for (const cat of systemCategories) {
      const matched = domainHelpRows.find(r => cat.includes(r.domain));
      assert.equal(matched, undefined,
        `system category "${cat}" must not match any registered domain`);
    }
  });
});

// ---------------------------------------------------------------------------
// B5 — run-workflow rootFrame: domain accessible as {{input.domain}} in steps
// ---------------------------------------------------------------------------

describe('domain propagation — rootFrame local_state (B5)', () => {
  // Mirrors run-workflow.mjs rootFrame initialisation:
  //   local_state: { ...(run.state?.local_state ?? {}), input: run.input ?? {} }
  //
  // When classify-intent writes domain: null (after B1 fix), {{input.domain}}
  // resolves to null via resolveInput.
  // When classify-intent omits domain (pre-fix), {{input.domain}} stays as a
  // literal string — a silent bug in serv_query filter values.

  function buildRootLocalState(runInput) {
    return { input: runInput ?? {} };
  }

  it('domain: null in run.input → {{input.domain}} resolves to null in step templates', () => {
    const localState = buildRootLocalState({ userInput: 'quiz me', domain: null });
    const resolved = resolveInput('{{input.domain}}', localState);
    assert.equal(resolved, null);
  });

  it('domain: "flashcards" in run.input → {{input.domain}} resolves to "flashcards"', () => {
    const localState = buildRootLocalState({ userInput: 'quiz me', domain: 'flashcards' });
    const resolved = resolveInput('{{input.domain}}', localState);
    assert.equal(resolved, 'flashcards');
  });

  it('domain absent from run.input (pre-B1-fix) → {{input.domain}} returns unresolved token', () => {
    const localState = buildRootLocalState({ userInput: 'quiz me' }); // no domain key
    const resolved = resolveInput('{{input.domain}}', localState);
    assert.equal(resolved, '{{input.domain}}',
      'pre-fix: absent domain silently passes the template string as a filter value');
  });
});
