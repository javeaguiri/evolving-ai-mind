// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/minds-eye/RegionHandle.jsx
//
// Her region's edge (docs/arch-web-app.md §4.1): dragged to widen or narrow the region, between
// MIN_WIDTH and MAX_SHARE of the window; the arrow keys move it too. A double-click returns it to
// DEFAULT_WIDTH. The width is remembered on this device when the drag ends.

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clampWidth, readWidth, writeWidth, DEFAULT_WIDTH, MIN_WIDTH, MAX_SHARE } from './conversation.mjs';

const KEY_STEP = 16;

/**
 * The region's width and how it changes: `set` while dragging, `keep` to remember it.
 *
 * @param {() => Storage|null} storage
 */
export function useRegionWidth(storage) {
  const [value, setValue] = useState(() => readWidth(storage()));
  const set  = useCallback(px => setValue(clampWidth(px, globalThis.innerWidth ?? px)), []);
  const keep = useCallback(px => {
    const width = clampWidth(px, globalThis.innerWidth ?? px);
    setValue(width);
    writeWidth(storage(), width);
  }, [storage]);
  return { value, set, keep };
}

/**
 * @param {object} props
 * @param {{ value: number, set: (px: number) => void, keep: (px: number) => void }} props.width
 */
export function RegionHandle({ width }) {
  const { t } = useTranslation();
  const drag = useRef(null);   // { left, last } while a drag is under way

  const onPointerDown = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { left: e.currentTarget.parentElement.getBoundingClientRect().left, last: width.value };
  };
  const onPointerMove = e => {
    if (!drag.current) return;
    drag.current.last = e.clientX - drag.current.left;
    width.set(drag.current.last);
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    width.keep(drag.current.last);
    drag.current = null;
  };
  const onKeyDown = e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); width.keep(width.value + KEY_STEP); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); width.keep(width.value - KEY_STEP); }
  };

  return (
    <div className="region-handle" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={t('mindsEye.resize')} title={t('mindsEye.resize')}
      aria-valuenow={width.value} aria-valuemin={MIN_WIDTH} aria-valuemax={Math.round((globalThis.innerWidth ?? 0) * MAX_SHARE) || undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={() => width.keep(DEFAULT_WIDTH)} onKeyDown={onKeyDown} />
  );
}
