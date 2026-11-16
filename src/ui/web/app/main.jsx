// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/main.jsx
//
// The web app's entry (docs/arch-web-app.md §1): load the catalog, then draw the app.

import { createRoot } from 'react-dom/client';
import './styles.css';
import { initI18n }   from './i18n.mjs';
import { App }        from './App.jsx';

const locale = 'en';
await initI18n(locale);
document.documentElement.lang = locale;
createRoot(document.getElementById('root')).render(<App />);
