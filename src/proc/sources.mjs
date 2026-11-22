// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/sources.mjs
//
// /api/v1/proc/sources/{source}/… — the records behind a records or summary panel, and the web's
// direct edits (docs/arch-web-app.md §3.1, §4.2, §6; docs/arch-home-brain.md §4.7, §4.8). A source
// is a registered PGD_ table or view, or an entity name, whose root table is read; a PGC_ system
// table is never a source.
//
//   GET  …/rows             the rows, a page at a time; ?with_version for a grid that saves
//   POST …/rows             a grid's save — SERV saveRows, under the edit policy
//   GET  …/schema           columns, foreign key targets, and what the edit policy opens
//   GET  …/records/{id}     a document — an entity's root and child rows, with versions
//   POST …/records[/{id}]   a document created or saved — SERV saveEntity, under the edit policy
//
// Every save is checked against the policy before SERV is called and refused whole if any part
// is not open; SERV logs it to PGC_ChangeLog with the principal as actor and the table's domain
// from the registry, never the request. Columns default to
// every non-vector column, and any column named — to select or to filter — must be registered.
// Each column carries the label a person reads: until the registry holds column labels (§6.3,
// Phase 1), the humanised name, marked labelFallback (§13). The page is bounded and says so;
// ?offset reads the next.
// Domain data belongs to the household.
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { respond, err }   from '../shared/lambda-utils.mjs';
import { getRows, saveRows, saveEntity, getEntityVersioned } from '../shared/serv-client.mjs';
import { childTablesOf }  from '../shared/schema-utils.mjs';
import { readPrincipal }  from './principal.mjs';
import { humanise }       from './workflows.mjs';
import { editableColumns, policyRefusals } from './edit-policy.mjs';

export const SOURCE_DEFAULT_LIMIT = 100;
export const SOURCE_MAX_LIMIT     = 500;

/**
 * Read ?columns, ?filter, ?order_by, ?limit and ?offset.
 *
 * @returns {{ columns: string[]|null, filter: object[], orderBy: string|null, limit: number, offset: number } | { error: string }}
 */
export function parseSourceQuery(query = {}) {
  const limit = query.limit === undefined ? SOURCE_DEFAULT_LIMIT : (/^\d+$/.test(query.limit) ? Number(query.limit) : NaN);
  if (Number.isNaN(limit) || limit < 1 || limit > SOURCE_MAX_LIMIT) return { error: `limit must be between 1 and ${SOURCE_MAX_LIMIT}` };
  const offset = query.offset === undefined ? 0 : (/^\d+$/.test(query.offset) ? Number(query.offset) : NaN);
  if (Number.isNaN(offset)) return { error: 'offset must be a whole number of rows, 0 or more' };

  let filter = [];
  if (query.filter !== undefined) {
    try { filter = JSON.parse(query.filter); } catch { return { error: 'filter must be a JSON array of { column, op, value }' }; }
    if (!Array.isArray(filter) || filter.some(f => !f || typeof f !== 'object' || typeof f.column !== 'string' || typeof f.op !== 'string')) {
      return { error: 'filter must be a JSON array of { column, op, value }' };
    }
  }
  if (query.with_version !== undefined && !['true', 'false'].includes(query.with_version)) {
    return { error: 'with_version must be true or false' };
  }
  const columns = query.columns === undefined ? null : query.columns.split(',').map(c => c.trim()).filter(Boolean);
  return { columns, filter, orderBy: query.order_by || null, limit, offset, withVersion: query.with_version === 'true' };
}

/**
 * The columns to read: those asked for, else every non-vector column. Every column named — to
 * select or to filter — must be registered.
 *
 * @param {object[]} registered  PGC_Schema.columns
 * @returns {{ columns: object[] } | { error: string }}
 */
export function chooseColumns(registered, { columns, filter }) {
  const byName  = new Map(registered.map(c => [c.name, c]));
  const unknown = [...(columns ?? []), ...filter.map(f => f.column)].filter(n => !byName.has(n));
  if (unknown.length) return { error: `no column ${[...new Set(unknown)].map(n => `"${n}"`).join(', ')}` };
  const chosen = columns
    ? columns.map(n => byName.get(n))
    : registered.filter(c => !String(c.type ?? '').toLowerCase().startsWith('vector'));
  return { columns: chosen.map(c => ({ name: c.name, type: c.type, label: humanise(c.name), labelFallback: true })) };
}

