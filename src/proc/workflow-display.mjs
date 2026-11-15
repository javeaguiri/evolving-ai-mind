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
// Pure — no I/O.

import { resolveTemplate } from './template-resolver.mjs';

export const DISPLAY_KEYS = ['label', 'menu', 'run_label'];

const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;
const TOKEN    = /\{\{[^}]+\}\}/;

const isText = v => typeof v === 'string' && v.trim() !== '';

/**
 * Check a display object before it is written. Absent (undefined) and null are both valid:
 * absent leaves the stored display as it is, null clears it.
 *
 * @returns {string|null}  What is wrong, or null when it may be written
 */
export function displayProblem(display) {
  if (display === undefined || display === null) return null;
  if (typeof display !== 'object' || Array.isArray(display)) return 'display must be an object';

  const unknown = Object.keys(display).filter(k => !DISPLAY_KEYS.includes(k));
  if (unknown.length) return `display accepts ${DISPLAY_KEYS.join(', ')} — not ${unknown.join(', ')}`;

  const { label, menu, run_label: runLabel } = display;
  if (label !== undefined && !isText(label)) {
    const entries = label && typeof label === 'object' && !Array.isArray(label) ? Object.entries(label) : [];
    if (!entries.length || entries.some(([lang, text]) => !LANGUAGE.test(lang) || !isText(text))) {
      return 'display.label must be text, or a language map such as { "en": "…", "es": "…" }';
    }
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
