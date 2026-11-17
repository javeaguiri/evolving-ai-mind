// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/panels/PanelFrame.jsx
//
// A panel's frame (docs/arch-web-app.md §4.2): its title, its width on the page's grid, the tools
// in its header, and its kind inside.

const WIDTH_CLASS = { '1/3': 'w-third', '1/2': 'w-half', '2/3': 'w-two-thirds', full: 'w-full' };

/**
 * The frame. `tools` sit in the header, after the title.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {string} props.width
 */
export function PanelFrame({ title, width, tools, children }) {
  return (
    <section className={`panel ${WIDTH_CLASS[width] ?? 'w-full'}`} aria-label={title || undefined}>
      <div className="phead">
        <h2>{title}</h2>
        {tools}
      </div>
      {children}
    </section>
  );
}
