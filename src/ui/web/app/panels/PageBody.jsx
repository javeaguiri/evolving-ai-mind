// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/panels/PageBody.jsx
//
// A page's panels (docs/arch-web-app.md §4.2), laid out in a grid by width; a phone stacks them in
// order, full width. Each is its kind inside the frame; a summary's chart and metric widgets are
// Phase 1 and draw the frame alone. A minds_eye panel is her region on its topic.

import { useTranslation }     from 'react-i18next';
import { resolveLanguageMap } from '../../../../shared/language-map.mjs';
import { RecordsPanel }       from './RecordsPanel.jsx';
import { WorkflowPanel }      from './WorkflowPanel.jsx';
import { ReportPanel }        from './ReportPanel.jsx';
import { MindsEyePanel }      from './MindsEyePanel.jsx';
import { PanelFrame }         from './PanelFrame.jsx';

/**
 * @param {object} props
 * @param {string} props.pageKey
 * @param {object[]} props.panels   The page's panels, as GET /pages sends them
 * @param {object} props.context    { api, domains, locale, timeZone, onSignInRequired }
 */
export function PageBody({ pageKey, panels, context }) {
  const { i18n } = useTranslation();
  return (
    <div className="panels">
      {panels.map(panel => {
        const title = resolveLanguageMap(panel.title ?? '', i18n.language);
        if (panel.kind === 'records') {
          return <RecordsPanel key={panel.id} pageKey={pageKey} panel={panel} title={title} context={context} />;
        }
        if (panel.kind === 'workflow') {
          return <WorkflowPanel key={panel.id} panel={panel} title={title} context={context} />;
        }
        if (panel.kind === 'summary' && panel.config?.widget === 'report') {
          return <ReportPanel key={panel.id} panel={panel} title={title} context={context} />;
        }
        if (panel.kind === 'minds_eye') {
          return <MindsEyePanel key={panel.id} panel={panel} title={title} context={context} />;
        }
        return <PanelFrame key={panel.id} title={title} width={panel.width} />;
      })}
    </div>
  );
}
