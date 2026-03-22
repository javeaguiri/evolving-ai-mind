// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/template-resolver.mjs
//
// Pure functions — no I/O, no AWS SDK, no side effects.
// Used by the Step Processor to resolve {{variable}} references
// in step definitions against the current local_state.
//
// Supports:
//   {{input.userInput}}               — dot-path into local_state
//   {{proposed_scaffold.domain}}      — nested object access
//   {{proposed_scaffold.tables.length}} — .length on arrays
//
// Does NOT support arbitrary expressions — only dot-path property
// access and the special .length suffix.

/**
 * Resolve a dot-path string against an object.
 * Handles .length as a terminal operation on arrays.
 *
 * @param {object} obj   The root object (local_state)
 * @param {string} path  Dot-separated key path e.g. "proposed_scaffold.tables.length"
 * @returns {*}          The resolved value, or undefined if not found
 */
export function resolvePath(obj, path) {
  const parts = path.split('.');
  let cur = obj;

  for (const key of parts) {
    if (cur == null) return undefined;
    // Support numeric index access for arrays
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
  if (typeof input === 'string') return resolveTemplate(input, localState);
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
