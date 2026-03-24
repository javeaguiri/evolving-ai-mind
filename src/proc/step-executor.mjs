// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/step-executor.mjs
//
// Step type handlers for the Step Processor.
// Called by run-workflow.mjs — one handler per step type.
//
// Each handler receives { step, localState, run, traceId } and returns:
//   { outputValue, nextAction, gatePayload? }
//
//   outputValue  — value to write to localState[step.output_key]
//   nextAction   — 'next' | 'end' | 'step:N' | 'suspend' | 'cancel'
//   gatePayload  — set only for human_gate steps; the WORKFLOW_GATE message body
//
// Implemented step types:
//   llm_call     — calls LLM, runs validate(), returns scaffold
//   js_transform — safe synchronous data transformation
//   human_gate   — builds dialog, returns suspend
//   serv_schema  — calls SERV createTable
//   serv_insert  — calls SERV insertRow
//   serv_query   — calls SERV getRows, writes rows array to output_key
//   serv_update  — calls SERV updateRows, generic filter + updates shape
//   serv_delete  — calls SERV deleteRows, generic filter shape
//   notify       — enqueues result message to SlackResults
//   end          — signals workflow complete
//
// Deferred step types (return NotImplemented error):
//   sub_workflow, condition
//
// Transport-agnostic — no AWS SDK, no Slack SDK.
// All SQS enqueue calls go through sqs-callback.mjs (imported by run-workflow.mjs).

import { callLlm }          from '../shared/llm-client.mjs';
import { validate }         from './review-output.mjs';
import { servPost, getRows, insertRow, updateRows, deleteRows } from '../shared/serv-client.mjs';
import {
  resolvePath,
  resolveTemplate,
  resolveInput,
  evalItemCondition,
} from './template-resolver.mjs';

// System columns excluded from columnSummary derivation
const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);

// ---------------------------------------------------------------------------
// Public dispatch — routes to the correct handler by step.type
// ---------------------------------------------------------------------------

/**
 * Execute a single workflow step.
 *
 * @param {object} params
 * @param {object} params.step        Step definition from PGC_Workflow.steps
 * @param {object} params.localState  Current frame local_state (may be mutated)
 * @param {object} params.run         PGC_WorkflowRun row (read-only in executor)
 * @param {string} params.traceId
 * @returns {Promise<StepResult>}
 */
export async function executeStep({ step, localState, run, traceId }) {
  switch (step.type) {
    case 'llm_call':     return executeLlmCall({ step, localState, run, traceId });
    case 'js_transform': return executeJsTransform({ step, localState, traceId });
    case 'human_gate':   return executeHumanGate({ step, localState, run, traceId });
    case 'serv_schema':  return executeServSchema({ step, localState, traceId });
    case 'serv_insert':  return executeServInsert({ step, localState, traceId });
    case 'serv_query':   return executeServQuery({ step, localState, traceId });
    case 'serv_update':  return executeServUpdate({ step, localState, traceId });
    case 'serv_delete':  return executeServDelete({ step, localState, traceId });
    case 'notify':       return executeNotify({ step, localState, traceId });
    case 'end':          return { outputValue: null, nextAction: 'end' };
    case 'iterator':     return { outputValue: null, nextAction: 'iterator' };

    case 'sub_workflow':
    case 'condition':
      throw new Error(`step type "${step.type}" not yet implemented (Phase 3)`);

    default:
      throw new Error(`unknown step type: "${step.type}"`);
  }
}

// ---------------------------------------------------------------------------
// llm_call
// ---------------------------------------------------------------------------

