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
//   Step 3: CRUD verb fallback for field=value structured input
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
 * @param {string}   userInput   Lowercased user input
 * @param {object[]} intentRows  PGC_IntentMap rows — each has { pattern, intent_category, action_type }
 * @returns {object|null}
 */
export function matchIntentMap(userInput, intentRows) {
  const input = userInput.toLowerCase();

  // Sort defensively: prefer rows with action_type='workflow' over crud/heavy_lift
  // rows with the same pattern. workflow_id is no longer a routing signal —
  // action_type alone determines priority. Within each tier, lower id wins.
  const sorted = [...intentRows].sort((a, b) => {
    const aScore = a.action_type === 'workflow'    ? 0
                 : a.action_type === 'heavy_lift'  ? 1
                 : 2;  // crud or anything else
    const bScore = b.action_type === 'workflow'    ? 0
                 : b.action_type === 'heavy_lift'  ? 1
                 : 2;
    if (aScore !== bScore) return aScore - bScore;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  for (const row of sorted) {
    try {
      const regex = new RegExp(row.pattern, 'i');
      if (regex.test(input)) {
        return row;
      }
    } catch (err) {
      // Malformed regex in PGC_IntentMap — skip and log; do not crash classification
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
 * Also matches against the domain name itself — "recipes" always matches
 * the recipes domain even if it is not explicitly listed in aliases.
 * Returns the first matching domain row, or null.
 *
 * Matching is case-insensitive substring — alias "portfolio" matches
 * "my stock portfolio tracker" without requiring exact word boundaries.
 *
 * @param {string}   userInput    Raw user input
 * @param {object[]} domainRows   PGC_DomainHelp rows — each has { domain, aliases }
 * @returns {object|null}
 */
export function matchDomainAlias(userInput, domainRows) {
  const input = userInput.toLowerCase();
  for (const row of domainRows) {
    // Domain name is always an implicit alias — checked first
    if (input.includes(row.domain.toLowerCase())) {
      return row;
    }
    const aliases = Array.isArray(row.aliases) ? row.aliases : [];
    for (const alias of aliases) {
      if (input.includes(alias.toLowerCase())) {
        return row;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pass 2 — step 2: workflow keyword scan
// ---------------------------------------------------------------------------

/**
 * Scan PGC_Workflow rows for a domain and test each workflow's intent_keywords
 * array for token presence in userInput. Returns the best-matching workflow
 * name and an optional search_term for retrieval workflows.
 *
 * Disambiguation rule: when multiple workflows match (e.g. both list_<domain>
 * and get_<domain> share a keyword like "show"), get_<domain> wins when the
 * input contains tokens beyond the verb and domain name — those extra tokens
 * indicate a search term rather than a broad list request.
 *
 * @param {string}   userInput       Raw user input (lowercased internally)
 * @param {string}   domain          Resolved domain name, e.g. "recipes"
 * @param {object[]} workflowRows    All PGC_Workflow rows — filtered by domain internally
 * @returns {{ workflow_name: string, search_term: string|null } | null}
 */
export function matchWorkflowByKeywords(userInput, domain, workflowRows) {
  const input = userInput.toLowerCase();
  const domainWorkflows = workflowRows.filter(r => r.domain === domain);

  if (domainWorkflows.length === 0) return null;

  const matches = [];
  for (const wf of domainWorkflows) {
    const keywords = Array.isArray(wf.intent_keywords) ? wf.intent_keywords : [];
    for (const keyword of keywords) {
      // Token presence — keyword must appear as a word boundary match to avoid
      // "add" matching inside "addition" or "address"
      const pattern = new RegExp(`\\b${keyword.toLowerCase()}\\b`);
      if (pattern.test(input)) {
        matches.push(wf);
        break; // one keyword is enough to count this workflow as a candidate
      }
    }
  }

  if (matches.length === 0) return null;

  // Disambiguation: if get_<domain> is among the candidates AND the input has
  // tokens beyond the verb+domain pair, prefer get_<domain> — those extra
  // tokens are a search term, not a list intent.
  const getWorkflow = matches.find(wf => wf.name === `get_${domain}`);
  const searchTerm  = extractSearchTerm(userInput, domain);

  if (getWorkflow && searchTerm) {
    return { workflow_name: getWorkflow.name, search_term: searchTerm };
  }

  // Prefer the first match in registration order (lower id = earlier seeded)
  const best = matches.sort((a, b) => (a.id ?? 0) - (b.id ?? 0))[0];

  // Populate search_term for any retrieval workflow that matched
  const isRetrieval = best.name.startsWith('get_') || best.name.startsWith('search_');
  return {
    workflow_name: best.name,
    search_term:   isRetrieval && searchTerm ? searchTerm : null,
  };
}

// ---------------------------------------------------------------------------
// Pass 2 — step 2 helper: search term extraction
// ---------------------------------------------------------------------------

/**
 * Extract the search term from a retrieval-intent user input by stripping
 * the leading verb tokens and the domain name.
 *
 * e.g. "get my recipes sweet potato chili"  → "sweet potato chili"
 *      "show recipes pasta carbonara"        → "pasta carbonara"
 *      "find my stock_portfolio AAPL"        → "AAPL"
 *      "show all my recipes"                 → null  (no extra tokens)
 *
 * Returns null when no meaningful search term remains after stripping.
 *
 * @param {string} userInput   Raw user input
 * @param {string} domain      Resolved domain name, e.g. "recipes"
 * @returns {string|null}
 */
export function extractSearchTerm(userInput, domain) {
  // Strip leading retrieval verb, optional quantifier, optional "my", then domain
  const domainPattern = domain.replace(/_/g, '[_\\s]+');
  const stripped = userInput
    .replace(
      new RegExp(
        `^\\s*(?:get|show|find|fetch|display|look\\s+up|search(?:\\s+for)?)\\s+` +
        `(?:all\\s+)?(?:my\\s+)?(?:${domainPattern})[s]?\\s*`,
        'i'
      ),
      ''
    )
    .trim();

  return stripped.length > 0 ? stripped : null;
}

// ---------------------------------------------------------------------------
// Pass 2 — step 3: CRUD verb detection (fallback for field=value input)
// ---------------------------------------------------------------------------

// Ordered by specificity — longer phrases before single words to avoid
// "update" matching before "show" in inputs like "show me updates".
const CRUD_PATTERNS = [
  { verbs: ['list', 'show me', 'get all', 'find all'], action: 'list',   stepType: 'serv_query'  },
  { verbs: ['show', 'find', 'get', 'fetch'],           action: 'list',   stepType: 'serv_query'  },
  { verbs: ['add', 'create', 'insert', 'new'],         action: 'insert', stepType: 'serv_insert' },
  { verbs: ['update', 'edit', 'change', 'modify'],     action: 'update', stepType: 'serv_update' },
  { verbs: ['delete', 'remove', 'drop'],               action: 'delete', stepType: 'serv_delete' },
];

/**
 * Returns true if userInput contains any CRUD verb from CRUD_PATTERNS.
 * Used by classify-intent.mjs to detect CRUD intent when Pass 2 finds no
 * domain match, so we can short-circuit with an instructive error rather
 * than burning a Tier 2 LLM call.
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
 * For non-delete verbs: returns the ad_hoc_step immediately on match.
 *
 * For delete verbs: requires an explicit ID in the input.
 *   Accepted formats: "id=42", "id= 42", "id 42", "id:42"
 *   - ID found    → returns ad_hoc_step with id filter pre-populated
 *   - ID missing  → returns { action: 'delete', ambiguous: true }
 *                   so classify-intent.mjs can return an instructive error
 *                   without falling through to Tier 2
 *
 * Returns null if no CRUD verb matched at all.
 *
 * @param {string} userInput    Raw user input
 * @param {object} domainRow    Matched PGC_DomainHelp row — needs { domain }
 * @param {string} rootTable    PGD root table name for this domain
 * @returns {{ action: string, stepType: string, adHocStep: object }
 *         | { action: 'delete', ambiguous: true }
 *         | { action: 'update', ambiguous: true, reason: 'no_id' | 'no_fields' }
 *         | null}
 */
export function matchCrudVerb(userInput, domainRow, rootTable) {
  const input = userInput.toLowerCase();

  for (const pattern of CRUD_PATTERNS) {
    for (const verb of pattern.verbs) {
      if (input.includes(verb)) {

        // Insert requires at least one field=value pair.
        // Accepted format: field=value  field="multi word value"
        // Rule: Pass 2 CRUD fallback claims insert intent ONLY when field=value
        // pairs are present. Without them, return ambiguous: true so
        // classify-intent.mjs yields to Tier 2 — which can route to a registered
        // add_<domain> workflow. Do NOT return crud_ambiguous here.
        if (pattern.action === 'insert') {
          const row = parseFieldValues(userInput);
          if (Object.keys(row).length === 0) {
            return { action: 'insert', ambiguous: true };
          }
          return {
            action:   'insert',
            stepType: 'serv_insert',
            adHocStep: {
              type:  'serv_insert',
              input: {
                tableName: rootTable,
                row,
              },
            },
          };
        }

        // Delete requires an explicit ID — formats: id=42  id= 42  id 42  id:42
        if (pattern.action === 'delete') {
          const idMatch = userInput.match(/\bid\s*[=:]\s*(\d+)\b/i)
                       ?? userInput.match(/\bid\s+(\d+)\b/i);
          if (!idMatch) {
            return { action: 'delete', ambiguous: true };
          }
          const id = parseInt(idMatch[1], 10);
          return {
            action:   'delete',
            stepType: 'serv_delete',
            adHocStep: {
              type:  'serv_delete',
              input: {
                tableName: rootTable,
                filters:   [{ column: 'id', op: 'eq', value: id }],
              },
            },
          };
        }

        // Update requires both an explicit ID and at least one field=value pair.
        // Missing ID → ambiguous with reason 'no_id'
        // Missing fields → ambiguous with reason 'no_fields'
        if (pattern.action === 'update') {
          const idMatch = userInput.match(/\bid\s*[=:]\s*(\d+)\b/i)
                       ?? userInput.match(/\bid\s+(\d+)\b/i);
          if (!idMatch) {
            return { action: 'update', ambiguous: true, reason: 'no_id' };
          }
          const updates = parseFieldValues(userInput);
          // Remove 'id' from updates if the user included it — id is filter only
          delete updates.id;
          if (Object.keys(updates).length === 0) {
            return { action: 'update', ambiguous: true, reason: 'no_fields' };
          }
          const id = parseInt(idMatch[1], 10);
          return {
            action:   'update',
            stepType: 'serv_update',
            adHocStep: {
              type:  'serv_update',
              input: {
                tableName: rootTable,
                filters:   [{ column: 'id', op: 'eq', value: id }],
                updates,
              },
            },
          };
        }

        // All other verbs (list/show) — return step without filters
        return {
          action:   pattern.action,
          stepType: pattern.stepType,
          adHocStep: {
            type:  pattern.stepType,
            input: {
              tableName: rootTable,
            },
          },
        };
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
 * Called by classify-intent.mjs before the fetch to LLM_CHAT_URL.
 *
 * Returns the messages array for the chat completions API.
 *
 * @param {string}      userInput       Raw user input
 * @param {string|null} domainHint      Resolved domain name from Pass 2, or null
 * @param {string[]}    workflowNames   All workflow names from PGC_Workflow — sonar picks from this list
 * @param {string}      promptText      System prompt text from PGC_Prompt.prompt_text
 * @returns {object[]}  messages array for chat completions body
 */
export function buildTier2Prompt(userInput, domainHint, workflowNames, promptText) {
  const knownWorkflows = workflowNames.length > 0
    ? `Known workflows: ${workflowNames.join(', ')}.`
    : 'No named workflows are registered yet.';

  const domainContext = domainHint
    ? `The user is working with the "${domainHint}" domain.`
    : '';

  // Inject runtime context into the stored prompt text using {{variable}} substitution
  const system = promptText
    .replace('{{knownWorkflows}}', knownWorkflows)
    .replace('{{domainContext}}', domainContext);

  return [
    { role: 'system', content: system    },
    { role: 'user',   content: userInput },
  ];
}

// ---------------------------------------------------------------------------
// Tier 3 — heavy lift routing decision
// ---------------------------------------------------------------------------

/**
 * Given a Tier 2 heavy_lift result, determine the downstream SQS message type.
 *
 * @param {string} intentCategory   From Tier 2 response
 * @returns {{ sqsType: string, notifyText: string|null }}
 *   sqsType is the SQS message type to enqueue, or 'WORKFLOW_NOTIFY' for unknowns.
 *   notifyText is non-null only when sqsType is WORKFLOW_NOTIFY.
 */
export function resolveTier3Route(intentCategory) {
  if (/create.domain|new.domain|build.domain/i.test(intentCategory)) {
    return { sqsType: 'CREATE_DOMAIN', notifyText: null };
  }
  if (/create.workflow|new.workflow/i.test(intentCategory)) {
    return { sqsType: 'CREATE_WORKFLOW', notifyText: null };
  }
  return {
    sqsType:    'WORKFLOW_NOTIFY',
    notifyText: 'I understood this but have no workflow for it yet. Use /create-workflow to build one.',
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse field=value pairs from a user input string.
 * Supports:
 *   name=Eggs Benedict          → { name: 'Eggs Benedict' }  (unquoted, space-terminated by next key=)
 *   name="Eggs Benedict"        → { name: 'Eggs Benedict' }  (double-quoted)
 *   name='Eggs Benedict'        → { name: 'Eggs Benedict' }  (single-quoted)
 *   servings=4                  → { servings: '4' }
 *
 * All values are returned as strings — SERV and PostgreSQL handle type coercion.
 * System columns (id, created_at, updated_at) are excluded even if provided.
 *
 * @param {string} userInput
 * @returns {object}  Plain object of field→value pairs, may be empty
 */
function parseFieldValues(userInput) {
  const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);
  const row = {};

  // Match: word=  optionally followed by quoted or unquoted value
  // Quoted:   field="value with spaces"  or  field='value with spaces'
  // Unquoted: field=value  (terminates at next word= or end of string)
  const pattern = /(\w+)\s*=\s*(?:"([^"]*?)"|'([^']*?)'|([^=\s]+(?:\s+(?!\w+=)[^=\s]+)*))/g;
  let match;
  while ((match = pattern.exec(userInput)) !== null) {
    const key   = match[1];
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!SYSTEM_COLS.has(key) && value !== '') {
      row[key] = value;
    }
  }
  return row;
}
