// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/memory-client.mjs
//
// Memory retrieval for the LLM harness.
// Provides scope expansion, client-side candidate filtering, budget-aware
// selection, and prompt block formatting.
//
// Retrieval issues one targeted query per expanded scope level — memory_type
// and scope containment are pushed server-side via SERV's `in` and
// `jsonb_contained_by` filter operators, so unrelated rows (other domains,
// other memory types) never compete for a shared row-count limit. Results
// are merged and deduplicated by id, then expiry + tags are re-checked
// client-side on the now-small candidate set.

import { getRows } from '../shared/serv-client.mjs';

// ---------------------------------------------------------------------------
// Scope expansion
// ---------------------------------------------------------------------------

/**
 * Expand a call scope into all parent scope levels for retrieval.
 * Returns scopes from most-specific to least-specific, deduplicated.
 *
 * For {"domain":"Recipes","workflow":"add_recipe"} returns:
 *   [{"domain":"Recipes","workflow":"add_recipe"}, {"domain":"Recipes"},
 *    {"topic":"conventions"}, {}]
 *
 * @param {object}  scope          Call scope (e.g. {domain, workflow})
 * @param {boolean} includePersona Include {"topic":"persona"} level (chat calls)
 * @returns {object[]}             Ordered scope levels, most specific first
 */
export function expandScope(scope, includePersona = false) {
  const seen = new Set();
  const result = [];

  const add = (s) => {
    const key = JSON.stringify(
      Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b)))
    );
    if (!seen.has(key)) {
      seen.add(key);
      result.push(s);
    }
  };

  // Most specific first
  add(scope);

  // Strip one dimension for compound scopes
  const { domain, workflow, topic } = scope;
  if (domain && workflow) add({ domain });
  if (domain && topic && topic !== 'conventions' && topic !== 'persona') add({ domain });

  // Persona for chat calls
  if (includePersona) add({ topic: 'persona' });

  // Cross-cutting conventions always
  add({ topic: 'conventions' });

  // Global always last
  add({});

  return result;
}

// ---------------------------------------------------------------------------
// Scope reachability
// ---------------------------------------------------------------------------

/**
 * Returns true if memScope is a subset of any scope in expandedScopes.
 * An empty memScope ({}) is a subset of everything (global — always matches).
 */
function scopeIsReachable(memScope, expandedScopes) {
  const memKeys = Object.keys(memScope ?? {});
  if (memKeys.length === 0) return true;
  return expandedScopes.some(expScope =>
    memKeys.every(k => expScope[k] === memScope[k])
  );
}

// ---------------------------------------------------------------------------
// Memory block formatting
// ---------------------------------------------------------------------------

/**
 * Format retrieved memory rows into a system-prompt injection block.
 * Returns an empty string when memories is empty.
 *
 * @param {object[]} memories  Sorted, budget-selected PGC_Memory rows
 * @returns {string}
 */
export function formatMemoryBlock(memories) {
  if (!memories?.length) return '';

  const byType = {};
  for (const m of memories) {
    (byType[m.memory_type] ??= []).push(m);
  }

  const typeLabels = {
    procedural: 'Workflow design intent',
    semantic:   'Domain design decisions and conventions',
    episodic:   'Recent activity',
  };

  const lines = ['--- MEMORY ---'];
  for (const type of ['procedural', 'semantic', 'episodic']) {
    const items = byType[type];
    if (!items?.length) continue;
    lines.push('');
    lines.push(`[${typeLabels[type]}]`);
    for (const m of items) {
      lines.push(`- ${m.content}`);
    }
  }
  lines.push('');
  lines.push('--- END MEMORY ---');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve and rank memories for a LLM call.
 *
 * Performs scope expansion, client-side filtering (scope, expiry, tags),
 * priority/type ordering, and budget-aware greedy selection.
 *
 * @param {object}   opts
 * @param {object}   opts.scope          Call scope (e.g. {domain, workflow})
 * @param {string[]} opts.tags           Required tags filter (null = no filter)
 * @param {number}   opts.budgetTokens   Max tokens for selected memories
 * @param {string[]} opts.memoryTypes    Which memory_type values to include
 * @param {string}   opts.callContext    'generation' | 'chat' — affects type ordering
 * @param {Function} opts._getRows       Injectable for unit tests (default: getRows)
 * @returns {Promise<object[]>}          Selected PGC_Memory rows
 */
export async function retrieveMemories({
  scope = {},
  tags = null,
  budgetTokens = 500,
  memoryTypes = ['episodic', 'semantic', 'procedural'],
  callContext = 'generation',
  _getRows = getRows,
} = {}) {
  if (budgetTokens <= 0) return [];

  const includePersona = callContext === 'chat';
  const expandedScopes = expandScope(scope, includePersona);
  const typeSet = new Set(memoryTypes);
  const now = Date.now();

  const byId = new Map();
  for (const candidateScope of expandedScopes) {
    const resp = await _getRows(
      'PGC_Memory',
      [
        { column: 'memory_type', op: 'in', value: memoryTypes },
        { column: 'scope', op: 'jsonb_contained_by', value: candidateScope },
      ],
      { column: 'priority', direction: 'asc' },
      500,
    );
    if (!resp.success || !resp.rows?.length) continue;
    for (const row of resp.rows) byId.set(row.id, row);
  }

  const candidates = [...byId.values()].filter(row => {
    if (!typeSet.has(row.memory_type)) return false;
    if (row.expires_at && new Date(row.expires_at).getTime() <= now) return false;
    if (!scopeIsReachable(row.scope ?? {}, expandedScopes)) return false;
    if (tags?.length > 0) {
      const rowTags = Array.isArray(row.tags) ? row.tags : [];
      if (!tags.every(t => rowTags.includes(t))) return false;
    }
    return true;
  });

  // Sort: priority ASC, memory_type precedence (varies by callContext), created_at DESC
  const typeOrder = callContext === 'chat'
    ? { episodic: 0, semantic: 1, procedural: 2 }
    : { procedural: 0, semantic: 1, episodic: 2 };

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const ta = typeOrder[a.memory_type] ?? 3;
    const tb = typeOrder[b.memory_type] ?? 3;
    if (ta !== tb) return ta - tb;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Budget-aware greedy selection — skip any memory that doesn't fit and keep
  // trying smaller/lower-priority ones, rather than stopping at the first miss.
  // A single oversized high-priority memory must not block everything behind it.
  const selected = [];
  let usedTokens = 0;
  for (const row of candidates) {
    const est = row.token_estimate ?? 0;
    if (usedTokens + est > budgetTokens) continue;
    selected.push(row);
    usedTokens += est;
  }

  return selected;
}
