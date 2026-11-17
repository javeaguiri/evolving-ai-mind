// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/shell/TopBar.jsx
//
// The top bar (docs/arch-web-app.md §4.1): 🏠, the Pages and Domains menus. On a phone the menus
// give way to the page's title, and move to tabs at the foot of the screen (PhoneTabs).

import { useState }       from 'react';
import { useTranslation } from 'react-i18next';
import { Link }           from '../Link.jsx';
import { Menus, MenuList } from './Menu.jsx';
import { Drawer }         from './Drawer.jsx';
import { HomeIcon }       from './icons.jsx';
import { pageItems, domainItems, sectionOf, currentItem } from './nav.mjs';

/** The two menus' contents, shared by the top bar and the phone's tabs. */
function useMenus(route, pages, domains) {
  const { t }   = useTranslation();
  const section = sectionOf(route);
  return [
    { key: 'pages',   label: t('nav.pages'),   items: pageItems(pages ?? []),     current: section === 'pages' },
    { key: 'domains', label: t('nav.domains'), items: domainItems(domains ?? []), current: section === 'domains',
      footer: { label: t('nav.seeAll'), to: '/d' } },
  ];
}

/**
 * @param {object} props
 * @param {{ page: string, params: object }} props.route
 * @param {string|null} props.title     The page's title — the phone shows it beside 🏠
 * @param {object[]|null} props.pages
 * @param {object[]|null} props.domains
 */
export function TopBar({ route, title, pages, domains, children }) {
  const { t } = useTranslation();
  const menus = useMenus(route, pages, domains);
  return (
    <header className="top">
      <Link to="/" className="homeb" aria-label={t('nav.home')} title={t('nav.home')} aria-current={route.page === 'home' ? 'page' : undefined}>
        <HomeIcon />
      </Link>
      <span className="crumb">{title}</span>
      <Menus menus={menus} currentKey={currentItem(route)} ariaLabel={t('nav.sections')} />
      <div className="icons">{children}</div>
    </header>
  );
}

/** The phone's Pages and Domains tabs, each opening its list from the side. */
export function PhoneTabs({ route, pages, domains }) {
  const { t }           = useTranslation();
  const menus           = useMenus(route, pages, domains);
  const [open, setOpen] = useState(null);
  const menu            = menus.find(m => m.key === open);
  return (
    <>
      <nav className="tabbar" aria-label={t('nav.sections')}>
        {menus.map(m => (
          <button key={m.key} type="button" aria-current={m.current ? 'true' : undefined} onClick={() => setOpen(m.key)}>{m.label}</button>
        ))}
      </nav>
      {menu && (
        <Drawer title={menu.label} onClose={() => setOpen(null)}>
          <MenuList items={menu.items} currentKey={currentItem(route)} footer={menu.footer} onPick={() => setOpen(null)} />
        </Drawer>
      )}
    </>
  );
}
