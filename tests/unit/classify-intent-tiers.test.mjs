// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/classify-intent-tiers.test.mjs
//
// Unit tests for src/proc/classify-intent-tiers.mjs pure functions.
// No I/O, no network, no DB — functions are called directly with mock data.
//
// Run: node --test tests/unit/classify-intent-tiers.test.mjs
// Verbose: node --test --test-reporter=spec tests/unit/classify-intent-tiers.test.mjs

import { describe, it }  from 'node:test';
import assert             from 'node:assert/strict';

import {
  matchIntentMap,
  matchDomainAlias,
  matchWorkflowByKeywords,
  extractSearchTerm,
  parseFieldValues,
} from '../../src/proc/classify-intent-tiers.mjs';

import { intentMapRows, systemIntentRows, allIntentRows } from '../fixtures/intent-map-rows.js';
import { domainHelpRows }                                  from '../fixtures/domain-help-rows.js';
import { workflowRows }                                    from '../fixtures/workflow-rows.js';

// ---------------------------------------------------------------------------
// matchIntentMap
// ---------------------------------------------------------------------------

describe('matchIntentMap', () => {
  it('returns the matching row for an exact pattern', () => {
    const row = matchIntentMap('list recipes', intentMapRows);
    assert.equal(row.intent_category, 'list_entity');
    assert.equal(row.action_type, 'workflow');
  });

  it('returns the matching row case-insensitively', () => {
    const row = matchIntentMap('LIST RECIPES', intentMapRows);
    assert.equal(row.intent_category, 'list_entity');
  });

  it('prefers workflow over heavy_lift over crud when patterns overlap', () => {
    const rows = [
      { id: 1, pattern: 'create',  intent_category: 'create_domain',  action_type: 'heavy_lift' },
      { id: 2, pattern: 'create',  intent_category: 'add_entity',     action_type: 'workflow'   },
    ];
    const row = matchIntentMap('create', rows);
    assert.equal(row.action_type, 'workflow');
    assert.equal(row.intent_category, 'add_entity');
  });

  it('prefers lower id within the same action_type tier', () => {
    const rows = [
      { id: 10, pattern: 'list recipes', intent_category: 'list_entity_b', action_type: 'workflow' },
      { id: 5,  pattern: 'list recipes', intent_category: 'list_entity_a', action_type: 'workflow' },
    ];
    const row = matchIntentMap('list recipes', rows);
    assert.equal(row.id, 5);
  });

  it('skips malformed regex without throwing', () => {
    const rows = [
      { id: 1, pattern: '([invalid',  intent_category: 'bad_pattern', action_type: 'workflow' },
      { id: 2, pattern: 'list recipes', intent_category: 'list_entity', action_type: 'workflow' },
    ];
    const row = matchIntentMap('list recipes', rows);
    assert.equal(row.intent_category, 'list_entity');
  });

  it('returns null when no pattern matches', () => {
    const row = matchIntentMap('something completely unrelated', intentMapRows);
    assert.equal(row, null);
  });

  it('matches UC 1.1 add recipe input — add_entity', () => {
    // Pattern covers plural "add recipes" — UC 1.1 natural language flows through Pass 2
    // after Pass 1 miss; this tests that the fixture pattern "add recipes" does match.
    const row = matchIntentMap('add recipes pasta carbonara with ingredients and steps', intentMapRows);
    assert.equal(row.intent_category, 'add_entity');
    assert.equal(row.action_type, 'workflow');
  });

  it('matches UC 1.2 list recipes — list_entity', () => {
    const row = matchIntentMap('list recipes', intentMapRows);
    assert.equal(row.intent_category, 'list_entity');
    assert.equal(row.action_type, 'workflow');
  });

  it('matches UC 1.3 get recipes sweet potato chili — get_entity', () => {
    const row = matchIntentMap('get recipes sweet potato chili', intentMapRows);
    assert.equal(row.intent_category, 'get_entity');
    assert.equal(row.action_type, 'workflow');
  });

  it('matches UC 1.4 get recipes id=1 — get_entity', () => {
    const row = matchIntentMap('get recipes id=1', intentMapRows);
    assert.equal(row.intent_category, 'get_entity');
    assert.equal(row.action_type, 'workflow');
  });

  it('matches UC 1.5 update recipes id=42 difficulty=hard — update_entity', () => {
    const row = matchIntentMap('update recipes id=42 difficulty=hard', intentMapRows);
    assert.equal(row.intent_category, 'update_entity');
    assert.equal(row.action_type, 'workflow');
  });

  it('matches UC 1.6 delete recipes id=42 — delete_entity', () => {
    const row = matchIntentMap('delete recipes id=42', intentMapRows);
    assert.equal(row.intent_category, 'delete_entity');
    assert.equal(row.action_type, 'workflow');
  });

  it('matches system heavy_lift pattern — create_domain', () => {
    // Pattern: create.domain|new.domain|build.domain — dot matches any single char.
    // "build domain" has exactly one char (space) between build and domain → matches.
    const row = matchIntentMap('build domain', allIntentRows);
    assert.equal(row.intent_category, 'create_domain');
    assert.equal(row.action_type, 'heavy_lift');
  });
});

