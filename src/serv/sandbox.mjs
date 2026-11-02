// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/sandbox.mjs
//
// The test sandbox (docs/arch-sandbox.md): a schema, sandbox_<n>, holding copies of the tables a
// test needs, so a test run never writes household data. Two halves:
//
//   POST /serv/sandbox/{create,reset,drop,current} — manage it. One sandbox at a time.
//   sandboxRefusal(req, name) — the x-sandbox header's check, run by handler.mjs before a
//     request enters the sandbox: the name must exist, a write to a PGD_* table the sandbox
//     does not hold is refused, and so is every schema change and bootstrap.
//
// Routing itself is search_path, set by getClient (init-brain.mjs) from sandbox-context.mjs.

import { ok, err }                            from '../shared/lambda-utils.mjs';
import { getClient }                          from './init-brain.mjs';
import { SANDBOX_NAME }                       from './sandbox-context.mjs';
import { validateFilters, buildWhereClause }  from './table.mjs';

const PGD_TABLE      = /^PGD_[A-Za-z0-9_]+$/;
const ALWAYS_COPIED  = ['PGC_Memory', 'PGC_Workflow'];
const SPEC_TABLE     = 'sandbox_spec';

const TABLE_WRITES   = new Set(['insertRow', 'updateRows', 'deleteRows', 'upsertRows']);
const ENTITY_WRITES  = new Set(['createEntity', 'updateEntity', 'upsertEntity', 'deleteEntity']);
const SCHEMA_READS   = new Set(['listTables', 'listPhysicalTables', 'getTable']);

const q = (name) => `"${name}"`;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function handle(req) {
  const client = getClient(process.env.PGD_DATABASE_URL);
  try {
    await client.connect();
    switch (req.subRoute) {
      case 'create': {
        const spec = normaliseSpec(req.body);
        if (spec.error) return err(400, spec.error, req.correlationId);
        const report = await createSandbox(client, spec);
        return report.error ? err(400, report.error, req.correlationId) : ok({ success: true, ...report }, req.correlationId);
      }
      case 'reset': {
        const current = await findSandbox(client);
        if (!current.sandbox) return err(404, 'no sandbox exists', req.correlationId);
        const report = await createSandbox(client, current.spec);
        return report.error ? err(400, report.error, req.correlationId) : ok({ success: true, ...report }, req.correlationId);
      }
      case 'drop':
        return ok({ success: true, dropped: await dropSandboxes(client) }, req.correlationId);
      case 'current':
        return ok({ success: true, ...(await findSandbox(client)) }, req.correlationId);
      default:
        return err(404, `sandbox route "${req.subRoute}" not found`, req.correlationId);
    }
  } catch (error) {
    console.error('serv/sandbox: failed', { subRoute: req.subRoute, error: error.message });
    return err(500, `sandbox ${req.subRoute} failed: ${error.message}`, req.correlationId);
  } finally {
    await client.end();
  }
}

/**
 * Validate a create request: every name a PGD table, every rows value all / none / filters.
 *
 * @returns {{ tables: [{ name, rows }] } | { error: string }}
 */
export function normaliseSpec(body = {}) {
  const tables = body?.tables;
  if (!Array.isArray(tables) || tables.length === 0) return { error: 'tables must be a non-empty array of { name, rows }' };
  const seen = new Set();
  const out  = [];
  for (const t of tables) {
    const name = typeof t === 'string' ? t : t?.name;
    const rows = typeof t === 'string' ? 'all' : (t?.rows ?? 'all');
    if (typeof name !== 'string' || !PGD_TABLE.test(name)) return { error: `"${name}" is not a PGD_ table name` };
    if (seen.has(name)) return { error: `"${name}" is named twice` };
    if (rows !== 'all' && rows !== 'none' && !Array.isArray(rows)) return { error: `rows for "${name}" must be "all", "none" or a filters array` };
    seen.add(name);
    out.push({ name, rows });
  }
  return { tables: out };
}

/**
 * Every PGD table the named ones need for their foreign keys, transitively.
 *
 * @param {string[]} named
 * @param {Array<{ child: string, parent: string }>} fkEdges
 * @returns {string[]} the parents not already named, in discovery order
 */
export function fkParents(named, fkEdges) {
  const have  = new Set(named);
  const added = [];
  const queue = [...named];
  while (queue.length > 0) {
    const child = queue.shift();
    for (const { parent } of fkEdges.filter(e => e.child === child)) {
      if (!have.has(parent) && PGD_TABLE.test(parent)) {
        have.add(parent);
        added.push(parent);
        queue.push(parent);
      }
    }
  }
  return added;
}

