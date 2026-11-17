// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/runs/RunThread.jsx
//
// A run, as Slack shows it in a thread (docs/arch-web-app.md §4.3, §9): its messages in order —
// notifications as markdown, a failure by its summary, each question with its message. Read from
// GET /inbox?run= and GET /runs/{runId} while the run is going and the tab is visible, less often
// after failures; *Working…* while the run works; a finished run read once. The same thread in a
// workflow panel, the run drawer and the run page. Answering a question in place is item 5.

import { useEffect, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from '../auth/session.mjs';
import { Markdown }            from '../Markdown.jsx';
import { addMessages, isActive, isWorking, threadDelay } from './runs.mjs';

/** The run and its messages, read again while it is going. */
export function useRunThread(api, runId, onSignInRequired) {
  const [state, setState] = useState({ run: null, messages: [], problem: null });

  useEffect(() => {
    let alive = true, timer = null, failures = 0, cursor = null, run = null, messages = [];
    async function read() {
      clearTimeout(timer);
      try {
        run = await api.get(`runs/${runId}`);
        for (let more = true; more;) {
          const page = await api.get('inbox', { run: runId, after: cursor ?? undefined });
          messages = addMessages(messages, page.messages);
          cursor   = page.cursor ?? cursor;
          more     = page.more === true && page.messages.length > 0;
        }
        if (!alive) return;
        failures = 0;
        setState({ run, messages, problem: null });
      } catch (e) {
        if (!alive) return;
        if (e instanceof SignInRequired) { onSignInRequired(); return; }
        if (e.code === 'run_not_found' || e.code === 'run_forbidden') { setState(s => ({ ...s, problem: 'gone' })); return; }
        failures += 1;
        setState(s => ({ ...s, problem: 'unreachable' }));
      }
      if (alive && (!run || isActive(run.status)) && document.visibilityState === 'visible') {
        timer = setTimeout(read, threadDelay(failures));
      }
    }
    const onVisible = () => { if (document.visibilityState === 'visible' && (!run || isActive(run.status))) read(); };
    document.addEventListener('visibilitychange', onVisible);
    read();
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [api, runId, onSignInRequired]);

  return state;
}

/** A collapsible part of a message — Slack's reveal button. */
function Reveal({ label, content }) {
  const { t } = useTranslation();
  return (
    <details className="reveal">
      <summary>{label || t('run.reveal')}</summary>
      <Markdown text={content} />
    </details>
  );
}

/** One message of the thread. `waiting`: the question the run is waiting at. */
export function Message({ message, waiting }) {
  const { t } = useTranslation();
  const p = message.payload ?? {};
  switch (message.messageType) {
    case 'HUMAN_NOTIFICATION':
      return (
        <div className="msg">
          {p.format === 'markdown' ? <Markdown text={p.message} /> : <p className="plain">{p.message}</p>}
          {(p.reveals ?? []).map((r, i) => <Reveal key={i} label={r.button_label} content={r.content} />)}
        </div>
      );
    case 'WORKFLOW_ERROR':
      return <div className="msg error" role="alert">{p.summary}</div>;
    case 'HUMAN_GATE':
      return (
        <div className={waiting ? 'msg gate waiting' : 'msg gate'}>
          {(p.dialog?.fields ?? []).map((f, i) => {
            if (f.type === 'typography') return <Markdown key={i} text={f.value} />;
            if (f.type === 'reveal') return <Reveal key={i} label={f.button_label} content={f.content} />;
            return null;
          })}
          {waiting && <p className="hint">{t('run.waiting')}</p>}
        </div>
      );
    default:
      return null;
  }
}

/**
 * The thread drawn from its data — what useRunThread feeds, and what the tests draw.
 *
 * @param {object} props
 * @param {object|null} props.run         GET /runs/{runId}
 * @param {object[]} props.messages       GET /inbox?run= messages, in order
 * @param {'gone'|'unreachable'|null} props.problem
 */
export function ThreadView({ run, messages, problem }) {
  const { t } = useTranslation();
  if (problem === 'gone') return <p className="muted">{t('run.gone')}</p>;
  if (!run) return problem ? <p className="muted">{t('run.unreachable')}</p> : <p className="muted">{t('shell.loading')}</p>;
  const lastGate = run.status === 'awaiting_human_gate' ? messages.findLast(m => m.messageType === 'HUMAN_GATE') : null;
  return (
    <div className="thread">
      {messages.map(m => <Message key={m.id} message={m} waiting={m === lastGate} />)}
      {messages.length === 0 && !isActive(run.status) && <p className="muted">{t('run.noMessages')}</p>}
      {isWorking(run.status) && <p className="working" role="status">{t('run.working')}</p>}
      {problem === 'unreachable' && <p className="muted">{t('run.unreachable')}</p>}
    </div>
  );
}

/**
 * @param {object} props
 * @param {number} props.runId
 * @param {{ api: object, onSignInRequired: () => void }} props.context
 * @param {(run: object) => void} [props.onRun]  Told the run each time it is read
 */
export function RunThread({ runId, context, onRun }) {
  const state = useRunThread(context.api, runId, context.onSignInRequired);
  useEffect(() => { if (state.run) onRun?.(state.run); }, [state.run, onRun]);
  return <ThreadView {...state} />;
}
