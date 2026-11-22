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
//
// Edit (§6.1, §6.4): a table whose edit policy opens a column the panel shows, or lets rows be
// added or removed, offers Edit — the source's schema says so (GET /sources/{source}/schema). In
// edit mode the grid re-reads its rows with their versions and edits them in place
// (records/EditGrid.jsx); Save sends every edit at once (POST /sources/{source}/rows). A refusal
// names what was refused; a row that moved since it was read is named, its edits dropped, and
// the rows read again. A foreign key shows the row it names, by its label column, in either mode.
// An entity's panel also offers Document: one record and its child tables, edited and saved
// together (records/DocumentView.jsx).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation }      from 'react-i18next';
import { SignInRequired }      from '../auth/session.mjs';
import { Drawer }              from '../shell/Drawer.jsx';
import { formatValue, isNumericColumn } from '../records/format.mjs';
import { rowsRequest, appendPage, mergeColumns, listFields, initialView, viewKey, RECORD_VIEWS, DOCUMENT_VIEW } from '../records/query.mjs';
import { withSchema, canEdit, noEdits, hasEdits, setCell, addRow, setAddedCell, dropAdded, toggleRemoved, editProblems,
         writesOf, applySaved, afterConflict, movedRows, referenceOptions } from '../records/edits.mjs';
import { EditGrid }            from '../records/EditGrid.jsx';
import { DocumentView }        from '../records/DocumentView.jsx';
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
function useRows(api, config, onSignInRequired, withVersion = false) {
  const [state, setState] = useState({ status: 'loading' });
  const [paging, setPaging] = useState({ busy: false, failed: false });
  const [reads, setReads] = useState(0);   // a reload asked for: the rows read again
  const read = useRef(0);   // which read the page belongs to: a new config starts a new one
  useEffect(() => {
    const id = ++read.current;
    const { source, query } = rowsRequest(config, 0, withVersion);
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
  }, [api, config, onSignInRequired, withVersion, reads]);

  const busy = useRef(false);
  const more = useCallback(() => {
    if (busy.current || state.status !== 'ready' || !state.body.more) return;
    busy.current = true;
    const id = read.current;
    const { source, query } = rowsRequest(config, state.body.rows.length, withVersion);
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
  }, [api, config, onSignInRequired, state, withVersion]);

  const replaceRows = useCallback(change => setState(s => (s.status === 'ready' ? { ...s, body: { ...s.body, rows: change(s.body.rows) } } : s)), []);
  const reload      = useCallback(() => setReads(n => n + 1), []);
  return { ...state, more, paging, replaceRows, reload };
}

/**
 * What the source's schema says — the columns' edit policy and foreign keys — and, for each
 * foreign key the panel shows, the rows it may name as options and as labels. Read once; a
 * schema that cannot be read leaves the panel read-only, its keys shown as read.
 */
