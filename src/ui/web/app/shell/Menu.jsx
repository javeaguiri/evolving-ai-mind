// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/shell/Menu.jsx
//
// The top bar's menus (docs/arch-web-app.md §4.1). Each opens on hover and on click — a tablet has
// no hover; a click pins it open until a second click, Escape or a click outside. After an item is
// chosen, hover stays quiet until the pointer leaves the menus, so the menu just closed does not
// open again under it. The menu of the section the user is in stays highlighted.

import { useEffect, useRef, useState } from 'react';
import { Link }                        from '../Link.jsx';

/**
 * The list a menu holds — also the phone's Pages and Domains drawers.
 *
 * @param {object} props
 * @param {{ key: string, label: string, to: string }[]} props.items
 * @param {string|null} props.currentKey
 * @param {{ label: string, to: string }} [props.footer]  *See all…*
 * @param {() => void} props.onPick
 */
export function MenuList({ items, currentKey, footer, onPick }) {
  return (
    <ul className="menulist">
      {items.map(item => (
        <li key={item.key}>
          <Link to={item.to} onNavigate={onPick} aria-current={item.key === currentKey ? 'page' : undefined}>{item.label}</Link>
        </li>
      ))}
      {footer && (
        <li className="foot">
          <Link to={footer.to} onNavigate={onPick}>{footer.label}</Link>
        </li>
      )}
    </ul>
  );
}

/**
 * @param {object} props
 * @param {{ key: string, label: string, items: object[], current: boolean, footer?: object }[]} props.menus
 * @param {string|null} props.currentKey
 * @param {string} props.ariaLabel
 */
export function Menus({ menus, currentKey, ariaLabel }) {
  const [open, setOpen]   = useState(null);    // { key, pinned }
  const [hush, setHush]   = useState(false);
  const nav               = useRef(null);

  useEffect(() => {
    if (!open?.pinned) return undefined;
    const onKey  = e => { if (e.key === 'Escape') setOpen(null); };
    const onDown = e => { if (!nav.current?.contains(e.target)) setOpen(null); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  const picked = () => { setOpen(null); setHush(true); };

  return (
    <nav className="menus" aria-label={ariaLabel} ref={nav} onMouseLeave={() => { setHush(false); if (!open?.pinned) setOpen(null); }}>
      {menus.map(menu => {
        const isOpen = open?.key === menu.key;
        return (
          <div
            key={menu.key}
            className={isOpen ? 'menuwrap open' : 'menuwrap'}
            onMouseEnter={() => { if (!hush && !open?.pinned) setOpen({ key: menu.key, pinned: false }); }}
            onMouseLeave={() => { if (!open?.pinned) setOpen(null); }}
          >
            <button
              type="button"
              className={menu.current ? 'mbtn cur' : 'mbtn'}
              aria-haspopup="true"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen && open.pinned ? null : { key: menu.key, pinned: true })}
            >
              {menu.label}<span className="car" aria-hidden="true">▾</span>
            </button>
            {isOpen && (
              <div className="dd">
                <MenuList items={menu.items} currentKey={currentKey} footer={menu.footer} onPick={picked} />
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
