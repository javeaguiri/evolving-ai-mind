// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/me.mjs
//
// GET /api/v1/proc/me — the principal, its roles, and the language and timezone it works in
// (docs/arch-web-app.md §3.1, §13). Until a user's own profile exists (Settings › Language,
// Phase 1) every principal works in the household's: HOUSEHOLD_LOCALE and HOUSEHOLD_TIMEZONE,
// from SSM. Name and email are Cognito's; WebApiFunction adds them. Transport-agnostic.

import { respond, err }  from '../shared/lambda-utils.mjs';
import { readPrincipal } from './principal.mjs';

/**
 * @param {{ user: string, roles: string[] }} principal
 * @returns {{ user: string, roles: string[], locale: string, timezone: string }}
 */
export function describePrincipal(principal, env = process.env) {
  return { user: principal.user, roles: principal.roles, locale: env.HOUSEHOLD_LOCALE, timezone: env.HOUSEHOLD_TIMEZONE };
}

export async function handle(req) {
  if ((req.method ?? 'GET') !== 'GET') {
    return err(404, `me route not found: ${req.method} /${req.proxy}`, req.correlationId);
  }
  const principal = readPrincipal(req.headers);
  if (!principal) return respond(401, { success: false, error: 'principal_required' }, req.correlationId);
  return respond(200, { success: true, ...describePrincipal(principal) }, req.correlationId);
}
