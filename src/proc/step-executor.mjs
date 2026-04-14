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
//   js_transform — expression sandbox via acorn AST gate + vm.runInNewContext.
//                  `items` = resolved input_key value. `local_state` = full workflow state.
//                  transform_type built-ins removed — all transforms are self-contained expressions.
//   serv_entity_schema — reads PGC_EntitySchema + PGC_Schema, assembles full entity schema
//   human_gate   — builds dialog, returns suspend
//   serv_schema  — calls SERV createTable
//   serv_insert  — calls SERV insertRow
//   serv_query        — calls SERV getRows, writes rows array to output_key
//   serv_entity_query — calls SERV listEntities, writes entities array to output_key
//   serv_entity_get   — calls SERV getEntity by id, writes entity object to output_key
//   serv_update  — calls SERV updateRows, generic filter + updates shape
//   serv_delete  — calls SERV deleteRows, generic filter shape
//   condition    — resolves expression, routes on_truthy/on_falsy — no I/O
//   simulate     — static analysis + optional path simulation of a step array
//   notify       — enqueues result message to SlackResults
//   end          — signals workflow complete
//
// Deferred step types (return NotImplemented error):
//   sub_workflow
//
// Transport-agnostic — no AWS SDK, no Slack SDK.
// All SQS enqueue calls go through sqs-callback.mjs (imported by run-workflow.mjs).

import vm                   from 'node:vm';
import * as acorn           from 'acorn';
import { callLlm }          from '../shared/llm-client.mjs';
import { validate }         from './review-output.mjs';
import { servPost, getRows, insertRow, updateRows, deleteRows, listEntities, getEntityById } from '../shared/serv-client.mjs';
import {
  resolvePath,
  resolveTemplate,
  resolveInput,
  evalItemCondition,
} from './template-resolver.mjs';

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
    case 'serv_query':        return executeServQuery({ step, localState, traceId });
    case 'serv_entity_query': return executeServEntityQuery({ step, localState, traceId });
    case 'serv_entity_get':    return executeServEntityGet({ step, localState, traceId });
    case 'serv_entity_schema': return executeServEntitySchema({ step, localState, traceId });
    case 'serv_update':       return executeServUpdate({ step, localState, traceId });
    case 'serv_delete':  return executeServDelete({ step, localState, traceId });
    case 'simulate':     return executeSimulate({ step, localState, run, traceId });
    case 'notify':       return executeNotify({ step, localState, traceId });
    case 'end':          return { outputValue: null, nextAction: 'end' };
    case 'iterator':     return { outputValue: null, nextAction: 'iterator' };
    case 'condition':    return executeCondition({ step, localState, traceId });

    case 'sub_workflow':
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

  // PGC_SystemContext injection — load context rows whose inject_for array
  // includes this prompt's intent_category. Each row's key becomes a
  // substitution variable in prompt_text (e.g. {{step_type_contracts}},
  // {{example}}, {{routing_value_rules}}). step.input values take precedence
  // over context rows — context only fills placeholders not already present.
  // Client-side filter: PGC_SystemContext is small; jsonb array containment
  // (@>) is not a supported SERV op so we filter after fetch.
  const contextResp = await getRows('PGC_SystemContext');
  const contextMap = {};
  if (contextResp.success && contextResp.rows?.length) {
    for (const row of contextResp.rows) {
      const injectFor = Array.isArray(row.inject_for) ? row.inject_for : [];
      const injectAlways = row.inject_always === true;
      if ((injectAlways || injectFor.includes(intentCategory)) && !(row.key in resolvedInput)) {
        contextMap[row.key] = row.content;
      }
    }
  }

  // Resolve user_input — the primary free-text variable in every llm_call step.
  const userInput = resolveTemplate(
    step.input?.user_input ?? '',
    localState,
  );

  // Substitute prompt_text placeholders. Priority order:
  //   1. resolvedInput (step.input fields resolved from local_state)
  //   2. contextMap (PGC_SystemContext rows for this intent_category)
  const allSubstitutions = { ...contextMap, ...resolvedInput };
  const instructions = Object.entries(allSubstitutions).reduce((text, [key, val]) => {
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
    promptRow.max_output_tokens ?? undefined,
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
  const { transform_type: transformType, expression } = step;

  // Only expression sandbox is supported — transform_type built-ins are removed.
  // All js_transform steps must use the expression field.
  if (!expression) {
    throw new Error(
      `js_transform step "${step.step}" missing expression. ` +
      'transform_type built-ins have been removed — use expression with local_state instead.'
    );
  }

  // Generic expression sandbox path
  if (expression) {
    if (!step.input_key) throw new Error('js_transform expression step missing input_key');
    if (!step.output_key) throw new Error('js_transform expression step missing output_key');
    const items  = resolvePath(localState, step.input_key);
    const result = runSandboxedExpression(expression, items, localState, traceId);
    return { outputValue: result, nextAction: resolveNextAction(step.on_success, null) };
  }


}

// ---------------------------------------------------------------------------
// AST gate — rejects unsafe node types before vm execution
// ---------------------------------------------------------------------------

const BLOCKED_IDENTIFIERS = new Set(['require', 'eval', 'fetch', 'XMLHttpRequest', 'Function']);
const BLOCKED_GLOBALS     = new Set(['process', 'global', '__dirname', '__filename']);

function assertSafeAst(node) {
  if (!node || typeof node !== 'object') return;

  const type = node.type;

  if (type === 'ImportDeclaration') {
    throw new Error('js_transform expression: import statements are not allowed');
  }
  if (type === 'AwaitExpression') {
    throw new Error('js_transform expression: await is not allowed — expressions must be synchronous');
  }
  if ((type === 'FunctionDeclaration' || type === 'ArrowFunctionExpression' || type === 'FunctionExpression') && node.async) {
    throw new Error('js_transform expression: async functions are not allowed');
  }
  if (type === 'CallExpression') {
    const callee = node.callee;
    if (callee?.type === 'Identifier' && BLOCKED_IDENTIFIERS.has(callee.name)) {
      throw new Error(`js_transform expression: "${callee.name}" is not allowed`);
    }
  }
  if (type === 'NewExpression') {
    const callee = node.callee;
    if (callee?.type === 'Identifier' && callee.name === 'Function') {
      throw new Error('js_transform expression: new Function() is not allowed');
    }
  }
  if (type === 'MemberExpression') {
    const obj = node.object;
    if (obj?.type === 'Identifier' && BLOCKED_GLOBALS.has(obj.name)) {
      throw new Error(`js_transform expression: "${obj.name}" is not allowed`);
    }
  }

  // Recurse into all child nodes
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach(assertSafeAst);
    } else if (child && typeof child === 'object' && child.type) {
      assertSafeAst(child);
    }
  }
}

