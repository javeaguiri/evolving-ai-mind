// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/classify-intent-tiers.mjs
//
// Pure classification functions — no I/O, no imports, directly unit-testable.
// Called by classify-intent.mjs which owns all DB reads and SQS writes.
//
// Pass 1 — PGC_IntentMap regex match (zero LLM)
//
// Pass 2 — Domain-Workflow Lookup (zero LLM):
//   Step 1: alias token scan against PGC_DomainHelp rows
//   Step 2: workflow keyword scan against PGC_Workflow.intent_keywords
//
// Phase B — direct table operations (PGC_*/PGD_* prefix path):
//   hasTablePrefix, extractTableName, hasCrudVerb, matchCrudVerb
//
// Tier 2 — cheap LLM classification (perplexity/sonar via LLM_CHAT_URL)
//   Called by classify-intent.mjs — this module builds the prompt only.
//
// Tier 3 — heavy lift handoff (no LLM call)
//   Routes to create_domain or create_workflow entry points.

// ---------------------------------------------------------------------------
// Pass 1 — PGC_IntentMap regex match
// ---------------------------------------------------------------------------

/**
 * Test userInput against all PGC_IntentMap pattern rows.
 * Returns the first matching row, or null if nothing matched.
 *
 * Sort order: workflow > heavy_lift > crud; lower id wins within each tier.
 * workflow_id is not a routing signal — action_type alone determines priority.
 *
 * @param {string}   userInput   Raw user input
 * @param {object[]} intentRows  PGC_IntentMap rows — each has { id, pattern, intent_category, action_type }
 * @returns {object|null}
 */
