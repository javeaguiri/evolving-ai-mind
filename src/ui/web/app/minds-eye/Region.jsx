// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/minds-eye/Region.jsx
//
// Her region (docs/arch-web-app.md §4.1, §4.5): the left of the page, where only she answers. Her
// sessions at its head, most recently active first, each named by its label or first message;
// opening one shows the conversation — the person's own messages and hers, a turn's tool calls on
// one line (decision T), her gates and questions answered in place (§5.2) — with a box to write
// in. *New* starts a session. « collapses the region to a strip, remembered on this device. The
// session open is in the location (`?minds-eye=`), so it is a deep link and survives a reload. An
// open conversation is read again while it is open and the tab visible: often while she works,
// less while she waits; the list less often still. A minds_eye panel (§4.2) draws the same region
// with a `topic`: its sessions are that topic's, and *New* starts one on it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from '../auth/session.mjs';
import { Markdown }            from '../Markdown.jsx';
import { Message }             from '../runs/RunThread.jsx';
import { Input }               from '../gates/Input.jsx';
import { relativeAge }         from '../shell/nav.mjs';
import {
  sessionName, addConversation, groupTurns, repliesMissing, conversationDelay, LIST_POLL_MS,
  answerable, answerField, answersFrom, stillExpecting, personCount, sessionsQuery, startBody, labelBody,
} from './conversation.mjs';

/** Her sessions — a topic's, for a panel — read when the region opens, after the person sends, and now and then. */
export function useSessions(api, active, onSignInRequired, topic = null) {
  const [state, setState] = useState({ sessions: null, problem: false });
  const readNow = useRef(() => {});

  useEffect(() => {
    if (!active) return undefined;
    let alive = true, timer = null;
    async function read() {
      clearTimeout(timer);
      try {
        const page = await api.get('minds-eye/sessions', sessionsQuery(topic));
        if (!alive) return;
        setState({ sessions: page.sessions, problem: false });
      } catch (e) {
        if (!alive) return;
        if (e instanceof SignInRequired) { onSignInRequired(); return; }
        setState(s => ({ ...s, problem: true }));
      }
      if (alive && document.visibilityState === 'visible') timer = setTimeout(read, LIST_POLL_MS);
    }
    readNow.current = read;
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onVisible);
    read();
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [api, active, onSignInRequired, topic]);

  const refresh = useCallback(() => readNow.current(), []);
  return { ...state, refresh };
}

/**
 * One session's conversation, read from its start and then past its cursors while it is open.
 * `refresh` is called after a send: the conversation then reads at the working pace until the
 * round it started shows, so what was sent is never left unanswered for a waiting interval.
 */
export function useConversation(api, sessionId, onSignInRequired) {
  const [state, setState] = useState({ session: null, messages: [], repliesKeptFrom: null, problem: null });
  const readNow = useRef(() => {});

  useEffect(() => {
    if (!sessionId) return undefined;
    let alive = true, timer = null, failures = 0, cursor = { after: 0, afterSeq: 0 }, messages = [], session = null;
    let expecting = null;      // a send not yet seen: { since, persons }
    setState({ session: null, messages: [], repliesKeptFrom: null, problem: null });
    async function read() {
      clearTimeout(timer);
      try {
        let page;
        for (let more = true; more;) {
          page     = await api.get(`minds-eye/sessions/${sessionId}/messages`, cursor);
          messages = addConversation(messages, page.messages);
          cursor   = page.cursor;
          more     = page.more === true && page.messages.length > 0;
        }
        if (!alive) return;
        session  = page.session;
        failures = 0;
        setState({ session, messages, repliesKeptFrom: page.repliesKeptFrom, problem: null });
      } catch (e) {
        if (!alive) return;
        if (e instanceof SignInRequired) { onSignInRequired(); return; }
        if (e.code === 'session_not_found' || e.code === 'session_forbidden') { setState(s => ({ ...s, problem: 'gone' })); return; }
        failures += 1;
        setState(s => ({ ...s, problem: 'unreachable' }));
      }
      if (!stillExpecting(expecting, { persons: personCount(messages), state: session?.state, now: Date.now() })) expecting = null;
      if (alive && document.visibilityState === 'visible') timer = setTimeout(read, conversationDelay(failures, expecting ? 'working' : session?.state));
    }
    readNow.current = () => { expecting = { since: Date.now(), persons: personCount(messages) }; read(); };
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onVisible);
    read();
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [api, sessionId, onSignInRequired]);

  const refresh = useCallback(() => readNow.current(), []);
  return { ...state, refresh };
}

