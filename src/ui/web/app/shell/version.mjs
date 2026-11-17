// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/shell/version.mjs
//
// Is a newer build of the site live than the one this tab runs? The app is a single page: a tab
// left open across a deploy keeps its old code until it reloads. deploy-web.mjs names each build's
// script by its content hash, and index.html — never cached — names the live one; a tab compares
// that name with its own. Pure, but for the read.

const SCRIPT = /\/assets\/app-[A-Za-z0-9]+\.js/;

/** The build's script a page of index.html names, or null. */
export function liveScript(html) {
  return SCRIPT.exec(html ?? '')?.[0] ?? null;
}

/**
 * @param {string} html        index.html as the site serves it now
 * @param {string} ownScript   The path this tab's script was loaded from
 * @returns {boolean}          True only when both are known and differ
 */
export function isNewBuild(html, ownScript) {
  const live = liveScript(html);
  return Boolean(live && SCRIPT.test(ownScript ?? '') && live !== SCRIPT.exec(ownScript)[0]);
}

/** How often an open tab asks whether a newer build is live. */
export const VERSION_CHECK_MS = 300_000;
