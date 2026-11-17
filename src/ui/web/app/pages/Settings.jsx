// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/pages/Settings.jsx
//
// ⚙ Settings (docs/arch-web-app.md §4.7): a dialog over the page it was opened from, on its own
// route, `/settings/{entry}`. Phase 0 has one entry, Profile — the name and email from the
// sign-in, read-only, and Sign out.

import { useTranslation } from 'react-i18next';
import { Link }           from '../Link.jsx';
import { Drawer }         from '../shell/Drawer.jsx';

/** The Phase 0 entries. */
export const SETTINGS_ENTRIES = ['profile'];

/**
 * @param {object} props
 * @param {string} props.entry
 * @param {{ name?: string, email?: string }|null} props.me
 * @param {string|null} props.from      The location it was opened over, carried to its entries
 * @param {() => void} props.onClose
 * @param {() => void} props.onSignOut
 */
export function Settings({ entry, me, from, onClose, onSignOut }) {
  const { t } = useTranslation();
  return (
    <Drawer title={t('settings.title')} onClose={onClose} centered>
      <div className="settings">
        <nav aria-label={t('settings.title')}>
          <Link to="/settings/profile" state={{ from }} aria-current={entry === 'profile' ? 'page' : undefined}>{t('settings.profile')}</Link>
        </nav>
        <div className="pane">
          {me
            ? (
              <dl className="fields">
                {me.name && <><dt>{t('settings.name')}</dt><dd>{me.name}</dd></>}
                <dt>{t('settings.email')}</dt><dd>{me.email}</dd>
              </dl>
            )
            : <p className="muted">{t('shell.loading')}</p>}
          <div>
            <button type="button" className="btn" onClick={onSignOut}>{t('settings.signOut')}</button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
