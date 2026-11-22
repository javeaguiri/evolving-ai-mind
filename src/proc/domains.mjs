// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/domains.mjs
//
// GET /api/v1/proc/domains/{domain} — a domain's records, from the registry: what its domain page
// draws a records panel for (docs/arch-web-app.md §4.4). Never stored, so a household cannot
// break a domain page by editing it. An entity with child tables is one source and replaces its
// root table; its child tables are shown inside its documents, not as sources of their own, unless
// a child table is itself the root of a registered entity — an expense is a spending category's
// child and an entity of its own (Javear, 2026-11-22). Every other table and view is its own
// source. Each is labelled from its table's name until the registry holds labels.
// Domain data belongs to the household.
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { respond, err }  from '../shared/lambda-utils.mjs';
import { getRows }       from '../shared/serv-client.mjs';
import { childTablesOf, tableLabel } from '../shared/schema-utils.mjs';
import { readPrincipal } from './principal.mjs';

const KIND_ORDER = { entity: 0, table: 1, view: 2 };

/**
 * A domain's sources, in the order its page draws them: entities with child tables first —
 * each replacing its root table — then the other tables, then views, each by label. A child
 * table of such an entity is left to its documents unless it is an entity's root itself.
 * Pure — exported for test.
 *
 * @param {object[]} tables    The domain's PGC_Schema rows { table_name, type, foreign_keys }
 * @param {object[]} entities  The domain's PGC_EntitySchema rows { entity_name, root_table, joins }
 * @returns {{ source: string, kind: string, label: string, labelFallback: true }[]}
 */
export function domainSources(tables, entities) {
  const documents = entities.filter(e => childTablesOf(e, tables).length > 0);
  const roots     = new Set(entities.map(e => e.root_table));
  const children  = new Set(documents.flatMap(e => childTablesOf(e, tables).map(c => c.tableName)).filter(t => !roots.has(t)));
  const replaced  = new Set([...documents.map(e => e.root_table), ...children]);
  return [
    ...documents.map(e => ({ source: e.entity_name, kind: 'entity', label: tableLabel(e.root_table), labelFallback: true })),
    ...tables.filter(t => !replaced.has(t.table_name))
      .map(t => ({ source: t.table_name, kind: t.type === 'view' ? 'view' : 'table', label: tableLabel(t.table_name), labelFallback: true })),
  ].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label));
}

/** @returns {Promise<{ status: number, body: object }>} */
export async function readDomain(domain) {
  const read = async (table, filters, columns) => {
    const resp = await getRows(table, filters, undefined, 1000, undefined, columns);
    if (resp.truncated) throw new Error(`${table} read for domain ${domain} was cut short`);
    return resp.rows ?? [];
  };
  const tables   = await read('PGC_Schema', [{ column: 'domain', op: 'eq', value: domain }, { column: 'target', op: 'eq', value: 'pgd' }],
    ['table_name', 'type', 'foreign_keys']);
  const entities = await read('PGC_EntitySchema', [{ column: 'domain', op: 'eq', value: domain }], ['entity_name', 'root_table', 'joins']);
  return { status: 200, body: { domain, sources: domainSources(tables, entities) } };
}

export async function handle(req) {
  const segments = (req.proxy || '').split('/').filter(Boolean);
  if ((req.method ?? 'GET') !== 'GET' || segments.length !== 2 || segments[0] !== 'domains') {
    return err(404, `domains route not found: ${req.method} /${req.proxy}`, req.correlationId);
  }
  const principal = readPrincipal(req.headers);
  if (!principal) return respond(401, { success: false, error: 'principal_required' }, req.correlationId);
  if (!principal.roles.includes('household')) return respond(403, { success: false, error: 'household_required' }, req.correlationId);

  const { status, body } = await readDomain(decodeURIComponent(segments[1]));
  return respond(status, { success: status === 200, ...body }, req.correlationId);
}
