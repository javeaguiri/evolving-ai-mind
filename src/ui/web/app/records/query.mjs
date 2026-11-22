// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/records/query.mjs
//
// A records panel's decisions (docs/arch-web-app.md §4.2), pure: what to ask GET /sources for,
// which columns each view shows and how they are labelled, and which view the panel opens on.
// One config serves every view, and no view needs an option: each falls back to the registry —
// the columns read, the table's label column (pickLabelColumn, the rule PROC uses).

import { pickLabelColumn, isReadableColumn } from '../../../../shared/schema-utils.mjs';
import { resolveLanguageMap }                 from '../../../../shared/language-map.mjs';

/** The views every records panel offers. */
export const RECORD_VIEWS = ['grid', 'list'];

/** An entity's records also open as a document: its root and child tables together (§6.2). */
export const DOCUMENT_VIEW = 'document';

/** A panel's `columns`, each as { name, label?, format?, … }, or null when it names none. */
function columnSpecs(config) {
  return Array.isArray(config.columns) ? config.columns.map(c => (typeof c === 'string' ? { name: c } : c)) : null;
}

/**
 * The query for GET /sources/{source}/rows. With `columns` named, only those are read — and any a
 * currency or the list view needs besides; with none, the read's own default (every readable column).
 * Read for editing, each row also carries its `id` and version: an edit addresses a row by both.
 *
 * @param {object} config  A records panel's config
 * @param {number} [offset] Rows already read — the next page starts after them
 * @param {boolean} [withVersion] Each row with its version — the grid is being edited
 * @returns {{ source: string, query: Record<string, string|number|undefined> }}
 */
export function rowsRequest(config, offset = 0, withVersion = false) {
  const specs = columnSpecs(config);
  const names = specs && [...new Set([
    ...(withVersion ? ['id'] : []),
    ...specs.map(s => s.name),
    ...specs.map(s => s.currency_column).filter(Boolean),
    ...[config.title_column, ...(config.detail_columns ?? [])].filter(Boolean),
  ])];
  return {
    source: config.source ?? config.entity,
    query:  {
      columns:  names ? names.join(',') : undefined,
      filter:   config.filter ? JSON.stringify(config.filter) : undefined,
      order_by: config.order_by,
      limit:    config.limit,
      offset:   offset || undefined,
      ...(withVersion ? { with_version: 'true' } : {}),
    },
  };
}

/**
 * A read with its next page added: the rows run on, `more` is the new page's, and the total is
 * the first page's (a short last page is not counted).
 *
 * @param {{ rows: object[], more: boolean, totalMatching?: number }} body
 * @param {{ rows: object[], more: boolean, totalMatching?: number }} page
 */
export function appendPage(body, page) {
  const totalMatching = body.totalMatching ?? page.totalMatching;
  return { ...body, rows: [...body.rows, ...page.rows], more: page.more, ...(totalMatching !== undefined ? { totalMatching } : {}) };
}

/** Columns the system keeps, never shown unless a panel names them (§6.1). */
const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at']);

/**
 * Every column read, each with the panel's own label and format where it gives them, in the
 * panel's order, then the rest. `shown`: the grid draws it — those the panel names, or, when it
 * names none, every one but the system's (§6.1: a key and timestamps are not shown).
 *
 * @param {object} config
 * @param {{ name: string, type: string, label: string }[]} read  The read's `columns`
 * @param {string} language
 */
export function mergeColumns(config, read, language) {
  const specs  = columnSpecs(config);
  const byName = new Map(read.map(c => [c.name, c]));
  const named  = (specs ?? []).filter(s => byName.has(s.name)).map(s => ({
    ...byName.get(s.name),
    ...s,
    label: s.label !== undefined ? resolveLanguageMap(s.label, language) : byName.get(s.name).label,
    shown: true,
  }));
  const rest = read.filter(c => !named.some(n => n.name === c.name)).map(c => ({ ...c, shown: !specs && !SYSTEM_COLUMNS.has(c.name) }));
  return [...named, ...rest];
}

/**
 * The list view's title and up to two details: the panel's `title_column` and `detail_columns`,
 * else the table's label column and the next readable columns the grid shows.
 *
 * @param {object} config
 * @param {object[]} columns  mergeColumns' result
 * @returns {{ title: string|null, details: string[] }}
 */
export function listFields(config, columns) {
  const title   = config.title_column ?? pickLabelColumn(columns);
  const details = config.detail_columns
    ?? columns.filter(c => c.shown && c.name !== title && isReadableColumn(c)).slice(0, 2).map(c => c.name);
  return { title, details };
}

/**
 * The view a panel opens on: the viewer's last choice, else the panel's `view`, else `grid` —
 * whichever of them is a view. `document` draws only for an entity, which the panel learns from
 * its schema; a table falls back to the grid.
 *
 * @param {object} config
 * @param {string|null} remembered
 */
export function initialView(config, remembered) {
  return [remembered, config.view, 'grid'].find(v => [...RECORD_VIEWS, DOCUMENT_VIEW].includes(v));
}

/**
 * A domain page's records panels (§4.4), one per source GET /domains/{domain} lists, in its order,
 * each full width, titled by its label, naming its source and nothing else — every view falls
 * back to the registry.
 *
 * @param {{ source: string, label: string }[]} sources
 */
export function domainPanels(sources) {
  return sources.map(s => ({ id: s.source, kind: 'records', width: 'full', title: s.label, config: { source: s.source } }));
}

/** Where the viewer's choice is kept, per panel, in this browser (§4.2). */
export const viewKey = (pageKey, panelId) => `evomind.view.${pageKey}.${panelId}`;
