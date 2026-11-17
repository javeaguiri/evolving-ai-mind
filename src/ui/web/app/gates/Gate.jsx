// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/gates/Gate.jsx
//
// A question, answered in place (docs/arch-web-app.md §5, §9): the dialog buildDialog builds —
// the payload Slack's dialogToBlocks draws — as components, with no domain words and no Slack
// ceilings. Every gate type's answer is the one Slack sends. A required field and a number are
// checked before anything is sent; PROC checks again and stays the authority. Sent, the gate
// becomes a one-line record; a 409 says it was answered elsewhere; a 422 marks its fields.

import { useState }       from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError }       from '../api/client.mjs';
import { SignInRequired } from '../auth/session.mjs';
import { Markdown }       from '../Markdown.jsx';
import { Grid }           from './Grid.jsx';
import { Input }          from './Input.jsx';
import { inputsOf, initialValues, isChanged, fieldProblems, answerFor, gridOf, listColumns } from './gate.mjs';

/** A collapsible part — Slack's reveal button. Its content is markdown, or a list of lines. */
export function Reveal({ label, content }) {
  const { t } = useTranslation();
  const text = Array.isArray(content) ? content.map(c => `- ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n') : String(content ?? '');
  return (
    <details className="reveal">
      <summary>{label || t('run.reveal')}</summary>
      <Markdown text={text} />
    </details>
  );
}

/** A value of a review_object pair: an array of records as a table, of values as a list. */
function ReviewValue({ value }) {
  if (Array.isArray(value)) {
    if (value.length && value.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
      const cols = listColumns(value.map(v => ({ fields: v })));
      return (
        <table className="kv nested">
          <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{value.map((v, i) => <tr key={i}>{cols.map(c => <td key={c}>{format(v[c])}</td>)}</tr>)}</tbody>
        </table>
      );
    }
    return <ul className="plainlist">{value.map((v, i) => <li key={i}>{format(v)}</li>)}</ul>;
  }
  return format(value);
}
const format = v => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * @param {object} props
 * @param {{ runId: number, gateId: string, gate_type: string, dialog: object }} props.gate  GET /gates/{runId}
 * @param {{ api: object, onSignInRequired: () => void }} props.context
 * @param {(record: { label: string, changes: number }) => void} props.onAnswered
 * @param {() => void} props.onMoved     The gate was answered elsewhere: read it again
 */
export function Gate({ gate, context, onAnswered, onMoved }) {
  const { t }    = useTranslation();
  const dialog   = gate.dialog ?? {};
  const fields   = dialog.fields ?? [];
  const inputs   = inputsOf(dialog);
  const grid     = gate.gate_type === 'form' ? gridOf(inputs) : null;
  const [initial]             = useState(() => initialValues(inputs));
  const [values, setValues]   = useState(initial);
  const [text, setText]       = useState('');
  const [chosen, setChosen]   = useState(null);           // a choice's radio
  const [problems, setProblems] = useState({});           // name → problem
  const [notice, setNotice]   = useState(null);
  const [sending, setSending] = useState(false);
  const [modal, setModal]     = useState(null);           // the button whose text area is open
  const [confirming, setConfirming] = useState(null);     // the list row asking Yes / No

  const changes = inputs.filter(f => isChanged(f, values, initial)).length;
  const choices = gate.gate_type === 'choice' ? fields.find(f => f.type === 'description_list')?.items ?? [] : [];
  const choiceValues = new Set(choices.map(c => c.value));

  async function send(action, label, extra = {}) {
    if (sending) return;
    const isCancel = action === 'cancel';
    if (gate.gate_type === 'form' && !isCancel && !extra.row) {
      const found = fieldProblems(inputs, values);
      setProblems(Object.fromEntries(found.map(p => [p.name, p.problem])));
      if (found.length) { setNotice(t('gate.fixFields')); return; }
    }
    setSending(true);
    setNotice(null);
    try {
      const body = answerFor(gate.gate_type, action, { values, inputs, inputValue: extra.inputValue ?? text, row: extra.row });
      await context.api.post(`gates/${gate.runId}/responses`, { gateId: gate.gateId, ...body });
      onAnswered({ label, changes: gate.gate_type === 'form' && !isCancel ? changes : 0 });
    } catch (e) {
      setSending(false);
      if (e instanceof SignInRequired) { context.onSignInRequired(); return; }
      if (e instanceof ApiError && (e.code === 'gate_moved' || e.code === 'gate_not_waiting')) { setNotice(t('gate.moved')); onMoved(); return; }
      if (e instanceof ApiError && e.code === 'invalid_fields') {
        setProblems(Object.fromEntries((e.fields ?? []).map(f => [f.name, f.problem])));
        setNotice(t('gate.fixFields'));
        return;
      }
      setNotice(t('gate.failed'));
    }
  }

  const problemOf = name => problems[name];
  const setValue  = (name, v) => { setValues(s => ({ ...s, [name]: v })); if (problems[name]) setProblems(p => ({ ...p, [name]: undefined })); };
  const setCheck  = (name, problem) => setProblems(p => ({ ...p, [name]: problem }));
  let gridDrawn = false;

  return (
    <div className="msg gate waiting" aria-busy={sending}>
      {fields.map((f, i) => {
        switch (f.type) {
          case 'typography': return <Markdown key={i} text={f.value} />;
          case 'reveal':     return <Reveal key={i} label={f.button_label} content={f.content} />;
          case 'description_list':
            if (gate.gate_type === 'choice') {
              return (
                <fieldset key={i} className="choices">
                  {f.items.map(item => (
                    <label key={item.value}>
                      <input type="radio" name={`choice-${gate.gateId}`} value={item.value} checked={chosen === item.value} onChange={() => setChosen(item.value)} disabled={sending} />
                      <span><b>{item.label}</b>{item.description && <span className="desc">{item.description}</span>}</span>
                    </label>
                  ))}
                </fieldset>
              );
            }
            return (
              <dl key={i} className="fields">
                {f.items.map(item => <div key={item.value} className="field"><dt>{item.label}</dt><dd>{item.description}</dd></div>)}
              </dl>
            );
          case 'review_object':
            return (
              <table key={i} className="kv">
                <tbody>{f.items.map((item, j) => <tr key={j}><th scope="row">{item.key}</th><td><ReviewValue value={item.value} /></td></tr>)}</tbody>
              </table>
            );
          case 'textbox':
            return (
              <label key={i} className="fld">
                <span>{f.label}</span>
                {f.multiline
                  ? <textarea value={text} placeholder={f.placeholder} onChange={e => setText(e.target.value)} disabled={sending} rows={4} />
                  : <input type="text" value={text} placeholder={f.placeholder} onChange={e => setText(e.target.value)} disabled={sending} />}
              </label>
            );
          case 'list': {
            const cols = listColumns(f.items);
            return (
              <div key={i} className="glist">
                {f.parentHeading && <h4>{f.parentHeading}</h4>}
                <div className="tablewrap">
                  <table className="grid static">
                    <thead><tr>{cols.map(c => <th key={c} scope="col">{c}</th>)}<th aria-label={t('gate.actions')} /></tr></thead>
                    <tbody>
                      {f.items.map(item => (
                        <tr key={item.id}>
                          {cols.map(c => <td key={c}>{format(item.fields?.[c])}</td>)}
                          <td className="act">
                            {item.secondaryAction && confirming !== item.id && (
                              <button type="button" className={`btn sm ${item.secondaryAction.style ?? ''}`} disabled={sending}
                                onClick={() => (item.secondaryAction.confirm ? setConfirming(item.id) : send(item.secondaryAction.action, item.secondaryAction.label, { row: item }))}>
                                {item.secondaryAction.label}
                              </button>
                            )}
                            {confirming === item.id && (
                              <span className="confirm">
                                <Markdown text={item.secondaryAction.confirm} />
                                <button type="button" className="btn sm primary" disabled={sending} onClick={() => send(item.secondaryAction.action, item.secondaryAction.label, { row: item })}>{t('gate.yes')}</button>
                                <button type="button" className="btn sm" onClick={() => setConfirming(null)}>{t('gate.no')}</button>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          }
          case 'input':
            if (grid) {
              if (gridDrawn) return null;
              gridDrawn = true;
              return <Grid key={i} grid={grid} values={values} initial={initial} problems={problems} onChange={setValue} onCheck={setCheck} disabled={sending} />;
            }
            return <Input key={i} field={f} value={values[f.name]} problem={problemOf(f.name)} onChange={v => setValue(f.name, v)} onCheck={p => setCheck(f.name, p)} disabled={sending} />;
          case 'actions': {
            const buttons = f.buttons.filter(b => !choiceValues.has(b.action));
            return (
              <div key={i} className="gateactions">
                {modal && (
                  <label className="fld">
                    <span>{modal.modal.input_label ?? modal.label}</span>
                    <textarea value={text} placeholder={modal.modal.placeholder} onChange={e => setText(e.target.value)} rows={modal.modal.multiline === false ? 2 : 4} disabled={sending} />
                  </label>
                )}
                <div className="btnrow">
                  {choices.length > 0 && (
                    <button type="button" className="btn primary" disabled={sending || chosen === null}
                      onClick={() => send(chosen, choices.find(c => c.value === chosen)?.label)}>{t('gate.continue')}</button>
                  )}
                  {modal && (
                    <>
                      <button type="button" className="btn primary" disabled={sending || !text.trim()} onClick={() => send(modal.action, modal.label, { inputValue: text })}>{t('gate.submit')}</button>
                      <button type="button" className="btn" disabled={sending} onClick={() => { setModal(null); setText(''); }}>{t('gate.back')}</button>
                    </>
                  )}
                  {!modal && buttons.map(b => (
                    <button key={b.action} type="button" className={`btn ${b.style === 'primary' ? 'primary' : b.style === 'danger' ? 'danger' : ''}`} disabled={sending}
                      title={b.description || undefined}
                      onClick={() => (b.modal ? setModal(b) : send(b.action, b.label))}>
                      {b.label}
                    </button>
                  ))}
                  {gate.gate_type === 'form' && changes > 0 && !modal && <span className="count">{t('gate.changes', { count: changes })}</span>}
                </div>
              </div>
            );
          }
          default: return null;
        }
      })}
      {notice && <p className="notice" role="alert">{notice}</p>}
    </div>
  );
}

/** A gate once answered here: one line, its inputs gone (§9). */
export function AnsweredRecord({ record }) {
  const { t } = useTranslation();
  return (
    <p className="answered">
      {t('gate.youChose', { label: record.label ?? '' })}
      {record.changes > 0 && <> · {t('gate.changes', { count: record.changes })}</>}
    </p>
  );
}