export function matchIntentMap(userInput, intentRows) {
  const input = userInput.toLowerCase();

  const sorted = [...intentRows].sort((a, b) => {
    const aScore = a.action_type === 'workflow'   ? 0
                 : a.action_type === 'heavy_lift' ? 1
                 : 2;
    const bScore = b.action_type === 'workflow'   ? 0
                 : b.action_type === 'heavy_lift' ? 1
                 : 2;
    if (aScore !== bScore) return aScore - bScore;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  for (const row of sorted) {
    try {
      if (new RegExp(row.pattern, 'i').test(input)) return row;
    } catch (err) {
      console.warn('classify-intent-tiers: invalid regex in PGC_IntentMap', {
        pattern: row.pattern,
        error:   err.message,
      });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pass 2 — step 1: PGC_DomainHelp alias match
// ---------------------------------------------------------------------------

/**
 * Tokenise userInput and scan every domain's aliases array for a match.
 * Also matches against the domain name itself as an implicit alias.
 * Matching is case-insensitive substring.
 *
 * @param {string}   userInput   Raw user input
 * @param {object[]} domainRows  PGC_DomainHelp rows — each has { domain, aliases }
 * @returns {object|null}        First matching domain row, or null
 */
export function matchDomainAlias(userInput, domainRows) {
  // Scan only the first line — the command prefix (verb + domain) is always there.
  // Body text (recipe descriptions, notes, etc.) can contain common words like
  // "system" that would match unrelated domain aliases if the full input were scanned.
  const input = userInput.split('\n')[0].slice(0, 200).toLowerCase();
  for (const row of domainRows) {
    if (input.includes(row.domain.toLowerCase())) return { ...row, _matched_alias: row.domain };
    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    for (const alias of aliases) {
      if (input.includes(alias.toLowerCase())) return { ...row, _matched_alias: alias };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pass 2 — step 2: workflow keyword scan
// ---------------------------------------------------------------------------

/**
 * Scan PGC_Workflow rows for the resolved domain and test each workflow's
 * intent_keywords array for token presence in userInput.
 *
 * Matching uses word-boundary regex — handles single-token ("get") and
 * multi-word ("look up") keywords while preventing false positives where a
 * keyword appears as a substring inside a longer word (e.g. "list" inside
 * the Spanish word "simplista").
 *
 * Disambiguation: prefer get_entity when search/id tokens present.
 * Tiebreaker: earliest keyword position in input (verb-first), then lowest id.
 *
 * @param {string}   userInput     Raw user input (lowercased internally)
 * @param {string}   domain        Resolved domain name, e.g. "recipes"
 * @param {object[]} workflowRows  All pre-loaded PGC_Workflow rows
 * @returns {{ workflow_name: string, search_term: string|null, record_id: number|null } | null}
 */
export function matchWorkflowByKeywords(userInput, domain, workflowRows, aliases = []) {
  // Scan only the first line for keyword matching — pasted multi-line body text
  // (e.g. a recipe with "find" or "show" in its body) must not influence intent routing.
  const input = userInput.split('\n')[0].slice(0, 200).toLowerCase();
  const domainWorkflows = workflowRows.filter(r => r.domain === domain || r.domain === null);

  if (domainWorkflows.length === 0) return null;

  // Word-boundary keyword test — prevents substring false positives where a keyword
  // appears inside a longer word (e.g. "list" inside the Spanish word "simplista").
  // Non-word chars (spaces, punctuation, newlines) count as boundaries.
  // Multi-word keywords (e.g. "show all") are tested across word sequences.
  function keywordMatchesWordBoundary(keyword, text) {
    const escaped = keyword.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    return new RegExp('(?<![a-z0-9\u00c0-\u024f])' + escaped + '(?![a-z0-9\u00c0-\u024f])', 'i').test(text);
  }

  // For each matching workflow, record the earliest position of any keyword hit
  // so verb-first ordering can be used as the tiebreaker.
  const matches = [];
  for (const wf of domainWorkflows) {
    const keywords = Array.isArray(wf.intent_keywords) ? wf.intent_keywords : [];
    let earliestPos = Infinity;
    for (const keyword of keywords) {
      const kw = keyword.toLowerCase();
      if (keywordMatchesWordBoundary(kw, input)) {
        const idx = input.indexOf(kw);
        if (idx < earliestPos) earliestPos = idx;
      }
    }
    if (earliestPos < Infinity) {
      matches.push({ wf, earliestPos });
    }
  }

  if (matches.length === 0) return null;

  // Disambiguation: prefer get_<domain> or get_entity when search/id tokens present
  const getMatch = matches.find(m => m.wf.name === `get_${domain}` || m.wf.name === 'get_entity');
  const { search_term, record_id } = extractSearchTerm(userInput, [domain, ...aliases]);

  if (getMatch && (search_term || record_id !== null)) {
    return { workflow_name: getMatch.wf.name, search_term, record_id };
  }

  // Primary tiebreaker: earliest keyword position in input (verb-first semantics).
  // Secondary tiebreaker: lowest DB id (stable ordering for equal positions).
  matches.sort((a, b) => a.earliestPos !== b.earliestPos
    ? a.earliestPos - b.earliestPos
    : (a.wf.id ?? 0) - (b.wf.id ?? 0)
  );
  const best = matches[0].wf;
  const isRetrieval = best.name.startsWith('get_') || best.name.startsWith('search_')
                   || best.name === 'get_entity' || best.name === 'search_entity';
  return {
    workflow_name: best.name,
    search_term:   isRetrieval ? search_term : null,
    record_id:     isRetrieval ? record_id   : null,
  };
}

// ---------------------------------------------------------------------------
// Pass 2 — step 2 helper: search term extraction
// ---------------------------------------------------------------------------

/**
 * Extract the search term or record id from a retrieval-intent user input.
 *
 * Strategy:
 *   1. Strip the leading verb + optional quantifiers ("get my", "show all", etc.)
 *   2. Strip the matched domain alias from the front of the remainder — using the
 *      actual alias strings rather than the canonical domain name, so "dish", "dishes",
 *      "food recipes", etc. are all handled correctly.
 *   3. Scan for id=N / id:N (spaces around separator ok) → record_id.
 *   4. Parse explicit field=value pairs (name="…", title=…) → search_term.
 *   5. Treat the entire remainder as an implicit name search.
 *
 * Examples:
 *   aliases = ['recipes','recipe','dish','dishes','meal']
 *   "get my recipes sweet potato chili" → { search_term: "sweet potato chili", record_id: null }
 *   "get dish id=1"                     → { search_term: null, record_id: 1 }
 *   "get dish id = 1"                   → { search_term: null, record_id: 1 }
 *   "get dish SWEET POTATO CHILI"       → { search_term: "SWEET POTATO CHILI", record_id: null }
 *   "get recipe name=\"SWEET POTATO\""  → { search_term: "SWEET POTATO", record_id: null }
 *   "show all my recipes"               → { search_term: null, record_id: null }
 *
 * @param {string}   userInput  Raw user input
 * @param {string[]} aliases    All candidate strings for the domain (domain name + aliases array)
 * @returns {{ search_term: string|null, record_id: number|null }}
 */
export function extractSearchTerm(userInput, aliases) {
  const VERBS = `(?:get|show|find|fetch|display|look\\s+up|search(?:\\s+for)?)`;
  const QUANT = `(?:all\\s+)?(?:my\\s+)?`;

  // Work on first line only — the command is always single-line.
  const firstLine = userInput.split('\n')[0];

  // Step 1: strip leading verb + optional quantifiers.
  const afterVerb = firstLine.replace(new RegExp(`^\\s*${VERBS}\\s+${QUANT}`, 'i'), '').trim();

  // Step 2: strip the matched alias from the front. Sort longest-first so a
  // multi-word alias like "food recipes" beats a shorter prefix like "food".
  // Underscores in alias strings match either underscore or whitespace in the input
  // (e.g. alias "stock_portfolio" matches "stock portfolio").
  let remainder = afterVerb;
  const sortedAliases = [...new Set(aliases)].sort((a, b) => b.length - a.length);
  for (const alias of sortedAliases) {
    const esc = alias.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&').replace(/_/g, '[_\\s]+');
    const stripped = remainder.replace(new RegExp(`^${esc}\\s*`, 'i'), '');
    if (stripped !== remainder) {
      remainder = stripped.trim();
      break;
    }
  }

  if (!remainder) return { search_term: null, record_id: null };

  // Step 3: id=N or id:N anywhere in the remainder (spaces around separator ok).
  const idToken = remainder.match(/\bid\s*[=:]\s*(\d+)\b/i);
  if (idToken) return { search_term: null, record_id: parseInt(idToken[1], 10) };

  // Step 4: explicit field=value pairs — parseFieldValues excludes 'id' (system col).
  const parsed = parseFieldValues(remainder);
  const parsedKeys = Object.keys(parsed);
  if (parsedKeys.length > 0) {
    // Prefer 'name' field; fall back to first parsed field value.
    const val = parsed.name ?? parsed[parsedKeys[0]];
    return { search_term: val ?? null, record_id: null };
  }

  // Step 5: plain text — treat entire remainder as implicit name search.
  return { search_term: remainder, record_id: null };
}

// ---------------------------------------------------------------------------
// Shared input parser — used by classify-intent.mjs handoff() for mutations
// ---------------------------------------------------------------------------

/**
 * Parse field=value pairs from a user input string.
 * Supports:
 *   name=Eggs Benedict          → { name: 'Eggs Benedict' }
 *   name="Eggs Benedict"        → { name: 'Eggs Benedict' }
 *   servings=4                  → { servings: '4' }
 *
 * All values are strings — SERV handles type coercion.
 * System columns (id, created_at, updated_at) are excluded.
 *
 * @param {string} userInput
 * @returns {object}  Plain object of field→value pairs, may be empty
 */
export function parseFieldValues(userInput) {
  const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);
  const row = {};
  const pattern = /(\w+)\s*=\s*(?:"([^"]*?)"|'([^']*?)'|([^=\s]+(?:\s+(?!\w+=)[^=\s]+)*))/g;
  let match;
  while ((match = pattern.exec(userInput)) !== null) {
    const key   = match[1];
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!SYSTEM_COLS.has(key.toLowerCase()) && value !== '') {
      row[key] = value;
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Phase B — direct table operations (PGC_*/PGD_* prefix path)
// ---------------------------------------------------------------------------

// Verb→action→stepType mapping used exclusively by the table-prefix pre-pass.
// Ordered longest-phrase-first to avoid "update" matching before "show" in
// inputs like "show me updates".
const CRUD_PATTERNS = [
  { verbs: ['list', 'show me', 'get all', 'find all'], action: 'list',   stepType: 'serv_query'  },
  { verbs: ['show', 'find', 'get', 'fetch'],           action: 'list',   stepType: 'serv_query'  },
  { verbs: ['add', 'create', 'insert', 'new'],         action: 'insert', stepType: 'serv_insert' },
  { verbs: ['update', 'edit', 'change', 'modify'],     action: 'update', stepType: 'serv_update' },
  { verbs: ['delete', 'remove', 'drop'],               action: 'delete', stepType: 'serv_delete' },
];

/**
 * Returns true if userInput contains a PGC_* or PGD_* table-name token.
 * This is the sole trigger for the direct-table CRUD path (Groups 3–4).
 *
 * @param {string} userInput
 * @returns {boolean}
 */
export function hasTablePrefix(userInput) {
  return /\b(PGC|PGD)_\w+/i.test(userInput);
}

/**
 * Extract the first PGC_* or PGD_* table-name token from userInput.
 * Returns the token in its original casing as provided by the user.
 *
 * @param {string} userInput
 * @returns {string|null}
 */
export function extractTableName(userInput) {
  const match = userInput.match(/\b((?:PGC|PGD)_\w+)/i);
  return match ? match[1] : null;
}

/**
 * Returns true if userInput contains any CRUD verb from CRUD_PATTERNS.
 * Used after Pass 2 domain miss to short-circuit Tier 2 with a helpful
 * error instead of spending a sonar LLM call on an unresolvable intent.
 *
 * @param {string} userInput
 * @returns {boolean}
 */
export function hasCrudVerb(userInput) {
  const input = userInput.toLowerCase();
  for (const pattern of CRUD_PATTERNS) {
    for (const verb of pattern.verbs) {
      if (input.includes(verb)) return true;
    }
  }
  return false;
}

/**
 * Build an ad_hoc_step for a direct table operation.
 * Called only when hasTablePrefix() returned true — tableName is the extracted
 * PGC_ or PGD_ prefixed token. The table name is the complete routing target.
 *
 * List accepts optional field=value filters. Insert requires at least one
 * field=value pair. Delete and update require id=N. Missing required inputs
 * return an ambiguous result so classify-intent.mjs posts an instructive error.
 *
 * @param {string} userInput
 * @param {string} tableName  Extracted table name, e.g. "PGD_Recipes"
 * @returns {{ action: string, stepType: string, adHocStep: object }
 *          | { action: string, ambiguous: true, reason?: string }
 *          | null}
 */
export function matchCrudVerb(userInput, tableName) {
  const input = userInput.toLowerCase();

  for (const pattern of CRUD_PATTERNS) {
    for (const verb of pattern.verbs) {
      if (input.includes(verb)) {

        if (pattern.action === 'list') {
          const fields = parseFieldValues(userInput);
          const filters = Object.entries(fields).map(([column, value]) => ({
            column,
            op: 'eq',
            value,
          }));
          return {
            action:   'list',
            stepType: 'serv_query',
            adHocStep: {
              type:  'serv_query',
              input: { tableName, ...(filters.length > 0 ? { filters } : {}) },
            },
          };
        }

        if (pattern.action === 'insert') {
          const row = parseFieldValues(userInput);
          if (Object.keys(row).length === 0) {
            return { action: 'insert', ambiguous: true };
          }
          return {
            action:   'insert',
            stepType: 'serv_insert',
            adHocStep: { type: 'serv_insert', input: { tableName, row } },
          };
        }

        if (pattern.action === 'delete') {
          const idMatch = userInput.match(/\bid\s*[=:]\s*(\d+)\b/i)
                       ?? userInput.match(/\bid\s+(\d+)\b/i);
          if (!idMatch) return { action: 'delete', ambiguous: true };
          return {
            action:   'delete',
            stepType: 'serv_delete',
            adHocStep: {
              type:  'serv_delete',
              input: { tableName, filters: [{ column: 'id', op: 'eq', value: parseInt(idMatch[1], 10) }] },
            },
          };
        }

        if (pattern.action === 'update') {
          const idMatch = userInput.match(/\bid\s*[=:]\s*(\d+)\b/i)
                       ?? userInput.match(/\bid\s+(\d+)\b/i);
          if (!idMatch) return { action: 'update', ambiguous: true, reason: 'no_id' };
          const updates = parseFieldValues(userInput);
          delete updates.id;
          if (Object.keys(updates).length === 0) {
            return { action: 'update', ambiguous: true, reason: 'no_fields' };
          }
          return {
            action:   'update',
            stepType: 'serv_update',
            adHocStep: {
              type:  'serv_update',
              input: {
                tableName,
                filters: [{ column: 'id', op: 'eq', value: parseInt(idMatch[1], 10) }],
                updates,
              },
            },
          };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 2 — prompt builder for sonar classification
// ---------------------------------------------------------------------------

/**
 * Build the sonar classification prompt.
 * Injects known workflow names and optional domain hint into stored prompt text.
 *
 * @param {string}      userInput      Raw user input
 * @param {string|null} domainHint     Resolved domain name from Pass 2, or null
 * @param {string[]}    workflowNames  All workflow names from pre-loaded PGC_Workflow rows
 * @param {string}      promptText     System prompt text from PGC_Prompt.prompt_text
 * @returns {object[]}  messages array for chat completions body
 */
export function buildTier2Prompt(userInput, domainHint, workflowNames, promptText) {
  const knownWorkflows = workflowNames.length > 0
    ? `Known workflows: ${workflowNames.join(', ')}.`
    : 'No named workflows are registered yet.';

  const domainContext = domainHint
    ? `The user is working with the "${domainHint}" domain.`
    : '';

  const instructions = promptText
    .replace('{{knownWorkflows}}', knownWorkflows)
    .replace('{{domainContext}}', domainContext);

  return { instructions, userMessage: userInput };
}

// ---------------------------------------------------------------------------
// Tier 3 — heavy lift routing decision
// ---------------------------------------------------------------------------

/**
 * Determine the downstream SQS message type for a heavy_lift result.
 *
 * @param {string} intentCategory  From Tier 2 response
 * @returns {{ sqsType: string, notifyText: string|null }}
 */
export function resolveTier3Route(intentCategory) {
  if (/create.domain|new.domain|build.domain/i.test(intentCategory)) {
    return { sqsType: 'CREATE_DOMAIN', notifyText: null };
  }
  if (/create.workflow|new.workflow/i.test(intentCategory)) {
    return { sqsType: 'CREATE_WORKFLOW', notifyText: null };
  }
  if (/delete.domain|remove.domain/i.test(intentCategory)) {
    return { sqsType: 'DELETE_DOMAIN', notifyText: null };
  }
  if (/delete.workflow|remove.workflow/i.test(intentCategory)) {
    return { sqsType: 'DELETE_WORKFLOW', notifyText: null };
  }
  return {
    sqsType:    'HUMAN_NOTIFICATION',
    notifyText: 'I understood this but have no workflow for it yet. Use /create-workflow to build one.',
  };
}
