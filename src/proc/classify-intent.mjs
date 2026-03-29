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
import { getRows, insertRow, updateRows } from '../shared/serv-client.mjs';
import { enqueueCallback, enqueueWorkflow } from '../shared/sqs-callback.mjs';
import {
  matchIntentMap,
  matchDomainAlias,
  matchCrudVerb,
  hasCrudVerb,
  buildTier2Prompt,
  resolveTier3Route,
} from './classify-intent-tiers.mjs';
import { executeStep } from './step-executor.mjs';

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
      // workflow_name is the intent_category when action_type is 'workflow' —
      // handoff() looks up the workflow by name, not by workflow_id.
      // workflow_id is no longer a routing gate — action_type alone determines routing.
      workflow_name:   intentMatch.action_type === 'workflow' ? intentMatch.intent_category : null,
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

        // Insert verb found but no field=value pairs — fetch column names from
        // PGC_Schema and return ambiguous so handoff() can show the correct syntax.
        if (crudMatch.ambiguous && crudMatch.action === 'insert') {
          const schemaRow = await getRows('PGC_Schema', [
            { column: 'table_name', op: 'eq', value: rootTable },
          ]);
          const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);
          const columns = (schemaRow.rows?.[0]?.columns ?? [])
            .filter(c => !SYSTEM_COLS.has(c.name))
            .map(c => c.name);
          return {
            intent_category: `insert_${domainMatch.domain}`,
            action_type:     'crud_ambiguous',
            confidence:      'crud',
            workflow_name:   null,
            workflow_id:     null,
            domain:          domainMatch.domain,
            ad_hoc_step:     null,
            known_domains:   domainRows.map(r => r.domain),
            table_columns:   columns,
            root_table:      rootTable,
          };
        }

        // Update verb found — missing ID or missing field=value pairs.
        // Fetch column names for the error message in both cases.
        if (crudMatch.ambiguous && crudMatch.action === 'update') {
          const schemaRow = await getRows('PGC_Schema', [
            { column: 'table_name', op: 'eq', value: rootTable },
          ]);
          const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);
          const columns = (schemaRow.rows?.[0]?.columns ?? [])
            .filter(c => !SYSTEM_COLS.has(c.name))
            .map(c => c.name);
          return {
            intent_category: `update_${domainMatch.domain}`,
            action_type:     'crud_ambiguous',
            confidence:      'crud',
            workflow_name:   null,
            workflow_id:     null,
            domain:          domainMatch.domain,
            ad_hoc_step:     null,
            known_domains:   domainRows.map(r => r.domain),
            table_columns:   columns,
            root_table:      rootTable,
            ambiguous_reason: crudMatch.reason,
          };
        }

        // Delete verb found but no ID — return ambiguous so handoff() can
        // send an instructive error. Do not fall to Tier 2 (it would
        // misclassify "delete my recipes" as a heavy_lift or crud intent).
        if (crudMatch.ambiguous && crudMatch.action === 'delete') {
          return {
            intent_category: `delete_${domainMatch.domain}`,
            action_type:     'crud_ambiguous',
            confidence:      'crud',
            workflow_name:   null,
            workflow_id:     null,
            domain:          domainMatch.domain,
            ad_hoc_step:     null,
            known_domains:   domainRows.map(r => r.domain),
            table_columns:   [],
            root_table:      rootTable,
          };
        }

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

  // ── Pass 1b failed — no domain matched ───────────────────────────────────
  // If the input contains a CRUD verb, the user is almost certainly trying to
  // operate on a domain they own but phrased it in a way we don't recognise.
  // Short-circuit here with an instructive error listing their registered
  // domains — no value in sending this to Tier 2 (it would misclassify it
  // or burn an LLM call to reach the same conclusion).
  if (hasCrudVerb(userInput)) {
    console.info('classify-intent: CRUD verb with no domain match — short-circuit', { traceId });
    return {
      intent_category: 'unknown_domain_crud',
      action_type:     'crud_ambiguous',
      confidence:      'crud',
      workflow_name:   null,
      workflow_id:     null,
      domain:          null,
      ad_hoc_step:     null,
      known_domains:   domainRows.map(r => r.domain),
    };
  }

  // ── Tier 2 — no Tier 1 match ─────────────────────────────────────────────
  return await tier2(userInput, null, intentRows, traceId);
}

// ---------------------------------------------------------------------------
// Tier 2 — cheap sonar classification
// ---------------------------------------------------------------------------

