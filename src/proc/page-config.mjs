// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/page-config.mjs
//
// The contract of a PGC_Page row (docs/arch-web-app.md §2.3, §4.2): a page holds panels, and each
// panel's config is checked against its kind before it is stored, as L0 checks a step against its
// PGC_StepType contract. An unknown kind, view, widget or key is refused, not stored. One check
// for every writer: dev_scripts/upsert-page.mjs now, the page editor and Novia later.
//
//   workflow  workflow | domain, limit?, show_output?
//   records   source (a table or view) | entity, view? (the one it opens on), the views' options —
//             the viewer switches between the views that fit, so the config names no widget
//   summary   widget: chart | metric (over a source) or report (over a workflow), and its options
//   novia     topic
//
// Pure — no I/O. The registry it checks names against is passed in.

import { isLabel } from './workflow-display.mjs';

export const PANEL_WIDTHS = ['1/3', '1/2', '2/3', 'full'];
export const VIEWS        = ['grid', 'list', 'document'];
export const WIDGETS      = ['chart', 'metric', 'report'];
const CHART_KINDS = ['bar', 'line', 'pie'];

const KIND_KEYS = {
  workflow: ['workflow', 'domain', 'limit', 'show_output'],
  records:  ['source', 'entity', 'view', 'columns', 'filter', 'order_by', 'limit', 'title_column', 'detail_columns', 'picker_column'],
  novia:    ['topic'],
};
const WIDGET_KEYS = {
  chart:  ['widget', 'source', 'kind', 'category_column', 'value_columns', 'filter'],
  metric: ['widget', 'source', 'value_column', 'compare_column', 'filter'],
  report: ['widget', 'workflow'],
};

const isText  = v => typeof v === 'string' && v.trim() !== '';
const isWhole = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/**
 * The views a records source can be shown in: a view's rows are not records you open one at a
 * time, so it has no document view.
 *
 * @param {'table'|'view'|'entity'} type
 */
export function viewsFor(type) {
  return type === 'view' ? ['grid', 'list'] : VIEWS;
}

/**
 * Every problem with a page, each naming where it is. Empty when the page may be written.
 *
 * @param {{ page_key, title, position, panels }} page
 * @param {{ sources: Map<string, { type: 'table'|'view', columns: Set<string> }>,
 *           entities: Map<string, string>,   // entity name → root table
 *           workflows: Set<string>, domains: Set<string> }} registry
 * @returns {string[]}
 */
export function pageProblems(page, registry) {
  const problems = [];
  const at = (where, what) => problems.push(`${where}: ${what}`);

  if (!/^[a-z0-9][a-z0-9-]*$/.test(page?.page_key ?? '')) at('page_key', 'lower-case letters, digits and hyphens');
  if (!isLabel(page?.title)) at('title', 'text, or a language map such as { "en": "…" }');
  if (!isWhole(page?.position, 0, 1000)) at('position', 'a whole number from 0 (Home is 0)');
  if (!Array.isArray(page?.panels)) { at('panels', 'an array'); return problems; }

  const ids = new Set();
  page.panels.forEach((panel, i) => {
    const where = `panel ${panel?.id ?? i}`;
    if (!isText(panel?.id)) at(where, 'id is required');
    else if (ids.has(panel.id)) at(where, 'id is used twice on this page');
    else ids.add(panel.id);

    const unknown = Object.keys(panel ?? {}).filter(k => !['id', 'kind', 'width', 'title', 'config'].includes(k));
    if (unknown.length) at(where, `unknown keys ${unknown.join(', ')}`);
    if (!PANEL_WIDTHS.includes(panel?.width)) at(where, `width is one of ${PANEL_WIDTHS.join(', ')}`);
    if (panel?.title !== undefined && !isLabel(panel.title)) at(where, 'title is text or a language map');

    const config = panel?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) { at(where, 'config is an object'); return; }

    switch (panel.kind) {
      case 'workflow': return workflowProblems(config, registry, m => at(where, m));
      case 'records':  return recordsProblems(config, registry, m => at(where, m));
      case 'summary':  return summaryProblems(config, registry, m => at(where, m));
      case 'novia':    return noviaProblems(config, m => at(where, m));
      default:         at(where, `kind is one of workflow, records, summary, novia — not ${panel?.kind}`);
    }
  });
  return problems;
}

function unknownKeys(config, allowed, report) {
  const unknown = Object.keys(config).filter(k => !allowed.includes(k));
  if (unknown.length) report(`config accepts ${allowed.join(', ')} — not ${unknown.join(', ')}`);
}