async function executeLlmCall({ step, localState, run, traceId }) {
  const intentCategory = step.input?.prompt;
  if (!intentCategory) throw new Error('llm_call step missing input.prompt');

  const promptResp = await getRows(
    'PGC_Prompt',
    [{ column: 'intent_category', op: 'eq', value: intentCategory }],
    { column: 'version', direction: 'desc' },
    1
  );
  if (!promptResp.success || promptResp.count === 0) {
    throw new Error(`prompt not found: intent_category="${intentCategory}"`);
  }
  const promptRow = promptResp.rows[0];

  // Resolve all template variables in the step input so the prompt has
  // access to domain, existing_tables, and any other input fields.
  const resolvedInput = resolveInput(step.input ?? {}, localState);

  // Resolve user_input — the primary free-text variable in every llm_call step.
  const userInput = resolveTemplate(
    step.input?.user_input ?? '',
    localState,
  );

  // Substitute {{userInput}} in prompt_text.
  // Additional variables (e.g. {{domain}}, {{existingTables}}) are substituted
  // using the full resolvedInput so the prompt gets complete context.
  const instructions = Object.entries(resolvedInput).reduce((text, [key, val]) => {
    const placeholder = `{{${key}}}`;
    const substitution = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
    return text.split(placeholder).join(substitution);
  }, promptRow.prompt_text ?? '');

  console.info('step-executor: llm_call', {
    intentCategory,
    promptVersion: promptRow.version,
    traceId,
  });

  const t0 = Date.now();
  const rawOutput = await callLlm(
    promptRow.model,
    instructions,
    userInput || JSON.stringify(resolvedInput),
    promptRow.output_schema,
    traceId,
  );
  const llmMs = Date.now() - t0;

  console.info('step-executor: llm_call completed', { llmMs, traceId });

  // Validate output — 2-attempt correction loop
  const validationResult = await validate({
    intentCategory,
    output: rawOutput,
    traceId,
  });

  if (!validationResult.valid) {
    throw new Error(
      `llm_call validation failed after ${validationResult.attempt} attempt(s): ` +
      JSON.stringify(validationResult.errors)
    );
  }

  const finalOutput = validationResult.correctedOutput ?? rawOutput;

  return {
    outputValue: finalOutput,
    nextAction:  resolveNextAction(step.on_success, null),
    meta:        { llmMs, attempt: validationResult.attempt },
  };
}

// ---------------------------------------------------------------------------
// js_transform
// ---------------------------------------------------------------------------

async function executeJsTransform({ step, localState, traceId }) {
  // Read source data from input_key
  const source = resolvePath(localState, step.input_key);
  if (!Array.isArray(source)) {
    throw new Error(
      `js_transform: input_key "${step.input_key}" did not resolve to an array — ` +
      `got ${JSON.stringify(source)}`
    );
  }

  // Built-in transform: enrich tables with columnSummary
  // This is the only js_transform used by create_domain.
  // Generic sandboxed JS execution is deferred to Phase 3.
  //
  // When the Step Processor encounters a js_transform step, it checks if the
  // step description identifies a known built-in transform.
  // If not, it throws NotImplemented until Phase 3 sandboxing is built.
  const enriched = source.map(item => {
    if (!item.columns) return item; // not a table object — pass through

    const nonSystem = item.columns
      .filter(c => !SYSTEM_COLS.has(c.name))
      .slice(0, 4)
      .map(c => c.name);

    return { ...item, columnSummary: nonSystem.join(', ') };
  });

  console.info('step-executor: js_transform — columnSummary enrichment', {
    itemCount: enriched.length,
    traceId,
  });

  return {
    outputValue: enriched,
    nextAction:  resolveNextAction(step.on_success, null),
  };
}

// ---------------------------------------------------------------------------
// human_gate — builds WORKFLOW_GATE dialog
// ---------------------------------------------------------------------------

async function executeHumanGate({ step, localState, run, traceId }) {
  const gateType = step.gate_type;
  const dialog   = buildDialog(step, localState);

  const gatePayload = {
    type:          'WORKFLOW_GATE',
    workflowRunId: run.id,
    gate_type:     gateType,
    dialog,
    callback:      run.callback,
    traceId,
  };

  console.info('step-executor: human_gate — dialog built', {
    gateType,
    fieldCount: dialog.fields.length,
    traceId,
  });

  return {
    outputValue: null,
    nextAction:  'suspend',
    gatePayload,
  };
}

// ---------------------------------------------------------------------------
// Dialog builder — translates human_gate step intent into WORKFLOW_GATE dialog
// ---------------------------------------------------------------------------

/**
 * Build a fully resolved WORKFLOW_GATE dialog from a human_gate step definition.
 * Called by executeHumanGate and by resume_gate when re-rendering after remove_item.
 *
 * @param {object} step        human_gate step definition
 * @param {object} localState  Current local_state (all template vars sourced here)
 * @returns {object}           Resolved dialog object
 */
