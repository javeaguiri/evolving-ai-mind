// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStepPatch, mergeOutcome } from '../../src/proc/minds-eye.mjs';

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

// An added step's POSITION is a contract, not a detail. L1's data-flow trace walks the array
// in top-to-bottom order, so a step appended at the end is treated as writing its output_key
// after every step already there — and any existing step reading that key is refused with
// `unresolved_template_variable` for a key the patch plainly writes.
//
// Session 1196 is the specimen: a patch replaced steps 16 and 17 and added 16b between them,
// 16b landed past 17 and past the `end` step, and four repair rounds were spent on a refusal
// that was false about the patch and true only of the array the merge had built. The previous
// version of this test asserted `merged.at(-1).step === '3g'` — it locked in the appending as
// the requirement, on this exact shape: a gate routing to a new js_transform.
test('a new step is placed after the step that routes to it, not appended', () => {
  const { merged, added, replaced } = mergeStepPatch(current(), {
    patch: [
      { step: '3',  type: 'human_gate', on_success: '3g', description: 'confirm' },
      { step: '3g', type: 'js_transform', on_success: '4', description: 'reshape' },
    ],
  });
  assert.equal(merged.length, 5);
  assert.deepEqual(added, ['3g']);
  assert.deepEqual(replaced, ['3']);
  assert.deepEqual(merged.map(s => s.step), ['1', '2', '3', '3g', '4']);
});

test('a chain of added steps resolves in order, each behind its own router', () => {
  // 3b routes to 3c, which does not exist until this same patch adds it. One pass cannot
  // place 3c, because its router is not in the array yet.
  const { merged, added } = mergeStepPatch(current(), {
    patch: [
      { step: '3',  type: 'human_gate',  on_success: '3b' },
      { step: '3b', type: 'js_transform', on_success: '3c' },
      { step: '3c', type: 'serv_update',  on_success: '4' },
    ],
  });
  assert.deepEqual(added.sort(), ['3b', '3c']);
  assert.deepEqual(merged.map(s => s.step), ['1', '2', '3', '3b', '3c', '4']);
});

test('a step reached from a gate option is placed behind that gate', () => {
  // The commonest place a new step is hung off, and the routing field is per-option rather
  // than on the step itself.
  const before = [
    { step: '1', type: 'human_gate', options: [{ value: 'edit', on_select: '1e' }, { value: 'skip', on_select: '2' }] },
    { step: '2', type: 'end' },
  ];
  const { merged, added } = mergeStepPatch(before, {
    patch: [{ step: '1e', type: 'js_transform', on_success: '2' }],
  });
  assert.deepEqual(added, ['1e']);
  assert.deepEqual(merged.map(s => s.step), ['1', '1e', '2']);
});

test('a step nothing routes to is appended, and left for L1 to call unreachable', () => {
  // Placement cannot invent a position that routing does not imply. Appending is the honest
  // answer, and the unreachable-step check is the one that should speak next.
  const { merged, added } = mergeStepPatch(current(), {
    patch: [{ step: '9z', type: 'js_transform', on_success: '4' }],
  });
  assert.deepEqual(added, ['9z']);
  assert.equal(merged.at(-1).step, '9z');
});

test('placement follows routing, never the look of the step identifier', () => {
  // "2a" sorting after "2" is a human convention the engine does not read. Here 2a is
  // routed to by step 3, and that is where it belongs.
  const { merged } = mergeStepPatch(current(), {
    patch: [
      { step: '3',  type: 'human_gate',  on_success: '2a' },
      { step: '2a', type: 'js_transform', on_success: '4' },
    ],
  });
  assert.deepEqual(merged.map(s => s.step), ['1', '2', '3', '2a', '4']);
});

test('a step:-prefixed routing token names its target the same way a bare key does', () => {
  const { merged } = mergeStepPatch(current(), {
    patch: [
      { step: '3',  type: 'human_gate',  on_success: 'step:3g' },
      { step: '3g', type: 'js_transform', on_success: '4' },
    ],
  });
  assert.deepEqual(merged.map(s => s.step), ['1', '2', '3', '3g', '4']);
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


// ---------------------------------------------------------------------------
// mergeOutcome — what the merge produced, reported to whoever is judged on it
// ---------------------------------------------------------------------------

test('the merge outcome names the resulting step order, where a placement fault shows', () => {
  const before = current();
  const report = mergeStepPatch(before, {
    patch: [
      { step: '3',  type: 'human_gate',  on_success: '3g' },
      { step: '3g', type: 'js_transform', on_success: '4' },
    ],
  });
  const { patched } = mergeOutcome(report, report.merged);

  assert.deepEqual(patched.added,      ['3g']);
  assert.deepEqual(patched.replaced,   ['3']);
  assert.deepEqual(patched.removed,    []);
  assert.deepEqual(patched.step_order, ['1', '2', '3', '3g', '4']);
});

test('step_order is reported as strings, so a numeric identifier reads the same as a stored one', () => {
  const report = mergeStepPatch(current(), { patch: [{ step: 2, type: 'llm_call', on_success: '3' }] });
  const { patched } = mergeOutcome(report, report.merged);
  assert.deepEqual(patched.step_order, ['1', '2', '3', '4']);
});

test('a whole-array submission has no merge to report', () => {
  // resolveProposedSteps returns no mergeReport for the steps form. Reporting an empty
  // patch there would describe a merge that never happened.
  assert.deepEqual(mergeOutcome(null, current()), {});
  assert.deepEqual(mergeOutcome(undefined, current()), {});
});
