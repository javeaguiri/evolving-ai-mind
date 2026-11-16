// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/config.mjs
//
// The site's configuration — the Cognito pool, client and domain, the site URL, the region —
// written in at build time by dev_scripts/deploy-web.mjs from the stack's outputs. None of it is
// a secret (docs/arch-web-app.md §1).

/* global __WEB_CONFIG__ */
export const WEB_CONFIG = __WEB_CONFIG__;
