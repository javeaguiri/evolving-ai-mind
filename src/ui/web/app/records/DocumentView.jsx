// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/records/DocumentView.jsx
//
// A records panel's document view (docs/arch-web-app.md §6.2): an entity — a recipe — chosen from
// its records by label, read whole (GET /sources/{entity}/records/{id}), its root record a form
// and each child table beneath it a grid (EditGrid). What the edit policy opens is editable; a
// foreign key is a drop-down of the rows it may name, by their label — never a typed id. Save
// writes the whole document at once (POST /sources/{entity}/records/{id}). A refusal is named; a
// change someone else made since it was read is named, the document read again, and the edits it
// did not touch kept. Every child collection is a grid until the registry says which column
// orders one (display.order_by).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation }  from 'react-i18next';
import { SignInRequired }  from '../auth/session.mjs';
import { Input }           from '../gates/Input.jsx';
import { formatValue }     from './format.mjs';
import { EditGrid }        from './EditGrid.jsx';
import { editorFor, editsInGrid, cellText, setCell, addRow, setAddedCell, dropAdded, toggleRemoved, referenceOptions } from './edits.mjs';
import { tableLabel }      from '../../../../shared/schema-utils.mjs';
import { documentColumns, noDocumentEdits, childEdits, withChildEdits, hasDocumentEdits, documentProblems,
         problemCount, documentWrites, afterDocumentConflict, documentMoved } from './document.mjs';

/**
 * The rows each foreign key may name, read once per referenced table, as options by table name.
 */
function useReferences(api, schema, locale, onSignInRequired) {
  const [byTable, setByTable] = useState({});
  useEffect(() => {
    let live = true;
    const tables = new Set([schema.table, ...(schema.children ?? [])]
      .flatMap(t => t.columns.filter(c => c.references).map(c => c.references.table)));
    for (const table of tables) {
      api.get(`sources/${encodeURIComponent(table)}/rows`, { limit: 500 }).then(
        body => { if (live) setByTable(o => ({ ...o, [table]: referenceOptions(body, locale) })); },
        e => { if (e instanceof SignInRequired) onSignInRequired(); },
      );
    }
    return () => { live = false; };
  }, [api, schema, locale, onSignInRequired]);
  return byTable;
}

const optionsFor = (columns, byTable) =>
  Object.fromEntries(columns.filter(c => c.references).map(c => [c.name, byTable[c.references.table] ?? []]));

/**
 * The root record as a form: an editable field as its control — `text` as a text area — the rest
 * as read.
 */
