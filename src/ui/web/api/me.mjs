// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/api/me.mjs
//
// GET /api/v1/ui/web/me — PROC's /me (roles, locale, timezone) joined with the user's name and
// email from Cognito (docs/arch-web-app.md §3.1). Cognito's GetUser is read over plain HTTPS
// with the request's own access token — the scope aws.cognito.signin.user.admin the authorizer
// already required — so the function needs no SDK and no IAM grant.

import { callProc, fetchUpstream, upstreamUnavailable } from './proc-client.mjs';

/**
 * The user's Cognito attributes, by name.
 *
 * @param {string} accessToken
 * @returns {Promise<Record<string, string>>}
 */
export async function getCognitoAttributes(accessToken) {
  const res = await fetchUpstream(`https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.GetUser' },
    body:    JSON.stringify({ AccessToken: accessToken }),
  });
  if (!res.ok || !Array.isArray(res.body?.UserAttributes)) {
    console.error('web-api: Cognito GetUser failed', { status: res.status, type: res.body?.__type });
    throw upstreamUnavailable();
  }
  return Object.fromEntries(res.body.UserAttributes.map(a => [a.Name, a.Value]));
}

/**
 * @returns {Promise<{ name: string|null, email: string, roles: string[], locale: string, timezone: string }>}
 */
export async function readMe({ sub, accessToken, correlationId }) {
  const [{ body: principal }, attributes] = await Promise.all([
    callProc({ method: 'GET', procPath: 'me', sub, correlationId }),
    getCognitoAttributes(accessToken),
  ]);
  return {
    name:     attributes.name ?? null,
    email:    attributes.email,
    roles:    principal.roles,
    locale:   principal.locale,
    timezone: principal.timezone,
  };
}
