// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/list-selection-match.test.mjs
//
// matchListSelection — resolving the ID typed under one table of a list_selection gate
// to the row it names. The real exported function, no copy.
//
// Run: node --test tests/unit/list-selection-match.test.mjs

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { matchListSelection } from '../../src/proc/run-workflow.mjs';

const open = { label: 'Open', action: 'open_row' };
const ingredient = { id: 7, fields: { name: 'Flour' },  responseData: { table: 'PGD_Ingredients' }, secondaryAction: open };
const step       = { id: 7, fields: { text: 'Mix' },    responseData: { table: 'PGD_RecipeSteps' }, secondaryAction: open };
const locked     = { id: 8, fields: { text: 'Bake' },   responseData: { table: 'PGD_RecipeSteps' } };
const plain      = { id: 3, fields: { name: 'Rent' },   secondaryAction: open };

describe('matchListSelection', () => {
  it('an id present in two tables resolves to the table whose box was used', () => {
    assert.equal(matchListSelection([ingredient, step], '7', 'PGD_Ingredients').item, ingredient);
    assert.equal(matchListSelection([ingredient, step], '7', 'PGD_RecipeSteps').item, step);
  });

  it('rows with no table match in the empty group', () => {
    assert.equal(matchListSelection([plain], '3', '').item, plain);
  });

  it('an id from another table is not found in this one', () => {
    const result = matchListSelection([ingredient, plain], '3', 'PGD_Ingredients');
    assert.equal(result.item, null);
    assert.match(result.problem, /no row with ID 3/);
  });

  it('a row shown but not selectable says so, rather than that it does not exist', () => {
    const result = matchListSelection([step, locked], '8', 'PGD_RecipeSteps');
    assert.equal(result.item, null);
    assert.equal(result.problem, "The row with ID 8 can't be selected.");
  });

  it('nothing typed asks for an ID', () => {
    assert.deepEqual(matchListSelection([plain], undefined, ''), { item: null, problem: 'Enter an ID before selecting.' });
    assert.deepEqual(matchListSelection([plain], '', ''), { item: null, problem: 'Enter an ID before selecting.' });
  });

  it('a click from a gate posted before ID boxes existed (no group) still resolves rows with no table', () => {
    assert.equal(matchListSelection([plain], '3', undefined).item, plain);
  });
});