async function tier2(userInput, domainHint, intentRows, traceId) {
  // Load prompt from PGC_Prompt — consistent with all other LLM calls in the system.
  // Gives Tier 2 versioning, error_log, and the right-brain improvement loop.
  const promptResp = await getRows('PGC_Prompt', [
    { column: 'intent_category', op: 'eq', value: 'classify_intent_tier2' },
  ]);
  const promptRow = promptResp.rows?.[0];
  if (!promptRow) throw new Error('PGC_Prompt row missing for classify_intent_tier2 — run init-brain');

  // Load all workflow names so sonar can match against them
  const workflowResp  = await getRows('PGC_Workflow');
  const workflowRows  = workflowResp.rows ?? [];
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
    // Log failure to PGC_Prompt.error_log — same pattern as review-output.mjs
    const errorEntry = {
      at:             new Date().toISOString(),
      error_type:     'llm_http_error',
      error_message:  `Tier 2 LLM error ${response.status}: ${text}`,
      llm_raw_output: text,
      recovery_action: 'halt',
    };
    console.error('classify-intent: Tier 2 LLM HTTP error', { traceId, status: response.status });
    // Best-effort error log write — do not throw on log failure
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
    // Log parse failure to PGC_Prompt.error_log
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
    // Look up workflow_id from the rows already loaded above — avoids a second DB round-trip
    const workflowId = workflowRows.find(r => r.name === workflow_name)?.id ?? null;

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
  // Named workflow matched — look up PGC_Workflow by name to get the id,
  // then create PGC_WorkflowRun and enqueue WORKFLOW_STEP execute_top.
  // workflow_id is no longer carried on PGC_IntentMap — we always resolve
  // by name so the intent map and workflow table remain structurally independent.
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

    const runResp = await insertRow('PGC_WorkflowRun', {
      workflow_id:  workflowId,
      trace_id:     traceId,
      triggered_by: 'slack',
      status:       'pending',
      input:        { userInput },
      stack:        [],
      state:        {},
      callback,
    });
    if (!runResp.success) {
      throw new Error(`handoff: failed to create PGC_WorkflowRun: ${runResp.error}`);
    }
    const workflowRunId = runResp.row.id;
    console.info('classify-intent: handoff — WorkflowRun created', { workflowRunId, traceId });

    await enqueueWorkflow({
      type:          'WORKFLOW_STEP',
      action:        'execute_top',
      workflowRunId,
      traceId,
    });
    return;
  }

  // CRUD verb present but request is ambiguous — return instructive error.
  // Sub-cases:
  //   insert, no field=value pairs         → list table fields
  //   update, no ID                        → ask for id=<number>
  //   update, no field=value pairs         → list table fields
  //   delete, no ID                        → ask for id=<number>
  //   unknown domain, any CRUD verb        → list registered domains
  if (result.action_type === 'crud_ambiguous') {
    const domainList  = formatKnownDomains(result.known_domains);
    const fieldList   = result.table_columns?.length
      ? `\n\nAvailable fields: ${result.table_columns.join(', ')}`
      : '';
    const firstField  = result.table_columns?.[0] ?? 'name';

    if (result.domain && result.intent_category.startsWith('insert_')) {
      await enqueueCallback(callback, {
        type:    'WORKFLOW_NOTIFY',
        traceId,
        message: `To add a ${result.domain} record I need field values.${fieldList}\n\nTry: /mind add my ${result.domain} field=value field2=value2\n\nExample: /mind add my ${result.domain} ${firstField}=My New Item`,
      });
    } else if (result.domain && result.intent_category.startsWith('update_')) {
      if (result.ambiguous_reason === 'no_id') {
        await enqueueCallback(callback, {
          type:    'WORKFLOW_NOTIFY',
          traceId,
          message: `To update a ${result.domain} record I need an explicit ID.${fieldList}\n\nTry: /mind update my ${result.domain} id=<number> ${firstField}=New Value\n\nTo find the ID first, use: /mind list my ${result.domain}`,
        });
      } else {
        // no_fields — ID was present but no field=value pairs
        await enqueueCallback(callback, {
          type:    'WORKFLOW_NOTIFY',
          traceId,
          message: `To update a ${result.domain} record I need at least one field value.${fieldList}\n\nTry: /mind update my ${result.domain} id=<number> ${firstField}=New Value`,
        });
      }
    } else if (result.domain && result.intent_category.startsWith('delete_')) {
      await enqueueCallback(callback, {
        type:    'WORKFLOW_NOTIFY',
        traceId,
        message: `To delete a ${result.domain} record I need an explicit ID.\n\nTry: /mind delete my ${result.domain} id=<number>\n\nTo find the ID first, use: /mind list my ${result.domain}`,
      });
    } else {
      await enqueueCallback(callback, {
        type:    'WORKFLOW_NOTIFY',
        traceId,
        message: `I could not find a matching domain for that request.${domainList}\n\nTo add a new domain, use: /create-domain`,
      });
    }
    return;
  }

  // CRUD — execute ad_hoc_step directly and post result as WORKFLOW_NOTIFY.
  if (result.action_type === 'crud' && result.ad_hoc_step) {
    await executeCrudStep(result, callback, traceId, userInput);
    return;
  }

  // CRUD with no ad_hoc_step (Tier 2 path — domain resolved but no root table)
  if (result.action_type === 'crud') {
    const domainText = result.domain ? ` in your ${result.domain} domain` : '';
    await enqueueCallback(callback, {
      type:    'WORKFLOW_NOTIFY',
      traceId,
      message: `I understood you want to ${result.intent_category.replace(/_/g, ' ')}${domainText}, but I could not determine which table to use. Try being more specific or use /create-domain to register this domain.`,
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
// CRUD ad_hoc_step execution
// ---------------------------------------------------------------------------

// Executes a single ad_hoc_step built by Pass 1c directly, without a full
// PGC_WorkflowRun lifecycle. A minimal run context is constructed in-memory
// so executeStep receives the shape it expects.
//
// Supported step types: serv_query, serv_insert, serv_delete (ID required —
//   enforced upstream in matchCrudVerb; ambiguous deletes never reach here).
// serv_update is not produced by Pass 1c today (no ad_hoc update pattern).

async function executeCrudStep(result, callback, traceId, userInput) {
  const step = result.ad_hoc_step;

  // Minimal run context — executeStep only reads run.id, run.callback, run.workflow_name
  // for logging and gate payloads. Ad_hoc steps never suspend (no human_gate type here).
  const minimalRun = {
    id:            0,
    workflow_name: `ad_hoc_${result.intent_category}`,
    callback,
  };

  // local_state carries userInput so any {{input.userInput}} refs in the step resolve.
  const localState = { input: { userInput } };

  console.info('classify-intent: executeCrudStep', {
    stepType: step.type,
    domain:   result.domain,
    traceId,
  });

  let stepResult;
  try {
    stepResult = await executeStep({ step, localState, run: minimalRun, traceId });
  } catch (stepError) {
    console.error('classify-intent: executeCrudStep failed', {
      stepType: step.type, error: stepError.message, traceId,
    });
    await enqueueCallback(callback, {
      type:    'WORKFLOW_NOTIFY',
      traceId,
      message: `Something went wrong with your ${result.domain ?? ''} ${step.type.replace('serv_', '')} request: ${stepError.message}`,
    });
    return;
  }

  const message = formatCrudResult(step.type, result.domain, stepResult.outputValue, step.input?.row);

  await enqueueCallback(callback, {
    type:    'WORKFLOW_NOTIFY',
    traceId,
    message,
  });
}

// ---------------------------------------------------------------------------
// CRUD result formatting
// ---------------------------------------------------------------------------

// Produces a plain-text summary of an ad_hoc CRUD step result for the user.
// Keeps responses concise — detailed data views are for full workflow results.

function formatCrudResult(stepType, domain, outputValue, insertedRow = {}) {
  if (stepType === 'serv_query') {
    const rows = Array.isArray(outputValue) ? outputValue : [];
    if (rows.length === 0) {
      return `No ${domain ?? 'records'} found.`;
    }
    // Show up to 10 rows. Use 'name' field if present, otherwise first non-system field.
    const SYSTEM_FIELDS = new Set(['id', 'created_at', 'updated_at']);
    const labelField = (rows[0] && Object.keys(rows[0]).find(k => k === 'name'))
      ?? Object.keys(rows[0] ?? {}).find(k => !SYSTEM_FIELDS.has(k))
      ?? 'id';
    const preview = rows.slice(0, 10).map((r, i) => `${i + 1}. ${r[labelField] ?? r.id} (id: ${r.id})`).join('\n');
    const suffix  = rows.length > 10 ? `\n…and ${rows.length - 10} more.` : '';
    return `Found ${rows.length} ${domain ?? 'record'}${domain ? '' : rows.length !== 1 ? 's' : ''}:\n${preview}${suffix}`;
  }

  if (stepType === 'serv_insert') {
    const id  = outputValue?.id ?? null;
    const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);
    const summary = Object.entries(insertedRow ?? {})
      .filter(([k]) => !SYSTEM_COLS.has(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const detail = summary ? ` (${summary})` : '';
    return `Added to ${domain ?? 'your data'}${detail}${id ? ` — id: ${id}` : ''}.`;
  }

  if (stepType === 'serv_update') {
    const count = outputValue?.updatedCount ?? 0;
    return count > 0
      ? `Updated ${count} ${domain ?? 'record'}${domain ? '' : count !== 1 ? 's' : ''}.`
      : `Nothing updated — no matching record found.`;
  }

  if (stepType === 'serv_delete') {
    const count = outputValue?.deletedCount ?? 0;
    return count > 0
      ? `Deleted ${count} ${domain ?? 'record'}${domain ? '' : count !== 1 ? 's' : ''}.`
      : `Nothing deleted — no matching record found.`;
  }

  // Fallback for any future step types routed here
  return `Done. ${JSON.stringify(outputValue ?? {}).slice(0, 200)}`;
}



function titleCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format a list of known domain names for display in an error message.
 * Returns an empty string when no domains are registered yet.
 *
 * @param {string[]|null} domains
 * @returns {string}
 */
function formatKnownDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0) {
    return '\n\nYou have no domains registered yet. Use /create-domain to create one.';
  }
  return `\n\nYour registered domains are: ${domains.join(', ')}`;
}
