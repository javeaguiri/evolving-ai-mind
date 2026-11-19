// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/schema-add-trigger.test.mjs
//
// addTrigger — the pure halves: the trigger functions SERV holds, the check every trigger
// passes before its parts are interpolated into DDL, and the DDL itself. A trigger's
// function is named from the catalogue, never sent as SQL, so validateTrigger is a
// security gate as validateForeignKey is.
//
// Run: node --test tests/unit/schema-add-trigger.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRIGGER_FUNCTIONS, triggerFunctionName, validateTrigger, buildTriggerSQL, functionsFor,
} from '../../src/serv/trigger-functions.mjs';
import { buildCreateTableSQL } from '../../src/serv/init-brain.mjs';
import { upsertNamed } from '../../src/serv/schema.mjs';
import { readdirSync, readFileSync } from 'node:fs';

const TEMPLATE_DIR = new URL('../../src/serv/templates/pgc/', import.meta.url);
const templates = readdirSync(TEMPLATE_DIR).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(new URL(f, TEMPLATE_DIR), 'utf8')));

const valid = { name: 'trg_pgc_sessionentry_last_active', timing: 'AFTER INSERT', function: 'touch_session_last_active()' };

describe('triggerFunctionName — names only what SERV holds', () => {
  it('reads a held function written with its parentheses', () => {
    assert.equal(triggerFunctionName('set_updated_at()'), 'set_updated_at');
    assert.equal(triggerFunctionName(' touch_session_last_active() '), 'touch_session_last_active');
  });

  it('is null for a function SERV does not hold, or one written without parentheses', () => {
    assert.equal(triggerFunctionName('drop_everything()'), null);
    assert.equal(triggerFunctionName('set_updated_at'), null);
    assert.equal(triggerFunctionName(undefined), null);
  });

  it('is null for anything carrying SQL', () => {
    assert.equal(triggerFunctionName('set_updated_at(); DROP TABLE "PGC_Session"'), null);
    assert.equal(triggerFunctionName('set_updated_at(1)'), null);
  });

  it('is null for an inherited property name', () => {
    assert.equal(triggerFunctionName('constructor()'), null);
    assert.equal(triggerFunctionName('toString()'), null);
  });
});

describe('validateTrigger — accepts a well-formed trigger', () => {
  it('returns null for a held function in a database it is installed in', () => {
    assert.equal(validateTrigger(valid, 'pgc'), null);
    assert.equal(validateTrigger({ name: 'trg_cards_updated_at', timing: 'BEFORE UPDATE', function: 'set_updated_at()' }, 'pgd'), null);
  });

  it('accepts every allowed timing', () => {
    for (const timing of ['BEFORE UPDATE', 'BEFORE INSERT', 'AFTER UPDATE', 'AFTER INSERT']) {
      assert.equal(validateTrigger({ ...valid, timing }, 'pgc'), null, timing);
    }
  });
});

describe('validateTrigger — rejects anything unsafe to interpolate', () => {
  it('rejects a missing trigger', () => {
    assert.match(validateTrigger(undefined, 'pgc'), /required/);
    assert.match(validateTrigger(null, 'pgc'), /required/);
  });

  it('rejects a trigger name with SQL punctuation, uppercase, or a leading digit', () => {
    for (const name of ['trg"; DROP TABLE x; --', 'Trg_Session', '1trg', '']) {
      assert.match(validateTrigger({ ...valid, name }, 'pgc'), /trigger name/, name);
    }
  });

  it('rejects a timing outside the four', () => {
    for (const timing of ['INSTEAD OF INSERT', 'after insert', 'AFTER INSERT OR UPDATE', undefined]) {
      assert.match(validateTrigger({ ...valid, timing }, 'pgc'), /timing/, String(timing));
    }
  });

  it('rejects a function SERV does not hold, naming the ones it does', () => {
    const problem = validateTrigger({ ...valid, function: 'my_function()' }, 'pgc');
    assert.match(problem, /not one SERV holds/);
    assert.match(problem, /set_updated_at\(\)/);
  });

  it('rejects a held function in a database it is not installed in', () => {
    assert.match(validateTrigger(valid, 'pgd'), /not installed in pgd/);
  });
});

describe('buildTriggerSQL', () => {
  it('renders CREATE OR REPLACE TRIGGER on the table', () => {
    const sql = buildTriggerSQL('PGC_SessionEntry', valid);
    assert.match(sql, /^CREATE OR REPLACE TRIGGER "trg_pgc_sessionentry_last_active"/);
    assert.match(sql, /AFTER INSERT ON "PGC_SessionEntry"/);
    assert.match(sql, /FOR EACH ROW EXECUTE FUNCTION touch_session_last_active\(\);$/);
  });

  it('is the statement buildCreateTableSQL emits for a template trigger', () => {
    const template = { table_name: 'PGD_Cards', columns: [{ name: 'id', type: 'serial', primaryKey: true }],
      triggers: [{ name: 'trg_cards_updated_at', timing: 'BEFORE UPDATE', function: 'set_updated_at()' }] };
    assert.deepEqual(buildCreateTableSQL(template).triggers, [buildTriggerSQL('PGD_Cards', template.triggers[0])]);
  });
});

describe('the catalogue', () => {
  it('installs set_updated_at in both databases, touch_session_last_active in PGC only', () => {
    assert.equal(functionsFor('pgc').length, Object.keys(TRIGGER_FUNCTIONS).length);
    assert.deepEqual(functionsFor('pgd'), [TRIGGER_FUNCTIONS.set_updated_at.sql]);
  });

  it('defines each function under its own name', () => {
    for (const [name, { sql }] of Object.entries(TRIGGER_FUNCTIONS)) {
      assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(\\)`), name);
    }
  });

  it('every PGC template trigger passes the check addTrigger applies', () => {
    const triggers = templates.flatMap(t => (t.triggers ?? []).map(trigger => ({ table: t.table_name, trigger })));
    assert.ok(triggers.length > 0);
    for (const { table, trigger } of triggers) {
      assert.equal(validateTrigger(trigger, 'pgc'), null, `${table}.${trigger.name}`);
    }
  });
});

describe('upsertNamed — a re-issued trigger converges', () => {
  it('appends a new trigger and replaces one of the same name', () => {
    const first = upsertNamed([], valid);
    assert.deepEqual(first, [valid]);
    const changed = { ...valid, timing: 'AFTER UPDATE' };
    assert.deepEqual(upsertNamed(first, changed), [changed]);
  });

  it('treats a null registry entry as empty', () => {
    assert.deepEqual(upsertNamed(null, valid), [valid]);
  });
});