/**
 * Her sessions, most recently active first.
 *
 * @param {object} props
 * @param {object[]|null} props.sessions
 * @param {number|null} props.currentId
 * @param {boolean} props.problem
 * @param {number} props.now
 * @param {string} props.locale
 * @param {(sessionId: number) => void} props.onOpen
 */
export function SessionList({ sessions, currentId, problem, now, locale, onOpen }) {
  const { t } = useTranslation();
  if (!sessions) return <p className="muted">{problem ? t('errors.retrying') : t('shell.loading')}</p>;
  if (!sessions.length) return <p className="muted">{t('mindsEye.empty')}</p>;
  return (
    <ul className="sessions">
      {sessions.map(s => (
        <li key={s.sessionId}>
          <button type="button" aria-current={s.sessionId === currentId ? 'true' : undefined} onClick={() => onOpen(s.sessionId)}>
            <span className="lbl">{sessionName(s) ?? t('mindsEye.unnamed')}</span>
            <span className="when">{s.state === 'working' ? t('mindsEye.working') : relativeAge(s.lastActiveAt, now, locale)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A turn's calls as one line: one call says what it did; several are counted and listed under it. */
function TurnLine({ item }) {
  const { t } = useTranslation();
  const [first] = item.calls;
  if (item.calls.length === 1) {
    return (
      <div className="turn">
        <Markdown text={`_${t('mindsEye.turn', { turn: item.turn })} · ${first.call}_${first.detail ? ` — ${first.detail}` : ''}`} />
      </div>
    );
  }
  return (
    <details className="turn">
      <summary>{t('mindsEye.turnCalls', { turn: item.turn, count: item.calls.length })}</summary>
      <ul>
        {item.calls.map(c => <li key={c.id}><Markdown text={`${c.call}${c.detail ? ` — ${c.detail}` : ''}`} /></li>)}
      </ul>
    </details>
  );
}

/**
 * Her questions on a reply. Under her latest reply, while she waits, each has its answer box —
 * its choices and a comment, or text — with *Anything else* and *Send answers*, as Slack draws
 * them; under an older reply they are what she asked.
 */
function Questions({ questions, onAnswers }) {
  const { t } = useTranslation();
  const [values, setValues]   = useState({});
  const [note, setNote]       = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice]   = useState(null);
  const set = (id, part, value) => setValues(v => ({ ...v, [id]: { ...v[id], [part]: value } }));
  const reply = answersFrom(questions, values, note);

  const send = async () => {
    if (!reply || sending) return;
    setSending(true);
    setNotice(null);
    try {
      await onAnswers(reply.answers, reply.note);
    } catch (err) {
      setNotice(err?.code === 'session_busy' || err?.code === 'gate_waiting' ? t(`mindsEye.${err.code}`) : t('mindsEye.failed'));
      setSending(false);
    }
  };

  return (
    <>
      <ol className="questions">
        {questions.map(q => (
          <li key={q.id}>
            <Markdown text={q.text} />
            {!onAnswers && q.options?.length > 0 && <p className="muted">{q.options.join(' · ')}</p>}
            {onAnswers && (
              <>
                <Input field={answerField(q, t('mindsEye.yourAnswer'))} value={values[q.id]?.answer ?? ''} disabled={sending}
                  onChange={v => set(q.id, 'answer', v)} />
                {q.options?.length > 0 && (
                  <Input field={{ name: `c-${q.id}`, input_type: 'text', label: t('mindsEye.comment'), optional: true }}
                    value={values[q.id]?.comment ?? ''} disabled={sending} onChange={v => set(q.id, 'comment', v)} />
                )}
              </>
            )}
          </li>
        ))}
      </ol>
      {onAnswers && (
        <div className="answers">
          <Input field={{ name: 'note', input_type: 'textarea', label: t('mindsEye.anythingElse'), optional: true }}
            value={note} disabled={sending} onChange={setNote} />
          {notice && <p className="notice" role="alert">{notice}</p>}
          <div className="btnrow">
            <button type="button" className="btn primary" disabled={!reply || sending} onClick={send}>{t('mindsEye.sendAnswers')}</button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * A gate's buttons: an action gate's approve (its label from /proc), approve-and-test when she
 * offers it, and Cancel; a continue gate's Continue and End — a follow-up is written in the box
 * below. A gate answered elsewhere says so.
 */
function GateButtons({ gate, onGate }) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const [notice, setNotice]   = useState(null);
  const p = gate.payload ?? {};
  const answer = async action => {
    if (sending) return;
    setSending(true);
    setNotice(null);
    try {
      await onGate(p.atSeq, action);
    } catch (err) {
      setNotice(err?.code === 'gate_moved' || err?.code === 'gate_not_waiting' ? t('gate.moved') : t('gate.failed'));
      setSending(false);
    }
  };
  const buttons = p.gate_type === 'minds_eye_continue_gate'
    ? [{ action: 'continue', label: t('gate.continue'), primary: true }, { action: 'end', label: t('mindsEye.end') }]
    : [
      { action: 'approve', label: p.confirmLabel || t('mindsEye.approve'), primary: true, danger: p.confirmStyle === 'danger' },
      ...(p.testLabel ? [{ action: 'test', label: p.testLabel }] : []),
      { action: 'cancel', label: t('mindsEye.cancel') },
    ];
  return (
    <>
      <div className="btnrow">
        {buttons.map(b => (
          <button key={b.action} type="button" className={b.danger ? 'btn danger' : b.primary ? 'btn primary' : 'btn'} disabled={sending}
            onClick={() => answer(b.action)}>{b.label}</button>
        ))}
      </div>
      {p.gate_type === 'minds_eye_continue_gate' && <p className="hint">{t('mindsEye.followupHint')}</p>}
      {notice && <p className="notice" role="alert">{notice}</p>}
    </>
  );
}

/** Why she paused, as a continue gate's `reason` says it (each key named, for the catalog's check). */
const PAUSED = {
  turn_limit:     t => t('mindsEye.paused.turn_limit'),
  action_limit:   t => t('mindsEye.paused.action_limit'),
  round_budget:   t => t('mindsEye.paused.round_budget'),
  after_followup: t => t('mindsEye.paused.after_followup'),
};

/**
 * One of her messages: a reply, an error, or a gate. `live`: the one the person can answer now,
 * drawn with its controls when the handlers are given.
 */
function HerMessage({ message, live, onGate, onAnswers }) {
  const { t } = useTranslation();
  const p = message.payload ?? {};
  if (message.messageType === 'HUMAN_GATE' && (p.gate_type === 'minds_eye_continue_gate' || p.gate_type === 'minds_eye_gate')) {
    const text = p.gate_type === 'minds_eye_continue_gate'
      ? <p className="plain">{(PAUSED[p.reason] ?? PAUSED.turn_limit)(t)}</p>
      : (p.dialog?.fields ?? []).map((f, i) => (f.type === 'typography' ? <Markdown key={i} text={f.value} /> : null));
    return (
      <div className={live ? 'msg gate waiting' : 'msg gate'}>
        {text}
        {live && onGate && <GateButtons gate={message} onGate={onGate} />}
        {live && !onGate && <p className="hint">{t('run.waiting')}</p>}
      </div>
    );
  }
  if (message.messageType === 'HUMAN_NOTIFICATION' && p.questions?.length) {
    return (
      <div className={live ? 'msg waiting' : 'msg'}>
        {p.format === 'markdown' ? <Markdown text={p.message} /> : <p className="plain">{p.message}</p>}
        <Questions key={message.id} questions={p.questions} onAnswers={live ? onAnswers : undefined} />
      </div>
    );
  }
  return <Message message={message} waiting={false} />;
}

/**
 * The conversation drawn from its data — what useConversation feeds, and what the tests draw.
 * With `onGate` and `onAnswers`, the message she waits on is answered in place.
 *
 * @param {object} props
 * @param {object|null} props.session
 * @param {object[]} props.messages
 * @param {string|null} props.repliesKeptFrom
 * @param {'gone'|'unreachable'|null} props.problem
 * @param {(atSeq: number, action: string) => Promise<void>} [props.onGate]
 * @param {(answers: object[], note: string|null) => Promise<void>} [props.onAnswers]
 * @param {string|null} [props.pending]   What the person just sent, until the stored copy arrives
 */
export function ConversationView({ session, messages, repliesKeptFrom, problem, onGate, onAnswers, pending = null }) {
  const { t } = useTranslation();
  if (problem === 'gone') return <p className="muted">{t('mindsEye.gone')}</p>;
  if (!session && !pending) return <p className="muted">{problem ? t('errors.retrying') : t('shell.loading')}</p>;
  const live = pending ? null : answerable(session, messages);
  return (
    <div className="convo">
      {session && repliesMissing(session, repliesKeptFrom) && <p className="muted notkept">{t('mindsEye.notKept')}</p>}
      {groupTurns(messages).map(item => {
        if (item.kind === 'turn')   return <TurnLine key={item.key} item={item} />;
        if (item.kind === 'person') return <div key={`p${item.seq}`} className="msg mine"><p className="plain">{item.text}</p></div>;
        return <HerMessage key={`i${item.id}`} message={item} live={item === live} onGate={onGate} onAnswers={onAnswers} />;
      })}
      {pending && (
        <div className="msg mine pending"><p className="plain">{pending}</p><p className="sent">{t('mindsEye.sent')}</p></div>
      )}
      {(pending || session?.state === 'working') && <p className="working" role="status">{t('mindsEye.working')}</p>}
      {problem === 'unreachable' && <p className="muted">{t('errors.retrying')}</p>}
    </div>
  );
}

/**
 * The box she is written to. Disabled while she works, and while a question of hers waits on an
 * answer that is not typed.
 *
 * @param {object} props
 * @param {string|null} props.blocked     Why nothing can be sent now, or null
 * @param {(text: string) => Promise<void>} props.onSend
 */
export function Composer({ blocked, onSend }) {
  const { t } = useTranslation();
  const [text, setText]       = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed]   = useState(null);
  const send = async e => {
    e.preventDefault();
    if (!text.trim() || sending || blocked) return;
    setSending(true);
    setFailed(null);
    try {
      await onSend(text.trim());
      setText('');
    } catch (err) {
      setFailed(err?.code === 'session_busy' || err?.code === 'gate_waiting' ? t(`mindsEye.${err.code}`) : t('mindsEye.failed'));
    } finally {
      setSending(false);
    }
  };
  return (
    <form className="composer" onSubmit={send}>
      <textarea value={text} rows={3} placeholder={t('mindsEye.placeholder')} aria-label={t('mindsEye.placeholder')}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e); }} />
      {(blocked || failed) && <p className="hint" role="status">{failed ?? blocked}</p>}
      <div className="btnrow">
        <button type="submit" className="btn primary" disabled={!text.trim() || sending || !!blocked}>{t('mindsEye.send')}</button>
      </div>
    </form>
  );
}

/**
 * The open conversation's name, renamed in place (decision S): ✎ turns it into a box holding its
 * label; Enter or leaving the box saves, Escape keeps the name. An empty box clears the label, and
 * the session is named by its first message again.
 *
 * @param {object} props
 * @param {string} props.name                 What the session is called now
 * @param {string|null} props.label           Its label, if it has one
 * @param {(text: string) => Promise<void>} props.onRename
 * @param {boolean} [props.editing]           Open on the box — for the tests
 */
export function ConvoTitle({ name, label, onRename, editing: initial = false }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(initial);
  const [text, setText]       = useState(label ?? '');
  const [failed, setFailed]   = useState(false);
  const saving = useRef(false);
  const open = () => { setText(label ?? ''); setFailed(false); setEditing(true); };
  const save = async () => {
    if (saving.current) return;
    if ((text.trim() || null) === (label ?? null)) { setEditing(false); return; }
    saving.current = true;
    try {
      await onRename(text);
      setEditing(false);
    } catch {
      setFailed(true);
    } finally {
      saving.current = false;
    }
  };
  if (!editing) {
    return (
      <div className="convo-head">
        <h3 className="convo-title">{name}</h3>
        <button type="button" className="ib" onClick={open} aria-label={t('mindsEye.rename')} title={t('mindsEye.rename')}>✎</button>
      </div>
    );
  }
  return (
    <form className="convo-head" onSubmit={e => { e.preventDefault(); save(); }}>
      <input className="convo-rename" value={text} placeholder={name || t('mindsEye.renamePlaceholder')} aria-label={t('mindsEye.renamePlaceholder')}
        autoFocus onChange={e => setText(e.target.value)} onBlur={save}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setEditing(false); } }} />
      {failed && <p className="hint" role="status">{t('mindsEye.renameFailed')}</p>}
    </form>
  );
}

/** Why a message cannot be sent to this session now, or null. */
function blockedReason(session, t) {
  if (!session) return null;
  if (session.state === 'working')    return t('mindsEye.session_busy');
  if (session.gate?.kind === 'action') return t('mindsEye.gate_waiting');
  return null;
}

/**
 * @param {object} props
 * @param {{ api: object, locale: string, onSignInRequired: () => void }} props.context
 * @param {number|null} props.sessionId     The session open, from `?minds-eye=`
 * @param {(sessionId: number|null) => void} props.onOpen
 * @param {boolean} [props.active]          Read the list — false while the region is not drawn
 * @param {string|null} [props.topic]       A minds_eye panel's topic: its sessions only, and New starts one on it
 */
export function MindsEyeRegion({ context, sessionId, onOpen, active = true, topic = null }) {
  const { t } = useTranslation();
  const { api, onSignInRequired } = context;
  const list  = useSessions(api, active, onSignInRequired, topic);
  const convo = useConversation(api, sessionId, onSignInRequired);
  const [composing, setComposing] = useState(false);
  const [sent, setSent]           = useState(null);   // { sessionId, text, persons } until the stored copy arrives
  const [renamed, setRenamed]     = useState(null);   // the session as last renamed, until the conversation reads it again
  const now     = Date.now();
  const persons = personCount(convo.messages);
  const pending = sent && sent.sessionId === sessionId && persons <= sent.persons ? sent.text : null;
  const hold    = (id, text) => setSent({ sessionId: id, text, persons: id === sessionId ? persons : 0 });

  const start = async text => {
    const { sessionId: started } = await api.post('minds-eye/sessions', startBody(text, topic));
    hold(started, text);
    setComposing(false);
    onOpen(started);
    list.refresh();
  };
  const send = async text => {
    await api.post(`minds-eye/sessions/${sessionId}/messages`, { text });
    hold(sessionId, text);
    convo.refresh();
    list.refresh();
  };
  const answers = async (given, note) => {
    await api.post(`minds-eye/sessions/${sessionId}/messages`, { answers: given, note });
    hold(sessionId, t('mindsEye.answersSent'));
    convo.refresh();
    list.refresh();
  };
  useEffect(() => {
    if (renamed && convo.session?.label === renamed.label) setRenamed(null);
  }, [renamed, convo.session]);
  const rename = async text => {
    const renamedTo = await api.patch(`minds-eye/sessions/${sessionId}`, labelBody(text));
    setRenamed(renamedTo);
    list.refresh();
  };
  const gate = async (atSeq, action) => {
    await api.post(`minds-eye/sessions/${sessionId}/responses`, { atSeq, action });
    convo.refresh();
    list.refresh();
  };

  if (composing) {
    return (
      <div className="region-body">
        <button type="button" className="fold" onClick={() => setComposing(false)}>{t('mindsEye.back')}</button>
        <Composer blocked={null} onSend={start} />
      </div>
    );
  }
  if (sessionId) {
    const shown = renamed?.sessionId === sessionId && convo.session ? { ...convo.session, label: renamed.label } : convo.session;
    const name  = shown ? sessionName(shown) ?? t('mindsEye.unnamed') : null;
    return (
      <div className="region-body">
        <button type="button" className="fold" onClick={() => onOpen(null)}>{t('mindsEye.back')}</button>
        {name && <ConvoTitle key={`${sessionId}:${shown.label ?? ''}`} name={name} label={shown.label ?? null} onRename={rename} />}
        <ConversationView session={convo.session} messages={convo.messages} repliesKeptFrom={convo.repliesKeptFrom} problem={convo.problem}
          onGate={gate} onAnswers={answers} pending={pending} />
        {convo.problem !== 'gone' && <Composer blocked={pending ? t('mindsEye.session_busy') : blockedReason(convo.session, t)} onSend={send} />}
      </div>
    );
  }
  return (
    <div className="region-body">
      <button type="button" className="btn" onClick={() => setComposing(true)}>{t('mindsEye.new')}</button>
      <SessionList sessions={list.sessions} currentId={sessionId} problem={list.problem} now={now} locale={context.locale} onOpen={onOpen} />
    </div>
  );
}
