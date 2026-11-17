// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/panels/ReportPanel.jsx
//
// A report panel (docs/arch-web-app.md §2.6, §4.2, §4.3, §9): the latest output of a workflow — the
// last notification of its latest completed run, whichever surface ran it — drawn as markdown, with
// when and from which run. ↻ Refresh starts the workflow; the run opens in the run drawer, where
// its questions are answered, and once it completes the report is drawn again from the new output.
// A run that fails or is cancelled leaves the report as it was.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from '../auth/session.mjs';
import { navigate }            from '../router.mjs';
import { Markdown }            from '../Markdown.jsx';
import { isActive, threadDelay } from '../runs/runs.mjs';
import { PanelFrame }          from './PanelFrame.jsx';

/**
 * The report drawn from its read — what the panel holds, and what the tests draw.
 *
 * @param {object} props
 * @param {{ status: string, body?: object }} props.output
 * @param {{ locale: string, timeZone?: string }} props.where
 */
export function ReportBody({ output, where }) {
  const { t } = useTranslation();
  switch (output.status) {
    case 'loading': return <div className="skeleton" aria-busy="true" aria-label={t('shell.loading')}><i /><i /><i /></div>;
    case 'none':    return <p className="muted">{t('report.notRun')}</p>;
    case 'missing': return <p className="muted">{t('report.missing', { workflow: output.workflow })}</p>;
    case 'failed':  return <p className="muted">{t('records.failed')}</p>;
    default: {
      const { payload, label, completedAt, runId } = output.body;
      const when = completedAt
        ? new Intl.DateTimeFormat(where.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: where.timeZone }).format(new Date(completedAt))
        : '';
      return (
        <>
          <div className="pbody report">
            {payload?.format === 'markdown' ? <Markdown text={payload.message} /> : <p className="plain">{payload?.message}</p>}
          </div>
          <p className="pfoot">{[when && t('report.updated', { when }), label, `#${runId}`].filter(Boolean).join(' · ')}</p>
        </>
      );
    }
  }
}

/**
 * @param {object} props
 * @param {{ id: string, width: string, config: { workflow: string } }} props.panel
 * @param {string} props.title
 * @param {{ api: object, locale: string, timeZone?: string, onSignInRequired: () => void }} props.context
 */
export function ReportPanel({ panel, title, context }) {
  const { t } = useTranslation();
  const { api, onSignInRequired } = context;
  const { workflow } = panel.config;
  const [output, setOutput]     = useState({ status: 'loading' });
  const [watching, setWatching] = useState(null);       // the refresh run, until it ends
  const [problem, setProblem]   = useState(null);

  const load = useCallback(() => {
    api.get(`outputs/${encodeURIComponent(workflow)}`).then(
      body => setOutput({ status: 'ready', body }),
      e => {
        if (e instanceof SignInRequired) onSignInRequired();
        else if (e.code === 'no_output') setOutput({ status: 'none' });
        else if (e.code === 'workflow_not_found') setOutput({ status: 'missing', workflow });
        else setOutput({ status: 'failed' });
      },
    );
  }, [api, workflow, onSignInRequired]);

  useEffect(load, [load]);

  // The refresh run: asked after until it ends; completed, the report is read again.
  useEffect(() => {
    if (watching === null) return undefined;
    let alive = true, timer = null, failures = 0;
    async function check() {
      try {
        const run = await api.get(`runs/${watching}`);
        failures = 0;
        if (!alive) return;
        if (!isActive(run.status)) {
          setWatching(null);
          if (run.status === 'completed') load();
          return;
        }
        timer = setTimeout(check, threadDelay(failures, run.status));
      } catch (e) {
        if (!alive) return;
        if (e instanceof SignInRequired) { onSignInRequired(); return; }
        failures += 1;
        timer = setTimeout(check, threadDelay(failures));
      }
    }
    check();
    return () => { alive = false; clearTimeout(timer); };
  }, [api, watching, load, onSignInRequired]);

  async function refresh() {
    setProblem(null);
    try {
      const { runId } = await api.post('runs', { workflow });
      setWatching(runId);
      navigate(`${window.location.pathname}?run=${runId}`);
    } catch (e) {
      if (e instanceof SignInRequired) onSignInRequired();
      else setProblem(t('workflow.failed'));
    }
  }

  const tools = output.status === 'missing' ? null : (
    <button type="button" className="btn sm" onClick={refresh} disabled={watching !== null}
      aria-label={t('report.refreshLabel')}>
      {watching !== null ? t('report.refreshing') : t('report.refresh')}
    </button>
  );
  return (
    <PanelFrame title={title} width={panel.width} tools={tools}>
      <ReportBody output={output} where={{ locale: context.locale, timeZone: context.timeZone }} />
      {problem && <p className="muted" role="alert">{problem}</p>}
    </PanelFrame>
  );
}
