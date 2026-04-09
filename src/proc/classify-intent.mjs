// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/classify-intent.mjs
// Handles POST /api/v1/proc/classify-intent
//         SQS  CLASSIFY_INTENT
//
// Intent Preprocessor — two-pass, domain-workflow-aware classification pipeline.
// See architecture Section 6.3 and docs/user-intent-use-cases.md.
//
// Pre-pass — PGC_*/PGD_* table-prefix detection → direct serv/table/* (Groups 3–4)
// Pass 1   — PGC_IntentMap regex match → workflow and heavy_lift routes
// Pass 2   — domain alias → workflow keyword scan → workflow route
// Tier 2   — sonar LLM fallback
// Tier 3   — heavy lift routing (no LLM)
//
// Transport-agnostic — req.source ('http' | 'sqs') determines response path only.
// All business logic is identical for both transports.

import { ok, err }                          from '../shared/lambda-utils.mjs';
import { getRows, insertRow, updateRows, deleteRows } from '../shared/serv-client.mjs';
import { enqueueCallback, enqueueWorkflow } from '../shared/sqs-callback.mjs';
import {
  matchIntentMap,
  matchDomainAlias,
  matchWorkflowByKeywords,
  extractSearchTerm,
  parseFieldValues,
  hasTablePrefix,
  extractTableName,
  matchCrudVerb,
  hasCrudVerb,
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

  let result, entitySchemaRows;
  try {
    ({ result, entitySchemaRows } = await classify(userInput, sessionId, traceId));
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
    search_term:   result.search_term ?? null,
    record_id:     result.record_id   ?? null,
  });

  if (req.source === 'http') {
    return ok({ ...result, traceId }, traceId);
  }

  await handoff(result, callback, traceId, userInput, entitySchemaRows);
}

// ---------------------------------------------------------------------------
// Classification pipeline
// ---------------------------------------------------------------------------

