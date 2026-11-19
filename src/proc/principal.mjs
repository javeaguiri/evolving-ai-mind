// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/principal.mjs
//
// The person a web-family PROC request acts for (docs/arch-security.md S5, the header form while
// there is one user). WebApiFunction sets x-principal-user from the verified Cognito token; only a
// caller holding the internal key reaches PROC, so only that caller can set it. It is never read
// from a request body.
//
// Roles come from configuration, not the request: 'household' when the user is one of
// HOUSEHOLD_PRINCIPALS. A web-started run belongs to the sub that started it (its callback's
// channel); a Slack-started or scheduled run, and every page, belongs to the household.
// Transport-agnostic — no AWS SDK.

/**
 * @param {object} headers     The request's headers, in whatever case API Gateway delivered them
 * @param {string} household   Comma-separated principals holding the household role
 * @returns {{ user: string, roles: string[] } | null}  null when no principal was sent
 */
export function readPrincipal(headers = {}, household = process.env.HOUSEHOLD_PRINCIPALS ?? '') {
  const key  = Object.keys(headers).find(k => k.toLowerCase() === 'x-principal-user');
  const user = key ? String(headers[key] ?? '').trim() : '';
  if (!user) return null;
  const members = household.split(',').map(s => s.trim()).filter(Boolean);
  return { user, roles: members.includes(user) ? ['household'] : [] };
}

/**
 * May this principal see this run, and everything addressed to it?
 *
 * @param {{ user: string, roles: string[] }} principal
 * @param {{ callback?: object|null }} run   A PGC_WorkflowRun row, with at least its callback
 */
export function canSeeRun(principal, run) {
  const callback = run?.callback;
  if (callback?.provider === 'web') return callback.channel === principal.user;
  return principal.roles.includes('household');
}

/**
 * May this principal see this minds-eye session? Only minds_eye sessions are ever shown, and a
 * session is owned by its callback as a run is: a web-started one by its starter, a Slack-started
 * one by the household (decision O).
 *
 * @param {{ user: string, roles: string[] }} principal
 * @param {{ session_type?: string, callback?: object|null }} session   A PGC_Session row
 */
export function canSeeSession(principal, session) {
  return session?.session_type === 'minds_eye' && canSeeRun(principal, session);
}

/**
 * A run Novia started to test her work (callback provider `novia`): it ran against the sandbox
 * and its messages went to her session, so no web read lists it or answers for it.
 *
 * @param {{ callback?: object|null }} run
 */
export const isNoviaTestRun = run => run?.callback?.provider === 'novia';