export function buildDialog(step, localState) {
  const fields = [];

  // typography — resolved message
  fields.push({
    type:  'typography',
    value: resolveTemplate(step.message_template ?? '', localState),
  });

  // Gate-type-specific fields
  switch (step.gate_type) {

    case 'edit_list': {
      const items = resolvePath(localState, step.context_key) ?? [];
      const resolvedItems = items.map(item => {
        const primary   = item[step.item_primary_key] ?? String(item);
        const secondary = item[step.item_secondary_key] ?? null;
        let secondaryAction = null;

        if (step.item_action) {
          const show = evalItemCondition(step.item_action.condition, item);
          if (show) {
            secondaryAction = {
              action:  step.item_action.action,
              label:   'Remove',
              style:   'danger',
              confirm: resolveTemplate(
                step.item_action.confirm_template ?? '',
                { ...localState, item },
              ),
            };
          }
        }

        return {
          id:              item[step.item_primary_key] ?? String(item),
          primary,
          secondary,
          secondaryAction,
        };
      });

      // label resolves template vars (e.g. table count)
      const domain = resolvePath(localState, 'proposed_scaffold.domain') ?? '';
      fields.push({
        type:  'list',
        name:  (step.context_key ?? '').split('.').pop(),
        label: `${domain} — ${resolvedItems.length} tables selected`,
        items: resolvedItems,
      });
      break;
    }

    case 'select_one': {
      const items = resolvePath(localState, step.context_key) ?? [];
      fields.push({
        type:    items.length <= 5 ? 'radio' : 'select',
        name:    step.context_key ?? 'selection',
        label:   resolveTemplate(step.message_template ?? '', localState),
        options: items.map(item => ({
          value: item[step.item_primary_key ?? 'id'] ?? String(item),
          label: item[step.item_primary_key ?? 'id'] ?? String(item),
        })),
      });
      break;
    }

    case 'select_many': {
      const items = resolvePath(localState, step.context_key) ?? [];
      fields.push({
        type:    'checkbox',
        name:    step.context_key ?? 'selection',
        label:   resolveTemplate(step.message_template ?? '', localState),
        options: items.map(item => ({
          value: item[step.item_primary_key ?? 'id'] ?? String(item),
          label: item[step.item_primary_key ?? 'id'] ?? String(item),
        })),
      });
      break;
    }

    case 'text_input': {
      fields.push({
        type:  'textbox',
        name:  'user_input',
        label: resolveTemplate(step.message_template ?? '', localState),
      });
      break;
    }

    case 'confirm':
    case 'review_object':
      // typography already added — no additional data fields needed
      break;

    default:
      console.warn('step-executor: unknown gate_type for dialog build', { gateType: step.gate_type });
  }

  // actions — from step.options
  fields.push({
    type:    'actions',
    buttons: (step.options ?? []).map(o => ({
      action: o.action,
      label:  o.label,
      style:  o.action === 'confirm' ? 'primary' : 'default',
    })),
  });

  return {
    title:  step.description ?? '',
    fields,
  };
}

// ---------------------------------------------------------------------------
// serv_schema — creates a PGD table
// ---------------------------------------------------------------------------

async function executeServSchema({ step, localState, traceId }) {
  // step.input may be "{{item}}" — resolves to the full table object
  const tableObj = resolveInput(step.input, localState);

  console.info('step-executor: serv_schema — createTable', {
    tableName: tableObj.tableName,
    traceId,
  });

  const resp = await servPost('/api/v1/serv/schema/createTable', tableObj);

  if (resp.statusCode !== 200 && resp.statusCode !== 201) {
    throw new Error(
      `serv_schema createTable failed for "${tableObj.tableName}": ` +
      `${resp.error ?? resp.statusCode}`
    );
  }

  return {
    outputValue: { tableName: tableObj.tableName, status: 'created' },
    nextAction:  resolveNextAction(step.on_success, null),
  };
}

// ---------------------------------------------------------------------------
// serv_insert — inserts a row into a PGC/PGD table
// ---------------------------------------------------------------------------

async function executeServInsert({ step, localState, traceId }) {
  const resolvedInput = resolveInput(step.input, localState);
  const { tableName, row } = resolvedInput;

  if (!tableName) throw new Error('serv_insert step missing input.tableName');
  if (!row)       throw new Error('serv_insert step missing input.row');

  console.info('step-executor: serv_insert', { tableName, traceId });

  const resp = await insertRow(tableName, row);

  if (!resp.success) {
    throw new Error(`serv_insert failed for "${tableName}": ${resp.error}`);
  }

  return {
    outputValue: { tableName, inserted: true, id: resp.row?.id },
    nextAction:  resolveNextAction(step.on_success, null),
  };
}

// ---------------------------------------------------------------------------
// serv_query — SELECT rows from a PGC/PGD table
// ---------------------------------------------------------------------------

// Step input shape:
//   {
//     "tableName": "PGD_Recipes",
//     "filters":   [ { "column": "name", "op": "like", "value": "{{state.search}}" } ],
//     "orderBy":   { "column": "created_at", "direction": "desc" },
//     "limit":     20
//   }
//
// filters, orderBy, and limit are all optional.
// Template variables in filter values are resolved via resolveInput before the SERV call.
// Rows array is written to local_state[output_key].