/**
 * Execute a pure synchronous JS expression in a sandboxed vm context.
 * `items` is bound to the resolved input_key value.
 * `local_state` is bound to the full local_state object, giving expressions
 * access to any workflow state key — required for cross-key transformations
 * such as merging a new table into an existing array.
 * Safe globals only — no Node.js APIs, no network, no async.
 *
 * @param {string} expression   JS value expression (no return, no semicolons)
 * @param {*}      items        Resolved input_key value from local_state
 * @param {object} localState   Full local_state — exposed as local_state in sandbox
 * @param {string} traceId
 * @returns {*}                 Expression result
 */
export function runSandboxedExpression(expression, items, localState, traceId) {
  // Parse and gate
  let ast;
  try {
    ast = acorn.parse(expression, { ecmaVersion: 2022 });
  } catch (parseErr) {
    throw new Error(`js_transform expression: syntax error — ${parseErr.message}`);
  }
  assertSafeAst(ast);

  // Execute in isolated context — 200ms timeout kills synchronous loops
  // local_state gives expressions access to any workflow state key.
  const sandbox = {
    items,
    local_state: localState,
    JSON, Math, Array, Object, String, Number, Boolean, Date,
  };
  let result;
  try {
    result = vm.runInNewContext(expression, sandbox, { timeout: 200 });
  } catch (vmErr) {
    if (vmErr.message?.includes('Script execution timed out')) {
      throw new Error('js_transform expression: execution timed out after 200ms — possible infinite loop');
    }
    throw new Error(`js_transform expression: runtime error — ${vmErr.message}`);
  }

  console.info('step-executor: js_transform — expression', { traceId });
  return result;
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

    case 'confirm': {
      // When context_key is present, build one button per item in the array
      // at that path — each item's `action` and `label` fields become buttons.
      // This is the dynamic confirm gate pattern used by the help workflow's
      // domain selection level: the domain list is not known at workflow authoring
      // time, so buttons are built at runtime from local_state.
      // When context_key is absent, confirm renders as typography-only (the
      // message is the prompt and the options array provides the buttons below).
      if (step.context_key) {
        const items = resolvePath(localState, step.context_key) ?? [];
        if (Array.isArray(items) && items.length > 0) {
          fields.push({
            type:    'actions',
            buttons: items.map(item => ({
              action: item.action,
              label:  item.label,
              style:  'default',
            })),
          });
        } else {
          fields.push({
            type:  'typography',
            value: '_(No domains registered yet — use /create-domain to add one)_',
          });
        }
      }
      // typography for the message is always added first (above the switch)
      // Static options buttons (Cancel etc.) are added after the switch — see below.
      break;
    }

    case 'review_object': {
      // Resolve the context and render as { key, value } pairs.
      // Handles two shapes:
      //   Flat object  — e.g. domainHelp: { domain, aliases, description, commands }
      //                  Each property becomes one key/value pair.
      //   Array of objects — e.g. tables: [{ tableName, columns, ... }]
      //                  Each element becomes one pair: tableName → column name list.
      //                  Uses step.item_primary_key (default: first string property)
      //                  and step.item_secondary_key (default: 'columns') to resolve
      //                  the label and value for each array element.
      const SYSTEM_KEYS = new Set(['id', 'created_at', 'updated_at',
        'columnSummary', 'domain', 'target', 'foreignKeys', 'constraints', 'triggers']);
      const ctx = step.context_key
        ? resolvePath(localState, step.context_key) ?? {}
        : {};

      let items;
      if (Array.isArray(ctx)) {
        // Array of objects — render each as label → value.
        // item_label_template: optional "step {{step}} — {{field}}" pattern;
        //   resolves {{key}} placeholders against each item's own properties.
        // item_primary_key: fallback single-field label (default: 'tableName').
        // item_secondary_key: value field (default: 'columns').
        const labelTemplate = step.item_label_template ?? null;
        const primaryKey    = step.item_primary_key    ?? 'tableName';
        const secondaryKey  = step.item_secondary_key  ?? 'columns';
        items = ctx.map(item => {
          const label = labelTemplate
            ? labelTemplate.replace(/\{\{(\w+)\}\}/g, (_, k) => item[k] ?? '')
            : (item[primaryKey] ?? String(item));
          const raw   = item[secondaryKey];
          let value;
          if (Array.isArray(raw)) {
            // columns array — extract .name from each column, skip system cols
            value = raw
              .map(c => (typeof c === 'object' ? c.name : String(c)))
              .filter(n => !SYSTEM_KEYS.has(n));
          } else {
            value = raw ?? '';
          }
          return { key: label, value };
        });
      } else {
        // Flat object — each non-system property is one pair.
        // Nested objects and arrays are JSON-stringified for display — prevents
        // '[object Object]' when a review_object gate receives structured data
        // (e.g. parsed_entity: { root: {...}, children: {...} }).
        items = Object.entries(ctx)
          .filter(([k, v]) => !SYSTEM_KEYS.has(k) && v !== null && v !== undefined)
          .map(([k, v]) => ({
            key:   k,
            value: (v !== null && typeof v === 'object') ? JSON.stringify(v, null, 2) : v,
          }));
      }

      if (items.length > 0) {
        fields.push({ type: 'review_object', items });
      }
      break;
    }

    default:
      console.warn('step-executor: unknown gate_type for dialog build', { gateType: step.gate_type });
  }

  // actions — from step.options
  // step.options may be a template string (e.g. "{{item.options}}") when the gate
  // lives inside an iterator item_step — resolve it before mapping.
  const resolvedOptions = typeof step.options === 'string'
    ? (resolvePath(localState, step.options.replace(/^{{|}}$/g, '')) ?? [])
    : (step.options ?? []);
  fields.push({
    type:    'actions',
    // o.modal is forwarded when present so callback.mjs can encode it into the
    // button value, enabling interactive.mjs to open a modal generically.
    buttons: resolvedOptions.map(o => ({
      action: o.action,
      label:  o.label,
      style:  o.action === 'confirm' ? 'primary' : 'default',
      ...(o.modal ? { modal: o.modal } : {}),
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
    outputValue: resp.row ?? { tableName, inserted: true, id: null },
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
// serv_entity_query — listEntities via SERV-Entity
// ---------------------------------------------------------------------------

// Step input shape:
//   {
//     "entityName": "Recipe",
//     "filters":    [ { "column": "name", "op": "like", "value": "{{input.search}}" } ],
//     "orderBy":    { "column": "name", "direction": "asc" },
//     "limit":      20
//   }
//
// entityName is required. filters, orderBy, limit are optional.
// Returns assembled entities — root columns + jsonb_agg child arrays.
// entities array is written to local_state[output_key].

async function executeServEntityQuery({ step, localState, traceId }) {
  const resolvedInput = resolveInput(step.input ?? {}, localState);
  const { entityName, filters, orderBy, limit } = resolvedInput;

  if (!entityName) throw new Error('serv_entity_query step missing input.entityName');

  console.info('step-executor: serv_entity_query', {
    entityName,
    filterCount: filters?.length ?? 0,
    traceId,
  });

  const resp = await listEntities(entityName, filters ?? [], orderBy, limit);

  if (!resp.success) {
    throw new Error(`serv_entity_query failed for "${entityName}": ${resp.error ?? resp.statusCode}`);
  }

  return {
    outputValue: resp.entities ?? [],
    nextAction:  resolveNextAction(step.on_success, null),
  };
}

// ---------------------------------------------------------------------------
// serv_entity_get — getEntity by id via SERV-Entity
// ---------------------------------------------------------------------------

// Step input shape:
//   {
//     "entityName": "Recipe",
//     "id":         "{{input.id}}"
//   }
//
// entityName and id are required.
// Returns the single assembled entity object (root + children) at output_key.

async function executeServEntityGet({ step, localState, traceId }) {
  const resolvedInput = resolveInput(step.input ?? {}, localState);
  const { entityName, id } = resolvedInput;

  if (!entityName) throw new Error('serv_entity_get step missing input.entityName');
  if (id === undefined || id === null) throw new Error('serv_entity_get step missing input.id');

  console.info('step-executor: serv_entity_get', { entityName, id, traceId });

  const resp = await getEntityById(entityName, id);

  if (!resp.success) {
    // Not-found is not a workflow error — write null to output_key and route
    // on_success so downstream steps (e.g. formatRecordList) produce a
    // user-friendly "No records found." message rather than failing the run.
    const isNotFound = typeof resp.error === 'string'
      && /not found/i.test(resp.error);
    if (isNotFound) {
      console.info('step-executor: serv_entity_get — not found', { entityName, id, traceId });
      return {
        outputValue: [],   // empty array — formatRecordList renders "No records found."
        nextAction:  resolveNextAction(step.on_success, null),
      };
    }
    throw new Error(`serv_entity_get failed for "${entityName}" id=${id}: ${resp.error ?? resp.statusCode}`);
  }

  return {
    outputValue: resp.entity ?? null,
    nextAction:  resolveNextAction(step.on_success, null),
  };
}

// ---------------------------------------------------------------------------
// serv_entity_schema — load full entity schema from PGC_EntitySchema + PGC_Schema
// ---------------------------------------------------------------------------

/**
 * Reads PGC_EntitySchema for join topology then PGC_Schema for live column
 * definitions across root and all child tables. Assembles and returns a full
 * entity schema object used by downstream llm_call steps (e.g. parse_entity_input).
 *
 * Replaces the two-step serv_query PGC_EntitySchema → js_transform buildEntitySchema
 * pattern. I/O does not belong in js_transform.
 *
 * Output shape written to output_key:
 *   {
 *     entity_name, description,
 *     root:     { table, columns: [{ name, type }] },
 *     children: [{ table, alias, fk_column, output_key, columns: [{ name, type }] }]
 *   }
 *
 * System columns (id, created_at, updated_at) and FK columns are excluded from
 * all column lists. Column definitions are read live — not cached — so new columns
 * are immediately visible without recreating the domain.
 */
async function executeServEntitySchema({ step, localState, traceId }) {
  const resolvedInput = resolveInput(step.input ?? {}, localState);
  const { entityName } = resolvedInput;

  if (!entityName) throw new Error('serv_entity_schema step missing input.entityName');

  // Load entity topology from PGC_EntitySchema
  const entityResp = await getRows(
    'PGC_EntitySchema',
    [{ column: 'entity_name', op: 'eq', value: entityName }],
    undefined,
    1
  );
  if (!entityResp.success || (entityResp.count ?? 0) === 0) {
    throw new Error(`serv_entity_schema: entity "${entityName}" not found in PGC_EntitySchema`);
  }
  const entitySchema  = entityResp.rows[0];
  const rootTable     = entitySchema.root_table;
  const joins         = Array.isArray(entitySchema.joins)        ? entitySchema.joins        : [];
  const aggregations  = Array.isArray(entitySchema.aggregations) ? entitySchema.aggregations : [];

  // Load live column definitions for all tables in one query
  const allTables = [rootTable, ...joins.map(j => j.table)].filter(Boolean);
  const schemaResp = await getRows(
    'PGC_Schema',
    [{ column: 'table_name', op: 'in', value: allTables }],
    undefined,
    allTables.length + 1
  );
  if (!schemaResp.success) {
    throw new Error(`serv_entity_schema: PGC_Schema query failed: ${schemaResp.error}`);
  }

  // Build tableName → column array lookup
  const schemaByTable = {};
  for (const row of schemaResp.rows ?? []) {
    schemaByTable[row.table_name] = row.columns ?? [];
  }

  // Returns non-system, non-FK { name, type } columns for a table
  const SYSTEM = new Set(['id', 'created_at', 'updated_at']);
  function userColumns(tableName, fkColumnsToExclude = []) {
    const exclude = new Set([...SYSTEM, ...fkColumnsToExclude]);
    return (schemaByTable[tableName] ?? [])
      .filter(c => !exclude.has(c.name))
      .map(c => ({ name: c.name, type: c.type }));
  }

  const rootColumns = userColumns(rootTable);

  const children = joins.map(join => {
    const agg = aggregations.find(a => a.alias === join.alias) ?? {};

    // FK column from PGC_Schema foreign_keys, or parsed from join.on expression
    const childSchemaRow = (schemaResp.rows ?? []).find(r => r.table_name === join.table);
    const fkCols = (childSchemaRow?.foreign_keys ?? []).map(fk => fk.column);
    if (fkCols.length === 0 && join.on) {
      const onMatch = join.on.match(/(\w+)\.(\w+)\s*=\s*r\.id/);
      if (onMatch) fkCols.push(onMatch[2]);
    }

    return {
      table:      join.table,
      alias:      join.alias,
      fk_column:  fkCols[0] ?? null,
      output_key: agg.outputKey ?? join.alias,
      columns:    userColumns(join.table, fkCols),
    };
  });

  const result = {
    entity_name:  entitySchema.entity_name,
    description:  entitySchema.description,
    root:         { table: rootTable, columns: rootColumns },
    children,
  };

  console.info('step-executor: serv_entity_schema', {
    entityName,
    rootTable,
    childCount: children.length,
    traceId,
  });

  return {
    outputValue: result,
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
// simulate — dry-run a workflow step array (Section 6.4.6)
// ---------------------------------------------------------------------------
//
// Three validation levels run in strict order — later levels only run if
// earlier levels pass.
//
//   Level 1 — Static analysis (no mocks needed)
//     Seven structural checks on the step array itself.
//     Returns immediately on failure — no path execution occurs.
//
//   Level 2 — Path execution (uses mock_outputs + simulation_paths)
//     Walks each named path, injecting mocks instead of calling real services.
//     Tracks local_state transitions. Fails if a template variable is
//     unresolvable or if the actual terminal != expected_terminal.
//
//   Level 3 — Skip-path analysis (advisory only)
//     For every step with on_failure: "human_feedback", simulates what happens
//     if the user chooses Skip at the recovery gate. Flags downstream steps
//     that read output_key values that would be null if the step was skipped.
//     Non-fatal — included in result but does not flip passed to false.
//
// simulation_mode flag: run.state.simulation_mode is set true before path
// execution begins and cleared after. All step handlers already check this
// flag (returning mock output instead of calling real services). The simulate
// handler itself reads mock outputs from local_state — it does not call SERV
// or LLM. Simulation is entirely in-process.

// Known valid routing token pattern — "next", "end", "cancel",
// "human_feedback", or "step:<key>" where <key> is a non-empty string.
const ROUTING_TOKEN_RE = /^(next|end|cancel|human_feedback|step:.+)$/;

async function executeSimulate({ step, localState, run, traceId }) {
  // ── Resolve inputs from local_state ─────────────────────────────────────
  const stepsKey       = step.input?.steps_key;
  const mockOutputsKey = step.input?.mock_outputs_key;   // optional
  const pathsKey       = step.input?.paths_key;          // optional

  if (!stepsKey) {
    throw new Error('simulate step missing input.steps_key');
  }

  const steps       = resolvePath(localState, stepsKey);
  const mockOutputs = mockOutputsKey ? resolvePath(localState, mockOutputsKey) : null;
  const simPaths    = pathsKey       ? resolvePath(localState, pathsKey)       : null;

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`simulate: steps_key "${stepsKey}" did not resolve to a non-empty array`);
  }

  const result = runSimulation({
    steps,
    mockOutputs,
    simulationPaths: simPaths,
    runInput: run?.input ?? {},
    traceId,
  });

  const passed = result.passed;
  return {
    outputValue: result,
    nextAction:  passed
      ? resolveNextAction(step.on_success, null)
      : resolveNextAction(step.on_failure ?? 'next', null),
  };
}

// ---------------------------------------------------------------------------
// runSimulation — exported for the HTTP simulate-workflow endpoint.
// Called identically from executeSimulate (step type) and simulate-workflow.mjs
// (standalone HTTP handler). No WorkflowRun required.
//
// @param {object[]} steps           — workflow step array to validate
// @param {object|null} mockOutputs  — mock outputs keyed by step number string
// @param {object[]|null} simulationPaths — named execution paths
// @param {object} runInput          — simulated run.input (available as {{input.*}})
// @param {string} [traceId]
// @returns {SimulateWorkflowResponse}
// ---------------------------------------------------------------------------

export function runSimulation({ steps, mockOutputs, simulationPaths, runInput = {}, traceId }) {
  console.info('step-executor: runSimulation — starting', {
    stepCount: steps.length,
    hasMocks:  !!mockOutputs,
    pathCount: Array.isArray(simulationPaths) ? simulationPaths.length : 0,
    traceId,
  });

  // ── Level 1 — Static analysis ────────────────────────────────────────────
  const staticIssues = runLevel1StaticAnalysis(steps);

  if (staticIssues.length > 0) {
    console.info('step-executor: runSimulation — Level 1 failed', {
      issueCount: staticIssues.length, traceId,
    });
    return {
      passed:          false,
      paths_run:       0,
      paths_passed:    0,
      paths_failed:    0,
      static_analysis: { passed: false, issues: staticIssues },
      path_results:    [],
      skip_path_warnings: [],
    };
  }

  // Level 1 passed — if no paths supplied, return Level 1 result only.
  // mockOutputs is optional — Level 2 runs whenever simulationPaths is present,
  // injecting null mock output for steps that have no entry in mockOutputs.
  if (!Array.isArray(simulationPaths) || simulationPaths.length === 0) {
    console.info('step-executor: runSimulation — Level 1 only (no paths provided)', { traceId });
    return {
      passed:          true,
      paths_run:       0,
      paths_passed:    0,
      paths_failed:    0,
      static_analysis: { passed: true, issues: [] },
      path_results:    [],
      skip_path_warnings: [],
    };
  }

  // ── Level 2 — Path execution ─────────────────────────────────────────────
  const pathResults = simulationPaths.map(
    path => executeSimPath(steps, path, mockOutputs, runInput)
  );

  const pathsPassed  = pathResults.filter(r => r.passed).length;
  const pathsFailed  = pathResults.filter(r => !r.passed).length;
  const level2Passed = pathsFailed === 0;

  // ── Level 3 — Skip-path analysis (advisory) ──────────────────────────────
  const skipPathWarnings = level2Passed
    ? runLevel3SkipPathAnalysis(steps, mockOutputs, runInput)
    : [];

  const result = {
    passed:          level2Passed,
    paths_run:       pathResults.length,
    paths_passed:    pathsPassed,
    paths_failed:    pathsFailed,
    static_analysis: { passed: true, issues: [] },
    path_results:    pathResults,
    skip_path_warnings: skipPathWarnings,
  };

  console.info('step-executor: runSimulation — complete', {
    passed: result.passed, pathsRun: result.paths_run,
    pathsPassed, pathsFailed, warnings: skipPathWarnings.length, traceId,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Level 1 — Static analysis
// ---------------------------------------------------------------------------

function runLevel1StaticAnalysis(steps) {
  const issues = [];

  // Build a set of all step keys for dead-target checking
  const stepKeys = new Set(steps.map(s => String(s.step)));

  // Build the set of output_key values written by each step at each point
  // in the canonical (top-to-bottom) execution order. This is a conservative
  // approximation — it does not model branching. It catches the common case
  // where a template references a key that is never written by any prior step.
  const outputKeysSoFar = new Set(['input']); // run.input is always available

  for (const s of steps) {
    const stepKey = String(s.step);

    // Check every routing value on this step
    const routingValues = [];
    if (s.on_success) routingValues.push({ field: 'on_success', value: s.on_success });
    if (s.on_failure) routingValues.push({ field: 'on_failure', value: s.on_failure });
    if (s.on_complete) routingValues.push({ field: 'on_complete', value: s.on_complete });
    if (s.type === 'condition') {
      // on_truthy/on_falsy are bare step keys — normalise to step:N for ROUTING_TOKEN_RE validation
      if (s.on_truthy) routingValues.push({ field: 'on_truthy', value: `step:${s.on_truthy}` });
      if (s.on_falsy)  routingValues.push({ field: 'on_falsy',  value: `step:${s.on_falsy}`  });
    }
    for (const opt of s.options ?? []) {
      if (opt.on_select) routingValues.push({ field: `options[${opt.action}].on_select`, value: opt.on_select });
    }

    for (const { field, value } of routingValues) {
      if (!ROUTING_TOKEN_RE.test(String(value))) {
        issues.push({
          check:         'unknown_routing_value',
          step:          stepKey,
          failure_class: 'unknown_routing_value',
          detail:        `Step "${stepKey}" field "${field}" has unknown routing value "${value}". Valid values: next, end, cancel, human_feedback, step:<key>`,
        });
      }
      // Check dead step:N targets
      if (String(value).startsWith('step:')) {
        const target = String(value).slice(5);
        if (!stepKeys.has(target)) {
          issues.push({
            check:         'dead_routing_target',
            step:          stepKey,
            failure_class: 'dead_routing_target',
            detail:        `Step "${stepKey}" field "${field}" routes to "step:${target}" but no step with key "${target}" exists`,
          });
        }
      }
    }

    // Check items_key for iterator steps
    if (s.type === 'iterator') {
      const baseKey = (s.items_key ?? '').split('.')[0];
      if (baseKey && !outputKeysSoFar.has(baseKey)) {
        issues.push({
          check:         'iterator_source_not_array',
          step:          stepKey,
          failure_class: 'iterator_source_not_array',
          detail:        `Iterator step "${stepKey}" items_key "${s.items_key}" — base key "${baseKey}" has not been written by any prior step. Available keys: ${[...outputKeysSoFar].join(', ')}`,
        });
      }
    }

    // Check gate has at least one cancel option
    if (s.type === 'human_gate') {
      const hasCancel = (s.options ?? []).some(o => o.action === 'cancel');
      if (!hasCancel) {
        issues.push({
          check:         'missing_cancel_option',
          step:          stepKey,
          failure_class: 'missing_cancel_option',
          detail:        `human_gate step "${stepKey}" has no option with action "cancel"`,
        });
      }

      // review_object and confirm gates must not have output_key
      if ((s.gate_type === 'review_object' || s.gate_type === 'confirm') && s.output_key) {
        issues.push({
          check:         'gate_output_key_invalid',
          step:          stepKey,
          failure_class: 'gate_output_key_invalid',
          detail:        `Gate type "${s.gate_type}" on step "${stepKey}" has output_key but this gate type does not write to local_state. Only text_input gates write output_key.`,
        });
      }
    }

    // Check template variables in message_template and input values
    const templatesToCheck = [];
    if (s.message_template) templatesToCheck.push(s.message_template);
    if (s.context_key)      templatesToCheck.push(`{{${s.context_key}}}`);
    if (typeof s.input === 'object' && s.input !== null) {
      Object.values(s.input).forEach(v => {
        if (typeof v === 'string') templatesToCheck.push(v);
      });
    }
    if (s.input_key) templatesToCheck.push(`{{${s.input_key}}}`);
    if (s.items_key) templatesToCheck.push(`{{${s.items_key}}}`);

    for (const template of templatesToCheck) {
      const refs = extractTemplateRefs(template);
      for (const ref of refs) {
        const baseKey = ref.split('.')[0];
        if (baseKey !== 'item' && baseKey !== 'input' && !outputKeysSoFar.has(baseKey)) {
          issues.push({
            check:         'unresolved_template_variable',
            step:          stepKey,
            failure_class: 'unresolved_template_variable',
            detail:        `Step "${stepKey}" references "{{${ref}}}" but base key "${baseKey}" has not been written by any prior step. Available keys: ${[...outputKeysSoFar].join(', ')}`,
            suggestion:    findClosestKey([...outputKeysSoFar], baseKey),
          });
        }
      }
    }

    // Register this step's output_key for downstream steps
    if (s.output_key) {
      const baseOut = s.output_key.split('.')[0];
      outputKeysSoFar.add(baseOut);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Level 2 — Path execution
// ---------------------------------------------------------------------------

function executeSimPath(steps, path, mockOutputs, runInput) {
  const localState     = { input: runInput };
  const transitions    = [];
  let stepVisits       = {};  // step_key → visit count, for loop detection
  let decisionIndex    = 0;

  // Build a map from step key to step definition for fast lookup
  const stepMap = Object.fromEntries(steps.map(s => [String(s.step), s]));

  // Start at the first step
  let currentKey = String(steps[0].step);
  let stepsExecuted = 0;
  const MAX_STEPS = steps.length * 10; // safety valve against infinite loops

  while (stepsExecuted < MAX_STEPS) {
    stepsExecuted++;

    if (currentKey === 'end' || currentKey === 'cancel' || currentKey === 'human_feedback') {
      break;
    }

    const currentStep = stepMap[currentKey];
    if (!currentStep) {
      return {
        path_name:           path.path_name,
        passed:              false,
        steps_executed:      stepsExecuted,
        terminal:            currentKey,
        expected_terminal:   path.expected_terminal,
        failure_step:        currentKey,
        failure_reason:      `Routing reached step key "${currentKey}" which does not exist in the step array`,
        local_state_transitions: transitions,
      };
    }

    stepVisits[currentKey] = (stepVisits[currentKey] ?? 0) + 1;

    const keysBefore = Object.keys(localState);
    let nextKey;
    let transition = {
      step:                    currentKey,
      type:                    currentStep.type,
      keys_before:             [...keysBefore],
      keys_added:              [],
      template_vars_resolved:  {},
      template_vars_missing:   [],
      status:                  'ok',
    };

    // Find the matching decision entry for this step (if any)
    const decision = (path.decisions ?? []).find(d => String(d.step) === currentKey);

    if (currentStep.type === 'end') {
      transitions.push({ ...transition });
      currentKey = 'end';
      break;
    }

    if (currentStep.type === 'human_gate') {
      if (!decision || decision.outcome !== 'gate') {
        // No decision for this gate — path is underspecified
        transition.status = 'failed';
        transitions.push(transition);
        return {
          path_name:           path.path_name,
          passed:              false,
          steps_executed:      stepsExecuted,
          terminal:            currentKey,
          expected_terminal:   path.expected_terminal,
          failure_step:        currentKey,
          failure_reason:      `Path "${path.path_name}" has no decision entry for human_gate step "${currentKey}" — add { step: "${currentKey}", outcome: "gate", user_response: "...", on_select: "..." }`,
          local_state_transitions: transitions,
        };
      }

      // For text_input gates, write the value to local_state
      if (currentStep.gate_type === 'text_input' && decision.output_key) {
        localState[decision.output_key] = decision.value ?? '';
        transition.keys_added.push(decision.output_key);
      }

      // Resolve next step from on_select
      const onSelect = decision.on_select;
      nextKey = resolveSimNextKey(steps, currentKey, onSelect);
      if (onSelect === 'cancel')           currentKey = 'cancel';
      else if (onSelect === 'end')         currentKey = 'end';
      else                                 currentKey = nextKey;

      transitions.push(transition);
      continue;
    }

    if (currentStep.type === 'notify') {
      // notify is a side-effect — advance to next, no output_key
      // condition steps have no on_success — follow on_truthy (happy path) for simulation
    const simNextAction = currentStep.type === 'condition'
      ? (currentStep.on_truthy ? `step:${currentStep.on_truthy}` : 'next')
      : (currentStep.on_success ?? 'next');
    nextKey = resolveSimNextKey(steps, currentKey, simNextAction);
      transitions.push(transition);
      currentKey = nextKey;
      continue;
    }

    if (currentStep.type === 'iterator') {
      // Treat iterator as a single step — output_key is written with an empty array
      // (mocks for iterator items are not required; the data-flow check is approximate)
      if (currentStep.output_key) {
        const baseOut = currentStep.output_key.split('.')[0];
        localState[baseOut] = [];
        transition.keys_added.push(baseOut);
      }
      nextKey = resolveSimNextKey(steps, currentKey, currentStep.on_complete ?? 'next');
      transitions.push(transition);
      currentKey = nextKey;
      continue;
    }

    // For steps with a decision entry that signals failure
    if (decision?.outcome === 'failure') {
      const onFailure = currentStep.on_failure ?? 'next';
      nextKey = resolveSimNextKey(steps, currentKey, onFailure);
      if (onFailure === 'human_feedback') currentKey = 'human_feedback';
      else if (onFailure === 'cancel')    currentKey = 'cancel';
      else if (onFailure === 'end')       currentKey = 'end';
      else                                currentKey = nextKey;
      transition.status = 'failed';
      transitions.push(transition);
      continue;
    }

    // Steps that produce output — inject mock output
    const mockKey = String(currentKey);
    const mockOutput = mockOutputs?.[mockKey] ?? null;

    // Validate that required template vars in this step's input resolve
    const templatesToCheck = [];
    if (typeof currentStep.input === 'object' && currentStep.input !== null) {
      Object.values(currentStep.input).forEach(v => {
        if (typeof v === 'string') templatesToCheck.push(v);
      });
    }

    for (const tmpl of templatesToCheck) {
      const refs = extractTemplateRefs(tmpl);
      for (const ref of refs) {
        const baseKey = ref.split('.')[0];
        if (baseKey !== 'item' && baseKey !== 'input' && !(baseKey in localState)) {
          transition.template_vars_missing.push(ref);
        } else if (baseKey in localState || baseKey === 'input') {
          transition.template_vars_resolved[ref] = String(localState[baseKey] ?? '').slice(0, 100);
        }
      }
    }

    if (transition.template_vars_missing.length > 0) {
      transition.status = 'failed';
      transitions.push(transition);
      return {
        path_name:           path.path_name,
        passed:              false,
        steps_executed:      stepsExecuted,
        terminal:            currentKey,
        expected_terminal:   path.expected_terminal,
        failure_step:        currentKey,
        failure_reason:      `Template variable(s) missing at step "${currentKey}": ${transition.template_vars_missing.join(', ')}. Available keys: ${Object.keys(localState).join(', ')}`,
        local_state_transitions: transitions,
      };
    }

    // Write mock output to local_state
    if (currentStep.output_key && mockOutput !== null) {
      const baseOut = currentStep.output_key.split('.')[0];
      if (!localState[baseOut]) {
        localState[baseOut] = mockOutput;
        transition.keys_added.push(baseOut);
      }
    }

    nextKey = resolveSimNextKey(steps, currentKey, currentStep.on_success ?? 'next');
    transitions.push(transition);
    currentKey = nextKey;
  }

  // Determine actual terminal
  let terminal;
  if (currentKey === 'end' || stepMap[currentKey]?.type === 'end') terminal = 'end';
  else if (currentKey === 'cancel') terminal = 'cancelled';
  else if (currentKey === 'human_feedback') terminal = 'human_feedback';
  else terminal = currentKey;

  const passed = terminal === path.expected_terminal;

  return {
    path_name:               path.path_name,
    passed,
    steps_executed:          stepsExecuted,
    terminal,
    expected_terminal:       path.expected_terminal,
    failure_step:            passed ? undefined : currentKey,
    failure_reason:          passed ? undefined : `Path ended at "${terminal}" but expected "${path.expected_terminal}"`,
    local_state_transitions: transitions,
  };
}

// ---------------------------------------------------------------------------
// Level 3 — Skip-path analysis (advisory)
// ---------------------------------------------------------------------------

function runLevel3SkipPathAnalysis(steps, mockOutputs, runInput) {
  const warnings = [];
  const stepMap  = Object.fromEntries(steps.map(s => [String(s.step), s]));

  for (const s of steps) {
    if (s.on_failure !== 'human_feedback') continue;

    // Simulate what happens if this step produces no output (user chose Skip)
    // then check if any downstream step reads its output_key
    if (!s.output_key) continue;

    const skippedKey = s.output_key.split('.')[0];

    for (const downstream of steps) {
      if (String(downstream.step) <= String(s.step)) continue; // only forward references

      const templatesToCheck = [];
      if (typeof downstream.input === 'object' && downstream.input !== null) {
        Object.values(downstream.input).forEach(v => {
          if (typeof v === 'string') templatesToCheck.push(v);
        });
      }
      if (downstream.items_key) templatesToCheck.push(`{{${downstream.items_key}}}`);
      if (downstream.context_key) templatesToCheck.push(`{{${downstream.context_key}}}`);

      for (const tmpl of templatesToCheck) {
        const refs = extractTemplateRefs(tmpl);
        if (refs.some(r => r.split('.')[0] === skippedKey)) {
          warnings.push({
            step:            String(s.step),
            downstream_step: String(downstream.step),
            missing_key:     s.output_key,
            detail:          `Step "${downstream.step}" reads "{{${s.output_key}}}" but step "${s.step}" is skippable via human_feedback. If step "${s.step}" is skipped, "${skippedKey}" will be null.`,
          });
          break; // one warning per downstream step is enough
        }
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Simulate helpers
// ---------------------------------------------------------------------------

/**
 * Extract all {{ref}} template variable names from a string.
 * Returns base paths only — "proposed_scaffold.domain" for "{{proposed_scaffold.domain}}".
 */
function extractTemplateRefs(template) {
  if (typeof template !== 'string') return [];
  const refs = [];
  const re   = /\{\{([^}]+)\}\}/g;
  let match;
  while ((match = re.exec(template)) !== null) {
    refs.push(match[1].trim());
  }
  return refs;
}

/**
 * Resolve the next step key for simulation (mirrors resolveNextStep in run-workflow.mjs
 * but operates purely on the steps array without DB access).
 */
function resolveSimNextKey(steps, currentKey, nextAction) {
  if (!nextAction || nextAction === 'next') {
    const idx = steps.findIndex(s => String(s.step) === String(currentKey));
    if (idx === -1 || idx === steps.length - 1) return 'end';
    return String(steps[idx + 1].step);
  }
  if (nextAction === 'end')                  return 'end';
  if (nextAction === 'cancel')               return 'cancel';
  if (nextAction === 'human_feedback')       return 'human_feedback';
  if (nextAction.startsWith('step:'))        return nextAction.slice(5);
  return 'end';
}

/**
 * Find the closest key to the search term by simple prefix/substring match.
 * Used to provide helpful suggestions in Level 1 errors.
 */
function findClosestKey(keys, search) {
  const exact = keys.find(k => k === search);
  if (exact) return exact;
  const prefix = keys.find(k => k.startsWith(search) || search.startsWith(k));
  if (prefix) return `Did you mean "{{${prefix}}}"?`;
  return null;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// condition
// ---------------------------------------------------------------------------

/**
 * Pure control-flow step — resolves a template expression against local_state
 * and routes to on_truthy or on_falsy without performing any I/O.
 *
 * Truthy: resolved value is non-empty string, not "null", not "undefined", not "0".
 * on_truthy / on_falsy must be bare step keys (e.g. "2", "3") — returned as "step:N".
 *
 * No output_key is written — condition steps produce no state output.
 */
function executeCondition({ step, localState, traceId }) {
  if (!step.expression) throw new Error('condition step missing expression');
  if (!step.on_truthy)  throw new Error('condition step missing on_truthy');
  if (!step.on_falsy)   throw new Error('condition step missing on_falsy');

  const resolved = resolveTemplate(step.expression, localState);
  // Treat unresolved template literals as falsy — resolveTemplate returns the
  // original {{token}} when the path is absent from local_state. A condition
  // step must not route truthy on a key that was never set.
  const isTruthy = resolved !== ''
    && resolved !== 'null'
    && resolved !== 'undefined'
    && resolved !== '0'
    && !resolved.includes('{{');

  const nextStep = isTruthy ? step.on_truthy : step.on_falsy;

  console.info('step-executor: condition', {
    expression: step.expression,
    resolved,
    isTruthy,
    nextStep,
    traceId,
  });

  return { outputValue: null, nextAction: `step:${nextStep}` };
}

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
