// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/panels/PanelBoundary.jsx
//
// One panel's failure stays in its frame (docs/arch-web-app.md §4.2, §9): an error while a panel
// draws is caught here, and the panel draws its frame with the error's message, while the rest of
// the page draws normally. Without it React unmounts the whole site and the page goes blank. The
// error goes to the console too, with the component stack, for whoever reads it.

import { Component }          from 'react';
import { useTranslation }     from 'react-i18next';
import { PanelFrame }         from './PanelFrame.jsx';

function PanelFailed({ title, width, message, onRetry }) {
  const { t } = useTranslation();
  return (
    <PanelFrame title={title} width={width}>
      <p className="msg error" role="alert">{t('panel.failed')} <code>{message}</code></p>
      <button type="button" className="btn sm" onClick={onRetry}>{t('panel.retry')}</button>
    </PanelFrame>
  );
}

export class PanelBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('panel failed', { panel: this.props.title, error, stack: info?.componentStack });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <PanelFailed title={this.props.title} width={this.props.width} message={String(this.state.error?.message ?? this.state.error)}
      onRetry={() => this.setState({ error: null })} />;
  }
}