function useSchema(api, config, locale, onSignInRequired) {
  const [schema, setSchema]   = useState(null);
  const [options, setOptions] = useState({});
  useEffect(() => {
    let live = true;
    const { source } = rowsRequest(config);
    api.get(`sources/${encodeURIComponent(source)}/schema`).then(
      found => {
        if (!live) return;
        setSchema(found);
        const shown = new Set(mergeColumns(config, found.table.columns, locale).filter(c => c.shown).map(c => c.name));
        for (const column of found.table.columns.filter(c => c.references && shown.has(c.name))) {
          api.get(`sources/${encodeURIComponent(column.references.table)}/rows`, { limit: 500 }).then(
            body => { if (live) setOptions(o => ({ ...o, [column.name]: referenceOptions(body, locale) })); },
            e => { if (e instanceof SignInRequired) onSignInRequired(); },
          );
        }
      },
      e => { if (e instanceof SignInRequired) onSignInRequired(); },
    );
    return () => { live = false; };
  }, [api, config, locale, onSignInRequired]);
  return { schema, options };
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
 * @param {Record<string, {value: string, label: string}[]>} [props.options]  A foreign key's rows, by column: shown by label
 */
export function RecordsBody({ config, body, view, where, onOpen, selected = null, onMore = null, paging = { busy: false, failed: false }, options = {} }) {
  const { t, i18n } = useTranslation();
  const columns = mergeColumns(config, body.columns, i18n.language);
  const shown   = columns.filter(c => c.shown);
  const cell    = (row, column) => labelOf(options[column.name], row[column.name]) ?? formatValue(row[column.name], column, row, where);
  const numeric = column => isNumericColumn(column) && !options[column.name];   // a key shown by its row's label is text

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
            <tr>{shown.map(c => <th key={c.name} scope="col" className={numeric(c) ? 'num' : undefined}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {body.rows.map((row, i) => (
              <tr key={row.id ?? i} tabIndex={0} onClick={() => onOpen(row)} onKeyDown={onKey(row)} aria-selected={row === selected ? 'true' : undefined}>
                {shown.map(c => <td key={c.name} className={numeric(c) ? 'num' : undefined}>{cell(row, c)}</td>)}
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

/** The label of the row a foreign key names, or undefined when it is not among the options read. */
function labelOf(choices, value) {
  if (!choices || value === null || value === undefined) return undefined;
  return choices.find(o => o.value === String(value))?.label;
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
  const [editing, setEditing] = useState(false);
  const [edits, setEdits]     = useState(noEdits);
  const [tried, setTried]     = useState(false);   // Save was pressed: every problem is shown
  const [saving, setSaving]   = useState(false);
  const [notice, setNotice]   = useState(null);
  const [opened, setOpened]   = useState(null);   // the record a row click opened as a document
  const added             = useRef(0);
  const state             = useRows(api, panel.config, onSignInRequired, editing);
  const { schema, options } = useSchema(api, panel.config, i18n.language, onSignInRequired);
  const where             = { locale, timeZone };

  const columns = state.status === 'ready' ? withSchema(mergeColumns(panel.config, state.body.columns, i18n.language), schema?.table) : [];
  const shown   = columns.filter(c => c.shown);
  const editable = state.status === 'ready' && canEdit(schema, shown);
  const allow    = { addRows: Boolean(schema?.table?.addRows), deleteRows: Boolean(schema?.table?.deleteRows) };
  const source   = rowsRequest(panel.config).source;
  const isEntity = schema?.kind === 'entity';
  const views    = isEntity ? [...RECORD_VIEWS, DOCUMENT_VIEW] : RECORD_VIEWS;
  const shownView = view === DOCUMENT_VIEW && schema && !isEntity ? 'grid' : view;

  const choose = v => { setView(v); remember(key, v); };
  // An entity's row opens as a document — the record with its child tables; a table's in the drawer.
  const openRow = row => {
    if (isEntity && row.id !== undefined) { setOpened(row.id); setView(DOCUMENT_VIEW); }
    else setOpen(row);
  };
  const startEditing = () => { setEditing(true); setOpen(null); setNotice(null); setTried(false); };
  const stopEditing  = () => {
    if (hasEdits(edits) && !window.confirm(t('records.discard'))) return;
    setEditing(false); setEdits(noEdits()); setTried(false);
  };

  function save() {
    if (Object.keys(editProblems(edits, shown)).length) { setTried(true); return; }
    const rows = state.body.rows;
    setSaving(true);
    setNotice(null);
    api.post(`sources/${encodeURIComponent(source)}/rows`, writesOf(edits, rows, shown)).then(
      result => {
        state.replaceRows(read => applySaved(read, result));
        setEdits(noEdits()); setEditing(false); setTried(false);
        setNotice({ kind: 'saved' });
      },
      e => {
        if (e instanceof SignInRequired) { onSignInRequired(); return; }
        if (e.code === 'version_conflict') {
          const conflicts = e.conflicts ?? [];
          setNotice({ kind: 'moved', rows: movedRows(conflicts, rows, columns, options) });
          setEdits(current => afterConflict(current, conflicts));
          state.reload();
        } else if (e.code === 'not_editable') setNotice({ kind: 'refused', fields: e.fields ?? [] });
        else if (e.code === 'invalid_writes') setNotice({ kind: 'invalid', message: e.message });
        else setNotice({ kind: 'failed' });
      },
    ).finally(() => setSaving(false));
  }

  const viewSwitch = (
    <span className="vsw" role="group" aria-label={t('records.view')}>
      {views.map(v => (
        <button key={v} type="button" aria-pressed={v === shownView} onClick={() => choose(v)}>
          {v === 'grid' ? t('records.grid') : v === 'list' ? t('records.list') : t('records.document')}
        </button>
      ))}
    </span>
  );
  const tools = editing
    ? (
      <span className="etools">
        {allow.addRows && <button type="button" className="btn sm" disabled={saving} onClick={() => setEdits(e => addRow(e, `new-${++added.current}`))}>{t('records.addRow')}</button>}
        <button type="button" className="btn sm" disabled={saving} onClick={stopEditing}>{t('records.cancel')}</button>
        <button type="button" className="btn sm primary" disabled={saving || !hasEdits(edits)} onClick={save}>{saving ? t('records.saving') : t('records.save')}</button>
      </span>
    )
    : (
      <>
        {viewSwitch}
        {editable && shownView !== DOCUMENT_VIEW && <button type="button" className="btn sm" onClick={startEditing}>{t('records.edit')}</button>}
      </>
    );

  let body;
  if (shownView === DOCUMENT_VIEW && !schema) {
    body = <div className="skeleton" aria-busy="true" aria-label={t('shell.loading')}><i /><i /><i /></div>;
  } else if (shownView === DOCUMENT_VIEW) {
    body = <DocumentView key={opened ?? 'pick'} api={api} source={source} schema={schema} where={where} initialId={opened}
      onSignInRequired={onSignInRequired} onNotice={setNotice} />;
  } else if (editing && state.status === 'ready') {
    const problems = editProblems(edits, shown);
    const touched  = key2 => {
      const [row, column] = key2.split(/:(?=[^:]*$)/);
      return edits.changes[row]?.[column] !== undefined || (edits.added.find(a => a.key === row)?.cells[column] ?? '') !== '';
    };
    const visible = Object.fromEntries(Object.entries(problems).filter(([k]) => tried || touched(k)));
    body = (
      <>
        <EditGrid columns={shown} rows={state.body.rows} edits={edits} problems={visible} options={options} allow={allow} where={where}
          disabled={saving}
          onCell={(row, column, text) => setEdits(e => setCell(e, row, column, text))}
          onAddedCell={(k, column, text) => setEdits(e => setAddedCell(e, k, column, text))}
          onRemove={id => setEdits(e => toggleRemoved(e, id))}
          onDropAdded={k => setEdits(e => dropAdded(e, k))} />
        {state.body.more && <MoreRows onMore={state.more} paging={state.paging} />}
      </>
    );
  } else if (state.status === 'loading') {
    body = <div className="skeleton" aria-busy="true" aria-label={t('shell.loading')}><i /><i /><i /></div>;
  } else if (state.status === 'missing') {
    body = <p className="muted">{t('records.missing', { source: state.source })}</p>;
  } else if (state.status === 'failed') {
    body = <p className="muted">{t('records.failed')}</p>;
  } else {
    body = <RecordsBody config={panel.config} body={state.body} view={shownView} where={where} onOpen={openRow} selected={open}
      onMore={state.more} paging={state.paging} options={options} />;
  }

  const titleOf = row => {
    const name = listFields(panel.config, columns).title;
    const column = columns.find(c => c.name === name);
    return (column && formatValue(row[name], column, row, where)) || title;
  };

  return (
    <PanelFrame title={title} width={panel.width} tools={state.status === 'ready' || shownView === DOCUMENT_VIEW ? tools : null}>
      {notice && <EditNotice notice={notice} onClose={() => setNotice(null)} />}
      {body}
      {open && (
        <Drawer title={titleOf(open)} onClose={() => setOpen(null)} beside>
          <RecordDetail columns={columns} row={open} where={where} />
        </Drawer>
      )}
    </PanelFrame>
  );
}

/** One part the edit policy refused, as a person reads it. */
function refusedPart(t, { name, problem }) {
  switch (problem) {
    case 'column_not_editable': return t('records.problem.column_not_editable', { name });
    case 'table_not_editable':  return t('records.problem.table_not_editable', { name });
    case 'add_rows':            return t('records.problem.add_rows', { name });
    case 'delete_rows':         return t('records.problem.delete_rows', { name });
    default:                    return name;
  }
}

/**
 * What became of a save: saved; refused, naming each part the policy does not open; refused by
 * the server for another reason; or rows that moved since they were read, named, their edits
 * dropped and the rows read again.
 */
export function EditNotice({ notice, onClose }) {
  const { t } = useTranslation();
  let text;
  if (notice.kind === 'saved') text = t('records.saved');
  else if (notice.kind === 'moved') {
    text = t('records.moved', { rows: notice.rows.map(r => (r.reason === 'deleted'
      ? t('records.movedDeleted', { name: r.name }) : t('records.movedChanged', { name: r.name }))).join('; ') });
  } else if (notice.kind === 'refused') {
    text = t('records.refused', { parts: notice.fields.map(f => refusedPart(t, f)).join('; ') });
  } else if (notice.kind === 'invalid') text = t('records.invalid', { message: notice.message });
  else if (notice.kind === 'gone') text = t('records.recordGone');
  else text = t('records.saveFailed');
  return (
    <p className={notice.kind === 'saved' ? 'msg' : 'msg error'} role={notice.kind === 'saved' ? 'status' : 'alert'}>
      {text} <button type="button" className="btn sm" onClick={onClose} aria-label={t('records.dismiss')}>×</button>
    </p>
  );
}
