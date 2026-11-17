// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/auth/pkce.mjs
//
// PKCE (RFC 7636) for the sign-in's authorization code flow (docs/arch-web-app.md §1): a random
// verifier kept by the browser, its S256 challenge sent to Cognito, and a random state that ties
// the callback to the request that started it. Web Crypto only. Pure.

export function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const randomString = size => base64url(crypto.getRandomValues(new Uint8Array(size)));

/** 32 random bytes — a 43-character verifier, the RFC's minimum length. */
export const createVerifier = () => randomString(32);

export const createState = () => randomString(16);

/**
 * @param {string} verifier
 * @returns {Promise<string>}  BASE64URL(SHA-256(verifier))
 */
export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
