// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/sources.mjs
//
// GET /api/v1/proc/sources/{source}/rows — the read-only records read behind a records or summary
// panel (docs/arch-web-app.md §3.1, §4.2). A source is a registered PGD_ table or view, or an
// entity name, whose root table is read; a PGC_ system table is never a source. Columns default to
// every non-vector column, and any column named — to select or to filter — must be registered.
// Each column carries the label a person reads: until the registry holds column labels (§6.3,
// Phase 1), the humanised name, marked labelFallback (§13). The page is bounded and says so;
// ?offset reads the next.
// Domain data belongs to the household.
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { respond, err }   from '../shared/lambda-utils.mjs';
import { getRows }        from '../shared/serv-client.mjs';
import { readPrincipal }  from './principal.mjs';
import { humanise }       from './workflows.mjs';

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
  const columns = query.columns === undefined ? null : query.columns.split(',').map(c => c.trim()).filter(Boolean);
  return { columns, filter, orderBy: query.order_by || null, limit, offset };
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

/** The PGC_Schema row a source reads, or null. Never a PGC_ table. */
async function resolveSource(source) {
  if (source.startsWith('PGC_')) return null;
  const columns = ['table_name', 'type', 'columns'];
  const direct  = await getRows('PGC_Schema',
    [{ column: 'table_name', op: 'eq', value: source }, { column: 'target', op: 'eq', value: 'pgd' }], undefined, 1, undefined, columns);
  if (direct.rows?.[0]) return direct.rows[0];

  const entity = await getRows('PGC_EntitySchema', [{ column: 'entity_name', op: 'eq', value: source }],
    undefined, 1, undefined, ['root_table']);
  const root = entity.rows?.[0]?.root_table;
  if (!root) return null;
  const rootResp = await getRows('PGC_Schema',
    [{ column: 'table_name', op: 'eq', value: root }, { column: 'target', op: 'eq', value: 'pgd' }], undefined, 1, undefined, columns);
  return rootResp.rows?.[0] ?? null;
}

/**
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function readSourceRows(source, query) {
  const schema = await resolveSource(source);
  if (!schema) return { status: 404, body: { error: 'source_not_found' } };

  const chosen = chooseColumns(schema.columns ?? [], query);
  if (chosen.error) return { status: 400, body: { error: 'invalid_query', message: chosen.error } };

  const resp = await getRows(schema.table_name, query.filter, pageOrder(query.orderBy, schema.columns ?? []), query.limit, undefined,
    chosen.columns.map(c => c.name), query.offset);
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

export async function handle(req) {
  const segments = (req.proxy || '').split('/').filter(Boolean);
  if ((req.method ?? 'GET') !== 'GET' || segments.length !== 3 || segments[2] !== 'rows') {
    return err(404, `sources route not found: ${req.method} /${req.proxy}`, req.correlationId);
  }
  const principal = readPrincipal(req.headers);
  if (!principal) return respond(401, { success: false, error: 'principal_required' }, req.correlationId);
  if (!principal.roles.includes('household')) return respond(403, { success: false, error: 'household_required' }, req.correlationId);

  const query = parseSourceQuery(req.query);
  if (query.error) return respond(400, { success: false, error: 'invalid_query', message: query.error }, req.correlationId);

  const { status, body } = await readSourceRows(decodeURIComponent(segments[1]), query);
  return respond(status, { success: status === 200, ...body }, req.correlationId);
}