async function classify(userInput, sessionId, traceId) {
  // Pre-load all three tables in parallel — all are needed across passes.
  // PGC_Workflow is included so Pass 2 keyword scan and handoff() share the
  // same rows without a second DB round-trip.
  const [intentMapResp, domainHelpResp, workflowResp, entitySchemaResp] = await Promise.all([
    getRows('PGC_IntentMap'),
    getRows('PGC_DomainHelp'),
    getRows('PGC_Workflow'),
    getRows('PGC_EntitySchema'),
  ]);

  if (intentMapResp.statusCode !== 200) {
    throw new Error(`PGC_IntentMap read failed: ${intentMapResp.error || intentMapResp.statusCode}`);
  }
  if (domainHelpResp.statusCode !== 200) {
    throw new Error(`PGC_DomainHelp read failed: ${domainHelpResp.error || domainHelpResp.statusCode}`);
  }
  if (workflowResp.statusCode !== 200) {
    throw new Error(`PGC_Workflow read failed: ${workflowResp.error || workflowResp.statusCode}`);
  }
  if (entitySchemaResp.statusCode !== 200) {
    throw new Error(`PGC_EntitySchema read failed: ${entitySchemaResp.error || entitySchemaResp.statusCode}`);
  }

  const intentRows       = intentMapResp.rows    ?? [];
  const domainRows       = domainHelpResp.rows   ?? [];
  const workflowRows     = workflowResp.rows     ?? [];
  const entitySchemaRows = entitySchemaResp.rows ?? [];

  // Wrap a result object with entitySchemaRows so handle() can pass both to handoff().
  const wrap = result => ({ result, entitySchemaRows });

  // ── Pre-pass — PGC_*/PGD_* table-prefix detection ────────────────────────
  // Short-circuits the entire pipeline. A user who types a raw table name is
  // performing a direct admin or debug operation — never a domain workflow.
  // No DB reads required beyond what is already pre-loaded.
  if (hasTablePrefix(userInput)) {
    const tableName = extractTableName(userInput);
    console.info('classify-intent: pre-pass table prefix detected', { tableName, traceId });
    const crudMatch = matchCrudVerb(userInput, tableName);

    if (!crudMatch) {
      // Table name present but no verb — ambiguous.
      return wrap({
        intent_category: `unknown_${tableName}`,
        action_type:     'crud_ambiguous',
        confidence:      'exact',
        workflow_name:   null,
        domain:          null,
        ad_hoc_step:     null,
        search_term:     null,
        record_id:       null,
        table_name:      tableName,
        ambiguous_reason: 'no_verb',
      });
    }

    if (crudMatch.ambiguous) {
      return wrap({
        intent_category:  `${crudMatch.action}_${tableName}`,
        action_type:      'crud_ambiguous',
        confidence:       'exact',
        workflow_name:    null,
        domain:           null,
        ad_hoc_step:      null,
        search_term:      null,
        record_id:        null,
        table_name:       tableName,
        ambiguous_reason: crudMatch.reason ?? crudMatch.action,
      });
    }

    return wrap({
      intent_category: `${crudMatch.action}_${tableName}`,
      action_type:     'crud',
      confidence:      'exact',
      workflow_name:   null,
      domain:          null,
      ad_hoc_step:     crudMatch.adHocStep,
      search_term:     null,
      record_id:       null,
      table_name:      tableName,
    });
  }

  // ── Pass 1 — PGC_IntentMap regex ─────────────────────────────────────────
  const intentMatch = matchIntentMap(userInput, intentRows);
  if (intentMatch) {
    console.info('classify-intent: Pass 1 match', { pattern: intentMatch.pattern, traceId });

    if (intentMatch.action_type === 'workflow' || intentMatch.action_type === 'heavy_lift') {
      // For generic *_entity intent categories, domain cannot be derived from
      // intent_category — resolve it from userInput via alias lookup instead.
      // For legacy domain-specific categories (get_recipes), derive as before.
      const isGenericEntity = intentMatch.intent_category.endsWith('_entity');
      let domain;
      if (isGenericEntity) {
        const domainMatch = matchDomainAlias(userInput, domainRows);
        domain = domainMatch?.domain ?? null;
      } else {
        // Strip verb prefix — null if result does not match a registered domain
        // (e.g. intent_category 'help' → stripped 'help' → no domain row → null).
        const stripped = intentMatch.intent_category.replace(/^(get|list|add|update|delete|search)_/, '');
        domain = domainRows.some(r => r.domain === stripped) ? stripped : null;
      }

      const isRetrieval = /^(get|search)_/.test(intentMatch.intent_category);
      const { search_term, record_id } = isRetrieval && domain
        ? extractSearchTerm(userInput, domain)
        : { search_term: null, record_id: null };

      return wrap({
        intent_category: intentMatch.intent_category,
        action_type:     intentMatch.action_type,
        confidence:      'exact',
        workflow_name:   intentMatch.action_type === 'workflow' ? intentMatch.intent_category : null,
        domain,
        ad_hoc_step:     null,
        search_term,
        record_id,
      });
    }

    // action_type === 'crud' — Phase B handles direct table operations.
    // For now, fall through to Pass 2 so domain workflows can claim the intent.
    // This means structured inputs like "add my recipes name=Pasta" that matched
    // a crud row in PGC_IntentMap will be re-evaluated by Pass 2 keyword scan
    // and routed to add_recipes workflow if one is registered.
    console.info('classify-intent: Pass 1 crud row — falling to Pass 2 (Phase B deferred)', { traceId });
  }

  // ── Pass 2 — Domain-Workflow Lookup ───────────────────────────────────────
  const domainMatch = matchDomainAlias(userInput, domainRows);
  if (domainMatch) {
    console.info('classify-intent: Pass 2 domain resolved', { domain: domainMatch.domain, traceId });

    const kwMatch = matchWorkflowByKeywords(userInput, domainMatch.domain, workflowRows);
    if (kwMatch) {
      console.info('classify-intent: Pass 2 keyword match', {
        workflow_name: kwMatch.workflow_name,
        search_term:   kwMatch.search_term ?? null,
        record_id:     kwMatch.record_id   ?? null,
        traceId,
      });
      return wrap({
        intent_category: kwMatch.workflow_name,
        action_type:     'workflow',
        confidence:      'keyword_match',
        workflow_name:   kwMatch.workflow_name,
        domain:          domainMatch.domain,
        ad_hoc_step:     null,
        search_term:     kwMatch.search_term ?? null,
        record_id:       kwMatch.record_id   ?? null,
      });
    }

    // Domain resolved but no keyword match — fall to Tier 2 with domain hint.
    // Tier 2 sonar will classify the intent with the domain already known.
    return wrap(await tier2(userInput, domainMatch.domain, workflowRows, traceId));
  }

  // ── Pass 2 domain miss — CRUD verb short-circuit ─────────────────────────
  // A CRUD verb with no recognised domain wastes a sonar call. Return a
  // crud_ambiguous result with the registered domain list so the user can
  // correct their input without an LLM round-trip.
  if (hasCrudVerb(userInput)) {
    console.info('classify-intent: CRUD verb with no domain match — short-circuit', { traceId });
    return wrap({
      intent_category:  'unknown_domain_crud',
      action_type:      'crud_ambiguous',
      confidence:       'crud',
      workflow_name:    null,
      domain:           null,
      ad_hoc_step:      null,
      search_term:      null,
      record_id:        null,
      known_domains:    domainRows.map(r => r.domain),
      ambiguous_reason: 'unknown_domain',
    });
  }

  // ── No Pre-pass, Pass 1, or Pass 2 match — Tier 2 ────────────────────────
  return wrap(await tier2(userInput, null, workflowRows, traceId));
}

