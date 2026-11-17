// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/workflow-display.mjs
//
// A workflow's `display` (PGC_Workflow.display, docs/arch-web-app.md §2.4, §6.3): how people see
// it in menus and lists. An evolving artifact — Novia writes it with register_workflow and
// propose_workflow_fix. Phase 0 defines three keys:
//
//   label      what a person reads instead of the name — a string, or a language map { en: '…' }
//   menu       false keeps the workflow out of menus and workflow panels
//   run_label  how one run is named in lists — a {{…}} template over the run's local_state
//
// A domain's `display` (PGC_DomainHelp.display, §3.1) takes the first two, label and menu.
// dev_scripts/upsert-domain-display.mjs writes it from the seed and household/domains.json.
//
// Pure — no I/O.

import { resolveTemplate } from './template-resolver.mjs';
import { stableStringify } from './fingerprint.mjs';

export const DISPLAY_KEYS        = ['label', 'menu', 'run_label'];
export const DOMAIN_DISPLAY_KEYS = ['label', 'menu'];

const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;
const TOKEN    = /\{\{[^}]+\}\}/;

const isText = v => typeof v === 'string' && v.trim() !== '';

/** Text, or a language map such as { en: '…', es: '…' } — how every user-facing label is stored. */
export function isLabel(v) {
  if (isText(v)) return true;
  const entries = v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : [];
  return entries.length > 0 && entries.every(([lang, text]) => LANGUAGE.test(lang) && isText(text));
}

/**
 * Check a display object before it is written. Absent (undefined) and null are both valid:
 * absent leaves the stored display as it is, null clears it.
 *
 * @returns {string|null}  What is wrong, or null when it may be written
 */
export function displayProblem(display, keys = DISPLAY_KEYS) {
  if (display === undefined || display === null) return null;
  if (typeof display !== 'object' || Array.isArray(display)) return 'display must be an object';

  const unknown = Object.keys(display).filter(k => !keys.includes(k));
  if (unknown.length) return `display accepts ${keys.join(', ')} — not ${unknown.join(', ')}`;

  const { label, menu, run_label: runLabel } = display;
  if (label !== undefined && !isLabel(label)) {
    return 'display.label must be text, or a language map such as { "en": "…", "es": "…" }';
  }
  if (menu !== undefined && typeof menu !== 'boolean') return 'display.menu must be true or false';
  if (runLabel !== undefined && !isText(runLabel)) return 'display.run_label must be text — a {{…}} template over the run\'s state';
  return null;
}

/**
 * A run's label, once its template can be filled. The engine substitutes and never formats:
 * a value meant for people is prepared by the workflow, in a js_transform.
 *
 * @param {string|undefined} runLabel   The workflow's display.run_label
 * @param {object} localState           The run's root frame local_state
 * @returns {string|null}  The label, or null while any token is still unresolved
 */
export function resolveRunLabel(runLabel, localState) {
  if (!isText(runLabel)) return null;
  const label = resolveTemplate(runLabel, localState ?? {}).trim();
  return label && !TOKEN.test(label) ? label : null;
}

/**
 * What writing these domain displays would do. Only a domain that exists is written — domains are
 * created by create_domain, never here — and a display is compared by value, not by the text it
 * serialises to (jsonb reorders keys), so a rerun with nothing changed writes nothing.
 *
 * @param {object[]} entries   [{ domain, display }] — display an object, or null to clear it
 * @param {object[]} liveRows  PGC_DomainHelp rows { domain, display }
 * @returns {{ problems: string[], writes: object[], current: string[] }}
 */
export function planDomainDisplays(entries, liveRows) {
  const live = new Map(liveRows.map(r => [r.domain, r.display ?? null]));
  const seen = new Set();
  const plan = { problems: [], writes: [], current: [] };
  for (const entry of entries) {
    const domain = entry?.domain;
    if (typeof domain !== 'string' || !domain) { plan.problems.push('an entry names no domain'); continue; }
    if (seen.has(domain)) { plan.problems.push(`${domain} — named twice`); continue; }
    seen.add(domain);
    if (!live.has(domain)) { plan.problems.push(`${domain} — no PGC_DomainHelp row; a domain is created by create_domain, not here`); continue; }
    if (!('display' in entry)) { plan.problems.push(`${domain} — display is required (null clears it)`); continue; }
    const problem = displayProblem(entry.display, DOMAIN_DISPLAY_KEYS);
    if (problem) { plan.problems.push(`${domain} — ${problem}`); continue; }
    if (stableStringify(entry.display) === stableStringify(live.get(domain))) plan.current.push(domain);
    else plan.writes.push({ domain, display: entry.display });
  }
  return plan;
}
