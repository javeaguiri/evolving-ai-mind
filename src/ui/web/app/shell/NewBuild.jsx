// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/shell/NewBuild.jsx
//
// "A new version is available — Reload": a tab left open across a deploy runs its old code until it
// reloads. It reads index.html now and then — as it becomes visible, and every few minutes while
// it is — and compares the build it names with its own. A read that fails says nothing.

import { useEffect, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { isNewBuild, VERSION_CHECK_MS } from './version.mjs';

const OWN_SCRIPT = new URL(import.meta.url).pathname;

export function NewBuild() {
  const { t } = useTranslation();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let timer = null;
    async function check() {
      clearTimeout(timer);
      try {
        const html = await (await fetch('/', { cache: 'no-store' })).text();
        if (isNewBuild(html, OWN_SCRIPT)) { setStale(true); return; }
      } catch { /* offline, or a deploy in flight: ask again later */ }
      if (document.visibilityState === 'visible') timer = setTimeout(check, VERSION_CHECK_MS);
    }
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    timer = setTimeout(check, VERSION_CHECK_MS);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  if (!stale) return null;
  return (
    <div className="banner info" role="status">
      {t('shell.newBuild')}{' '}
      <button type="button" className="btn sm" onClick={() => window.location.reload()}>{t('shell.reload')}</button>
    </div>
  );
}
