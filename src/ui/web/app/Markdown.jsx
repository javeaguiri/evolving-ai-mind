// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/app/Markdown.jsx
//
// Markdown from /proc — a run's messages, a report — drawn as React elements (docs/arch-web-app.md
// §11). It may be LLM-written and carry injected content, so only marked's lexer is used and every
// token becomes an element here: raw HTML is shown as the text it is, an image as its description
// — a remote image is never fetched — and a link is followed only to http, https or mailto, in a
// new tab with noopener noreferrer. Nothing is inserted as HTML, so nothing needs sanitising.

import { marked } from 'marked';

const SAFE_HREF = /^(https?:|mailto:)/i;

function inline(tokens = []) {
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'strong':   return <strong key={i}>{inline(t.tokens)}</strong>;
      case 'em':       return <em key={i}>{inline(t.tokens)}</em>;
      case 'del':      return <del key={i}>{inline(t.tokens)}</del>;
      case 'codespan': return <code key={i}>{t.text}</code>;
      case 'br':       return <br key={i} />;
      case 'link':
        return SAFE_HREF.test(t.href)
          ? <a key={i} href={t.href} target="_blank" rel="noopener noreferrer">{inline(t.tokens)}</a>
          : <span key={i}>{inline(t.tokens)}</span>;
      case 'image':    return <span key={i}>{t.text}</span>;
      case 'text':     return t.tokens ? <span key={i}>{inline(t.tokens)}</span> : t.text;
      default:         return t.raw ?? '';       // html, escape and anything new: as written
    }
  });
}

function blocks(tokens = []) {
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'space':
      case 'def':        return null;
      case 'heading': {
        const Tag = t.depth <= 1 ? 'h3' : t.depth === 2 ? 'h4' : 'h5';
        return <Tag key={i}>{inline(t.tokens)}</Tag>;
      }
      case 'paragraph':  return <p key={i}>{inline(t.tokens)}</p>;
      case 'text':       return <p key={i}>{t.tokens ? inline(t.tokens) : t.text}</p>;
      case 'blockquote': return <blockquote key={i}>{blocks(t.tokens)}</blockquote>;
      case 'code':       return <pre key={i}><code>{t.text}</code></pre>;
      case 'hr':         return <hr key={i} />;
      case 'list': {
        const Tag = t.ordered ? 'ol' : 'ul';
        return (
          <Tag key={i} start={t.ordered && t.start !== 1 ? t.start : undefined}>
            {t.items.map((item, j) => (
              <li key={j}>{item.task && <span aria-hidden="true">{item.checked ? '☑ ' : '☐ '}</span>}{listItem(item)}</li>
            ))}
          </Tag>
        );
      }
      case 'table': {
        const align = k => (t.align[k] ? `al-${t.align[k]}` : undefined);   // a class: the CSP allows no inline style
        return (
          <div key={i} className="mdtable">
            <table>
              <thead><tr>{t.header.map((c, k) => <th key={k} className={align(k)}>{inline(c.tokens)}</th>)}</tr></thead>
              <tbody>{t.rows.map((row, r) => <tr key={r}>{row.map((c, k) => <td key={k} className={align(k)}>{inline(c.tokens)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      }
      default:           return <p key={i}>{t.raw}</p>;   // html: shown, never inserted
    }
  });
}

/** A tight list item's text is inline; a loose one holds blocks. A task's checkbox token is drawn
 * by the item itself. */
function listItem(item) {
  const tokens = item.tokens.filter(t => t.type !== 'checkbox');
  const only   = tokens.length === 1 && tokens[0].type === 'text' ? tokens[0] : null;
  return only ? inline(only.tokens ?? [{ type: 'text', text: only.text }]) : blocks(tokens);
}

/**
 * @param {object} props
 * @param {string} props.text
 */
export function Markdown({ text }) {
  return <div className="md">{blocks(marked.lexer(text ?? '', { gfm: true }))}</div>;
}
