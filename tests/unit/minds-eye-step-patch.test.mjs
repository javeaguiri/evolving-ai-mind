// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStepPatch } from '../../src/proc/minds-eye.mjs';

const current = () => ([
  { step: '1',  type: 'serv_query', on_success: '2',  description: 'load' },
  { step: '2',  type: 'llm_call',   on_success: '3',  description: 'classify' },
  { step: '3',  type: 'human_gate', on_success: '4',  description: 'confirm' },
  { step: '4',  type: 'end',                          description: 'done' },
]);

test('a patch replaces only the steps it names, and leaves the rest identical', () => {
  const before = current();
  const { merged, replaced, added, removed } = mergeStepPatch(before, {
    patch: [{ step: '2', type: 'llm_call', on_success: '3', description: 'classify better' }],
  });

  assert.equal(merged.length, 4);
  assert.deepEqual(replaced, ['2']);
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
  assert.equal(merged[1].description, 'classify better');

  // The untouched steps must be the very objects that were stored — this is the property
  // the whole patch exists for. A resubmitted full array could not promise it.
  assert.deepEqual(merged[0], before[0]);
  assert.deepEqual(merged[2], before[2]);
  assert.deepEqual(merged[3], before[3]);
});

test('a replaced step keeps its position, so step 0 cannot drift', () => {
  const { merged } = mergeStepPatch(current(), {
    patch: [{ step: '1', type: 'serv_query', on_success: '2', description: 'load faster' }],
  });
  assert.equal(merged[0].step, '1');
  assert.equal(merged[0].description, 'load faster');
});

test('a new step is appended and reported as added', () => {
  const { merged, added, replaced } = mergeStepPatch(current(), {
    patch: [
      { step: '3',  type: 'human_gate', on_success: '3g', description: 'confirm' },
      { step: '3g', type: 'js_transform', on_success: '4', description: 'reshape' },
    ],
  });
  assert.equal(merged.length, 5);
  assert.deepEqual(added, ['3g']);
  assert.deepEqual(replaced, ['3']);
  assert.equal(merged.at(-1).step, '3g');
});

test('omitting a step never deletes it — only removeSteps does', () => {
  const withoutFour = mergeStepPatch(current(), {
    patch: [{ step: '1', type: 'serv_query', on_success: '2', description: 'load' }],
  });
  assert.equal(withoutFour.merged.length, 4, 'omission must mean unchanged');

  const explicit = mergeStepPatch(current(), { patch: [], removeSteps: ['4'] });
  assert.equal(explicit.merged.length, 3);
  assert.deepEqual(explicit.removed, ['4']);
  assert.equal(explicit.merged.find(s => s.step === '4'), undefined);
});

test('removeSteps naming a step that does not exist is reported, not silently ignored', () => {
  const { unknownRemovals, merged } = mergeStepPatch(current(), { patch: [], removeSteps: ['99'] });
  assert.deepEqual(unknownRemovals, ['99']);
  assert.equal(merged.length, 4);
});

test('the same step named twice in one patch is reported', () => {
  const { duplicatePatchKeys } = mergeStepPatch(current(), {
    patch: [
      { step: '2', description: 'first' },
      { step: '2', description: 'second' },
    ],
  });
  assert.deepEqual(duplicatePatchKeys, ['2']);
});

test('numeric and string step identifiers address the same step', () => {
  const { merged, replaced, added } = mergeStepPatch(current(), {
    patch: [{ step: 2, type: 'llm_call', on_success: '3', description: 'numeric key' }],
  });
  assert.deepEqual(replaced, ['2']);
  assert.deepEqual(added, []);
  assert.equal(merged.length, 4);
  assert.equal(merged[1].description, 'numeric key');
});

test('an empty patch is a no-op that returns the stored array unchanged', () => {
  const before = current();
  const { merged, added, replaced, removed } = mergeStepPatch(before, { patch: [] });
  assert.deepEqual(merged, before);
  assert.deepEqual([added, replaced, removed], [[], [], []]);
});

test('removal and replacement compose in one patch', () => {
  const { merged, replaced, removed } = mergeStepPatch(current(), {
    patch:       [{ step: '3', type: 'human_gate', on_success: '4', description: 'confirm twice' }],
    removeSteps: ['2'],
  });
  assert.deepEqual(removed, ['2']);
  assert.deepEqual(replaced, ['3']);
  assert.deepEqual(merged.map(s => s.step), ['1', '3', '4']);
});

test('defaults tolerate a missing stored array', () => {
  const { merged, added } = mergeStepPatch(undefined, { patch: [{ step: '1', type: 'end' }] });
  assert.equal(merged.length, 1);
  assert.deepEqual(added, ['1']);
});
