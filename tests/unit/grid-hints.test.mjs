// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/grid-hints.test.mjs
//
// Sprint 16 scope 5 (docs/arch-web-app.md §7.1): row, column and group on a form field — on the
// human_gate contract, enforced by L0 from that contract, carried by buildDialog, and drawn by
// Slack as a heading per group. Contracts are the real seed, never a copy.

import { describe, it }  from 'node:test';
import assert            from 'node:assert/strict';
import { readFileSync }  from 'node:fs';

import { runLevel0ShapeCheck, runSimulation, countGroupHeadings } from '../../src/proc/simulation-engine.mjs';
import { buildDialog }                                            from '../../src/proc/step-executor.mjs';
import { dialogToBlocks }                                         from '../../src/ui/slackbot/callback.mjs';

const contracts = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_StepType.json', 'utf8'));

const cell = (name, row, column, group, extra = {}) => ({ name, type: 'number', label: name, default: 1, row, column, group, ...extra });
const gate = fields => ({
  step: '2', type: 'human_gate', gate_type: 'form', message_template: 'Edit', output_key: 'answers', on_cancel: 'cancel',
  fields,
  options: [{ action: 'save', label: 'Save' }, { action: 'cancel', label: 'Cancel', on_select: 'cancel' }],
});
const itemIssues = fields => runLevel0ShapeCheck([gate(fields), { step: '3', type: 'end' }], { stepTypeContracts: contracts })
  .issues.filter(i => i.check === 'malformed_array_item');

describe('the human_gate contract declares the grid hints', () => {
  it('fields.items describes row, column and group', () => {
    const fields = contracts.find(c => c.step_type === 'human_gate').input_contract.find(c => c.field === 'fields');
    assert.deepEqual(Object.keys(fields.items.properties), ['row', 'column', 'group']);
    assert.match(fields.description, /GRID HINTS/);
  });
});

describe('L0 — a gridded form, composed from the contract', () => {
  it('accepts a grid of text or number hints, and a form with none', () => {
    assert.deepEqual(itemIssues([cell('a_17', '17', 'Amount', 'Monthly'), cell('a_30', 30, 'Amount', 'Annual')]), []);
    assert.deepEqual(itemIssues([{ name: 'note', type: 'text' }]), []);
  });

  it('refuses a row without its column, and a column without its row', () => {
    const issues = itemIssues([cell('a', '1', undefined, undefined), cell('b', undefined, 'Amount', undefined)]);
    assert.equal(issues.length, 2);
    assert.match(issues[0].detail, /fields\[0\] \("a"\): row comes with column/);
    assert.match(issues[1].detail, /fields\[1\] \("b"\): column comes with row/);
  });

  it('refuses a hint that is not text or a number', () => {
    const issues = itemIssues([cell('a', { id: 1 }, 'Amount', ''), cell('b', '2', 'Amount', ['x'])]);
    assert.ok(issues.some(i => /\("a"\): row must be string or number/.test(i.detail)));
    assert.ok(issues.some(i => /\("a"\): group must be string or number/.test(i.detail)));
    assert.ok(issues.some(i => /\("b"\): group must be string or number/.test(i.detail)));
  });

  it('a templated fields array is built at run time and not checked here', () => {
    assert.deepEqual(itemIssues('{{grid_fields}}'), []);
  });
});

describe('L1 — a group heading counts toward the gate\'s ceiling', () => {
  it('counts one heading wherever the group changes', () => {
    assert.equal(countGroupHeadings([{ group: 'A' }, { group: 'A' }, { group: 'B' }, {}, { group: 'B' }]), 3);
    assert.equal(countGroupHeadings([{ name: 'x' }]), 0);
  });

  it('38 fields in three groups exceed the ceiling that 38 ungrouped fields fit', () => {
    const fields = n => Array.from({ length: 38 }, (_, i) => cell(`f${i}`, String(i), 'Amount', n ? ['A', 'B', 'C'][i % 3] : undefined));
    const tooMany = steps => runSimulation({ steps: [gate(steps), { step: '3', type: 'end' }], mockOutputs: null, simulationPaths: null, stepTypeContracts: contracts, traceId: 't' })
      .static_analysis.issues.some(i => i.check === 'gate_too_many_fields');
    assert.equal(tooMany(fields(false)), false);
    assert.equal(tooMany(fields(true)), true);
  });
});

describe('buildDialog carries the hints; Slack draws a heading per group', () => {
  const step = gate([cell('a_17', 17, 'Amount', 'Monthly'), cell('a_18', '18', 'Amount', 'Monthly'), cell('a_30', '30', 'Amount', 'Annual'), { name: 'note', type: 'text' }]);
  const dialog = buildDialog(step, {});
  const inputs = dialog.fields.filter(f => f.type === 'input');

  it('copies row, column and group as text, and leaves a plain field without them', () => {
    assert.deepEqual([inputs[0].row, inputs[0].column, inputs[0].group], ['17', 'Amount', 'Monthly']);
    assert.equal('row' in inputs[3], false);
  });

  it('one header block where the group changes, the inputs stacked as before', () => {
    const blocks = dialogToBlocks(dialog, 9, 'form');
    const headers = blocks.filter(b => b.type === 'header').map(b => b.text.text);
    assert.deepEqual(headers, ['Monthly', 'Annual']);
    const order = blocks.filter(b => b.type === 'header' || b.type === 'input').map(b => b.type === 'header' ? b.text.text : b.block_id.split('::')[1]);
    assert.deepEqual(order, ['Monthly', 'a_17', 'a_18', 'Annual', 'a_30', 'note']);
  });
});