/**
 * The order a page is read in, ending on `id` where the source has one: rows that tie on the
 * order asked for would otherwise fall on either side of a page's edge, repeated or skipped.
 *
 * @param {string|null} orderBy   SQL ORDER BY terms, as ?order_by
 * @param {object[]}    registered PGC_Schema.columns
 * @returns {string|undefined}
 */
export function pageOrder(orderBy, registered) {
  if (!registered.some(c => c.name === 'id')) return orderBy ?? undefined;
  if (orderBy && orderBy.split(',').some(term => term.trim().split(/\s+/)[0].replace(/"/g, '') === 'id')) return orderBy;
  return orderBy ? `${orderBy}, id ASC` : 'id ASC';
}

const SCHEMA_COLUMNS = ['table_name', 'type', 'columns', 'domain', 'foreign_keys'];

/**
 * The PGC_Schema row a source reads, and its PGC_EntitySchema row when the source is an entity
 * (null for a table or view); null when there is no such source. Never a PGC_ table.
 */
async function resolveSource(source) {
  if (source.startsWith('PGC_')) return null;
  const direct  = await getRows('PGC_Schema',
    [{ column: 'table_name', op: 'eq', value: source }, { column: 'target', op: 'eq', value: 'pgd' }], undefined, 1, undefined, SCHEMA_COLUMNS);
  if (direct.rows?.[0]) return { schema: direct.rows[0], entity: null };

  const entityResp = await getRows('PGC_EntitySchema', [{ column: 'entity_name', op: 'eq', value: source }],
    undefined, 1, undefined, ['entity_name', 'root_table', 'joins']);
  const entity = entityResp.rows?.[0];
  if (!entity?.root_table) return null;
  const rootResp = await getRows('PGC_Schema',
    [{ column: 'table_name', op: 'eq', value: entity.root_table }, { column: 'target', op: 'eq', value: 'pgd' }], undefined, 1, undefined, SCHEMA_COLUMNS);
  return rootResp.rows?.[0] ? { schema: rootResp.rows[0], entity } : null;
}

/** An entity's child tables, from the registry. */
async function readChildTables(entity) {
  const joined = [...new Set((entity.joins ?? []).map(j => j.table))];
  if (joined.length === 0) return [];
  const resp = await getRows('PGC_Schema', [{ column: 'table_name', op: 'in', value: joined }], undefined, joined.length, undefined,
    ['table_name', 'columns', 'foreign_keys']);
  return childTablesOf(entity, resp.rows ?? []);
}

/** The edit policy rows of these tables, by table name. A table without one is read-only. */
async function readPolicies(tables) {
  const resp = await getRows('PGC_EditPolicy', [{ column: 'table_name', op: 'in', value: tables }], undefined, tables.length, undefined,
    ['table_name', 'columns', 'add_rows', 'delete_rows']);
  return new Map((resp.rows ?? []).map(r => [r.table_name, r]));
}

const hasVersions = columns => columns.some(c => c.name === 'updated_at');

/**
 * One table as the web lays it out and edits it (openapi SourceTable): its non-vector columns,
 * each with its label, nullability, foreign key target and `editable`, and the table's
 * `addRows`, `deleteRows` — the edit policy's answers, none on a table without versions.
 * Pure — exported for test.
 */
export function sourceTable(tableName, schemaColumns, foreignKeys, policy, parentKey) {
  const versioned = hasVersions(schemaColumns);
  const open      = editableColumns(policy, schemaColumns, parentKey);
  const fkBy      = new Map((foreignKeys ?? []).map(f => [f.column, f.references]));
  return {
    table: tableName,
    versioned,
    columns: schemaColumns
      .filter(c => !String(c.type ?? '').toLowerCase().startsWith('vector'))
      .map(c => ({
        name: c.name, type: c.type, label: humanise(c.name), labelFallback: true,
        nullable: c.nullable !== false && !c.primaryKey,
        editable: open.has(c.name),
        ...(fkBy.get(c.name) ? { references: { table: fkBy.get(c.name).table, column: fkBy.get(c.name).column } } : {}),
      })),
    addRows:    versioned && policy?.add_rows === true,
    deleteRows: versioned && policy?.delete_rows === true,
    ...(parentKey ? { parentKey } : {}),
  };
}

/**
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function readSourceRows(source, query) {
  const resolved = await resolveSource(source);
  if (!resolved) return { status: 404, body: { error: 'source_not_found' } };
  const { schema } = resolved;

  const chosen = chooseColumns(schema.columns ?? [], query);
  if (chosen.error) return { status: 400, body: { error: 'invalid_query', message: chosen.error } };
  if (query.withVersion && !hasVersions(schema.columns ?? [])) {
    return { status: 400, body: { error: 'invalid_query', message: `${schema.table_name} has no versions — with_version needs updated_at` } };
  }

  const resp = await getRows(schema.table_name, query.filter, pageOrder(query.orderBy, schema.columns ?? []), query.limit, undefined,
    chosen.columns.map(c => c.name), query.offset, query.withVersion);
  return {
    status: 200,
    body: {
      columns: chosen.columns,
      rows:    resp.rows ?? [],
      more:    Boolean(resp.truncated),
      ...(resp.total_matching !== undefined ? { totalMatching: resp.total_matching } : {}),
    },
  };
}

/**
 * @returns {Promise<{ status: number, body: object }>}  The source as openapi SourceSchema
 */
export async function readSourceSchema(source) {
  const resolved = await resolveSource(source);
  if (!resolved) return { status: 404, body: { error: 'source_not_found' } };
  const { schema, entity } = resolved;
  const children = entity ? await readChildTables(entity) : [];
  const policies = await readPolicies([schema.table_name, ...children.map(c => c.tableName)]);
  return {
    status: 200,
    body: {
      source,
      kind:   entity ? 'entity' : schema.type === 'view' ? 'view' : 'table',
      domain: schema.domain ?? null,
      table:  sourceTable(schema.table_name, schema.columns ?? [], schema.foreign_keys, policies.get(schema.table_name) ?? null),
      ...(entity ? { children: children.map(c => sourceTable(c.tableName, c.columns ?? [], c.gate.foreign_keys, policies.get(c.tableName) ?? null, c.parentKey)) } : {}),
    },
  };
}

/**
 * A SERV save's answer as PROC's: the result on 200; the rows that moved on 409; SERV's
 * refusal of the request's shape or a column as invalid_writes; PGC_TableMap's refusal as
 * not_editable; a missing record as record_not_found.
 */
function fromServSave(result, pick) {
  const { statusCode, error } = result;
  if (statusCode === 200) return { status: 200, body: pick(result) };
  if (statusCode === 409) return { status: 409, body: { error: 'version_conflict', conflicts: result.conflicts ?? [] } };
  if (statusCode === 400) return { status: 400, body: { error: 'invalid_writes', message: error } };
  if (statusCode === 403) return { status: 403, body: { error: 'not_editable', message: error } };
  if (statusCode === 404) return { status: 404, body: { error: 'record_not_found', message: error } };
  throw new Error(`SERV save failed (${statusCode}): ${error}`);
}

const changeLogFor = (principal, domain) => ({ actor: principal.user, via: 'web', domain });
const notEditable  = fields => ({ status: 403, body: { error: 'not_editable', fields } });
const isRecord     = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A grid's save: one table's update, insert and delete, checked against its edit policy and
 * refused whole if any part is not open, then SERV saveRows, logged.
 */
export async function saveSourceRows(source, body, principal) {
  const resolved = await resolveSource(source);
  if (!resolved) return { status: 404, body: { error: 'source_not_found' } };
  const { schema, entity } = resolved;
  if (entity || schema.type === 'view') {
    return { status: 400, body: { error: 'not_a_table', message: `${source} is ${entity ? 'an entity — save it as a document' : 'a view'}` } };
  }
  const writes   = { update: body?.update, insert: body?.insert, delete: body?.delete };
  const policies = await readPolicies([schema.table_name]);
  const refused  = policyRefusals(schema.table_name, writes, policies.get(schema.table_name) ?? null, schema.columns ?? []);
  if (refused.length) return notEditable(refused);

  const result = await saveRows({ tableName: schema.table_name, ...writes, changeLog: changeLogFor(principal, schema.domain) });
  return fromServSave(result, r => ({ updated: r.updated, inserted: r.inserted, deleted: r.deleted, ...(r.batchId ? { batchId: r.batchId } : {}) }));
}

/** A document: an entity's root with `_version`, and its child rows by table name. */
export async function readSourceRecord(source, id) {
  const resolved = await resolveSource(source);
  if (!resolved) return { status: 404, body: { error: 'source_not_found' } };
  if (!resolved.entity) return { status: 400, body: { error: 'not_an_entity', message: `${source} is a table — read its rows` } };
  const result = await getEntityVersioned(resolved.entity.entity_name, id);
  if (result.statusCode === 404) return { status: 404, body: { error: 'record_not_found' } };
  if (result.statusCode !== 200) throw new Error(`SERV getEntity failed (${result.statusCode}): ${result.error}`);
  return { status: 200, body: { entity: result.entity, children: result.children } };
}

/**
 * A document created (id null) or saved: the root's changes and each child table's writes,
 * each checked against its table's edit policy and refused whole if any part is not open, then
 * SERV saveEntity, logged. A save of children only needs nothing open on the root.
 */
export async function saveSourceRecord(source, id, body, principal) {
  const resolved = await resolveSource(source);
  if (!resolved) return { status: 404, body: { error: 'source_not_found' } };
  const { schema, entity } = resolved;
  if (!entity) return { status: 400, body: { error: 'not_an_entity', message: `${source} is a table — save its rows` } };

  const children   = await readChildTables(entity);
  const byTable    = new Map(children.map(c => [c.tableName, c]));
  const childWrites = isRecord(body?.children) ? body.children : {};
  const policies   = await readPolicies([schema.table_name, ...children.map(c => c.tableName)]);

  const rootChanges = isRecord(body?.root?.changes) ? body.root.changes : {};
  const rootWrites  = id === null ? { insert: [rootChanges] }
    : Object.keys(rootChanges).length ? { update: [{ changes: rootChanges }] } : {};
  const refused = [
    ...policyRefusals(schema.table_name, rootWrites, policies.get(schema.table_name) ?? null, schema.columns ?? []),
    // A table that is not this entity's child is SERV's to refuse; the policy has nothing to say of it.
    ...Object.entries(childWrites).filter(([table]) => byTable.has(table)).flatMap(([table, writes]) => {
      const child = byTable.get(table);
      return policyRefusals(table, writes, policies.get(table) ?? null, child.columns ?? [], child.parentKey);
    }),
  ];
  if (refused.length) return notEditable(refused);

  const result = await saveEntity({
    entityName: entity.entity_name,
    ...(id === null ? {} : { id, version: body?.version }),
    ...(body?.root !== undefined ? { root: body.root } : {}),
    ...(body?.children !== undefined ? { children: body.children } : {}),
    changeLog: changeLogFor(principal, schema.domain),
  });
  return fromServSave(result, r => ({ entity: r.entity, children: r.children, ...(r.batchId ? { batchId: r.batchId } : {}) }));
}

const RECORD_ID = /^[1-9][0-9]{0,15}$/;

/** The route a request names: its operation, and the source and record id it addresses. */
export function matchSourceRoute(method, proxy) {
  const [head, source, kind, id, ...rest] = String(proxy ?? '').split('/').filter(Boolean);
  if (head !== 'sources' || !source || rest.length) return null;
  const at = (op, extra = {}) => ({ op, source: decodeURIComponent(source), ...extra });
  if (kind === 'rows' && id === undefined)   return method === 'GET' ? at('readRows') : method === 'POST' ? at('saveRows') : null;
  if (kind === 'schema' && id === undefined) return method === 'GET' ? at('readSchema') : null;
  if (kind === 'records' && id === undefined) return method === 'POST' ? at('createRecord') : null;
  if (kind === 'records' && RECORD_ID.test(id ?? '')) {
    return method === 'GET' ? at('readRecord', { id: Number(id) }) : method === 'POST' ? at('saveRecord', { id: Number(id) }) : null;
  }
  return null;
}

export async function handle(req) {
  const route = matchSourceRoute(req.method ?? 'GET', req.proxy);
  if (!route) return err(404, `sources route not found: ${req.method} /${req.proxy}`, req.correlationId);
  const principal = readPrincipal(req.headers);
  if (!principal) return respond(401, { success: false, error: 'principal_required' }, req.correlationId);
  if (!principal.roles.includes('household')) return respond(403, { success: false, error: 'household_required' }, req.correlationId);

  let outcome;
  switch (route.op) {
    case 'readRows': {
      const query = parseSourceQuery(req.query);
      if (query.error) return respond(400, { success: false, error: 'invalid_query', message: query.error }, req.correlationId);
      outcome = await readSourceRows(route.source, query);
      break;
    }
    case 'saveRows':     outcome = await saveSourceRows(route.source, req.body, principal); break;
    case 'readSchema':   outcome = await readSourceSchema(route.source); break;
    case 'readRecord':   outcome = await readSourceRecord(route.source, route.id); break;
    case 'createRecord': outcome = await saveSourceRecord(route.source, null, req.body, principal); break;
    case 'saveRecord':   outcome = await saveSourceRecord(route.source, route.id, req.body, principal); break;
  }
  return respond(outcome.status, { success: outcome.status === 200, ...outcome.body }, req.correlationId);
}
