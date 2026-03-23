// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/classify-intent.mjs
// Handles POST /api/v1/proc/classify-intent
//         SQS  CLASSIFY_INTENT
//
// Intent Preprocessor — three-tier classification pipeline.
// See architecture Section 6.4 for full design.
//
// Tier 1 — coded logic (zero LLM cost):
//   Pass 1a: regex match against PGC_IntentMap rows
//   Pass 1b: alias token match against PGC_DomainHelp rows
//   Pass 1c: CRUD verb detection against resolved domain
//
// Tier 2 — cheap LLM classification (perplexity/sonar via LLM_CHAT_URL)
//
// Tier 3 — heavy lift handoff:
//   Routes to CREATE_DOMAIN, CREATE_WORKFLOW, or WORKFLOW_NOTIFY
//
// Transport-agnostic — req.source ('http' | 'sqs') determines response path only.
// All business logic is identical for both transports.

import { ok, err }             from '../shared/lambda-utils.mjs';
import { getRows }             from '../shared/serv-client.mjs';
import { enqueueCallback, enqueueWorkflow } from '../shared/sqs-callback.mjs';
import {
  matchIntentMap,
  matchDomainAlias,
  matchCrudVerb,
  buildTier2Prompt,
  resolveTier3Route,
} from './classify-intent-tiers.mjs';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handle(req) {
  const userInput = (req.body?.userInput || '').trim();
  const sessionId = req.body?.sessionId ?? null;
  const callback  = req.callback ?? req.body?.callback ?? null;
  const traceId   = req.traceId  ?? req.correlationId;

  if (!userInput) {
    return err(400, 'userInput is required', traceId);
  }

  console.info('classify-intent: start', { traceId, userInput, sessionId });

  let result;
  try {
    result = await classify(userInput, sessionId, traceId);
  } catch (error) {
    console.error('classify-intent: classification failed', { traceId, error: error.message });
    if (req.source === 'sqs' && callback) {
      await enqueueCallback(callback, {
        type:    'WORKFLOW_NOTIFY',
        traceId,
        message: `Classification failed: ${error.message}`,
      });
      return;
    }
    return err(500, error.message, traceId);
  }

  console.info('classify-intent: result', {
    traceId,
    confidence:    result.confidence,
    intent:        result.intent_category,
    action_type:   result.action_type,
    workflow_name: result.workflow_name ?? null,
    domain:        result.domain ?? null,
  });

  // HTTP path — return result directly for curl testing
  if (req.source === 'http') {
    return ok({ ...result, traceId }, traceId);
  }

  // SQS path — hand off to downstream
  await handoff(result, callback, traceId, userInput);
}

// ---------------------------------------------------------------------------
// Classification pipeline
// ---------------------------------------------------------------------------

async function classify(userInput, sessionId, traceId) {
  // Load PGC_IntentMap and PGC_DomainHelp in parallel — both needed for Tier 1
  const [intentMapResp, domainHelpResp] = await Promise.all([
    getRows('PGC_IntentMap'),
    getRows('PGC_DomainHelp'),
  ]);

  if (intentMapResp.statusCode !== 200) {
    throw new Error(`PGC_IntentMap read failed: ${intentMapResp.error || intentMapResp.statusCode}`);
  }
  if (domainHelpResp.statusCode !== 200) {
    throw new Error(`PGC_DomainHelp read failed: ${domainHelpResp.error || domainHelpResp.statusCode}`);
  }

  const intentRows = intentMapResp.rows ?? [];
  const domainRows = domainHelpResp.rows ?? [];

  // ── Pass 1a — PGC_IntentMap regex ────────────────────────────────────────
  const intentMatch = matchIntentMap(userInput, intentRows);
  if (intentMatch) {
    console.info('classify-intent: Pass 1a match', { pattern: intentMatch.pattern, traceId });
    return {
      intent_category: intentMatch.intent_category,
      action_type:     intentMatch.action_type,
      confidence:      'exact',
      workflow_name:   intentMatch.workflow_id ? intentMatch.intent_category : null,
      workflow_id:     intentMatch.workflow_id ?? null,
      domain:          null,
      ad_hoc_step:     null,
    };
  }

  // ── Pass 1b — PGC_DomainHelp alias ───────────────────────────────────────
  const domainMatch = matchDomainAlias(userInput, domainRows);
  if (domainMatch) {
    console.info('classify-intent: Pass 1b match', { domain: domainMatch.domain, traceId });

    // ── Pass 1c — CRUD verb detection ──────────────────────────────────────
    // Fetch the root table for this domain — try PGC_EntitySchema first,
    // fall back to PGC_Schema (domain tables registered but entity not yet defined).
    const entityResp = await getRows('PGC_EntitySchema', [
      { column: 'entity_name', op: 'like', value: `%${titleCase(domainMatch.domain)}%` },
    ]);

    let rootTable = entityResp.rows?.[0]?.root_table ?? null;

    // Fallback — entity not registered yet, derive root table from PGC_Schema.
    // Root table = the one with no foreign keys (no FK references to other tables).
    if (!rootTable) {
      const schemaResp = await getRows('PGC_Schema', [
        { column: 'domain', op: 'eq', value: domainMatch.domain },
        { column: 'target', op: 'eq', value: 'pgd' },
      ]);
      const tables = schemaResp.rows ?? [];
      // Primary table has empty or null foreign_keys array
      const primary = tables.find(t => !t.foreign_keys || t.foreign_keys.length === 0);
      rootTable = primary?.table_name ?? (tables[0]?.table_name ?? null);
      if (rootTable) {
        console.info('classify-intent: Pass 1c entity fallback via PGC_Schema', {
          domain: domainMatch.domain, rootTable, traceId,
        });
      }
    }

    if (rootTable) {
      const crudMatch = matchCrudVerb(userInput, domainMatch, rootTable);
      if (crudMatch) {
        console.info('classify-intent: Pass 1c match', {
          action: crudMatch.action, domain: domainMatch.domain, traceId,
        });
        return {
          intent_category: `${crudMatch.action}_${domainMatch.domain}`,
          action_type:     'crud',
          confidence:      'crud',
          workflow_name:   null,
          workflow_id:     null,
          domain:          domainMatch.domain,
          ad_hoc_step:     crudMatch.adHocStep,
        };
      }
    }

    // Domain resolved but no CRUD verb — fall to Tier 2 with domain hint
    return await tier2(userInput, domainMatch.domain, intentRows, traceId);
  }

  // ── Tier 2 — no Tier 1 match ─────────────────────────────────────────────
  return await tier2(userInput, null, intentRows, traceId);
}