// ---------------------------------------------------------------------------
// matchDomainAlias
// ---------------------------------------------------------------------------

describe('matchDomainAlias', () => {
  it('matches the domain name itself as an implicit alias', () => {
    const row = matchDomainAlias('show all my recipes', domainHelpRows);
    assert.equal(row.domain, 'recipes');
  });

  it('matches an entry from the aliases array', () => {
    const row = matchDomainAlias('show all my cooking ideas', domainHelpRows);
    assert.equal(row.domain, 'recipes');
  });

  it('matches substring — alias does not need to be a whole word', () => {
    const row = matchDomainAlias('meal planning for the week', domainHelpRows);
    assert.equal(row.domain, 'recipes');
  });

  it('is case-insensitive', () => {
    const row = matchDomainAlias('SHOW MY RECIPES', domainHelpRows);
    assert.equal(row.domain, 'recipes');
  });

  it('returns null when no domain or alias matches', () => {
    const row = matchDomainAlias('track my golf scores', domainHelpRows);
    assert.equal(row, null);
  });

  it('returns null for empty input', () => {
    const row = matchDomainAlias('', domainHelpRows);
    assert.equal(row, null);
  });

  it('returns null when domainRows is empty', () => {
    const row = matchDomainAlias('show my recipes', []);
    assert.equal(row, null);
  });
});

// ---------------------------------------------------------------------------
// matchWorkflowByKeywords
// ---------------------------------------------------------------------------

describe('matchWorkflowByKeywords', () => {
  it('UC 1.1 — add keyword matches add_entity (domain: null universal candidate)', () => {
    // This is the UC 1.1 fix — generic workflows with domain: null must match.
    const result = matchWorkflowByKeywords(
      'add recipe pasta carbonara with ingredients and steps',
      'recipes',
      workflowRows
    );
    assert.ok(result, 'expected a match');
    assert.equal(result.workflow_name, 'add_entity');
    assert.equal(result.search_term, null);
    assert.equal(result.record_id, null);
  });

  it('list keyword matches list_entity', () => {
    const result = matchWorkflowByKeywords('list recipes', 'recipes', workflowRows);
    assert.ok(result);
    assert.equal(result.workflow_name, 'list_entity');
  });

  it('get keyword matches get_entity', () => {
    const result = matchWorkflowByKeywords('get my recipes sweet potato chili', 'recipes', workflowRows);
    assert.ok(result);
    assert.equal(result.workflow_name, 'get_entity');
  });

  it('disambiguation — get_entity wins over list_entity when search term is present', () => {
    // Both 'show' (list_entity) and 'show' (get_entity) could match,
    // but extra tokens after verb+domain signal a search term → get_entity wins.
    const rows = [
      { id: 310, name: 'get_entity',  domain: null, intent_keywords: ['get', 'show', 'find'] },
      { id: 311, name: 'list_entity', domain: null, intent_keywords: ['list', 'show all', 'all'] },
    ];
    const result = matchWorkflowByKeywords('show recipes pasta carbonara', 'recipes', rows);
    assert.ok(result);
    assert.equal(result.workflow_name, 'get_entity');
    assert.equal(result.search_term, 'pasta carbonara');
  });

  it('search_term is set for get_entity match with extra tokens', () => {
    const result = matchWorkflowByKeywords('get recipes sweet potato chili', 'recipes', workflowRows);
    assert.ok(result);
    assert.equal(result.workflow_name, 'get_entity');
    assert.equal(result.search_term, 'sweet potato chili');
  });

  it('record_id is set when remainder is solely id=N', () => {
    const result = matchWorkflowByKeywords('get recipes id=1', 'recipes', workflowRows);
    assert.ok(result);
    assert.equal(result.workflow_name, 'get_entity');
    assert.equal(result.record_id, 1);
    assert.equal(result.search_term, null);
  });

  it('search_term is null when no extra tokens after verb+domain', () => {
    const result = matchWorkflowByKeywords('list recipes', 'recipes', workflowRows);
    assert.ok(result);
    assert.equal(result.search_term, null);
    assert.equal(result.record_id, null);
  });

  it('returns null when no keyword matches', () => {
    const result = matchWorkflowByKeywords('something unrelated', 'recipes', workflowRows);
    assert.equal(result, null);
  });

  it('returns null when workflowRows is empty', () => {
    const result = matchWorkflowByKeywords('get recipes', 'recipes', []);
    assert.equal(result, null);
  });

  it('update keyword matches update_entity', () => {
    const result = matchWorkflowByKeywords('update recipes id=42 difficulty=hard', 'recipes', workflowRows);
    assert.ok(result);
    assert.equal(result.workflow_name, 'update_entity');
  });

  it('delete keyword matches delete_entity', () => {
    const result = matchWorkflowByKeywords('delete recipes id=42', 'recipes', workflowRows);
    assert.ok(result);
    assert.equal(result.workflow_name, 'delete_entity');
  });

  it('domain: null rows are available as candidates for any domain', () => {
    // Core assertion for the UC 1.1 fix — null domain rows match regardless of domain.
    const domainSpecificRows = [
      { id: 310, name: 'get_entity', domain: null, intent_keywords: ['get', 'find'] },
    ];
    const result = matchWorkflowByKeywords('get stocks AAPL', 'stock_portfolio', domainSpecificRows);
    assert.ok(result);
    assert.equal(result.workflow_name, 'get_entity');
  });
});

