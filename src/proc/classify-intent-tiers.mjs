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
 * Detect a CRUD verb in userInput against a resolved domain.
 * Returns an ad_hoc_step definition if matched, or null.
 *
 * The ad_hoc_step is built but not yet executed — execution requires
 * serv_query/serv_update/serv_delete step types (Phase 3).
 *
 * @param {string} userInput    Raw user input
 * @param {object} domainRow    Matched PGC_DomainHelp row — needs { domain }
 * @param {string} rootTable    PGD root table name for this domain from PGC_EntitySchema
 * @returns {{ action: string, stepType: string, adHocStep: object }|null}
 */
export function matchCrudVerb(userInput, domainRow, rootTable) {
  const input = userInput.toLowerCase();

  for (const pattern of CRUD_PATTERNS) {
    for (const verb of pattern.verbs) {
      if (input.includes(verb)) {
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
 * @returns {object[]}  messages array for chat completions body
 */
export function buildTier2Prompt(userInput, domainHint, workflowNames) {
  const knownWorkflows = workflowNames.length > 0
    ? `Known workflows: ${workflowNames.join(', ')}.`
    : 'No named workflows are registered yet.';

  const domainContext = domainHint
    ? `The user is working with the "${domainHint}" domain.`
    : '';

  const system = [
    'You are an intent classifier for a personal automation system.',
    'Classify the user input and return JSON only — no prose, no markdown fences.',
    knownWorkflows,
    domainContext,
    '',
    'Return exactly this shape:',
    '{',
    '  "intent_category": "<string>",',
    '  "workflow_name": "<workflow name from the known list, or null>",',
    '  "action_type": "crud" | "workflow" | "heavy_lift"',
    '}',
    '',
    'Rules:',
    '- If the input matches a known workflow name, set action_type = "workflow" and workflow_name = that name.',
    '- If the input is a data operation (list, add, update, delete, find) on a personal domain, set action_type = "crud".',
    '- If the input requires building something new (new domain, new workflow, new capability), set action_type = "heavy_lift".',
    '- intent_category should be a short snake_case label e.g. "list_recipes", "meal_planner", "create_domain".',
    '- workflow_name must be null unless it exactly matches a name from the known workflows list.',
  ].join('\n');

  return [
    { role: 'system',    content: system    },
    { role: 'user',      content: userInput },
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