async function executeServQuery({ step, localState, traceId }) {
  const resolvedInput = resolveInput(step.input ?? {}, localState);
  const { tableName, filters, orderBy, limit } = resolvedInput;

  if (!tableName) throw new Error('serv_query step missing input.tableName');

  console.info('step-executor: serv_query', {
    tableName,
    filterCount: filters?.length ?? 0,
    traceId,
  });

  const resp = await getRows(tableName, filters ?? [], orderBy, limit);

  if (!resp.success) {
    throw new Error(`serv_query failed for "${tableName}": ${resp.error ?? resp.statusCode}`);
  }

  return {
    outputValue: resp.rows ?? [],
    nextAction:  resolveNextAction(step.on_success, null),
  };
}

// ---------------------------------------------------------------------------
// serv_update — UPDATE rows in a PGC/PGD table
// ---------------------------------------------------------------------------

// Step input shape (generic — mirrors SERV updateRows contract):
//   {
//     "tableName": "PGD_Recipes",
//     "filters":   [ { "column": "id", "op": "eq", "value": "{{selected_record.id}}" } ],
//     "updates":   { "name": "{{new_name}}" }
//   }
//
// filters must be non-empty — SERV rejects unfiltered mass updates.
// Template variables in both filters and updates are resolved via resolveInput.
// The right brain is responsible for ensuring filters are PK-scoped before
// this workflow is stored — the executor does not add safety constraints here.

async function executeServUpdate({ step, localState, traceId }) {
  const resolvedInput = resolveInput(step.input ?? {}, localState);
  const { tableName, filters, updates } = resolvedInput;

  if (!tableName) throw new Error('serv_update step missing input.tableName');
  if (!filters || filters.length === 0) throw new Error('serv_update step missing or empty input.filters');
  if (!updates || Object.keys(updates).length === 0) throw new Error('serv_update step missing input.updates');

  console.info('step-executor: serv_update', {
    tableName,
    filterCount: filters.length,
    updateKeys:  Object.keys(updates),
    traceId,
  });

  const resp = await updateRows(tableName, filters, updates);

  if (!resp.success) {
    throw new Error(`serv_update failed for "${tableName}": ${resp.error ?? resp.statusCode}`);
  }

  return {
    outputValue: { tableName, updatedCount: resp.updatedCount ?? 0, rows: resp.rows ?? [] },
    nextAction:  resolveNextAction(step.on_success, null),
  };
}

// ---------------------------------------------------------------------------
// serv_delete — DELETE rows from a PGC/PGD table
// ---------------------------------------------------------------------------

// Step input shape (generic — mirrors SERV deleteRows contract):
//   {
//     "tableName": "PGD_Recipes",
//     "filters":   [ { "column": "id", "op": "eq", "value": "{{selected_record.id}}" } ]
//   }
//
// filters must be non-empty — SERV rejects unfiltered mass deletes.
// Template variables in filters are resolved via resolveInput.
// Intended to be preceded by serv_query + human_gate so the user has
// confirmed which record(s) are being deleted before this step executes.

async function executeServDelete({ step, localState, traceId }) {
  const resolvedInput = resolveInput(step.input ?? {}, localState);
  const { tableName, filters } = resolvedInput;

  if (!tableName) throw new Error('serv_delete step missing input.tableName');
  if (!filters || filters.length === 0) throw new Error('serv_delete step missing or empty input.filters');

  console.info('step-executor: serv_delete', {
    tableName,
    filterCount: filters.length,
    traceId,
  });

  const resp = await deleteRows(tableName, filters);

  if (!resp.success) {
    throw new Error(`serv_delete failed for "${tableName}": ${resp.error ?? resp.statusCode}`);
  }

  return {
    outputValue: { tableName, deletedCount: resp.deletedCount ?? 0 },
    nextAction:  resolveNextAction(step.on_success, null),
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

async function executeNotify({ step, localState, traceId }) {
  const message = resolveTemplate(step.message_template ?? '', localState);

  console.info('step-executor: notify', { traceId });

  // run-workflow.mjs will enqueue the CREATE_DOMAIN_RESULT to SlackResultsQueue
  return {
    outputValue: { message },
    nextAction:  resolveNextAction(step.on_success, null),
    notifyMessage: message,
  };
}

// ---------------------------------------------------------------------------
// Routing helper
// ---------------------------------------------------------------------------

/**
 * Resolve an on_success/on_complete routing value to a canonical next action.
 * Passes through 'next', 'end', 'step:N', 'cancel' unchanged.
 * Falls back to 'next' if value is missing.
 */
function resolveNextAction(onSuccess, _localState) {
  if (!onSuccess || onSuccess === 'next') return 'next';
  if (onSuccess === 'end')               return 'end';
  if (onSuccess === 'cancel')            return 'cancel';
  if (onSuccess.startsWith('step:'))     return onSuccess;
  return 'next';
}