// ---------------------------------------------------------------------------
// Tier 2 — cheap sonar classification
// ---------------------------------------------------------------------------

async function tier2(userInput, domainHint, intentRows, traceId) {
  // Load all workflow names so sonar can match against them
  const workflowResp = await getRows('PGC_Workflow');
  const workflowNames = (workflowResp.rows ?? []).map(r => r.name);

  const messages = buildTier2Prompt(userInput, domainHint, workflowNames);

  console.info('classify-intent: Tier 2 sonar call', { traceId, domainHint });

  const llmKey = process.env.LLM_API_KEY;
  if (!llmKey) throw new Error('LLM_API_KEY env var not set');

  const response = await fetch(process.env.LLM_CHAT_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${llmKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:       'sonar',
      messages,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tier 2 LLM error ${response.status}: ${text}`);
  }

  const data    = await response.json();
  const rawText = data.choices?.[0]?.message?.content ?? '';

  if (!rawText) throw new Error('Tier 2 LLM returned empty response');

  let parsed;
  try {
    const clean = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(clean);
  } catch (error) {
    throw new Error(`Tier 2 LLM returned invalid JSON: ${error.message}`);
  }

  const { intent_category, workflow_name, action_type } = parsed;

  console.info('classify-intent: Tier 2 result', {
    traceId, intent_category, workflow_name, action_type,
  });

  // Heavy lift — route to Tier 3
  if (action_type === 'heavy_lift' || (!workflow_name && action_type !== 'crud')) {
    return {
      intent_category: intent_category ?? 'unknown',
      action_type:     'heavy_lift',
      confidence:      'heavy_lift',
      workflow_name:   null,
      workflow_id:     null,
      domain:          domainHint,
      ad_hoc_step:     null,
    };
  }

  // Named workflow matched
  if (workflow_name) {
    // Look up workflow_id from the rows we already loaded
    const workflowResp2 = await getRows('PGC_Workflow', [
      { column: 'name', op: 'eq', value: workflow_name },
    ]);
    const workflowId = workflowResp2.rows?.[0]?.id ?? null;

    return {
      intent_category: intent_category ?? workflow_name,
      action_type:     'workflow',
      confidence:      'llm_classified',
      workflow_name,
      workflow_id:     workflowId,
      domain:          domainHint,
      ad_hoc_step:     null,
    };
  }

  // CRUD — no rootTable available at this point, ad_hoc_step cannot be built
  return {
    intent_category: intent_category ?? 'unknown',
    action_type:     'crud',
    confidence:      'llm_classified',
    workflow_name:   null,
    workflow_id:     null,
    domain:          domainHint,
    ad_hoc_step:     null,
  };
}

// ---------------------------------------------------------------------------
// SQS handoff — route result to downstream
// ---------------------------------------------------------------------------

async function handoff(result, callback, traceId, userInput) {
  // Named workflow matched — enqueue WORKFLOW_STEP execute_top
  if (result.action_type === 'workflow' && result.workflow_id) {
    await enqueueWorkflow({
      type:          'WORKFLOW_STEP',
      action:        'execute_top',
      workflowRunId: null,          // run-workflow.mjs creates the PGC_WorkflowRun row
      workflowId:    result.workflow_id,
      userInput,
      traceId,
      callback,
    });
    return;
  }

  // CRUD — ad_hoc_step built but not yet executable (Phase 3)
  if (result.action_type === 'crud') {
    const domainText = result.domain ? ` in your ${result.domain} domain` : '';
    await enqueueCallback(callback, {
      type:    'WORKFLOW_NOTIFY',
      traceId,
      message: `I understood you want to ${result.intent_category.replace(/_/g, ' ')}${domainText}. CRUD execution coming in Phase 3.`,
    });
    return;
  }

  // Heavy lift — Tier 3 routing
  if (result.action_type === 'heavy_lift') {
    const { sqsType, notifyText } = resolveTier3Route(result.intent_category);

    if (sqsType === 'WORKFLOW_NOTIFY') {
      await enqueueCallback(callback, {
        type:    'WORKFLOW_NOTIFY',
        traceId,
        message: notifyText,
      });
      return;
    }

    // CREATE_DOMAIN or CREATE_WORKFLOW — forward to existing entry points
    await enqueueWorkflow({
      type:      sqsType,
      userInput,
      traceId,
      callback,
    });
    return;
  }

  // Fallback — should not be reached
  console.warn('classify-intent: unhandled result in handoff', { result, traceId });
  if (callback) {
    await enqueueCallback(callback, {
      type:    'WORKFLOW_NOTIFY',
      traceId,
      message: 'I was not sure how to handle that. Try rephrasing or use /create-workflow.',
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
