// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/auth/session.mjs
//
// The signed-in session (docs/arch-web-app.md §1, v0.7). Sign-in is Cognito's managed login with
// the authorization code and PKCE; the access token is held in memory only, the refresh token in
// localStorage, behind the CloudFront CSP. Refresh tokens rotate, so a refresh goes through
// Cognito's GetTokensFromRefreshToken and stores the new refresh token it returns; one refresh
// runs at a time, since two would each spend the same token. When the refresh token is refused
// the session ends and the user signs in again, back to the page they were on (§9 Signed out).
//
// Everything the browser provides is passed in, so the session is tested without one.

import { createVerifier, createState, challengeFor } from './pkce.mjs';

export const REFRESH_KEY = 'evomind.refreshToken';
export const PENDING_KEY = 'evomind.signIn';
const SCOPES             = 'openid email profile aws.cognito.signin.user.admin';
/** An access token this close to expiry is refreshed before use. */
const EXPIRY_MARGIN_MS   = 60_000;

/** Refused by Cognito — sign in again. */
export class SignInRequired extends Error {}
/** Cognito could not be reached — the session is kept. */
export class AuthUnavailable extends Error {}

/**
 * A path on this site to return to after sign-in: absolute, never another origin.
 */
export function safeReturnPath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') && !path.startsWith('/auth/')
    ? path : '/';
}

/**
 * @param {object} deps
 * @param {{ userPoolId: string, clientId: string, authDomain: string, siteUrl: string, region: string }} deps.config
 * @param {Storage} deps.local     localStorage — the refresh token
 * @param {Storage} deps.pending   sessionStorage — one sign-in in flight: verifier, state, return path
 * @param {typeof fetch} deps.fetch
 * @param {(url: string) => void} deps.redirect
 * @param {() => number} [deps.now]
 */
export function createSession({ config, local, pending, fetch, redirect, now = Date.now }) {
  const redirectUri = `${config.siteUrl}/auth/callback`;
  let access     = null;   // { token, expiresAt }
  let refreshing = null;

  async function post(url, init) {
    try {
      const res = await fetch(url, { method: 'POST', ...init });
      return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
    } catch {
      throw new AuthUnavailable();
    }
  }

  function keep({ accessToken, expiresIn, refreshToken }) {
    access = { token: accessToken, expiresAt: now() + expiresIn * 1000 };
    if (refreshToken) local.setItem(REFRESH_KEY, refreshToken);
  }

  function end() {
    access = null;
    local.removeItem(REFRESH_KEY);
  }

  /** Off to managed login; back at /auth/callback, then at `returnTo`. */
  async function signIn(returnTo) {
    const verifier = createVerifier();
    const state    = createState();
    pending.setItem(PENDING_KEY, JSON.stringify({ verifier, state, returnTo: safeReturnPath(returnTo) }));
    const query = new URLSearchParams({
      response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri, scope: SCOPES,
      state, code_challenge: await challengeFor(verifier), code_challenge_method: 'S256',
    });
    redirect(`${config.authDomain}/oauth2/authorize?${query}`);
  }

  /**
   * Finish a sign-in at /auth/callback.
   *
   * @param {URLSearchParams} params  The callback's query
   * @returns {Promise<string>}        The path to return to
   */
  async function completeSignIn(params) {
    const started = JSON.parse(pending.getItem(PENDING_KEY) ?? 'null');
    pending.removeItem(PENDING_KEY);
    if (!started || params.get('state') !== started.state || params.get('error') || !params.get('code')) {
      throw new SignInRequired(params.get('error') ?? 'the sign-in did not match one this page started');
    }
    const res = await post(`${config.authDomain}/oauth2/token`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: config.clientId, code: params.get('code'),
        redirect_uri: redirectUri, code_verifier: started.verifier,
      }),
    });
    if (!res.ok) throw new SignInRequired(res.body?.error ?? `token exchange ${res.status}`);
    keep({ accessToken: res.body.access_token, expiresIn: res.body.expires_in, refreshToken: res.body.refresh_token });
    return started.returnTo;
  }

  async function refresh() {
    const refreshToken = local.getItem(REFRESH_KEY);
    if (!refreshToken) throw new SignInRequired('no refresh token');
    const res = await post(`https://cognito-idp.${config.region}.amazonaws.com/`, {
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken' },
      body: JSON.stringify({ RefreshToken: refreshToken, ClientId: config.clientId }),
    });
    if (res.status === 400) {
      end();
      throw new SignInRequired(res.body?.__type ?? 'refresh refused');
    }
    if (!res.ok) throw new AuthUnavailable();
    const result = res.body.AuthenticationResult;
    keep({ accessToken: result.AccessToken, expiresIn: result.ExpiresIn, refreshToken: result.RefreshToken });
  }

  /** Refresh now, once however many callers ask at the same time. */
  function forceRefresh() {
    refreshing ??= refresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  /**
   * A usable access token, refreshed when it is near expiry or missing.
   *
   * @returns {Promise<string>}  throws SignInRequired or AuthUnavailable
   */
  async function accessToken() {
    if (!access || access.expiresAt - now() < EXPIRY_MARGIN_MS) await forceRefresh();
    return access.token;
  }

  /** Revoke the refresh token, forget the session, and leave through Cognito's logout. */
  async function signOut() {
    const refreshToken = local.getItem(REFRESH_KEY);
    end();
    if (refreshToken) {
      await post(`${config.authDomain}/oauth2/revoke`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken, client_id: config.clientId }),
      }).catch(() => null);
    }
    redirect(`${config.authDomain}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: `${config.siteUrl}/` })}`);
  }

  return { signIn, completeSignIn, accessToken, forceRefresh, signOut, hasSession: () => local.getItem(REFRESH_KEY) !== null };
}