/**
 * A trigger's definition moved from public onto the copy of its table.
 */
export function retargetTrigger(def, table, sandbox) {
  const from = `ON public.${q(table)} `;
  if (!def.includes(from)) throw new Error(`trigger definition for ${table} does not name public.${q(table)}`);
  return def.replace(from, `ON ${q(sandbox)}.${q(table)} `);
}

// ---------------------------------------------------------------------------
// Create, find, drop
// ---------------------------------------------------------------------------

async function dropSandboxes(client) {
  const { rows } = await client.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^sandbox_[0-9]+$'`);
  for (const { nspname } of rows) await client.query(`DROP SCHEMA ${q(nspname)} CASCADE`);
  return rows.map(r => r.nspname);
}

async function findSandbox(client) {
  const { rows } = await client.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^sandbox_[0-9]+$' ORDER BY nspname DESC LIMIT 1`);
  const sandbox = rows[0]?.nspname ?? null;
  if (!sandbox) return { sandbox: null, spec: null };
  const spec = await client.query(`SELECT spec FROM ${q(sandbox)}.${q(SPEC_TABLE)} LIMIT 1`);
  return { sandbox, spec: spec.rows[0]?.spec ?? null };
}

/**
 * Build a fresh sandbox from a spec, in one transaction: copies, sequences, rows, triggers,
 * then foreign keys and views — whose definitions are read while search_path is still public,
 * so they name tables unqualified and bind to the copies when replayed inside the sandbox.
 */
