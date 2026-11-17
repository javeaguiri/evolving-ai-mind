// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/panels/WorkflowPanel.jsx
//
// A workflow panel (docs/arch-web-app.md §4.2, §4.3, §9): a Start button per workflow — the one
// it names or every one of its domain — and their runs by name, newest first. Start, or a run
// clicked, opens that run in the panel, which widens to the page's width while it shows it; ⤢
// opens it as the run page, × goes back to the list.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from '../auth/session.mjs';
import { Link }                from '../Link.jsx';
import { RunThread }           from '../runs/RunThread.jsx';
import { panelWorkflows, runName } from '../runs/runs.mjs';
import { relativeAge }         from '../shell/nav.mjs';
import { PanelFrame }          from './PanelFrame.jsx';

const DEFAULT_LIMIT = 5;

/** A run's state, when it needs saying — a finished run says nothing. */
function StatusTag({ status }) {
  const { t } = useTranslation();
  if (status === 'awaiting_human_gate') return <span className="pill wait">{t('run.status.needsYou')}</span>;
  if (status === 'pending' || status === 'running' || status === 'awaiting_llm_break') return <span className="pill run">{t('run.status.running')}</span>;
  if (status === 'failed') return <span className="pill bad">{t('run.status.failed')}</span>;
  if (status === 'cancelled') return <span className="pill done">{t('run.status.cancelled')}</span>;
  return null;
}

/**
 * The list half of the panel, drawn from its data — what the panel holds when no run is open,
 * and what the tests draw.
 *
 * @param {object} props
 * @param {{ name: string, label: string }[]} props.workflows
 * @param {object[]|null} props.runs      GET /runs's runs, or null while they are read
 * @param {{ language: string, locale: string, timeZone?: string, now: number }} props.where
 * @param {(name: string) => void} props.onStart
 * @param {(runId: number) => void} props.onOpen
 * @param {string|null} props.problem     A start or read that failed, in words
 * @param {boolean} props.starting
 */
export function WorkflowList({ workflows, runs, where, onStart, onOpen, problem, starting }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="btnrow">
        {workflows.map(w => (
          <button key={w.name} type="button" className={workflows.length === 1 ? 'btn primary' : 'btn'} disabled={starting} onClick={() => onStart(w.name)}>
            {w.label}
          </button>
        ))}
      </div>
      {problem && <p className="muted" role="alert">{problem}</p>}
      {runs === null && <div className="skeleton" aria-busy="true" aria-label={t('shell.loading')}><i /><i /></div>}
      {runs !== null && runs.length === 0 && (
        <p className="muted">{workflows.length === 1 ? t('workflow.emptyOne', { workflow: workflows[0].label }) : t('workflow.empty')}</p>
      )}
      {runs !== null && runs.length > 0 && (
        <ul className="runs">
          {runs.map(r => (
            <li key={r.runId}>
              <button type="button" onClick={() => onOpen(r.runId)}>
                <span className="lbl">{runName(r, where)}</span>
                <StatusTag status={r.status} />
                <span className="when"><time dateTime={r.startedAt}>{relativeAge(r.startedAt, where.now, where.locale)}</time> · #{r.runId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * @param {object} props
 * @param {{ id: string, width: string, config: { workflow?: string, domain?: string, limit?: number } }} props.panel
 * @param {string} props.title
 * @param {{ api: object, domains: object[]|null, locale: string, timeZone?: string, onSignInRequired: () => void }} props.context
 */
export function WorkflowPanel({ panel, title, context }) {
  const { t, i18n }  = useTranslation();
  const { api, onSignInRequired } = context;
  const { config }   = panel;
  const workflows    = panelWorkflows(config, context.domains ?? []);
  const [runs, setRuns]         = useState(null);
  const [open, setOpen]         = useState(null);      // runId shown in the panel
  const [openRun, setOpenRun]   = useState(null);
  const [problem, setProblem]   = useState(null);
  const [starting, setStarting] = useState(false);
  const where = { language: i18n.language, locale: context.locale, timeZone: context.timeZone, now: Date.now() };

  const failed = useCallback(e => {
    if (e instanceof SignInRequired) onSignInRequired();
    else setProblem(t('workflow.failed'));
  }, [onSignInRequired, t]);

  useEffect(() => {
    if (open !== null) return undefined;
    let alive = true;
    const query = { ...(config.domain ? { domain: config.domain } : { workflow: config.workflow }), limit: config.limit ?? DEFAULT_LIMIT };
    api.get('runs', query).then(body => { if (alive) setRuns(body.runs); }, e => { if (alive) failed(e); });
    return () => { alive = false; };
  }, [api, config, open, failed]);

  async function start(name) {
    setStarting(true);
    setProblem(null);
    try {
      const { runId } = await api.post('runs', { workflow: name });
      setOpenRun(null);
      setOpen(runId);
    } catch (e) {
      failed(e);
    } finally {
      setStarting(false);
    }
  }

  if (open !== null) {
    const tools = (
      <span className="ptools">
        <Link to={`/runs/${open}`} className="iconbtn" aria-label={t('run.openPage')} title={t('run.openPage')}>⤢</Link>
        <button type="button" className="iconbtn" aria-label={t('shell.close')} title={t('shell.close')} onClick={() => { setOpen(null); setRuns(null); }}>×</button>
      </span>
    );
    return (
      <PanelFrame title={openRun ? runName(openRun, where) : title} width="full" tools={tools}>
        <RunThread runId={open} context={context} onRun={setOpenRun} />
      </PanelFrame>
    );
  }
  return (
    <PanelFrame title={title} width={panel.width}>
      <WorkflowList workflows={workflows} runs={runs} where={where} onStart={start} onOpen={id => { setOpenRun(null); setOpen(id); }} problem={problem} starting={starting} />
    </PanelFrame>
  );
}
