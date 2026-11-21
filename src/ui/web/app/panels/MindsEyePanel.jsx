// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/panels/MindsEyePanel.jsx
//
// A minds_eye panel (docs/arch-web-app.md §2.5, §4.2): one topic's sessions, most recently active
// first; opening one continues it in the panel; *New* starts a session on the topic. Her region
// drawn with the panel's topic. The session open is the panel's own — `?minds-eye=` is the
// region's.

import { useState }       from 'react';
import { MindsEyeRegion } from '../minds-eye/Region.jsx';
import { panelTopic }     from '../minds-eye/conversation.mjs';
import { PanelFrame }     from './PanelFrame.jsx';

/**
 * @param {object} props
 * @param {object} props.panel     { id, width, config: { domain } | { topic } }
 * @param {string} props.title     The panel's own title, resolved; the topic's title stands in for none
 * @param {object} props.context   { api, domains, locale, onSignInRequired }
 */
export function MindsEyePanel({ panel, title, context }) {
  const [sessionId, setSessionId] = useState(null);
  const { topic, title: topicTitle } = panelTopic(panel.config, context.domains ?? []);
  return (
    <PanelFrame title={title || topicTitle} width={panel.width}>
      <MindsEyeRegion context={context} topic={topic} sessionId={sessionId} onOpen={setSessionId} />
    </PanelFrame>
  );
}