async function createSandbox(client, spec) {
  const named = spec.tables.map(t => t.name);

  const columns = await client.query(
    `SELECT table_name, column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [[...named, ...ALWAYS_COPIED]]);
  const missing = named.filter(n => !columns.rows.some(c => c.table_name === n));
  if (missing.length > 0) return { error: `not in the database: ${missing.join(', ')}` };

  const edges = (await client.query(
    `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace`)).rows
    .map(e => ({ child: e.child.replace(/"/g, ''), parent: e.parent.replace(/"/g, '') }));
  const parents = fkParents(named, edges);

  const plan = [
    ...spec.tables.map(t => ({ ...t, added_as: 'named' })),
    ...parents.map(name => ({ name, rows: 'all', added_as: 'fk_parent' })),
    ...ALWAYS_COPIED.map(name => ({ name, rows: 'all', added_as: 'always' })),
  ];
  const tableNames = plan.map(p => p.name);

  const allColumns = (await client.query(
    `SELECT table_name, column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)`, [tableNames])).rows;
  const columnsOf = (t) => allColumns.filter(c => c.table_name === t);

  for (const p of plan) {
    if (!Array.isArray(p.rows)) continue;
    const problem = validateFilters(p.rows, new Set(columnsOf(p.name).map(c => c.column_name)));
    if (problem) return { error: `${p.name}: ${problem}` };
  }

  // Read with search_path at public, before the sandbox exists.
  const triggers = (await client.query(
    `SELECT c.relname AS table_name, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)`,
    [tableNames])).rows;
  const foreignKeys = (await client.query(
    `SELECT c.relname AS table_name, k.conname, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
      WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)`,
    [tableNames])).rows;
  const views = (await client.query(
    `SELECT DISTINCT v.relname AS view_name, pg_get_viewdef(v.oid) AS def FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class   v ON v.oid = r.ev_class
       JOIN pg_class   t ON t.oid = d.refobjid
      WHERE v.relkind = 'v' AND v.relnamespace = 'public'::regnamespace AND v.relname LIKE 'PGD\\_%'
        AND t.relnamespace = 'public'::regnamespace AND t.relname = ANY($1) AND v.oid <> t.oid`,
    [tableNames])).rows;

  await client.query('BEGIN');
  try {
    await dropSandboxes(client);
    const sandbox = `sandbox_${Date.now()}`;
    await client.query(`CREATE SCHEMA ${q(sandbox)}`);

    const report = [];
    for (const p of plan) {
      const target = `${q(sandbox)}.${q(p.name)}`;
      await client.query(`CREATE TABLE ${target} (LIKE public.${q(p.name)} INCLUDING ALL)`);

      let copied = 0;
      if (p.rows !== 'none') {
        const { whereClause, values } = Array.isArray(p.rows) ? buildWhereClause(p.rows) : { whereClause: '', values: [] };
        copied = (await client.query(`INSERT INTO ${target} SELECT * FROM public.${q(p.name)} ${whereClause}`, values)).rowCount;
      }

      // Its own sequence for every serial column, set past the real table's ids.
      for (const c of columnsOf(p.name).filter(c => String(c.column_default ?? '').startsWith('nextval('))) {
        const seq = `${q(sandbox)}.${q(`${p.name}_${c.column_name}_seq`)}`;
        await client.query(`CREATE SEQUENCE ${seq} OWNED BY ${target}.${q(c.column_name)}`);
        await client.query(`ALTER TABLE ${target} ALTER COLUMN ${q(c.column_name)} SET DEFAULT nextval('${seq}')`);
        await client.query(`SELECT setval('${seq}', GREATEST((SELECT max(${q(c.column_name)}) FROM public.${q(p.name)}), 1))`);
      }

      for (const t of triggers.filter(t => t.table_name === p.name)) {
        await client.query(retargetTrigger(t.def, p.name, sandbox));
      }
      report.push({ name: p.name, rows: p.rows, copied, added_as: p.added_as });
    }

    // Unqualified names in these definitions now bind to the copies first.
    await client.query(`SET LOCAL search_path TO ${q(sandbox)}, public`);
    for (const fk of foreignKeys) {
      await client.query(`ALTER TABLE ${q(sandbox)}.${q(fk.table_name)} ADD CONSTRAINT ${q(fk.conname)} ${fk.def} NOT VALID`);
    }
    for (const v of views) {
      await client.query(`CREATE VIEW ${q(sandbox)}.${q(v.view_name)} AS ${v.def}`);
    }

    await client.query(`CREATE TABLE ${q(sandbox)}.${q(SPEC_TABLE)} (spec jsonb NOT NULL)`);
    await client.query(`INSERT INTO ${q(sandbox)}.${q(SPEC_TABLE)} (spec) VALUES ($1)`, [JSON.stringify({ tables: spec.tables })]);
    await client.query('COMMIT');

    console.info('serv/sandbox: created', { sandbox, tables: report.map(r => `${r.name}:${r.copied}`), views: views.map(v => v.view_name) });
    return {
      sandbox,
      tables: report.filter(r => r.added_as !== 'always'),
      views:  views.map(v => v.view_name),
      always: report.filter(r => r.added_as === 'always').map(r => ({ name: r.name, copied: r.copied })),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The x-sandbox header's check
// ---------------------------------------------------------------------------

/**
 * Whether a request may run against `sandbox`. Returns null when it may, otherwise
 * { status, message } — the request is refused and never enters the sandbox.
 *
 * @param {object} req      The parsed SERV request (route, subRoute, body)
 * @param {string} sandbox  The x-sandbox header's value
 */
export async function sandboxRefusal(req, sandbox) {
  if (!SANDBOX_NAME.test(sandbox)) return { status: 400, message: `x-sandbox "${sandbox}" is not a sandbox name` };
  if (req.route === 'sandbox' || req.route === 'bootstrap') {
    return { status: 403, message: `${req.route} is not available inside a sandbox` };
  }
  if (req.route === 'schema' && !SCHEMA_READS.has(req.subRoute)) {
    return { status: 403, message: 'schema changes are not available inside a sandbox — a test cannot create or alter tables' };
  }

  const isTableWrite  = req.route === 'table'  && TABLE_WRITES.has(req.subRoute);
  const isEntityWrite = req.route === 'entity' && ENTITY_WRITES.has(req.subRoute);

  const client = getClient(process.env.PGD_DATABASE_URL);
  try {
    await client.connect();
    const exists = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [sandbox]);
    if (exists.rows.length === 0) return { status: 400, message: `sandbox "${sandbox}" does not exist` };
    if (!isTableWrite && !isEntityWrite) return null;

    let table = req.body?.tableName ?? null;
    if (isEntityWrite) {
      const e = await client.query(`SELECT root_table FROM "PGC_EntitySchema" WHERE entity_name = $1`, [req.body?.entityName ?? null]);
      table = e.rows[0]?.root_table ?? null;
    }
    if (typeof table !== 'string' || !PGD_TABLE.test(table)) return null;

    const held = await client.query(`SELECT to_regclass($1) AS oid`, [`${q(sandbox)}.${q(table)}`]);
    if (held.rows[0]?.oid) return null;
    return { status: 409, message: `"${table}" is not in the test sandbox, so this write would change household data — add it with start_test` };
  } finally {
    await client.end();
  }
}
