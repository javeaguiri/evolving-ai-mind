// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/i18n.mjs
//
// The app's words, from catalogs only (docs/arch-web-app.md §13): i18next with ICU
// MessageFormat for plurals and parameters. English is the only catalog in Phase 0.

import i18next             from 'i18next';
import ICU                 from 'i18next-icu';
import { initReactI18next } from 'react-i18next';
import en                  from './locales/en.json';

export const CATALOGS = { en };

/**
 * @param {string} locale  BCP 47, from GET /me
 */
export async function initI18n(locale) {
  await i18next.use(ICU).use(initReactI18next).init({
    lng:           locale,
    fallbackLng:   'en',
    resources:     Object.fromEntries(Object.entries(CATALOGS).map(([lng, translation]) => [lng, { translation }])),
    interpolation: { escapeValue: false },
  });
  return i18next;
}
