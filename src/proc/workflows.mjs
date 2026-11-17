// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/workflows.mjs
//
// GET /api/v1/proc/workflows — the household's domains and the workflows a person can start in
// each: the Domains menu and a domain page's workflow panel (docs/arch-web-app.md §3.1), the
// workflows part of Phase 1's GET /domains. A domain is any with a PGC_DomainHelp row or a
// domain workflow, unless its display.menu is false; a workflow is the latest version of each domain workflow whose display.menu
// is not false. System workflows (domain null) are never listed — they are not startable by
// name (runs.mjs). Labels come from display.label on PGC_DomainHelp and PGC_Workflow, in the
// household's language; with none stored, the humanised identifier, marked labelFallback.
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { respond, err }  from '../shared/lambda-utils.mjs';
import { getRows }       from '../shared/serv-client.mjs';
import { readPrincipal } from './principal.mjs';
import { resolveLanguageMap } from '../shared/language-map.mjs';
import { isLabel }       from './workflow-display.mjs';

/** budgets_expenses → "Budgets expenses" */
export function humanise(identifier) {
  const words = identifier.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a person reads for a domain or workflow: its display.label in the locale, else its
 * humanised identifier, marked labelFallback. One rule for the Domains menu and the gates.
 */
export function labelOf(display, identifier, locale) {
  return isLabel(display?.label)
    ? { label: resolveLanguageMap(display.label, locale), labelFallback: false }
    : { label: humanise(identifier), labelFallback: true };
}

/**
 * @param {object[]} domainRows    PGC_DomainHelp rows { domain, display }
 * @param {object[]} workflowRows  PGC_Workflow rows { name, domain, version, description, display }, every version
 * @param {string}   locale        The caller's locale
 * @returns {object[]}  DomainMenu entries, sorted by label in the caller's locale
 */
export function domainMenus(domainRows, workflowRows, locale) {
  const latest = new Map();
  for (const row of workflowRows) {
    if (row.domain == null) continue;
    const held = latest.get(row.name);
    if (!held || row.version > held.version) latest.set(row.name, row);
  }
  const byLabel = new Intl.Collator(locale).compare;
  const domains = new Map(domainRows.map(d => [d.domain, d.display]));
  for (const wf of latest.values()) if (!domains.has(wf.domain)) domains.set(wf.domain, null);

  return [...domains].filter(([, display]) => display?.menu !== false).map(([domain, display]) => ({
    domain,
    ...labelOf(display, domain, locale),
    workflows: [...latest.values()]
      .filter(wf => wf.domain === domain && wf.display?.menu !== false)
      .map(wf => ({ name: wf.name, ...labelOf(wf.display, wf.name, locale), description: wf.description ?? null }))
      .sort((a, b) => byLabel(a.label, b.label)),
  })).sort((a, b) => byLabel(a.label, b.label));
}

export async function handle(req) {
  if ((req.method ?? 'GET') !== 'GET') {
    return err(404, `workflows route not found: ${req.method} /${req.proxy}`, req.correlationId);
  }
  const principal = readPrincipal(req.headers);
  if (!principal) return respond(401, { success: false, error: 'principal_required' }, req.correlationId);
  if (!principal.roles.includes('household')) return respond(403, { success: false, error: 'household_required' }, req.correlationId);

  // Every version of every domain workflow: SERV cannot ask for the latest per name. A read SERV
  // cut short could drop a workflow, or show an older version's label, so it is refused, not served.
  const [domainResp, workflowResp] = await Promise.all([
    getRows('PGC_DomainHelp', [], undefined, undefined, undefined, ['domain', 'display']),
    getRows('PGC_Workflow', [{ column: 'domain', op: 'not_null' }], undefined, undefined, undefined,
      ['name', 'domain', 'version', 'description', 'display']),
  ]);
  const cut = [domainResp, workflowResp].find(r => r.truncated);
  if (cut) {
    console.error('proc/workflows: a registry read was cut short — menu withheld', { totalMatching: cut.total_matching, limit: cut.limit });
    return respond(500, { success: false, error: 'workflows_truncated', totalMatching: cut.total_matching }, req.correlationId);
  }
  const domains = domainMenus(domainResp.rows ?? [], workflowResp.rows ?? [], process.env.HOUSEHOLD_LOCALE);
  return respond(200, { success: true, domains }, req.correlationId);
}
