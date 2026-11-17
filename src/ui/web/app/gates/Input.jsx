// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/gates/Input.jsx
//
// A form field's control, by its input_type (docs/arch-web-app.md §5.3): native controls, an
// option valued '' the standard "none". A number is a text box with the numeric keyboard — the
// shared rule reads a decimal comma, which a number input would refuse. `bare` draws the control
// alone, for a grid cell, with its label kept for a screen reader.

import { useTranslation } from 'react-i18next';
import { numberRule, readNumber } from '../../../../shared/number-rule.mjs';

const NATIVE = { date: 'date', time: 'time', datetime: 'datetime-local', text: 'text' };

/**
 * @param {object} props
 * @param {object} props.field             A dialog input: { name, input_type, label, optional, options?, placeholder? }
 * @param {string|string[]} props.value
 * @param {string} [props.problem]
 * @param {(value: string|string[]) => void} props.onChange
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.bare]
 * @param {(problem: string|undefined) => void} [props.onCheck]  On leaving a number field: what the rule says
 * @param {object} [props.inputProps]      Passed to the control — a grid's keyboard handling
 */
export function Input({ field, value, problem, onChange, disabled, bare = false, onCheck, inputProps = {} }) {
  const { t } = useTranslation();
  const id     = `f-${field.name}`;
  const common = { id, name: field.name, disabled, 'aria-invalid': problem ? true : undefined, 'aria-label': bare ? field.label : undefined, ...inputProps };
  const options = field.options ?? [];
  let control;

  switch (field.input_type) {
    case 'textarea':
      control = <textarea {...common} value={value} placeholder={field.placeholder} rows={3} onChange={e => onChange(e.target.value)} />;
      break;
    case 'number':
      control = (
        <input {...common} type="text" inputMode={field.decimal === false ? 'numeric' : 'decimal'} value={value} placeholder={field.placeholder}
          className={bare ? 'cell num' : undefined}
          onChange={e => onChange(e.target.value)}
          onBlur={() => onCheck?.(String(value).trim() === '' ? undefined : readNumber(String(value), numberRule(field)).problem)} />
      );
      break;
    case 'select':
      control = (
        <select {...common} value={value} onChange={e => onChange(e.target.value)}>
          {!options.some(o => o.value === '') && <option value="">{t('gate.none')}</option>}
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'multi_select':
      control = (
        <select {...common} multiple value={value} onChange={e => onChange([...e.target.selectedOptions].map(o => o.value))}>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'radio':
      control = (
        <span role="radiogroup" aria-labelledby={`${id}-l`} className="opts">
          {options.map(o => (
            <label key={o.value}><input type="radio" name={field.name} value={o.value} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} /> {o.label}</label>
          ))}
        </span>
      );
      break;
    case 'checkbox':
      control = (
        <span role="group" aria-labelledby={`${id}-l`} className="opts">
          {options.map(o => (
            <label key={o.value}>
              <input type="checkbox" value={o.value} checked={value.includes(o.value)} disabled={disabled}
                onChange={e => onChange(e.target.checked ? [...value, o.value] : value.filter(v => v !== o.value))} /> {o.label}
            </label>
          ))}
        </span>
      );
      break;
    default:
      control = <input {...common} type={NATIVE[field.input_type] ?? 'text'} value={value} placeholder={field.placeholder}
        className={bare ? 'cell' : undefined} onChange={e => onChange(e.target.value)} />;
  }

  if (bare) return control;
  const grouped = field.input_type === 'radio' || field.input_type === 'checkbox';
  return (
    <div className="fld">
      {grouped
        ? <span id={`${id}-l`} className="flabel">{field.label}{field.optional && <i> {t('gate.optional')}</i>}</span>
        : <label htmlFor={id} className="flabel">{field.label}{field.optional && <i> {t('gate.optional')}</i>}</label>}
      {control}
      {problem && <span className="problem">{field.label} {problem}</span>}
    </div>
  );
}
