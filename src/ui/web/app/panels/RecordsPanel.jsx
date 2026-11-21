// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/panels/RecordsPanel.jsx
//
// A records panel (docs/arch-web-app.md §4.2, §9), read-only in Phase 0: a table, view or entity
// read through GET /sources/{source}/rows, shown in one view at a time — grid or list — with the
// switch in its header. The viewer's choice is remembered per panel in this browser and never
// changes the page. A long read scrolls inside the panel, its header in place, and reads on as its
// end comes into view, a page at a time, until there is no more (*Show more* does the same). A row opens a
// read-only record drawer beside the page, which follows the next row clicked. A bounded read says
// so; a source that is gone draws a frame naming it, and the rest of the page draws normally.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from '../auth/session.mjs';
import { Drawer }              from '../shell/Drawer.jsx';
import { formatValue, isNumericColumn } from '../records/format.mjs';
import { rowsRequest, appendPage, mergeColumns, listFields, initialView, viewKey, RECORD_VIEWS } from '../records/query.mjs';
import { PanelFrame }          from './PanelFrame.jsx';

function remembered(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function remember(key, view) {
  try { window.localStorage.setItem(key, view); } catch { /* the choice lasts this visit only */ }
}

/**
 * The read, as it stands: loading, ready, missing (404) or failed; and `more`, which reads the
 * next page onto a ready one — `paging` while it is under way, `pageFailed` when it was refused.
 */
function useRows(api, config, onSignInRequired) {
  const [state, setState] = useState({ status: 'loading' });
  const [paging, setPaging] = useState({ busy: false, failed: false });
  const read = useRef(0);   // which read the page belongs to: a new config starts a new one
  useEffect(() => {
    const id = ++read.current;
    const { source, query } = rowsRequest(config);
    setState({ status: 'loading' });
    setPaging({ busy: false, failed: false });
    api.get(`sources/${encodeURIComponent(source)}/rows`, query).then(
      body => { if (read.current === id) setState({ status: 'ready', body }); },
      e => {
        if (read.current !== id) return;
        if (e instanceof SignInRequired) onSignInRequired();
        else setState({ status: e.code === 'source_not_found' ? 'missing' : 'failed', source });
      },
    );
    return () => { read.current += 1; };
  }, [api, config, onSignInRequired]);

  const busy = useRef(false);
  const more = useCallback(() => {
    if (busy.current || state.status !== 'ready' || !state.body.more) return;
    busy.current = true;
    const id = read.current;
    const { source, query } = rowsRequest(config, state.body.rows.length);
    setPaging({ busy: true, failed: false });
    api.get(`sources/${encodeURIComponent(source)}/rows`, query).then(
      page => {
        busy.current = false;
        if (read.current !== id) return;
        setState(s => ({ ...s, body: appendPage(s.body, page) }));
        setPaging({ busy: false, failed: false });
      },
      e => {
        busy.current = false;
        if (read.current !== id) return;
        if (e instanceof SignInRequired) onSignInRequired();
        setPaging({ busy: false, failed: true });
      },
    );
  }, [api, config, onSignInRequired, state]);

  return { ...state, more, paging };
}

/**
 * The end of a read that has more: read on when it scrolls into view (unless the last page was
 * refused — then only the button tries again), or when *Show more* is pressed.
 */
function MoreRows({ onMore, paging, as: Tag = 'div' }) {
  const { t } = useTranslation();
  const at = useRef(null);
  useEffect(() => {
    const el = at.current;
    if (!el || paging.failed || typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) onMore(); },
      { root: el.closest('.pbody'), rootMargin: '0px 0px 200px 0px' });
    seen.observe(el);
    return () => seen.disconnect();
  }, [onMore, paging.failed]);
  return (
    <Tag ref={at} className="more">
      {paging.busy
        ? <span className="muted">{t('shell.loading')}</span>
        : <button type="button" className="btn" onClick={onMore}>{paging.failed ? t('records.moreFailed') : t('records.more')}</button>}
    </Tag>
  );
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
 * @param {object|null} [props.selected]  The row the record drawer shows
 * @param {() => void} [props.onMore]       Reads the next page, when the read has more
 * @param {{ busy: boolean, failed: boolean }} [props.paging]
 */
export function RecordsBody({ config, body, view, where, onOpen, selected = null, onMore = null, paging = { busy: false, failed: false } }) {
  const { t, i18n } = useTranslation();
  const columns = mergeColumns(config, body.columns, i18n.language);
  const shown   = columns.filter(c => c.shown);
  const cell    = (row, column) => formatValue(row[column.name], column, row, where);

  if (body.rows.length === 0) return <p className="muted">{t('records.empty')}</p>;

  const footer = body.more && (
    <p className="pfoot">{t('records.showing', { shown: body.rows.length, total: body.totalMatching ?? body.rows.length })}</p>
  );
  const end = (as) => body.more && onMore && <MoreRows onMore={onMore} paging={paging} as={as} />;
  const onKey = row => e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row); } };

  if (view === 'list') {
    const { title, details } = listFields(config, columns);
    const byName = new Map(columns.map(c => [c.name, c]));
    return (
      <>
        <ul className="rlist pbody">
          {body.rows.map((row, i) => (
            <li key={row.id ?? i}>
              <button type="button" onClick={() => onOpen(row)} aria-current={row === selected ? 'true' : undefined}>
                <span className="rt">{title ? cell(row, byName.get(title)) : ''}</span>
                <span className="rd">{details.map(d => cell(row, byName.get(d))).filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
          {end('li')}
        </ul>
        {footer}
      </>
    );
  }
  return (
    <>
      <div className="tablewrap pbody">
        <table className="grid">
          <thead>
            <tr>{shown.map(c => <th key={c.name} scope="col" className={isNumericColumn(c) ? 'num' : undefined}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {body.rows.map((row, i) => (
              <tr key={row.id ?? i} tabIndex={0} onClick={() => onOpen(row)} onKeyDown={onKey(row)} aria-selected={row === selected ? 'true' : undefined}>
                {shown.map(c => <td key={c.name} className={isNumericColumn(c) ? 'num' : undefined}>{cell(row, c)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {end('div')}
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
    body = <RecordsBody config={panel.config} body={state.body} view={view} where={where} onOpen={setOpen} selected={open}
      onMore={state.more} paging={state.paging} />;
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
        <Drawer title={titleOf(open)} onClose={() => setOpen(null)} beside>
          <RecordDetail columns={columns} row={open} where={where} />
        </Drawer>
      )}
    </PanelFrame>
  );
}
