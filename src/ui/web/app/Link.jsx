// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/Link.jsx
//
// A link inside the app: a real <a href>, so it can be copied, opened in a new tab or read by a
// screen reader as a link; a plain click moves without a reload (docs/arch-web-app.md §4.8).

import { navigate } from './router.mjs';

/**
 * @param {object} props
 * @param {string} props.to
 * @param {{ from?: string }} [props.state]  Carried on the history entry (router.mjs navigate)
 * @param {() => void} [props.onNavigate]    After a click handled in the app
 */
export function Link({ to, state, onNavigate, children, ...rest }) {
  function onClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to, state);
    onNavigate?.();
  }
  return <a href={to} onClick={onClick} {...rest}>{children}</a>;
}
