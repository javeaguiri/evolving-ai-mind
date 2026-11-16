// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/App.jsx
//
// The shell (docs/arch-web-app.md §4.1). Empty until the top bar, sign-in and routes land.

import { useTranslation } from 'react-i18next';

export function App() {
  const { t } = useTranslation();
  return (
    <main className="shell">
      <h1>{t('app.name')}</h1>
    </main>
  );
}
