// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/panels/RecordsPanel.jsx
//
// A records panel (docs/arch-web-app.md §4.2, §9), read-only in Phase 0: a table, view or entity
// read through GET /sources/{source}/rows, shown in one view at a time — grid or list — with the
// switch in its header. The viewer's choice is remembered per panel in this browser and never
// changes the page. A row opens a read-only record drawer. A bounded read says so; a source that
// is gone draws a frame naming it, and the rest of the page draws normally.

import { useEffect, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from '../auth/session.mjs';
import { Drawer }              from '../shell/Drawer.jsx';
import { formatValue, isNumericColumn } from '../records/format.mjs';
import { rowsRequest, mergeColumns, listFields, initialView, viewKey, RECORD_VIEWS } from '../records/query.mjs';
import { PanelFrame }          from './PanelFrame.jsx';

function remembered(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function remember(key, view) {
  try { window.localStorage.setItem(key, view); } catch { /* the choice lasts this visit only */ }
}

/** The read, as it stands: loading, ready, missing (404) or failed. */
function useRows(api, config, onSignInRequired) {
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    const { source, query } = rowsRequest(config);
    setState({ status: 'loading' });
    api.get(`sources/${encodeURIComponent(source)}/rows`, query).then(
      body => { if (alive) setState({ status: 'ready', body }); },
      e => {
        if (!alive) return;
        if (e instanceof SignInRequired) onSignInRequired();
        else setState({ status: e.code === 'source_not_found' ? 'missing' : 'failed', source });
      },
    );
    return () => { alive = false; };
  }, [api, config, onSignInRequired]);
  return state;
}

/**
 * The panel's body, drawn from a read — what the panel holds once its rows are in, and what the
 * tests draw.
 *
 * @param {object} props
 * @param {object} props.config
 * @param {{ columns: object[], rows: object[], more: boolean, totalMatching?: number }} props.body
 * @param {'grid'|'list'} props.view
 * @param {{ locale: string, timeZone: string }} props.where
 * @param {(row: object) => void} props.onOpen
 */
export function RecordsBody({ config, body, view, where, onOpen }) {
  const { t, i18n } = useTranslation();
  const columns = mergeColumns(config, body.columns, i18n.language);
  const shown   = columns.filter(c => c.shown);
  const cell    = (row, column) => formatValue(row[column.name], column, row, where);

  if (body.rows.length === 0) return <p className="muted">{t('records.empty')}</p>;

  const footer = body.more && (
    <p className="pfoot">{t('records.showing', { shown: body.rows.length, total: body.totalMatching ?? body.rows.length })}</p>
  );
  const onKey = row => e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row); } };

  if (view === 'list') {
    const { title, details } = listFields(config, columns);
    const byName = new Map(columns.map(c => [c.name, c]));
    return (
      <>
        <ul className="rlist">
          {body.rows.map((row, i) => (
            <li key={row.id ?? i}>
              <button type="button" onClick={() => onOpen(row)}>
                <span className="rt">{title ? cell(row, byName.get(title)) : ''}</span>
                <span className="rd">{details.map(d => cell(row, byName.get(d))).filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
        {footer}
      </>
    );
  }
  return (
    <>
      <div className="tablewrap">
        <table className="grid">
          <thead>
            <tr>{shown.map(c => <th key={c.name} scope="col" className={isNumericColumn(c) ? 'num' : undefined}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {body.rows.map((row, i) => (
              <tr key={row.id ?? i} tabIndex={0} onClick={() => onOpen(row)} onKeyDown={onKey(row)}>
                {shown.map(c => <td key={c.name} className={isNumericColumn(c) ? 'num' : undefined}>{cell(row, c)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </>
  );
}

/** One row, every column read, as label and value. */
export function RecordDetail({ columns, row, where }) {
  return (
    <dl className="fields">
      {columns.map(c => (
        <div key={c.name} className="field">
          <dt>{c.label}</dt>
          <dd>{formatValue(row[c.name], c, row, where)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * @param {object} props
 * @param {string} props.pageKey
 * @param {{ id: string, width: string, config: object }} props.panel
 * @param {string} props.title
 * @param {{ api: object, locale: string, timeZone: string, onSignInRequired: () => void }} props.context
 */
export function RecordsPanel({ pageKey, panel, title, context }) {
  const { t, i18n }       = useTranslation();
  const { api, locale, timeZone, onSignInRequired } = context;
  const key               = viewKey(pageKey, panel.id);
  const [view, setView]   = useState(() => initialView(panel.config, remembered(key)));
  const [open, setOpen]   = useState(null);
  const state             = useRows(api, panel.config, onSignInRequired);
  const where             = { locale, timeZone };

  const choose = v => { setView(v); remember(key, v); };
  const tools = (
    <span className="vsw" role="group" aria-label={t('records.view')}>
      {RECORD_VIEWS.map(v => (
        <button key={v} type="button" aria-pressed={v === view} onClick={() => choose(v)}>
          {v === 'grid' ? t('records.grid') : t('records.list')}
        </button>
      ))}
    </span>
  );

  let body;
  if (state.status === 'loading') {
    body = <div className="skeleton" aria-busy="true" aria-label={t('shell.loading')}><i /><i /><i /></div>;
  } else if (state.status === 'missing') {
    body = <p className="muted">{t('records.missing', { source: state.source })}</p>;
  } else if (state.status === 'failed') {
    body = <p className="muted">{t('records.failed')}</p>;
  } else {
    body = <RecordsBody config={panel.config} body={state.body} view={view} where={where} onOpen={setOpen} />;
  }

  const columns = state.status === 'ready' ? mergeColumns(panel.config, state.body.columns, i18n.language) : [];
  const titleOf = row => {
    const name = listFields(panel.config, columns).title;
    const column = columns.find(c => c.name === name);
    return (column && formatValue(row[name], column, row, where)) || title;
  };

  return (
    <PanelFrame title={title} width={panel.width} tools={state.status === 'ready' ? tools : null}>
      {body}
      {open && (
        <Drawer title={titleOf(open)} onClose={() => setOpen(null)}>
          <RecordDetail columns={columns} row={open} where={where} />
        </Drawer>
      )}
    </PanelFrame>
  );
}