// ---------------------------------------------------------------------------
// Tier 2 — cheap sonar classification
// ---------------------------------------------------------------------------

async function tier2(userInput, domainHint, workflowRows, traceId) {
  const promptResp = await getRows('PGC_Prompt', [
    { column: 'intent_category', op: 'eq', value: 'classify_intent_tier2' },
  ]);
  const promptRow = promptResp.rows?.[0];
  if (!promptRow) throw new Error('PGC_Prompt row missing for classify_intent_tier2 — run init-brain');

  const workflowNames = workflowRows.map(r => r.name);
  const messages = buildTier2Prompt(userInput, domainHint, workflowNames, promptRow.prompt_text);

  console.info('classify-intent: Tier 2 sonar call', { traceId, domainHint, promptVersion: promptRow.version });

  const llmKey = process.env.LLM_API_KEY;
  if (!llmKey) throw new Error('LLM_API_KEY env var not set');

  const response = await fetch(process.env.LLM_CHAT_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${llmKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:       promptRow.model ?? 'sonar',
      messages,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const errorEntry = {
      at:              new Date().toISOString(),
      error_type:      'llm_http_error',
      error_message:   `Tier 2 LLM error ${response.status}: ${text}`,
      llm_raw_output:  text,
      recovery_action: 'halt',
    };
    console.error('classify-intent: Tier 2 LLM HTTP error', { traceId, status: response.status });
    try {
      const existingLog = Array.isArray(promptRow.error_log?.attempts) ? promptRow.error_log.attempts : [];
      await updateRows('PGC_Prompt',
        [{ column: 'intent_category', op: 'eq', value: 'classify_intent_tier2' }],
        { error_log: { attempts: [...existingLog, errorEntry] } }
      );
    } catch (logErr) {
      console.warn('classify-intent: error_log write failed', logErr.message);
    }
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
    const errorEntry = {
      at:              new Date().toISOString(),
      error_type:      'invalid_json',
      error_message:   error.message,
      llm_raw_output:  rawText.slice(0, 500),
      recovery_action: 'halt',
    };
    console.error('classify-intent: Tier 2 JSON parse failed', { traceId, raw: rawText.slice(0, 200) });
    try {
      const existingLog = Array.isArray(promptRow.error_log?.attempts) ? promptRow.error_log.attempts : [];
      await updateRows('PGC_Prompt',
        [{ column: 'intent_category', op: 'eq', value: 'classify_intent_tier2' }],
        { error_log: { attempts: [...existingLog, errorEntry] } }
      );
    } catch (logErr) {
      console.warn('classify-intent: error_log write failed', logErr.message);
    }
    throw new Error(`Tier 2 LLM returned invalid JSON: ${error.message}`);
  }

  const { intent_category, workflow_name, action_type } = parsed;

  console.info('classify-intent: Tier 2 result', {
    traceId, intent_category, workflow_name, action_type,
  });

  if (action_type === 'heavy_lift' || (!workflow_name && action_type !== 'crud')) {
    return {
      intent_category: intent_category ?? 'unknown',
      action_type:     'heavy_lift',
      confidence:      'heavy_lift',
      workflow_name:   null,
      domain:          domainHint,
      ad_hoc_step:     null,
      search_term:     null,
      record_id:       null,
    };
  }

  if (workflow_name) {
    return {
      intent_category: intent_category ?? workflow_name,
      action_type:     'workflow',
      confidence:      'llm_classified',
      workflow_name,
      domain:          domainHint,
      ad_hoc_step:     null,
      search_term:     null,
      record_id:       null,
    };
  }

  return {
    intent_category: intent_category ?? 'unknown',
    action_type:     'crud',
    confidence:      'llm_classified',
    workflow_name:   null,
    domain:          domainHint,
    ad_hoc_step:     null,
    search_term:     null,
    record_id:       null,
  };
}

// ---------------------------------------------------------------------------
// SQS handoff — route result to downstream
// ---------------------------------------------------------------------------

async function handoff(result, callback, traceId, userInput, entitySchemaRows) {
  // ── Workflow ──────────────────────────────────────────────────────────────
  if (result.action_type === 'workflow' && result.workflow_name) {

    const wfResp = await getRows(
      'PGC_Workflow',
      [{ column: 'name', op: 'eq', value: result.workflow_name }],
      null, 1
    );
    if (!wfResp.success || wfResp.count === 0) {
      throw new Error(`handoff: workflow "${result.workflow_name}" not found in PGC_Workflow`);
    }
    const workflowId = wfResp.rows[0].id;

    // Build workflow input.
    // entity_name derived by convention from domain — "recipes" → "Recipe",
    // "stock_portfolio" → "StockPortfolio". Must match PGC_EntitySchema.entity_name.
    // For mutation workflows (update_entity, delete_entity), parse id=N and
    // field=value pairs from userInput so workflow steps can use {{input.id}}
    // and {{input.updates}} without a separate parsing step.
    const isMutation = ['update_entity', 'delete_entity'].includes(result.workflow_name);
    let parsedId      = null;
    let parsedUpdates = null;

    if (isMutation) {
      const idMatch = userInput.match(/\bid\s*[=:]\s*(\d+)\b/i)
                   ?? userInput.match(/\bid\s+(\d+)\b/i);
      parsedId = idMatch ? parseInt(idMatch[1], 10) : null;

      // No id provided — post instructive error instead of creating a WorkflowRun.
      // The workflow cannot proceed without an explicit id.
      if (parsedId === null) {
        const verb      = result.workflow_name === 'delete_entity' ? 'delete' : 'update';
        const domain    = result.domain ?? 'entity';
        const exampleId = 1;
        await enqueueCallback(callback, {
          type:    'WORKFLOW_NOTIFY',
          traceId,
          message: `To ${verb} a ${domain} record I need an explicit id.\n\n` +
                   `Use: \`/m list ${domain}\` to find the id, then:\n` +
                   `\`/m ${verb} ${domain} id=<number>${result.workflow_name === 'update_entity' ? ' <field>=<value>' : ''}\``,
        });
        return;
      }

      if (result.workflow_name === 'update_entity') {
        const updates = parseFieldValues(userInput);
        delete updates.id;
        parsedUpdates = Object.keys(updates).length > 0 ? updates : null;

        // No field=value pairs provided — post instructive error without creating a WorkflowRun.
        if (!parsedUpdates) {
          const domain = result.domain ?? 'entity';
          await enqueueCallback(callback, {
            type:    'WORKFLOW_NOTIFY',
            traceId,
            message: `To update a ${domain} record I need at least one field=value pair.\n\n` +
                     `Example: \`/m update ${domain} id=${parsedId} <field>=<value>\``,
          });
          return;
        }
      }
    }

    // entity_name read from PGC_EntitySchema.domain — single source of truth.
    // Fallback to toEntityName() covers domains created before the domain column existed.
    const domainEntity = result.domain
      ? (entitySchemaRows.find(r => r.domain === result.domain)?.entity_name ?? toEntityName(result.domain))
      : null;

    const workflowInput = {
      userInput,
      ...(domainEntity                                                        ? { entity_name: domainEntity }      : {}),
      ...(result.search_term                                                  ? { search: result.search_term }     : {}),
      ...(result.record_id !== null && result.record_id !== undefined         ? { id: result.record_id }           : {}),
      ...(parsedId !== null                                                   ? { id: parsedId }                   : {}),
      ...(parsedUpdates                                                       ? { updates: parsedUpdates }         : {}),
    };

    const runResp = await insertRow('PGC_WorkflowRun', {
      workflow_id:  workflowId,
      trace_id:     traceId,
      triggered_by: 'slack',
      status:       'pending',
      input:        workflowInput,
      stack:        [],
      state:        {},
      callback,
    });
    if (!runResp.success) {
      throw new Error(`handoff: failed to create PGC_WorkflowRun: ${runResp.error}`);
    }
    const workflowRunId = runResp.row.id;
    console.info('classify-intent: handoff — WorkflowRun created', {
      workflowRunId,
      workflow:     result.workflow_name,
      entity_name:  domainEntity ?? null,
      search_term:  result.search_term ?? null,
      traceId,
    });

    await enqueueWorkflow({
      type:          'WORKFLOW_STEP',
      action:        'execute_top',
      workflowRunId,
      traceId,
    });
    return;
  }

  // ── Heavy lift — Tier 3 ───────────────────────────────────────────────────
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

    await enqueueWorkflow({
      type:      sqsType,
      userInput,
      traceId,
      callback,
    });
    return;
  }

  // ── CRUD — direct table operation (Groups 3–4) ───────────────────────────
  if (result.action_type === 'crud' && result.ad_hoc_step) {
    await executeCrudStep(result, callback, traceId);
    return;
  }

  // ── CRUD ambiguous — post instructive error ───────────────────────────────
  if (result.action_type === 'crud_ambiguous') {
    const table  = result.table_name ?? null;
    const reason = result.ambiguous_reason ?? '';
    let message;

    if (reason === 'no_verb' && table) {
      message = `Please include a verb with the table name.\n\n` +
                `Examples:\n` +
                `• \`/m list ${table}\`\n` +
                `• \`/m add ${table} field=value\`\n` +
                `• \`/m update ${table} id=N field=value\`\n` +
                `• \`/m delete ${table} id=N\``;
    } else if (reason === 'insert' && table) {
      message = `To insert a row into \`${table}\` I need at least one field=value pair.\n\n` +
                `Example: \`/m add ${table} name=MyItem\``;
    } else if (reason === 'no_id' && table) {
      message = `To update a row in \`${table}\` I need \`id=N\`.\n\n` +
                `Example: \`/m update ${table} id=42 field=value\``;
    } else if (reason === 'no_fields' && table) {
      message = `To update a row in \`${table}\` I need at least one field=value pair.\n\n` +
                `Example: \`/m update ${table} id=42 name=NewValue\``;
    } else if (reason === 'delete' && table) {
      message = `To delete a row from \`${table}\` I need \`id=N\`.\n\n` +
                `Example: \`/m delete ${table} id=42\``;
    } else if (reason === 'unknown_domain') {
      const domainList = Array.isArray(result.known_domains) && result.known_domains.length > 0
        ? `\n\nYour registered domains are: ${result.known_domains.join(', ')}`
        : '\n\nYou have no domains registered yet. Use /create-domain to create one.';
      message = `I could not match a domain for that request.${domainList}`;
    } else {
      message = `I could not complete that request — please be more specific.`;
    }

    await enqueueCallback(callback, { type: 'WORKFLOW_NOTIFY', traceId, message });
    return;
  }

  // ── Fallback — should not be reached ─────────────────────────────────────
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

/**
 * Derive PGC_EntitySchema.entity_name from a domain name by convention.
 * Each underscore-separated word is title-cased and joined without separator.
 *   "recipes"         → "Recipe"     (singular — strip trailing s)
 *   "stock_portfolio" → "StockPortfolio"
 *   "golf_scores"     → "GolfScore"  (strip trailing s)
 *
 * Convention: entity names are singular. Strip a trailing "s" from the last
 * word only when it results in a string that is already registered in
 * PGC_EntitySchema — we apply the strip unconditionally since it matches the
 * naming convention enforced by create_domain (entity_name = TitleCase singular).
 *
 * @param {string} domain  Snake_case domain name
 * @returns {string}       TitleCase entity name
 */
function toEntityName(domain) {
  const words = domain.split('_');
  const titled = words.map(w => w.charAt(0).toUpperCase() + w.slice(1));
  // Strip trailing 's' from last word to produce singular entity name
  const last = titled[titled.length - 1];
  if (last.endsWith('s') && last.length > 2) {
    titled[titled.length - 1] = last.slice(0, -1);
  }
  return titled.join('');
}

// ---------------------------------------------------------------------------
// Table CRUD execution — Groups 3 and 4
// ---------------------------------------------------------------------------

/**
 * Execute an ad_hoc_step built by the pre-pass table-prefix path.
 * Calls SERV directly via serv-client helpers. No WorkflowRun lifecycle.
 */
async function executeCrudStep(result, callback, traceId) {
  const step      = result.ad_hoc_step;
  const tableName = result.table_name ?? step.input?.tableName ?? 'unknown';

  console.info('classify-intent: executeCrudStep', { stepType: step.type, tableName, traceId });

  let output;
  try {
    if (step.type === 'serv_query') {
      const resp = await getRows(tableName, step.input?.filters ?? []);
      if (!resp.success) throw new Error(resp.error ?? 'getRows failed');
      output = resp.rows ?? [];
    } else if (step.type === 'serv_insert') {
      const resp = await insertRow(tableName, step.input?.row ?? {});
      if (!resp.success) throw new Error(resp.error ?? 'insertRow failed');
      output = resp.row;
    } else if (step.type === 'serv_update') {
      const resp = await updateRows(tableName, step.input?.filters ?? [], step.input?.updates ?? {});
      if (!resp.success) throw new Error(resp.error ?? 'updateRows failed');
      output = resp;
    } else if (step.type === 'serv_delete') {
      const resp = await deleteRows(tableName, step.input?.filters ?? []);
      if (!resp.success) throw new Error(resp.error ?? 'deleteRows failed');
      output = resp;
    } else {
      throw new Error(`executeCrudStep: unsupported step type "${step.type}"`);
    }
  } catch (stepError) {
    console.error('classify-intent: executeCrudStep failed', {
      stepType: step.type, tableName, error: stepError.message, traceId,
    });
    await enqueueCallback(callback, {
      type:    'WORKFLOW_NOTIFY',
      traceId,
      message: `Something went wrong with your ${step.type.replace('serv_', '')} on \`${tableName}\`: ${stepError.message}`,
    });
    return;
  }

  const message = formatTableCrudResult(step.type, tableName, output, step.input?.row);
  await enqueueCallback(callback, { type: 'WORKFLOW_NOTIFY', traceId, message });
}

/**
 * Format the result of a direct table CRUD operation for display to the user.
 * Table name is shown explicitly — this is an admin/debug path, not a
 * domain-friendly workflow result.
 */
function formatTableCrudResult(stepType, tableName, output, insertedRow = {}) {
  if (stepType === 'serv_query') {
    const rows = Array.isArray(output) ? output : [];
    if (rows.length === 0) return `No rows found in \`${tableName}\`.`;
    const SYSTEM_FIELDS = new Set(['created_at', 'updated_at']);
    const labelField = Object.keys(rows[0]).find(k => k === 'name')
                    ?? Object.keys(rows[0]).find(k => !SYSTEM_FIELDS.has(k))
                    ?? 'id';
    const preview = rows.slice(0, 10)
      .map((r, i) => `${i + 1}. ${r[labelField] ?? r.id} (id: ${r.id})`)
      .join('\n');
    const suffix = rows.length > 10 ? `\n…and ${rows.length - 10} more.` : '';
    return `Found ${rows.length} row${rows.length !== 1 ? 's' : ''} in \`${tableName}\`:\n${preview}${suffix}`;
  }

  if (stepType === 'serv_insert') {
    const id = output?.id ?? null;
    const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);
    const summary = Object.entries(insertedRow ?? {})
      .filter(([k]) => !SYSTEM_COLS.has(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const detail = summary ? ` (${summary})` : '';
    return `Inserted row into \`${tableName}\`${detail}${id != null ? ` — id: ${id}` : ''}.`;
  }

  if (stepType === 'serv_update') {
    const count = output?.updatedCount ?? 0;
    return count > 0
      ? `Updated ${count} row${count !== 1 ? 's' : ''} in \`${tableName}\`.`
      : `No rows updated in \`${tableName}\` — no matching record found.`;
  }

  if (stepType === 'serv_delete') {
    const count = output?.deletedCount ?? 0;
    return count > 0
      ? `Deleted ${count} row${count !== 1 ? 's' : ''} from \`${tableName}\`.`
      : `No rows deleted from \`${tableName}\` — no matching record found.`;
  }

  return `Done. ${JSON.stringify(output ?? {}).slice(0, 200)}`;
}
