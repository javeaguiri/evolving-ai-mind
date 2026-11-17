// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/runs/RunThread.jsx
//
// A run, as Slack shows it in a thread (docs/arch-web-app.md §4.3, §8, §9): its messages in order —
// notifications as markdown, a failure by its summary, each question with its message — and the
// question the run waits at answered in place. That question is read from GET /gates/{runId},
// rebuilt from the run with the gateId an answer names, whichever surface started the run; the
// copies in the inbox are what was sent. A question answered here becomes a one-line record for as
// long as the page holds it. What came before the person's last answer folds into one line, and a
// new question is brought into view. The run's id is shown, for talking about it. Read from
// GET /runs/{runId} and GET /inbox?run= while the run is going
// and the tab visible: often while it works, less while it waits on a person, less still after
// failures; at once after an answer. *Working…* while the run works; a finished run read once.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from '../auth/session.mjs';
import { Markdown }            from '../Markdown.jsx';
import { Gate, Reveal, AnsweredRecord } from '../gates/Gate.jsx';
import { resolveLanguageMap }  from '../../../../shared/language-map.mjs';
import { addMessages, isActive, isWorking, threadDelay, latestGateId, foldPoint } from './runs.mjs';

/** The run, its messages and the question it waits at, read again while it is going. */
export function useRunThread(api, runId, onSignInRequired) {
  const [state, setState] = useState({ run: null, messages: [], gate: null, problem: null });
  const readNow = useRef(() => {});

  useEffect(() => {
    let alive = true, timer = null, failures = 0, cursor = null, run = null, messages = [], gate = null;
    let answeredAt = null;     // the gate just answered here: keep the quick pace until the run moves past it
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
        if (run.status !== 'awaiting_human_gate') gate = null;
        else if (!gate || gate.gateId !== latestGateId(messages)) {
          gate = await api.get(`gates/${runId}`).catch(e => { if (e.code === 'gate_not_waiting') return null; throw e; });
        }
        if (!alive) return;
        failures = 0;
        setState({ run, messages, gate, problem: null });
      } catch (e) {
        if (!alive) return;
        if (e instanceof SignInRequired) { onSignInRequired(); return; }
        if (e.code === 'run_not_found' || e.code === 'run_forbidden') { setState(s => ({ ...s, problem: 'gone' })); return; }
        failures += 1;
        setState(s => ({ ...s, problem: 'unreachable' }));
      }
      if (answeredAt && (run?.status !== 'awaiting_human_gate' || latestGateId(messages) !== answeredAt)) answeredAt = null;
      if (alive && (!run || isActive(run.status)) && document.visibilityState === 'visible') {
        timer = setTimeout(read, threadDelay(failures, answeredAt ? 'running' : run?.status));
      }
    }
    readNow.current = () => { answeredAt = gate?.gateId ?? null; gate = null; read(); };
    const onVisible = () => { if (document.visibilityState === 'visible' && (!run || isActive(run.status))) read(); };
    document.addEventListener('visibilitychange', onVisible);
    read();
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [api, runId, onSignInRequired]);

  const refresh = useCallback(() => readNow.current(), []);
  return { ...state, refresh };
}

/** One message of the thread, as it was sent. `waiting`: the question the run waits at. */
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
 * @param {object|null} [props.gate]      GET /gates/{runId}: the question the run waits at
 * @param {Record<string, object>} [props.answered]  gateId → the record of an answer given here
 * @param {'gone'|'unreachable'|null} props.problem
 * @param {object} [props.context]        { api, onSignInRequired } — for answering
 * @param {(gateId: string, record: object) => void} [props.onAnswered]
 * @param {() => void} [props.onMoved]
 */
export function ThreadView({ run, messages, gate = null, answered = {}, problem, context, onAnswered, onMoved }) {
  const { t, i18n } = useTranslation();
  const [unfolded, setUnfolded] = useState(false);
  const liveRef = useRef(null);
  const liveId  = run?.status === 'awaiting_human_gate' ? gate?.gateId ?? null : null;

  useEffect(() => {
    if (!liveId || !liveRef.current) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    liveRef.current.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [liveId]);

  if (problem === 'gone') return <p className="muted">{t('run.gone')}</p>;
  if (!run) return problem ? <p className="muted">{t('run.unreachable')}</p> : <p className="muted">{t('shell.loading')}</p>;

  const live    = run.status === 'awaiting_human_gate' ? gate : null;
  const lastOf  = new Map(messages.filter(m => m.messageType === 'HUMAN_GATE').map(m => [m.payload?.dialog?.gate_id, m.id]));
  const liveSent = live && lastOf.has(live.gateId);
  const answer  = live && !answered[live.gateId] && context
    ? <Gate key={live.gateId} gate={live} context={context} onAnswered={record => onAnswered(live.gateId, record)} onMoved={onMoved} />
    : null;
  const waitingAt = run.status === 'awaiting_human_gate' && !live ? messages.findLast(m => m.messageType === 'HUMAN_GATE') : null;
  // While the run waits, the newest question is the one waited at, read from /gates or not yet.
  const waitedAt  = run.status === 'awaiting_human_gate' ? liveId ?? latestGateId(messages) : null;
  const from      = unfolded ? 0 : foldPoint(messages, waitedAt);
  const workflow  = run.workflowLabel ? resolveLanguageMap(run.workflowLabel, i18n.language) : run.workflowName;

  return (
    <div className="thread">
      {run.runId && <p className="runmeta">{t('run.meta', { workflow: workflow ?? '', runId: run.runId })}</p>}
      {from > 0 && (
        <button type="button" className="fold" onClick={() => setUnfolded(true)}>{t('run.earlier', { count: from })}</button>
      )}
      {messages.slice(from).map(m => {
        const gid = m.messageType === 'HUMAN_GATE' ? m.payload?.dialog?.gate_id : null;
        const last = gid && lastOf.get(gid) === m.id;
        if (last && live && gid === live.gateId && answer) return <div key={m.id} ref={liveRef}>{answer}</div>;
        return (
          <div key={m.id}>
            <Message message={m} waiting={m === waitingAt} />
            {last && answered[gid] && <AnsweredRecord record={answered[gid]} />}
          </div>
        );
      })}
      {live && !liveSent && answer && <div ref={liveRef}>{answer}</div>}
      {messages.length === 0 && !live && !isActive(run.status) && <p className="muted">{t('run.noMessages')}</p>}
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
  const { refresh, ...state } = useRunThread(context.api, runId, context.onSignInRequired);
  const [answered, setAnswered] = useState({});
  useEffect(() => { if (state.run) onRun?.(state.run); }, [state.run, onRun]);
  const onAnswered = useCallback((gateId, record) => { setAnswered(a => ({ ...a, [gateId]: record })); refresh(); }, [refresh]);
  return <ThreadView {...state} answered={answered} context={context} onAnswered={onAnswered} onMoved={refresh} />;
}
