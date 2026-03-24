// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/classify-intent-tiers.mjs
//
// Pure classification functions — no I/O, no imports, directly unit-testable.
// Called by classify-intent.mjs which owns all DB reads and SQS writes.
//
// Tier 1 — coded logic (zero LLM cost):
//   Pass 1a: regex test against PGC_IntentMap rows
//   Pass 1b: alias token scan against PGC_DomainHelp rows
//   Pass 1c: CRUD verb detection against resolved domain
//
// Tier 2 — cheap LLM classification (perplexity/sonar via LLM_CHAT_URL)
//   Called by classify-intent.mjs — this module builds the prompt only.
//
// Tier 3 — heavy lift handoff (no LLM call)
//   Routes to create_domain or create_workflow entry points.

// ---------------------------------------------------------------------------
// Tier 1a — PGC_IntentMap regex match
// ---------------------------------------------------------------------------

/**
 * Test userInput against all PGC_IntentMap pattern rows.
 * Returns the first matching row, or null if nothing matched.
 *
 * @param {string}   userInput   Lowercased user input
 * @param {object[]} intentRows  PGC_IntentMap rows — each has { pattern, intent_category, action_type, workflow_id }
 * @returns {object|null}
 */
export function matchIntentMap(userInput, intentRows) {
  const input = userInput.toLowerCase();
  for (const row of intentRows) {
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
// Tier 1b — PGC_DomainHelp alias match
// ---------------------------------------------------------------------------

/**
 * Tokenise userInput and scan every domain's aliases array for a match.
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
// Tier 1c — CRUD verb detection
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
 * Used by classify-intent.mjs to detect CRUD intent before falling to Tier 2
 * when Pass 1b found no domain match.
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


 *
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
 *         | null}
 */
export function matchCrudVerb(userInput, domainRow, rootTable) {
  const input = userInput.toLowerCase();

  for (const pattern of CRUD_PATTERNS) {
    for (const verb of pattern.verbs) {
      if (input.includes(verb)) {

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

        // All other verbs — return step without filters (list/show queries
        // return all rows; insert/update are handled by Tier 2 or full workflow)
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
 * @param {string|null} domainHint      Resolved domain name from Pass 1b, or null
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
