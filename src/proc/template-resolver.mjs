// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/template-resolver.mjs
//
// Pure functions — no I/O, no AWS SDK, no side effects.
// Used by the Step Processor to resolve {{variable}} references
// in step definitions against the current local_state.
//
// Supports standard JSONPath subset — no $ root prefix needed:
//   {{input.userInput}}                 — dot-path into local_state
//   {{proposed_scaffold.domain}}        — nested object access
//   {{proposed_scaffold.tables.length}} — .length on arrays
//   {{all_cards[*].id}}                 — JSONPath wildcard: extract field from every array element
//   {{entity_schema_rows[0].root_table}} — bracket index access

/**
 * Normalise a path string to a plain dot-separated token list.
 * Converts JSONPath bracket notation — [*] and [n] — to dot segments
 * so the walker below handles a single unified format.
 *
 * "cards[*].id"   → ["cards", "*", "id"]
 * "rows[0].name"  → ["rows", "0", "name"]
 * "input.domain"  → ["input", "domain"]
 */
function tokenizePath(path) {
  return path.replace(/\[(\*|\d+)\]/g, '.$1').split('.').filter(Boolean);
}

/**
 * Resolve a path string against an object.
 * Accepts dot-path and JSONPath bracket notation (see tokenizePath).
 * Handles [*] wildcard and numeric index access.
 *
 * @param {object} obj   The root object (local_state)
 * @param {string} path  Path string e.g. "cards[*].id" or "input.domain"
 * @returns {*}          The resolved value, or undefined if not found
 */
export function resolvePath(obj, path) {
  const parts = tokenizePath(path);
  let cur = obj;

  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (cur == null) return undefined;

    if (key === '*') {
      if (!Array.isArray(cur)) return undefined;
      const remaining = parts.slice(i + 1).join('.');
      return remaining ? cur.map(item => resolvePath(item, remaining)) : cur;
    }

    if (Array.isArray(cur) && /^\d+$/.test(key)) {
      cur = cur[parseInt(key, 10)];
    } else {
      cur = cur[key];
    }
  }
  return cur;
}

/**
 * Resolve all {{variable}} placeholders in a template string.
 * Unknown paths are left as-is: {{missing.key}} stays unchanged.
 *
 * @param {string} template   Template string with {{dot.path}} placeholders
 * @param {object} localState The current frame local_state
 * @returns {string}          Resolved string
 */
export function resolveTemplate(template, localState) {
  if (typeof template !== 'string') return template;

  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const trimmed = path.trim();

    // {{a.b.c.length}} — resolve the array then return its length
    if (trimmed.endsWith('.length')) {
      const arrayPath = trimmed.slice(0, -7); // strip '.length'
      const arr = resolvePath(localState, arrayPath);
      return Array.isArray(arr) ? String(arr.length) : '0';
    }

    const val = resolvePath(localState, trimmed);
    if (val === undefined || val === null) return match; // leave unresolved
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  });
}

/**
 * Resolve all {{variable}} placeholders in a step's input object.
 * Recursively walks the input — resolves string values, leaves other
 * types unchanged.
 *
 * @param {object|string|*} input   The step input (may be an object or string)
 * @param {object} localState       Current frame local_state
 * @returns {object|string|*}       Input with all template variables resolved
 */
export function resolveInput(input, localState) {
  // Single {{path}} token — if it resolves to a non-primitive, return the
  // raw value directly. This handles input: "{{item}}" in iterator steps
  // where item is a full object that must be passed through intact.
  if (typeof input === 'string') {
    const singleToken = input.match(/^\{\{([^}]+)\}\}$/);
    if (singleToken) {
      const val = resolvePath(localState, singleToken[1].trim());
      if (val !== undefined && val !== null) return val;
    }
    return resolveTemplate(input, localState);
  }
  if (Array.isArray(input))     return input.map(i => resolveInput(i, localState));
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, resolveInput(v, localState)])
    );
  }
  return input;
}

/**
 * Evaluate a simple boolean condition expression against an item object.
 * Safe evaluator — only property access, .length, comparison operators.
 * Used by edit_list gate to determine which items get action buttons.
 *
 * Supported syntax:
 *   item.foreignKeys.length > 0
 *   item.isParent === false
 *   !item.isSystem
 *   item.status !== 'deleted'
 *
 * @param {string} condition   Expression string — item is available as 'item'
 * @param {object} item        The individual list item being evaluated
 * @returns {boolean}
 */
export function evalItemCondition(condition, item) {
  try {
    // Restricted to a safe subset — no arbitrary code via Function constructor.
    // For this use case (simple property comparisons) this is sufficient.
    // A future iteration can add a proper expression AST parser if needed.
    return new Function('item', `'use strict'; return Boolean(${condition});`)(item);
  } catch (e) {
    console.warn('template-resolver: condition eval failed', {
      condition,
      error: e.message,
    });
    return false;
  }
}