// ---------------------------------------------------------------------------
// extractSearchTerm
// ---------------------------------------------------------------------------

describe('extractSearchTerm', () => {
  it('extracts search term after stripping verb and domain', () => {
    const { search_term, record_id } = extractSearchTerm('get my recipes sweet potato chili', 'recipes');
    assert.equal(search_term, 'sweet potato chili');
    assert.equal(record_id, null);
  });

  it('extracts search term with "show" verb', () => {
    const { search_term } = extractSearchTerm('show recipes pasta carbonara', 'recipes');
    assert.equal(search_term, 'pasta carbonara');
  });

  it('extracts search term with "find" verb', () => {
    const { search_term } = extractSearchTerm('find my recipes sweet potato', 'recipes');
    assert.equal(search_term, 'sweet potato');
  });

  it('returns record_id when remainder is solely id=N', () => {
    const { search_term, record_id } = extractSearchTerm('get recipes id=1', 'recipes');
    assert.equal(search_term, null);
    assert.equal(record_id, 1);
  });

  it('returns record_id for id:N format', () => {
    const { search_term, record_id } = extractSearchTerm('get recipes id:42', 'recipes');
    assert.equal(search_term, null);
    assert.equal(record_id, 42);
  });

  it('returns null/null when no extra tokens after verb+domain', () => {
    const { search_term, record_id } = extractSearchTerm('show all my recipes', 'recipes');
    assert.equal(search_term, null);
    assert.equal(record_id, null);
  });

  it('returns null/null when input is just the verb with no extra tokens', () => {
    // "get recipes" strips to empty string → no search term, no id.
    const { search_term, record_id } = extractSearchTerm('get recipes', 'recipes');
    assert.equal(search_term, null);
    assert.equal(record_id, null);
  });

  it('handles underscore domain with space in input', () => {
    const { search_term } = extractSearchTerm('get my stock portfolio AAPL', 'stock_portfolio');
    assert.equal(search_term, 'AAPL');
  });
});

// ---------------------------------------------------------------------------
// parseFieldValues
// ---------------------------------------------------------------------------

describe('parseFieldValues', () => {
  it('parses a simple unquoted field=value pair', () => {
    const result = parseFieldValues('update recipes name=Pasta');
    assert.deepEqual(result, { name: 'Pasta' });
  });

  it('parses double-quoted value with spaces', () => {
    const result = parseFieldValues('add recipes name="Sweet Potato Chili"');
    assert.deepEqual(result, { name: 'Sweet Potato Chili' });
  });

  it('parses single-quoted value', () => {
    const result = parseFieldValues("add recipes name='Eggs Benedict'");
    assert.deepEqual(result, { name: 'Eggs Benedict' });
  });

  it('parses multiple field=value pairs', () => {
    const result = parseFieldValues('update recipes id=42 difficulty=hard servings=4');
    assert.deepEqual(result, { difficulty: 'hard', servings: '4' });
  });

  it('excludes SYSTEM_COLS — id is excluded', () => {
    const result = parseFieldValues('update recipes id=42 difficulty=hard');
    assert.ok(!('id' in result), 'id should be excluded');
    assert.equal(result.difficulty, 'hard');
  });

  it('excludes SYSTEM_COLS case-insensitively — ID, Created_At, UPDATED_AT', () => {
    const result = parseFieldValues('add recipes ID=5 Created_At=2026-01-01 UPDATED_AT=2026-01-01 name=Pasta');
    assert.ok(!('ID' in result));
    assert.ok(!('Created_At' in result));
    assert.ok(!('UPDATED_AT' in result));
    assert.equal(result.name, 'Pasta');
  });

  it('returns empty object when no field=value pairs present', () => {
    const result = parseFieldValues('add recipe pasta carbonara with ingredients and steps');
    assert.deepEqual(result, {});
  });

  it('returns empty object for empty input', () => {
    const result = parseFieldValues('');
    assert.deepEqual(result, {});
  });

  it('parses numeric value as string', () => {
    const result = parseFieldValues('update recipes servings=4');
    assert.equal(result.servings, '4');
    assert.equal(typeof result.servings, 'string');
  });

  it('parses unquoted multi-word value terminated by next key=', () => {
    const result = parseFieldValues('add recipes name=Sweet Potato Chili servings=4');
    assert.equal(result.name, 'Sweet Potato Chili');
    assert.equal(result.servings, '4');
  });
});
