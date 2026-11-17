// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/runs/runs.mjs
//
// A run's decisions (docs/arch-web-app.md §2.4, §4.3, §9), pure: what a run is called, whether it
// is still going, which workflows a panel starts, how a thread's messages come together and how
// often it asks for more.

import { resolveLanguageMap } from '../../../../shared/language-map.mjs';

/** A run still going: its thread asks for more messages until it is not. */
const ACTIVE = new Set(['pending', 'running', 'awaiting_human_gate', 'awaiting_llm_break']);
export const isActive = status => ACTIVE.has(status);

/** A run that is working, not waiting on a person: the thread says Working…. */
export const isWorking = status => status === 'pending' || status === 'running';

/**
 * What a run is called (§2.4): its label, else its workflow's label — a string or a language map,
 * as stored — and the day it started, in the user's locale and timezone.
 *
 * @param {{ label?: string|null, workflowLabel?: string|object|null, workflowName?: string|null, startedAt?: string }} run
 * @param {{ language: string, locale: string, timeZone?: string }} where
 */
export function runName(run, { language, locale, timeZone }) {
  if (run.label) return run.label;
  const workflow = run.workflowLabel ? resolveLanguageMap(run.workflowLabel, language) : run.workflowName ?? '';
  const started  = run.startedAt ? new Date(run.startedAt) : null;
  if (!started || Number.isNaN(started.getTime())) return workflow;
  return `${workflow} · ${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone }).format(started)}`;
}

/**
 * The workflows a workflow panel starts, from GET /workflows: the one it names, or every one of
 * its domain. A named workflow the menu does not list is still started, by its name.
 *
 * @param {{ workflow?: string, domain?: string }} config
 * @param {{ domain: string, workflows: { name: string, label: string }[] }[]} domains
 * @returns {{ name: string, label: string }[]}
 */
export function panelWorkflows(config, domains) {
  if (config.domain) return domains.find(d => d.domain === config.domain)?.workflows ?? [];
  const listed = domains.flatMap(d => d.workflows).find(w => w.name === config.workflow);
  return [listed ?? { name: config.workflow, label: config.workflow }];
}

/**
 * The thread with a new page of messages added: each message once, in the order sent.
 *
 * @param {object[]} held
 * @param {object[]} arrived
 */
export function addMessages(held, arrived) {
  const seen = new Set(held.map(m => m.id));
  return [...held, ...arrived.filter(m => !seen.has(m.id))].sort((a, b) => a.id - b.id);
}

/** How often a thread asks while its run is going, and the longest it waits after failures. */
export const THREAD_POLL_MS     = 3_000;
export const THREAD_POLL_MAX_MS = 60_000;

/** The wait before the thread's next read: steady, doubling with each failure in a row. */
export function threadDelay(failures) {
  return Math.min(THREAD_POLL_MS * 2 ** failures, THREAD_POLL_MAX_MS);
}