export function RootForm({ columns, entity, edits, problems, options, where, onCell, disabled }) {
  const cells = edits.changes[entity.id] ?? {};
  return (
    <div className="docform">
      {columns.map(column => {
        const value = entity[column.name];
        if (!editsInGrid(column)) {
          const label = column.references && (options[column.name] ?? []).find(o => o.value === String(value))?.label;
          return (
            <div key={column.name} className="field">
              <span className="flabel">{column.label}</span>
              <span>{label || formatValue(value, column, entity, where)}</span>
            </div>
          );
        }
        const editor = editorFor(column);
        const field  = {
          name: `root-${column.name}`, label: column.label, optional: column.nullable !== false, ...editor,
          ...(String(column.type).toLowerCase() === 'text' ? { input_type: 'textarea' } : {}),
          ...(column.references ? { options: options[column.name] ?? [] } : {}),
        };
        const changed = column.name in cells;
        return (
          <div key={column.name} className={changed ? 'changed' : undefined}>
            <Input field={field} value={changed ? cells[column.name] : cellText(value, column)} problem={problems[`${entity.id}:${column.name}`]}
              disabled={disabled} onChange={text => onCell(column, text)} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.api
 * @param {string} props.source            The entity's name
 * @param {object} props.schema            SourceSchema of the entity
 * @param {{ locale: string, timeZone: string }} props.where
 * @param {() => void} props.onSignInRequired
 * @param {(notice: object|null) => void} props.onNotice  What became of a save, for the panel to show
 * @param {number|null} [props.initialId]  The record it opens on — a row clicked in the grid
 */
export function DocumentView({ api, source, schema, where, onSignInRequired, onNotice, initialId = null }) {
  const { t, i18n } = useTranslation();
  const [picks, setPicks]   = useState(null);
  const [id, setId]         = useState(initialId);
  const [doc, setDoc]       = useState({ status: 'idle' });
  const [edits, setEdits]   = useState(noDocumentEdits);
  const [tried, setTried]   = useState(false);
  const [saving, setSaving] = useState(false);
  const added   = useRef(0);
  const byTable = useReferences(api, schema, i18n.language, onSignInRequired);

  useEffect(() => {
    let live = true;
    api.get(`sources/${encodeURIComponent(source)}/rows`, { limit: 500 }).then(
      body => { if (live) setPicks(referenceOptions(body, i18n.language)); },
      e => { if (e instanceof SignInRequired) onSignInRequired(); else if (live) setPicks([]); },
    );
    return () => { live = false; };
  }, [api, source, i18n.language, onSignInRequired]);

  const read = useCallback(recordId => api.get(`sources/${encodeURIComponent(source)}/records/${recordId}`), [api, source]);

  useEffect(() => {
    if (id === null) return undefined;
    let live = true;
    setDoc({ status: 'loading' });
    read(id).then(
      body => { if (live) setDoc({ status: 'ready', body }); },
      e => {
        if (!live) return;
        if (e instanceof SignInRequired) onSignInRequired();
        else setDoc({ status: e.code === 'record_not_found' ? 'missing' : 'failed' });
      },
    );
    return () => { live = false; };
  }, [id, read, onSignInRequired]);

  const choose = next => {
    if (hasDocumentEdits(edits) && !window.confirm(t('records.discard'))) return;
    setEdits(noDocumentEdits()); setTried(false); onNotice(null);
    setId(next === '' ? null : Number(next));
  };

  function save() {
    const problems = documentProblems(edits, schema);
    if (problemCount(problems)) { setTried(true); return; }
    const before = doc.body;
    setSaving(true);
    onNotice(null);
    api.post(`sources/${encodeURIComponent(source)}/records/${id}`, documentWrites(edits, before, schema)).then(
      result => {
        setDoc({ status: 'ready', body: { entity: result.entity, children: result.children } });
        setEdits(noDocumentEdits()); setTried(false);
        onNotice({ kind: 'saved' });
      },
      e => {
        if (e instanceof SignInRequired) { onSignInRequired(); return; }
        if (e.code === 'version_conflict') {
          const conflicts = e.conflicts ?? [];
          read(id).then(after => {
            onNotice({ kind: 'moved', rows: documentMoved(before, after, conflicts, schema, byTable) });
            setEdits(current => afterDocumentConflict(current, before, after, conflicts, schema));
            setDoc({ status: 'ready', body: after });
          }, () => onNotice({ kind: 'failed' }));
        } else if (e.code === 'not_editable') onNotice({ kind: 'refused', fields: e.fields ?? [] });
        else if (e.code === 'invalid_writes') onNotice({ kind: 'invalid', message: e.message });
        else if (e.code === 'record_not_found') onNotice({ kind: 'gone' });
        else onNotice({ kind: 'failed' });
      },
    ).finally(() => setSaving(false));
  }

  const discard = () => { setEdits(noDocumentEdits()); setTried(false); onNotice(null); };

  let body = null;
  if (doc.status === 'loading') body = <div className="skeleton" aria-busy="true" aria-label={t('shell.loading')}><i /><i /><i /></div>;
  else if (doc.status === 'missing') body = <p className="muted">{t('records.recordGone')}</p>;
  else if (doc.status === 'failed') body = <p className="muted">{t('records.failed')}</p>;
  else if (doc.status === 'ready') {
    const { entity, children } = doc.body;
    const problems = documentProblems(edits, schema);
    // A new row's problems — its empty required cells — wait for Save; a changed cell's show at once.
    const shown    = all => (tried ? all : Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith('new-'))));
    const rootColumns = documentColumns(schema.table);
    body = (
      <>
        <RootForm columns={rootColumns} entity={entity} edits={edits.root} problems={shown(problems.root)} where={where}
          options={optionsFor(rootColumns, byTable)} disabled={saving}
          onCell={(column, text) => setEdits(e => ({ ...e, root: setCell(e.root, entity, column, text) }))} />
        {(schema.children ?? []).map(child => {
          const columns = documentColumns(child);
          const change  = fn => setEdits(e => withChildEdits(e, child.table, fn));
          return (
            <section key={child.table} className="docchild">
              <div className="phead">
                <h3>{tableLabel(child.table)}</h3>
                {child.addRows && (
                  <button type="button" className="btn sm" disabled={saving}
                    onClick={() => change(c => addRow(c, `new-${++added.current}`))}>{t('records.addRow')}</button>
                )}
              </div>
              <EditGrid columns={columns} rows={children?.[child.table] ?? []} edits={childEdits(edits, child.table)}
                problems={shown(problems.children[child.table] ?? {})} options={optionsFor(columns, byTable)}
                allow={{ addRows: child.addRows, deleteRows: child.deleteRows }} where={where} disabled={saving}
                onCell={(row, column, text) => change(c => setCell(c, row, column, text))}
                onAddedCell={(k, column, text) => change(c => setAddedCell(c, k, column, text))}
                onRemove={rowId => change(c => toggleRemoved(c, rowId))}
                onDropAdded={k => change(c => dropAdded(c, k))} />
            </section>
          );
        })}
        <div className="docsave">
          <button type="button" className="btn sm" disabled={saving || !hasDocumentEdits(edits)} onClick={discard}>{t('records.discardButton')}</button>
          <button type="button" className="btn sm primary" disabled={saving || !hasDocumentEdits(edits)} onClick={save}>
            {saving ? t('records.saving') : t('records.save')}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="document pbody">
      <label className="docpick">
        <span className="flabel">{t('records.choose', { what: tableLabel(schema.table.table) })}</span>
        <select value={id ?? ''} onChange={e => choose(e.target.value)} disabled={saving || picks === null}>
          <option value="">{picks === null ? t('shell.loading') : t('records.pick')}</option>
          {(picks ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {body}
    </div>
  );
}
