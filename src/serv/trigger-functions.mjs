// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/trigger-functions.mjs
//
// The trigger functions SERV installs, and the DDL for a trigger that calls one. A trigger's
// `function` names an entry here, and its SQL is never taken from a caller: bootstrap installs
// each function in the databases it lists, and addTrigger installs the one a trigger names
// before creating the trigger. Pure.

const TRIGGER_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export const TRIGGER_TIMINGS = new Set(['BEFORE UPDATE', 'BEFORE INSERT', 'AFTER UPDATE', 'AFTER INSERT']);

/**
 * @type {Record<string, { targets: Array<'pgc'|'pgd'>, sql: string }>}
 */
export const TRIGGER_FUNCTIONS = {
  // Every PGD table and the PGC tables with updated_at keep it current on update.
  set_updated_at: {
    targets: ['pgc', 'pgd'],
    sql: `
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `,
  },
  // A session's last activity is its latest entry's time, the order Novia's sessions are listed in.
  touch_session_last_active: {
    targets: ['pgc'],
    sql: `
    CREATE OR REPLACE FUNCTION touch_session_last_active()
    RETURNS TRIGGER AS $$
    BEGIN
      UPDATE "PGC_Session" SET last_active_at = NEW.created_at WHERE id = NEW.session_id;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `,
  },
};

/**
 * The catalogue name a trigger's `function` refers to — `set_updated_at()` → `set_updated_at`.
 * Null when it names nothing SERV holds.
 *
 * @param {string} fn
 * @returns {string|null}
 */
export function triggerFunctionName(fn) {
  const name = /^([a-z][a-z0-9_]*)\(\)$/.exec(String(fn ?? '').trim())?.[1];
  return name && Object.hasOwn(TRIGGER_FUNCTIONS, name) ? name : null;
}

/**
 * An error string, or null when the trigger is safe to render into DDL for a table in
 * `target`. Every part of it reaching the SQL string is checked here.
 *
 * @param {{ name?: string, timing?: string, function?: string }} trigger
 * @param {'pgc'|'pgd'} target
 * @returns {string|null}
 */
export function validateTrigger(trigger, target) {
  if (!trigger || typeof trigger !== 'object') return 'trigger is required';
  const { name, timing } = trigger;
  if (!name || !TRIGGER_NAME_PATTERN.test(name)) {
    return `Invalid trigger name "${name}" — must be lowercase alphanumeric + underscore`;
  }
  if (!TRIGGER_TIMINGS.has(timing)) {
    return `timing "${timing}" is not allowed — use ${[...TRIGGER_TIMINGS].join(', ')}`;
  }
  const fn = triggerFunctionName(trigger.function);
  if (!fn) {
    return `function "${trigger.function}" is not one SERV holds — use ${Object.keys(TRIGGER_FUNCTIONS).map(f => `${f}()`).join(', ')}`;
  }
  if (!TRIGGER_FUNCTIONS[fn].targets.includes(target)) {
    return `function "${fn}()" is not installed in ${target}`;
  }
  return null;
}

/**
 * CREATE OR REPLACE TRIGGER for one trigger on one table.
 *
 * @param {string} tableName
 * @param {{ name: string, timing: string, function: string }} trigger
 * @returns {string}
 */
export function buildTriggerSQL(tableName, trigger) {
  return `
    CREATE OR REPLACE TRIGGER "${trigger.name}"
      ${trigger.timing} ON "${tableName}"
      FOR EACH ROW EXECUTE FUNCTION ${trigger.function};
  `.trim();
}

/**
 * The functions bootstrap installs in one database.
 *
 * @param {'pgc'|'pgd'} target
 * @returns {string[]}  Each function's CREATE OR REPLACE
 */
export function functionsFor(target) {
  return Object.values(TRIGGER_FUNCTIONS).filter(f => f.targets.includes(target)).map(f => f.sql);
}
