// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/gate-contract-conformance.test.mjs
//
// The human_gate contract is the system's description of itself: it is what Novia reads
// to decide what a form can do, and she has no way to check it against the code. When the
// two disagree she does not discover a bug — she designs around a limit that is not there,
// states it to the user as fact, and the false limit outlives the session.
//
// That happened. Session 1189: the contract described `default` as the value a field opens
// with "for select/radio", buildInputElement emitted no initial_option for either, and the
// contract said nothing at all about `fields` accepting a {{template}} reference — which the
// engine had supported since the form gate shipped. She concluded the platform "can only
// collect selections, not edits to individual values" and designed an alias-editing
// workaround around a capability that already existed.
//
// These tests are the check she cannot run. They read the contract text out of the seed and
// assert the renderer honours every claim it makes, so a contract that drifts ahead of the
// code fails here rather than in a design conversation months later.

import { describe, it }          from 'node:test';
import assert                    from 'node:assert/strict';
import { readFileSync }          from 'node:fs';
import { fileURLToPath }         from 'node:url';
import { dirname, join }         from 'node:path';

import { buildInputElement, WIDGET_OPTION_LIMIT } from '../../src/ui/slackbot/callback.mjs';

const here      = dirname(fileURLToPath(import.meta.url));
const seedPath  = join(here, '../../src/serv/templates/pgc/seeds/seed_PGC_StepType.json');
const stepTypes = JSON.parse(readFileSync(seedPath, 'utf8'));

const humanGate   = stepTypes.find(t => t.step_type === 'human_gate');
const fieldsClaim = humanGate.input_contract.find(f => f.field === 'fields').description;

// The contract names its own field types in one place: "`type` is one of a | b | c and
// states WHAT is collected". Parsing them rather than restating them is the point — a type
// added to the contract and not to the renderer must fail, and a hand-copied list here
// would go stale in exactly the way the contract did.
function declaredFieldTypes(text) {
  const m = text.match(/`type` is one of ([^.]+?) and states WHAT/);
  assert.ok(m, 'contract no longer states its field types in the expected form — update the parser, not the assertion');
  return m[1].split('|').map(s => s.trim()).filter(Boolean);
}

// "OPTION CAPS — radio/checkbox 10, select/multi_select 100"
function declaredOptionCaps(text) {
  const m = text.match(/OPTION CAPS — ([^.]+)\./);
  assert.ok(m, 'contract no longer states option caps in the expected form');
  const caps = {};
  for (const clause of m[1].split(',')) {
    const [names, n] = clause.trim().split(/\s+(?=\d+$)/);
    for (const name of names.split('/')) caps[name.trim()] = Number(n);
  }
  return caps;
}

const FIELD_TYPES = declaredFieldTypes(fieldsClaim);

// One sample per type, good enough to render: option-backed types need options, and the
// initial value must name an option by its `value` exactly as the contract says it does.
const SAMPLE = {
  text:         { initial: 'Rustic Sliced Bread', expect: e => e.initial_value === 'Rustic Sliced Bread' },
  textarea:     { initial: 'a longer note',       expect: e => e.initial_value === 'a longer note' && e.multiline === true },
  select:       { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], initial: 'b', expect: e => e.initial_option?.value === 'b' },
  multi_select: { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], initial: ['a', 'b'], expect: e => e.initial_options?.map(o => o.value).join() === 'a,b' },
  radio:        { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], initial: 'a', expect: e => e.initial_option?.value === 'a' },
  checkbox:     { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], initial: ['b'], expect: e => e.initial_options?.map(o => o.value).join() === 'b' },
  date:         { initial: '2026-09-08', expect: e => e.initial_date === '2026-09-08' },
  time:         { initial: '09:30',      expect: e => e.initial_time === '09:30' },
  datetime:     { initial: 1757318400,   expect: e => e.initial_date_time === 1757318400 },
};

const fieldFor = (type) => ({ name: 'f', input_type: type, ...(SAMPLE[type] ?? {}) });

describe('human_gate contract conformance — the renderer honours what the contract claims', () => {

  it('every field type the contract declares has a sample here', () => {
    const missing = FIELD_TYPES.filter(t => !SAMPLE[t]);
    assert.deepEqual(missing, [],
      `contract declares field type(s) this test cannot exercise: ${missing.join(', ')}. ` +
      'Add a sample above and make the renderer handle it — a declared type with no element ' +
      'renders as nothing at all, and the gate silently drops the field.');
  });

  it('renders an element for every field type the contract declares', () => {
    for (const type of FIELD_TYPES) {
      const built = buildInputElement(fieldFor(type));
      assert.ok(built?.element,
        `contract declares field type "${type}" but buildInputElement returns nothing for it — ` +
        'the field would be dropped from the gate without a word.');
    }
  });

  it('carries `default` through as the value the field OPENS WITH, for every type', () => {
    // The specific claim that was false: "An untouched field submits its default
    // (\"YYYY-MM-DD\" for date; the option's `value` for select/radio)."
    for (const type of FIELD_TYPES) {
      const { element } = buildInputElement(fieldFor(type));
      assert.ok(SAMPLE[type].expect(element),
        `field type "${type}" drops its default — the contract promises the field opens with it. ` +
        `Element rendered: ${JSON.stringify(element)}`);
    }
  });

  it('option caps in the contract match the caps the renderer enforces', () => {
    assert.deepEqual(declaredOptionCaps(fieldsClaim), WIDGET_OPTION_LIMIT,
      'the contract and the renderer disagree about how many options a control accepts');
  });

  it('an initial value that names no rendered option is dropped, not sent', () => {
    // Slack rejects the whole block when initial_option is absent from options, so a stale
    // default must degrade to "nothing preselected" rather than take the gate down with it.
    const { element } = buildInputElement({
      name: 'f', input_type: 'select', initial: 'gone',
      options: [{ value: 'a', label: 'A' }],
    });
    assert.equal(element.initial_option, undefined);
  });
});

describe('option sets past a control cap are bounded, and say so', () => {

  for (const [type, cap] of Object.entries(WIDGET_OPTION_LIMIT)) {
    it(`${type} keeps ${cap} options and states how many it withheld`, () => {
      const options = Array.from({ length: cap + 32 }, (_, i) => ({ value: String(i), label: `Item ${i}` }));
      const { element, hint } = buildInputElement({ name: 'f', input_type: type, options });

      const rendered = element.options.length;
      assert.equal(rendered, cap, `${type} rendered ${rendered} options; Slack rejects the message past ${cap}`);
      assert.ok(hint, `${type} truncated its option list without saying so — a silent bound is the defect`);
      assert.ok(hint.includes(String(cap + 32)), 'the hint must name the true total, not just the cut size');
    });
  }

  it('preselects from the bounded list, never from an option that was cut', () => {
    const options = Array.from({ length: 140 }, (_, i) => ({ value: String(i), label: `Item ${i}` }));
    const { element } = buildInputElement({ name: 'f', input_type: 'select', initial: '130', options });
    assert.equal(element.initial_option, undefined,
      'option 130 was not rendered, so naming it as the initial option makes Slack reject the block');
  });
});
