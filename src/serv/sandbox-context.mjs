// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/sandbox-context.mjs
//
// The test sandbox a SERV request runs against, if any (docs/arch-sandbox.md §3). handler.mjs
// enters it once per request, after sandbox.mjs has validated the x-sandbox header; getClient
// reads it, so every connection the request opens has its search_path set and no route has to
// know a sandbox exists. Its own module so init-brain.mjs and sandbox.mjs can both import it.

import { AsyncLocalStorage } from 'node:async_hooks';

export const SANDBOX_NAME = /^sandbox_[0-9]+$/;

const context = new AsyncLocalStorage();

/** Run fn with every connection it opens pointed at `sandbox`. The name must already be valid. */
export function inSandbox(sandbox, fn) {
  return context.run({ sandbox }, fn);
}

/** The sandbox the current request runs against, or null. */
export function currentSandbox() {
  return context.getStore()?.sandbox ?? null;
}
