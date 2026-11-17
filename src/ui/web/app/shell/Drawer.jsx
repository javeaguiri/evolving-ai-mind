// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/shell/Drawer.jsx
//
// A panel over the page, from the inline end: 🔔's list, the phone's Pages and Domains, the run
// drawer (docs/arch-web-app.md §4.1, §4.3). `centered` draws it as a dialog in the middle — Settings.
// Escape, the close button or a click on the scrim closes it.

import { useEffect }      from 'react';
import { useTranslation } from 'react-i18next';

/**
 * @param {object} props
 * @param {string} props.title
 * @param {() => void} props.onClose
 * @param {boolean} [props.centered]
 */
export function Drawer({ title, onClose, centered = false, children }) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={centered ? 'scrim center' : 'scrim'} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={centered ? 'modal' : 'drawer'} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dh">
          <h2>{title}</h2>
          <button type="button" className="close" onClick={onClose} aria-label={t('shell.close')}>×</button>
        </div>
        <div className="db">{children}</div>
      </div>
    </div>
  );
}
