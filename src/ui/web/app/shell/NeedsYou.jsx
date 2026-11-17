// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/shell/NeedsYou.jsx
//
// 🔔 Needs you (docs/arch-web-app.md §4.1, §9): the questions waiting on a person, across every
// run and provider, from GET /gates. The count shows only when there are some. The list opens from
// the side; each entry names its question, workflow and run, how long it has waited, and Slack
// when Slack started it, and opens the question inside its run (`?run=`, the run drawer).
// Read while the tab is visible, again as soon as it becomes visible, less often after failures.

import { useEffect, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from '../auth/session.mjs';
import { Link }                from '../Link.jsx';
import { Drawer }              from './Drawer.jsx';
import { BellIcon }            from './icons.jsx';
import { gateHeadline, relativeAge, pollDelay } from './nav.mjs';

/** The waiting gates, read again on a timer while the page is visible. */
function useWaitingGates(api, onSignInRequired) {
  const [gates, setGates] = useState(null);

  useEffect(() => {
    let timer    = null;
    let failures = 0;
    let alive    = true;
    async function read() {
      clearTimeout(timer);
      try {
        const body = await api.get('gates');
        if (!alive) return;
        setGates(body.gates);
        failures = 0;
      } catch (e) {
        if (!alive) return;
        if (e instanceof SignInRequired) { onSignInRequired(); return; }
        failures += 1;
      }
      if (document.visibilityState === 'visible') timer = setTimeout(read, pollDelay(failures));
    }
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onVisible);
    read();
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [api, onSignInRequired]);

  return gates;
}

/**
 * The list itself, drawn from the gates — what the drawer holds, and what the tests draw.
 *
 * @param {object} props
 * @param {object[]} props.gates            GET /gates's `gates`
 * @param {Map<string, string>} props.labels Workflow labels by name
 * @param {string} props.path               The current path — a run opens over it
 * @param {number} props.now
 * @param {() => void} props.onPick
 */
export function WaitingList({ gates, labels, path, now, onPick }) {
  const { t, i18n } = useTranslation();
  if (gates.length === 0) return <p className="muted">{t('needsYou.empty')}</p>;
  return (
    <ul className="waiting">
      {gates.map(g => {
        const workflow = labels.get(g.workflowName) ?? g.workflowName;
        return (
          <li key={g.runId}>
            <Link to={`${path}?run=${g.runId}`} onNavigate={onPick}>
              <span className="q">{gateHeadline(g.dialog) ?? g.label ?? workflow}</span>
              <span className="sub">
                {[workflow, g.label].filter(Boolean).join(' · ')}
                {g.waitingSince && <> · <time dateTime={g.waitingSince}>{relativeAge(g.waitingSince, now, i18n.language)}</time></>}
              </span>
              {g.provider === 'slack' && <span className="pill slack">{t('needsYou.slack')}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * @param {object} props
 * @param {{ get: (path: string) => Promise<any> }} props.api
 * @param {Map<string, string>} props.labels
 * @param {string} props.path
 * @param {() => void} props.onSignInRequired
 */
export function NeedsYou({ api, labels, path, onSignInRequired }) {
  const { t }           = useTranslation();
  const gates           = useWaitingGates(api, onSignInRequired);
  const [open, setOpen] = useState(false);
  const count           = gates?.length ?? 0;
  return (
    <>
      <button type="button" className="ib" onClick={() => setOpen(true)} aria-label={t('needsYou.button', { count })} title={t('needsYou.title')}>
        <BellIcon />
        {count > 0 && <span className="badge">{count}</span>}
      </button>
      {open && (
        <Drawer title={t('needsYou.title')} onClose={() => setOpen(false)}>
          {gates === null
            ? <p className="muted">{t('shell.loading')}</p>
            : <WaitingList gates={gates} labels={labels} path={path} now={Date.now()} onPick={() => setOpen(false)} />}
        </Drawer>
      )}
    </>
  );
}
