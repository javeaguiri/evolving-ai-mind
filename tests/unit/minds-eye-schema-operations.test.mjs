// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-schema-operations.test.mjs
//
// propose_schema_fix takes a sequence of operations under one approval. Session 1307 added two
// columns and their CHECKs through four separate approvals, and each approval is a stop the
// user has to come back to before the prompt cache expires.
//
// Run: node --test tests/unit/minds-eye-schema-operations.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { schemaOperations, schemaOperationsRefusal, applySchemaOperations, gateButtonConfig, schemaOperationLines } from '../../src/proc/minds-eye.mjs';

const addCol   = { operation: 'addColumn', column: { name: 'kind', type: 'text' } };
const addCheck = { operation: 'modifyConstraint', constraintName: 'chk_t_kind', expression: "kind IN ('a','b')", columns: ['kind'] };

describe('schemaOperations', () => {
  it('reads a call without operations as its one operation', () => {
    assert.deepEqual(schemaOperations({ tableName: 'PGD_T', ...addCol }), [{ tableName: 'PGD_T', ...addCol }]);
  });

  it('gives an operation without its own tableName the call\'s', () => {
    const ops = schemaOperations({ tableName: 'PGD_T', operations: [addCol, { ...addCheck, tableName: 'PGD_U' }] });
    assert.deepEqual(ops.map(o => o.tableName), ['PGD_T', 'PGD_U']);
    assert.deepEqual(ops.map(o => o.operation), ['addColumn', 'modifyConstraint']);
  });
});

describe('schemaOperationsRefusal', () => {
  it('accepts a valid sequence', () => {
    assert.equal(schemaOperationsRefusal({ tableName: 'PGD_T', operations: [addCol, addCheck] }), null);
  });

  it('names each operation that cannot run, by its position', () => {
    const r = schemaOperationsRefusal({ operations: [addCol, { operation: 'renameTable', tableName: 'PGD_T' }] });
    assert.match(r.error, /Not sent for approval/);
    assert.deepEqual(r.problems, [
      'operation 1: operation and tableName are required',
      'operation 2: unknown schema operation renameTable',
    ]);
  });

  it('refuses an empty sequence', () => {
    assert.match(schemaOperationsRefusal({ tableName: 'PGD_T', operations: [] }).error, /empty/);
  });

  it('still refuses a single operation with no tableName', () => {
    assert.ok(schemaOperationsRefusal(addCol));
  });
});

describe('applySchemaOperations', () => {
  const ops = schemaOperations({ tableName: 'PGD_T', operations: [addCol, addCheck, { operation: 'dropColumn', columnName: 'old' }] });

  it('sends every operation in order, each with its own fields and no operation key', async () => {
    const sent = [];
    const r = await applySchemaOperations(ops, async (operation, body) => { sent.push([operation, body]); return { success: true }; });
    assert.equal(r.success, true);
    assert.deepEqual(sent.map(([o]) => o), ['addColumn', 'modifyConstraint', 'dropColumn']);
    assert.deepEqual(sent[0][1], { tableName: 'PGD_T', column: { name: 'kind', type: 'text' } });
    assert.deepEqual(r.applied.map(a => a.type), ['addColumn', 'modifyConstraint', 'dropColumn']);
  });

  it('stops at an operation SERV refuses, and says what was applied and what did not run', async () => {
    const sent = [];
    const r = await applySchemaOperations(ops, async (operation) => {
      sent.push(operation);
      if (operation === 'modifyConstraint') throw new Error('check constraint is violated by some row');
      return { success: true };
    });
    assert.equal(r.success, false);
    assert.deepEqual(sent, ['addColumn', 'modifyConstraint'], 'nothing after the failure is sent');
    assert.deepEqual(r.applied, [{ operation: 1, type: 'addColumn', tableName: 'PGD_T' }]);
    assert.deepEqual(r.failed, { operation: 2, type: 'modifyConstraint', tableName: 'PGD_T', error: 'check constraint is violated by some row' });
    assert.deepEqual(r.not_run, [{ operation: 3, type: 'dropColumn', tableName: 'PGD_T' }]);
  });

  it('treats a success: false result as a failure too', async () => {
    const r = await applySchemaOperations(ops, async () => ({ success: false, error: 'no such column' }));
    assert.equal(r.failed.operation, 1);
    assert.equal(r.failed.error, 'no such column');
    assert.equal(r.not_run.length, 2);
  });
});

describe('gateButtonConfig — a schema sequence', () => {
  it('is a danger gate when any operation drops a column', () => {
    assert.equal(gateButtonConfig('propose_schema_fix', { operations: [addCol, { operation: 'dropColumn', tableName: 'PGD_T', columnName: 'x' }] }).confirmStyle, 'danger');
  });

  it('is a standard Apply gate otherwise', () => {
    assert.deepEqual(gateButtonConfig('propose_schema_fix', { tableName: 'PGD_T', operations: [addCol, addCheck] }), { confirmLabel: 'Apply', confirmStyle: null });
  });
});

describe('schemaOperationLines — a default on the gate', () => {
  it('says an added column\'s default fills the existing rows', () => {
    assert.deepEqual(schemaOperationLines({ operation: 'addColumn', column: { name: 'kind', type: 'text', default: "'a'", nullable: false } }),
      ["Add column: `kind` (text, default `'a'`, NOT NULL) — existing rows get the default"]);
  });

  it('says a changed default applies to new rows only, then the nullability', () => {
    assert.deepEqual(schemaOperationLines({ operation: 'modifyColumn', columnName: 'kind', default: "'a'", nullable: false }), [
      "Set `kind` default → `'a'` (new rows only; existing rows keep their value)",
      'Set `kind` nullable: false',
    ]);
  });

  it('shows a dropped default', () => {
    assert.deepEqual(schemaOperationLines({ operation: 'modifyColumn', columnName: 'kind', dropDefault: true }), ["Drop `kind`'s default"]);
  });
});