function workflowProblems(config, registry, report) {
  unknownKeys(config, KIND_KEYS.workflow, report);
  const { workflow, domain, limit, show_output: showOutput } = config;
  if ((workflow === undefined) === (domain === undefined)) report('name a workflow or a domain, not both');
  if (workflow !== undefined && !registry.workflows.has(workflow)) report(`no workflow "${workflow}"`);
  if (domain   !== undefined && !registry.domains.has(domain))     report(`no domain "${domain}"`);
  if (limit !== undefined && !isWhole(limit, 1, 50)) report('limit is a whole number from 1 to 50');
  if (showOutput !== undefined && typeof showOutput !== 'boolean') report('show_output is true or false');
}

/** The source a records or summary panel reads, or null after reporting why it cannot. */
function resolveSource(config, registry, report, { entityAllowed }) {
  const { source, entity } = config;
  if (entityAllowed && (source === undefined) === (entity === undefined)) { report('name a source or an entity, not both'); return null; }
  if (!entityAllowed && source === undefined) { report('source is required'); return null; }
  if (entity !== undefined) {
    const root = registry.entities.get(entity);
    if (!root) { report(`no entity "${entity}"`); return null; }
    return { type: 'entity', columns: registry.sources.get(root)?.columns ?? new Set() };
  }
  const found = registry.sources.get(source);
  if (!found) { report(`no table or view "${source}"`); return null; }
  return found;
}

function columnProblems(names, source, report) {
  for (const name of names) {
    if (!source.columns.has(name)) report(`no column "${name}"`);
  }
}

function filterProblems(filter, source, report) {
  if (filter === undefined) return;
  if (!Array.isArray(filter) || filter.some(f => !f || typeof f !== 'object' || !isText(f.column) || !isText(f.op))) {
    report('filter is an array of { column, op, value }');
    return;
  }
  columnProblems(filter.map(f => f.column), source, report);
}

function recordsProblems(config, registry, report) {
  unknownKeys(config, KIND_KEYS.records, report);
  const source = resolveSource(config, registry, report, { entityAllowed: true });
  if (!source) return;
  const { view, columns, limit, title_column: titleColumn, detail_columns: detailColumns, picker_column: pickerColumn } = config;

  if (view !== undefined && !viewsFor(source.type).includes(view)) {
    report(`view is one of ${viewsFor(source.type).join(', ')} for a ${source.type}`);
  }
  if (columns !== undefined) {
    if (!Array.isArray(columns)) report('columns is an array');
    else columnProblems(columns.map(c => (typeof c === 'string' ? c : c?.name)), source, report);
  }
  filterProblems(config.filter, source, report);
  if (limit !== undefined && !isWhole(limit, 1, 500)) report('limit is a whole number from 1 to 500');
  for (const [key, value] of [['title_column', titleColumn], ['picker_column', pickerColumn]]) {
    if (value === undefined) continue;
    if (!isText(value)) report(`${key} is a column name`);
    else columnProblems([value], source, report);
  }
  if (detailColumns !== undefined) {
    if (!Array.isArray(detailColumns)) report('detail_columns is an array');
    else columnProblems(detailColumns, source, report);
  }
}

function summaryProblems(config, registry, report) {
  const { widget } = config;
  if (!WIDGETS.includes(widget)) { report(`widget is one of ${WIDGETS.join(', ')}`); return; }
  unknownKeys(config, WIDGET_KEYS[widget], report);

  if (widget === 'report') {
    if (!registry.workflows.has(config.workflow)) report(`no workflow "${config.workflow}"`);
    return;
  }
  const source = resolveSource(config, registry, report, { entityAllowed: false });
  if (!source) return;
  filterProblems(config.filter, source, report);

  if (widget === 'chart') {
    if (config.kind !== undefined && !CHART_KINDS.includes(config.kind)) report(`kind is one of ${CHART_KINDS.join(', ')}`);
    if (!isText(config.category_column)) report('category_column is required');
    else columnProblems([config.category_column], source, report);
    if (!Array.isArray(config.value_columns) || !config.value_columns.length) report('value_columns names at least one column');
    else columnProblems(config.value_columns, source, report);
  } else {
    if (!isText(config.value_column)) report('value_column is required');
    else columnProblems([config.value_column], source, report);
    if (config.compare_column !== undefined) columnProblems([config.compare_column], source, report);
  }
}

function noviaProblems(config, report) {
  unknownKeys(config, KIND_KEYS.novia, report);
  if (!isText(config.topic)) report('topic is required');
}

/**
 * The page's title in the caller's language: the language itself, else English, else the first
 * language the map holds.
 */
export function resolveTitle(title, language = 'en') {
  if (typeof title === 'string') return title;
  return title?.[language] ?? title?.en ?? Object.values(title ?? {})[0] ?? '';
}
