// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/gates/Grid.jsx
//
// A form whose fields all name their row and column, drawn as one editable grid (docs/arch-web-
// app.md §5.2): a row header from its first field's label, `group` as heading rows, a missing cell
// blank. A changed cell is marked; Tab moves on as it always does, Enter and the up and down arrows
// move between rows, left and right between cells when the caret is at the text's edge. It never
// computes a total — a figure that depends on the values is the workflow's, in its message.

import { useRef }   from 'react';
import { Input }    from './Input.jsx';
import { isChanged, moveCell } from './gate.mjs';

/**
 * @param {object} props
 * @param {{ columns: string[], rows: object[] }} props.grid   gridOf's result
 * @param {object} props.values
 * @param {object} props.initial
 * @param {Record<string, string|undefined>} props.problems
 * @param {(name: string, value: any) => void} props.onChange
 * @param {(name: string, problem: string|undefined) => void} [props.onCheck]
 * @param {boolean} [props.disabled]
 */
export function Grid({ grid, values, initial, problems, onChange, onCheck, disabled }) {
  const table = useRef(null);
  const size  = { rows: grid.rows.length, columns: grid.columns.length };

  function onKeyDown(r, c) {
    return e => {
      const target = e.currentTarget;
      const atStart = target.selectionStart === 0 && target.selectionEnd === 0;
      const atEnd   = target.value === undefined || target.selectionStart === target.value.length;
      if ((e.key === 'ArrowLeft' && !atStart) || (e.key === 'ArrowRight' && !atEnd)) return;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return;
      if (target.tagName === 'SELECT' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
      const to = moveCell({ r, c }, e.key, size);
      const next = table.current?.querySelector(`[data-cell="${to.r}:${to.c}"]`);
      if (next) { e.preventDefault(); next.focus(); next.select?.(); }
    };
  }

  let group = null;
  const problemsShown = grid.rows.flatMap(row => Object.values(row.cells)).filter(f => problems[f.name]);
  return (
    <>
      <div className="tablewrap">
        <table className="grid edit" ref={table}>
          <thead>
            <tr><th scope="col" aria-hidden="true" />{grid.columns.map(c => <th key={c} scope="col">{c}</th>)}</tr>
          </thead>
          <tbody>
            {grid.rows.flatMap((row, r) => {
              const out = [];
              if (row.group && row.group !== group) {
                group = row.group;
                out.push(<tr key={`g-${r}`} className="grp"><th colSpan={grid.columns.length + 1} scope="colgroup">{row.group}</th></tr>);
              }
              out.push(
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  {grid.columns.map((col, c) => {
                    const field = row.cells[col];
                    if (!field) return <td key={col} />;
                    const changed = isChanged(field, values, initial);
                    return (
                      <td key={col} className={[changed && 'changed', problems[field.name] && 'bad'].filter(Boolean).join(' ') || undefined}>
                        <Input bare field={{ ...field, label: `${row.label} — ${col}` }} value={values[field.name]} problem={problems[field.name]}
                          onChange={v => onChange(field.name, v)} onCheck={p => onCheck?.(field.name, p)} disabled={disabled}
                          inputProps={{ 'data-cell': `${r}:${c}`, onKeyDown: onKeyDown(r, c) }} />
                      </td>
                    );
                  })}
                </tr>,
              );
              return out;
            })}
          </tbody>
        </table>
      </div>
      {problemsShown.length > 0 && (
        <ul className="problems" role="alert">
          {problemsShown.map(f => <li key={f.name}>{f.label} — {f.column}: {problems[f.name]}</li>)}
        </ul>
      )}
    </>
  );
}
