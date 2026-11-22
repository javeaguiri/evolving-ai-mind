// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/records/EditGrid.jsx
//
// A records panel's grid in edit mode (docs/arch-web-app.md §6.1): the panel's columns, each
// cell the policy opens an input (gates/Input.jsx) — a foreign key a select of the rows it may
// name — the rest shown as read. A changed cell is marked; new rows come first; a removed row is
// struck through and can be put back. Enter and the up and down arrows move between rows, left
// and right between cells at the text's edge, as in a gate's grid (moveCell). Nothing is saved
// here: the panel saves every edit at once.

import { useRef }         from 'react';
import { useTranslation } from 'react-i18next';
import { Input }          from '../gates/Input.jsx';
import { moveCell }       from '../gates/gate.mjs';
import { formatValue, isNumericColumn } from './format.mjs';
import { editorFor, editsInGrid, cellText } from './edits.mjs';

/**
 * @param {object} props
 * @param {object[]} props.columns     The panel's shown columns, withSchema's
 * @param {object[]} props.rows        The rows read, each with `_version`
 * @param {object}   props.edits       { changes, added, removed }
 * @param {Record<string, string>} props.problems  By `<row id or new key>:<column>`
 * @param {Record<string, {value: string, label: string}[]>} props.options  A foreign key's choices, by column
 * @param {{ addRows: boolean, deleteRows: boolean }} props.allow
 * @param {{ locale: string, timeZone: string }} props.where
 * @param {(row: object, column: object, text: string) => void} props.onCell
 * @param {(key: string, column: object, text: string) => void} props.onAddedCell
 * @param {(id: number) => void} props.onRemove
 * @param {(key: string) => void} props.onDropAdded
 * @param {boolean} [props.disabled]
 */
export function EditGrid({ columns, rows, edits, problems, options, allow, where, onCell, onAddedCell, onRemove, onDropAdded, disabled }) {
  const { t } = useTranslation();
  const holder = useRef(null);
  const lines  = [
    ...edits.added.map(a => ({ key: a.key, added: a })),
    ...rows.map(row => ({ key: String(row.id), row })),
  ];
  const editable = columns.filter(editsInGrid);
  const size     = { rows: lines.length, columns: editable.length };

  function onKeyDown(r, c) {
    return e => {
      const target  = e.currentTarget;
      const atStart = target.selectionStart === 0 && target.selectionEnd === 0;
      const atEnd   = target.value === undefined || target.selectionStart === target.value.length;
      if ((e.key === 'ArrowLeft' && !atStart) || (e.key === 'ArrowRight' && !atEnd)) return;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return;
      if (target.tagName === 'SELECT' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
      const to   = moveCell({ r, c }, e.key, size);
      const next = holder.current?.querySelector(`[data-cell="${to.r}:${to.c}"]`);
      if (next) { e.preventDefault(); next.focus(); next.select?.(); }
    };
  }

  const fieldOf = (column, key, label) => ({
    name: `${key}-${column.name}`, label, optional: column.nullable !== false,
    ...editorFor(column),
    ...(column.references ? { options: options[column.name] ?? [] } : {}),
    ...(String(column.type).toLowerCase() === 'boolean' ? { options: [{ value: 'true', label: t('records.yes') }, { value: 'false', label: t('records.no') }] } : {}),
  });

  const lineLabel = line => (line.added ? t('records.newRow') : `#${line.row.id}`);
  // A foreign key is shown by the label of the row it names, and reads as text.
  const numeric    = column => isNumericColumn(column) && !column.references;
  const shownValue = (row, column) => {
    const value = row[column.name];
    const label = value !== null && value !== undefined && (options[column.name] ?? []).find(o => o.value === String(value))?.label;
    return label || formatValue(value, column, row, where);
  };

  return (
    <div className="tablewrap pbody" ref={holder}>
      <table className="grid edit records">
        <thead>
          <tr>
            {columns.map(c => <th key={c.name} scope="col" className={numeric(c) ? 'num' : undefined}>{c.label}</th>)}
            {(allow.deleteRows || edits.added.length > 0) && <th scope="col" aria-label={t('records.remove')} />}
          </tr>
        </thead>
        <tbody>
          {lines.map((line, r) => {
            const removed = line.row && edits.removed.includes(line.row.id);
            const cells   = line.added ? line.added.cells : edits.changes[line.row.id] ?? {};
            return (
              <tr key={line.key} className={[line.added && 'new', removed && 'removed'].filter(Boolean).join(' ') || undefined}>
                {columns.map(column => {
                  const c = editable.indexOf(column);
                  if (c === -1) {
                    const value = line.row ? shownValue(line.row, column) : '';
                    return <td key={column.name} className={numeric(column) ? 'num' : undefined}>{value}</td>;
                  }
                  const changed = column.name in cells;
                  const text    = changed ? cells[column.name] : line.row ? cellText(line.row[column.name], column) : '';
                  const problem = problems[`${line.key}:${column.name}`];
                  return (
                    <td key={column.name} className={[changed && line.row && 'changed', problem && 'bad'].filter(Boolean).join(' ') || undefined}>
                      <Input bare field={fieldOf(column, line.key, `${lineLabel(line)} — ${column.label}`)} value={text} problem={problem}
                        disabled={disabled || removed}
                        onChange={v => (line.added ? onAddedCell(line.key, column, v) : onCell(line.row, column, v))}
                        inputProps={{ 'data-cell': `${r}:${c}`, onKeyDown: onKeyDown(r, c), className: 'cell' }} />
                    </td>
                  );
                })}
                {(allow.deleteRows || edits.added.length > 0) && (
                  <td className="act">
                    {line.added
                      ? <button type="button" className="btn sm" disabled={disabled} onClick={() => onDropAdded(line.key)}
                          aria-label={t('records.dropNew')}>×</button>
                      : allow.deleteRows && (
                        <button type="button" className="btn sm" disabled={disabled} onClick={() => onRemove(line.row.id)} aria-pressed={removed}
                          aria-label={removed ? t('records.keep', { row: lineLabel(line) }) : t('records.removeRow', { row: lineLabel(line) })}>
                          {removed ? '↺' : '×'}
                        </button>
                      )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
