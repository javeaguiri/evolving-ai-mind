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
//   gatePayload  — set only for human_gate steps; the HUMAN_GATE message body
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
//   condition    — resolves expression, routes on_success/on_else — no I/O
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
import { servPost, getRows, insertRow, insertRows, updateRows, deleteRows, listEntities, getEntityById } from '../shared/serv-client.mjs';
import { executeLlmCall }               from './llm-harness.mjs';
import {
  resolvePath,
  resolveTemplate,
  resolveInput,
  evalItemCondition,
} from './template-resolver.mjs';
import { runSimulation, runLevel1StaticAnalysis } from './simulation-engine.mjs';

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
    case 'serv_entity_insert': return executeServEntityInsert({ step, localState, traceId });
    case 'serv_update':       return executeServUpdate({ step, localState, traceId });
    case 'serv_delete':  return executeServDelete({ step, localState, traceId });
    case 'simulate':     return executeSimulate({ step, localState, run, traceId });
    case 'notify':       return executeNotify({ step, localState, traceId });
    case 'write_memory': return executeWriteMemory({ step, localState, run, traceId });
    case 'end':          return { outputValue: null, nextAction: 'end' };
    case 'iterator':     return { outputValue: null, nextAction: 'iterator' };
    case 'condition':    return executeCondition({ step, localState, traceId });

    case 'sub_workflow':
      throw new Error(`step type "${step.type}" not yet implemented (Phase 3)`);

    default:
      throw new Error(`unknown step type: "${step.type}"`);
  }
}

// llm_call is handled by llm-harness.mjs (executeLlmCall imported above)

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
    if (!step.output_key) throw new Error('js_transform expression step missing output_key');
    // input_key is optional — expressions that read everything from local_state do not need it.
    const items  = step.input_key ? resolvePath(localState, step.input_key) : null;
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

  // Execute in isolated context. local_state and items are passed as JSON strings
  // so the V8 contextification step is fast regardless of local_state size.
  // JSON.parse inside the vm is a native built-in and adds only ~5–20ms overhead.
  // 500ms timeout covers JSON.parse + expression; still catches real infinite loops.
  const sandbox = {
    __ls: JSON.stringify(localState),
    __it: JSON.stringify(items ?? null),
    JSON, Math, Array, Object, String, Number, Boolean, Date,
  };
  const wrapped = `var local_state=JSON.parse(__ls);var items=JSON.parse(__it);(${expression})`;
  let result;
  try {
    result = vm.runInNewContext(wrapped, sandbox, { timeout: 500 });
  } catch (vmErr) {
    if (vmErr.message?.includes('Script execution timed out')) {
      throw new Error('js_transform expression: execution timed out after 500ms — possible infinite loop');
    }
    throw new Error(`js_transform expression: runtime error — ${vmErr.message}`);
  }

  console.info('step-executor: js_transform — expression', { traceId });
  return result;
}

// ---------------------------------------------------------------------------
// human_gate — builds HUMAN_GATE dialog
// ---------------------------------------------------------------------------

async function executeHumanGate({ step, localState, run, traceId }) {
  const gateType = step.gate_type;
  const dialog   = buildDialog(step, localState);

  const gatePayload = {
    type:          'HUMAN_GATE',
    workflowRunId: run.id,
    step:          String(step.step),
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
// Dialog builder — translates human_gate step intent into HUMAN_GATE dialog
// ---------------------------------------------------------------------------

/**
 * Build a fully resolved HUMAN_GATE dialog from a human_gate step definition.
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
      // label is the short Slack input element label — the full instructions are
      // already in the typography field above. multiline is required by callback.mjs
      // to set plain_text_input.multiline on the rendered Slack input block.
      fields.push({
        type:      'textbox',
        name:      'user_input',
        label:       step.input_label   ?? 'Your input',
        multiline:   step.multiline     ?? false,
        ...(step.placeholder ? { placeholder: step.placeholder } : {}),
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
        // Plain nested objects are expanded one level (e.g. parsed_entity.children →
        // children › cards, children › cardsides) so callback.mjs can apply smart
        // array summarisation (collapse empty {}, skip empty arrays) per sub-key.
        // Scalar and array values are passed through as-is.
        items = Object.entries(ctx)
          .filter(([k, v]) => !SYSTEM_KEYS.has(k) && v !== null && v !== undefined)
          .flatMap(([k, v]) => {
            if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
              // Expand one level — each child key becomes "parent › child"
              return Object.entries(v)
                .filter(([, sv]) => sv !== null && sv !== undefined)
                .map(([sk, sv]) => ({ key: `${k} › ${sk}`, value: sv }));
            }
            return [{ key: k, value: v }];
          });
      }

      if (items.length > 0) {
        fields.push({ type: 'review_object', items });
      }
      break;
    }

    case 'choice': {
      // Single-select with question heading, per-option descriptions, and lettered buttons.
      // Mirrors HTML radio button semantics: label displays, value is submitted.
      // Resolved options carry { value, label, description, on_select }.
      // description_list renders the explanation text above the buttons in the UI.
      const rawChoiceOptions = typeof step.options === 'string'
        ? (resolvePath(localState, step.options.replace(/^{{|}}$/g, '')) ?? [])
        : (step.options ?? []);
      const choiceItems = rawChoiceOptions
        .map(o => ({ value: o.value, label: o.label, description: resolveTemplate(o.description ?? '', localState) }));
      if (choiceItems.length > 0 && choiceItems.some(item => item.description)) {
        fields.push({ type: 'description_list', items: choiceItems });
      }
      // buttons for choice are built below — value used instead of action
      break;
    }

    case 'followup_prompt':
      // Typography field (always added above) is the only content needed.
      // callback.mjs adds the "Ask follow-up" button based on gate_type.
      break;

    default:
      console.warn('step-executor: unknown gate_type for dialog build', { gateType: step.gate_type });
  }

  // reveal — optional on any gate type. Single task_card above the gate buttons.
  if (step.reveal) {
    fields.push({
      type:         'reveal',
      button_label: step.reveal.button_label,
      content:      resolveTemplate(step.reveal.content ?? '', localState),
    });
  }

  // reveals — array of task_cards, one per entry (e.g. one per table).
  // Supports an inline array or a {{template}} reference to localState.
  const revealsArray = typeof step.reveals === 'string'
    ? (resolvePath(localState, step.reveals.replace(/^{{|}}$/g, '')) ?? [])
    : (Array.isArray(step.reveals) ? step.reveals : []);
  for (const r of revealsArray) {
    fields.push({
      type:         'reveal',
      button_label: r.button_label,
      content:      resolveTemplate(r.content ?? '', localState),
    });
  }

  // actions — from step.options
  // step.options may be a template string (e.g. "{{item.options}}") when the gate
  // lives inside an iterator item_step — resolve it before mapping.
  const resolvedOptions = typeof step.options === 'string'
    ? (resolvePath(localState, step.options.replace(/^{{|}}$/g, '')) ?? [])
    : (step.options ?? []);

  // Expand options that carry an iterator field — one button per row in
  // localState[o.iterator]. label and value are resolved against a merged
  // state (localState + item) so {{name}}, {{id}} etc. bind to the row.
  const expandedOptions = resolvedOptions.flatMap(o => {
    if (!o.iterator) return [o];
    const items = Array.isArray(localState[o.iterator]) ? localState[o.iterator] : [];
    return items.map(item => {
      const itemState = { ...localState, ...item };
      return {
        ...o,
        label:    resolveTemplate(String(o.label  ?? ''), itemState),
        value:    resolveTemplate(String(o.value  ?? ''), itemState),
        iterator: undefined,
      };
    });
  });

  // choice gate uses value as the identifier (HTML radio semantics); all other
  // gate types use action. Button style: primary for confirm/yes actions, default otherwise.
  const isChoice = step.gate_type === 'choice';
  const resolvedSpecialButtons = step.special_buttons ?? [];
  fields.push({
    type:    'actions',
    // o.modal forwarded so callback.mjs encodes it into button value for interactive.mjs.
    // special_buttons appended after options — appear in actions block only,
    // never in description_list or other content fields.
    buttons: [...expandedOptions, ...resolvedSpecialButtons].map(o => ({
      action: isChoice ? o.value : o.action,
      label:  o.label,
      style:  o.style ?? ((o.action === 'confirm' || o.value === 'confirm') ? 'primary' : 'default'),
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

  if (tableName === 'PGC_Workflow' && Array.isArray(row?.steps)) {
    const l1 = runLevel1StaticAnalysis(row.steps);
    if (l1.issues.length > 0) {
      throw Object.assign(
        new Error(`PGC_Workflow insert rejected — L1 validation failed (${l1.issues.length} issue(s))`),
        { l1Issues: l1.issues }
      );
    }
  }

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
 *     children: [{
 *       table, alias, fk_column, output_key, columns: [{ name, type }],
 *       parent,      // null = direct child of root; alias string = grandchild; 'self' = self-ref
 *       match_by,    // 'index' (cardsides[i] ↔ cards[i]) | 'self' (self-referential two-pass)
 *       fk_columns,  // present only when table has >1 FK: [{column, parent}]
 *       match_key,   // present only for self-ref: column used to resolve parent_<match_key>
 *     }]
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

  // Load live column definitions for all domain tables in one query.
  // Using domain filter ensures reference tables (no outgoing FKs, not in joins) are
  // included so their lookup columns can be resolved during child FK processing.
  const domain        = entitySchema.domain ?? null;
  const schemaFilter  = domain
    ? [{ column: 'domain', op: 'eq', value: domain }]
    : [{ column: 'table_name', op: 'in', value: [rootTable, ...joins.map(j => j.table)].filter(Boolean) }];
  const schemaResp = await getRows('PGC_Schema', schemaFilter, undefined, 50);
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

  // For a reference table, pick the best natural key column for name-matching.
  // Prefers columns named name/label/code/title, then falls back to first non-system column.
  function getLookupColumn(tableName) {
    const PREFERRED = new Set(['name', 'label', 'code', 'title']);
    const cols = (schemaByTable[tableName] ?? []).filter(c => !SYSTEM.has(c.name));
    return (cols.find(c => PREFERRED.has(c.name)) ?? cols[0])?.name ?? 'name';
  }

  const rootColumns = userColumns(rootTable);

  // table → alias lookup — used to resolve FK references to parent aliases
  const tableToAlias = Object.fromEntries(joins.map(j => [j.table, j.alias]));

  const children = joins.map(join => {
    const agg            = aggregations.find(a => a.alias === join.alias) ?? {};
    const childSchemaRow = (schemaResp.rows ?? []).find(r => r.table_name === join.table);

    // Collect all FK definitions with their referenced table
    let fkDefs = (childSchemaRow?.foreign_keys ?? []).map(fk => ({
      column:     fk.column,
      references: fk.references?.table ?? null,
    }));
    if (fkDefs.length === 0 && join.on) {
      const onMatch = join.on.match(/(\w+)\.(\w+)\s*=\s*r\.id/);
      if (onMatch) fkDefs.push({ column: onMatch[2], references: rootTable });
    }

    // Resolve parent alias for each FK:
    //   references root table → parent = null  (direct child of root)
    //   references self table → parent = 'self'  (self-referential)
    //   references another join table → parent = alias of that table
    //   references a table not in joins → reference table (resolved by name at insert time)
    const refFkCols = [];
    const regularFkColumns = [];
    for (const fk of fkDefs) {
      let parent;
      if (!fk.references || fk.references === rootTable) {
        parent = null;
        regularFkColumns.push({ column: fk.column, parent });
      } else if (fk.references === join.table) {
        parent = 'self';
        regularFkColumns.push({ column: fk.column, parent });
      } else if (tableToAlias[fk.references] != null) {
        parent = tableToAlias[fk.references];
        regularFkColumns.push({ column: fk.column, parent });
      } else {
        // FK targets a table not in joins — treat as reference table
        refFkCols.push({
          column:        fk.column,
          ref_table:     fk.references,
          lookup_column: getLookupColumn(fk.references),
        });
      }
    }

    // Primary FK: prefer the one pointing to root, otherwise the first one
    const primaryFk = regularFkColumns.find(f => f.parent === null) ?? regularFkColumns[0] ?? null;
    const isSelfRef = regularFkColumns.some(f => f.parent === 'self');
    const matchBy   = isSelfRef ? 'self' : 'index';

    // For self-referential: use aggregation match_key if provided, else first non-system column
    let matchKey;
    if (isSelfRef) {
      matchKey = agg.match_key ?? null;
      if (!matchKey) {
        const nonFk = (childSchemaRow?.columns ?? [])
          .filter(c => !['id', 'created_at', 'updated_at'].includes(c.name) &&
                       !fkDefs.map(f => f.column).includes(c.name));
        matchKey = nonFk[0]?.name ?? 'name';
      }
    }

    // Only exclude programmatically injected FK columns from the LLM's column list.
    // Ref FK columns must remain visible so the LLM can supply string name values
    // (e.g. ingredient_fk: "garlic") that are resolved to IDs before insert.
    const allFkCols = regularFkColumns.map(f => f.column);

    return {
      table:                join.table,
      alias:                join.alias,
      fk_column:            primaryFk?.column ?? null,
      ...(regularFkColumns.length > 1 ? { fk_columns: regularFkColumns } : {}),
      ...(refFkCols.length > 0        ? { ref_fk_columns: refFkCols }    : {}),
      parent:               isSelfRef ? 'self' : (primaryFk?.parent ?? null),
      match_by:             matchBy,
      ...(matchKey ? { match_key: matchKey } : {}),
      output_key:           agg.outputKey ?? join.alias,
      columns:              userColumns(join.table, allFkCols),
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
// serv_entity_insert — insert a multi-level entity with FK threading
// ---------------------------------------------------------------------------
//
// Handles n-level hierarchies and self-referential tables without any
// workflow-level glue. The entity schema (from serv_entity_schema) carries
// parent, match_by, fk_column(s) derived from PGC_Schema.foreign_keys.
//
// Step input shape:
//   {
//     "entitySchema": "{{full_entity_schema}}",  // from serv_entity_schema step
//     "parsedEntity": "{{parsed_entity}}"         // from parse_entity_input llm_call
//   }
//
// Output shape written to output_key:
//   { root_id, root_record, inserted_counts: { <alias>: <count>, ... } }

async function executeServEntityInsert({ step, localState, traceId }) {
  const resolvedInput = resolveInput(step.input ?? {}, localState);
  const { entitySchema, parsedEntity } = resolvedInput;

  if (!entitySchema) throw new Error('serv_entity_insert: entitySchema is required in input');
  if (!parsedEntity) throw new Error('serv_entity_insert: parsedEntity is required in input');

  // Insert root row
  const rootResult = await insertRow(entitySchema.root.table, parsedEntity.root ?? {});
  if (!rootResult.success) {
    throw new Error(`serv_entity_insert root insert failed for "${entitySchema.root.table}": ${rootResult.error}`);
  }
  const rootId = rootResult.row.id;

  // Map alias → inserted rows (needed to resolve FK chains)
  const insertedByAlias = {};
  const insertedCounts  = {};

  // Process children in dependency order
  const children = entitySchema.children ?? [];
  const ordered  = entityInsertTopoSort(children);

  for (const child of ordered) {
    const { table, alias, output_key, parent, match_by, fk_column, fk_columns, match_key } = child;
    const childRows = (parsedEntity.children ?? {})[output_key] ?? [];

    if (childRows.length === 0) {
      insertedByAlias[alias] = [];
      insertedCounts[alias]  = 0;
      continue;
    }

    // Self-referential: two-pass insert + update
    if (match_by === 'self' && fk_column) {
      const rows = await entityInsertSelfRef({
        table, childRows, fkColumn: fk_column, matchKey: match_key ?? 'name', traceId,
      });
      insertedByAlias[alias] = rows;
      insertedCounts[alias]  = rows.length;
      continue;
    }

    // Resolve primary parent rows for index-based FK injection
    const parentRows = parent
      ? (insertedByAlias[parent] ?? [])
      : [{ id: rootId }];

    // Prepare all rows with FK injected, then bulk-insert in one SQL statement
    const preparedRows = childRows.map((childRow, i) => {
      const row = { ...childRow };

      if (fk_columns && fk_columns.length > 1) {
        for (const fkDef of fk_columns) {
          const fkParentRows = fkDef.parent
            ? (insertedByAlias[fkDef.parent] ?? [])
            : [{ id: rootId }];
          const fkRow = fkParentRows[i] ?? fkParentRows[fkParentRows.length - 1] ?? { id: rootId };
          delete row[fkDef.column];
          row[fkDef.column] = fkRow.id;
        }
      } else if (fk_column) {
        const parentRow = parentRows[i] ?? parentRows[parentRows.length - 1] ?? { id: rootId };
        delete row[fk_column];
        row[fk_column] = parentRow.id;
      }

      return row;
    });

    // Resolve reference table FKs: string name values → integer IDs (find-or-create)
    const refFkColumns = child.ref_fk_columns ?? [];
    if (refFkColumns.length > 0) {
      for (const row of preparedRows) {
        for (const refFk of refFkColumns) {
          const raw = row[refFk.column];
          if (raw != null && typeof raw === 'string') {
            row[refFk.column] = await resolveRefTableId(refFk.ref_table, refFk.lookup_column, raw, traceId);
          }
        }
      }
    }

    const result = await insertRows(table, preparedRows);
    if (!result.success) {
      throw new Error(`serv_entity_insert failed for "${table}": ${result.error}`);
    }

    insertedByAlias[alias] = result.rows ?? [];
    insertedCounts[alias]  = (result.rows ?? []).length;
  }

  console.info('step-executor: serv_entity_insert complete', {
    rootTable: entitySchema.root.table,
    rootId,
    insertedCounts,
    traceId,
  });

  return {
    outputValue: {
      root_id:         rootId,
      root_record:     rootResult.row,
      inserted_counts: insertedCounts,
    },
  };
}

/**
 * Resolve a reference table FK: find an existing row by lookup_column = nameValue,
 * or insert a new row if none exists. Returns the integer PK.
 * Handles lookup tables (PGD_Ingredients, PGD_MeasurementUnits, etc.) whose string
 * values are supplied by the LLM and must be mapped to DB IDs before child insert.
 */
async function resolveRefTableId(refTable, lookupColumn, nameValue, traceId) {
  const existing = await getRows(refTable, [{ column: lookupColumn, op: 'eq', value: nameValue }], undefined, 1);
  if (existing.success && (existing.count ?? 0) > 0) return existing.rows[0].id;
  const inserted = await insertRow(refTable, { [lookupColumn]: nameValue });
  if (!inserted.success) {
    throw new Error(`serv_entity_insert: ref table insert failed for "${refTable}" (${lookupColumn}="${nameValue}"): ${inserted.error}`);
  }
  console.info('step-executor: serv_entity_insert created ref row', { refTable, lookupColumn, nameValue, traceId });
  return inserted.row.id;
}

/**
 * Topologically sort children by parent dependency.
 * A child is ready when ALL of its parent aliases are already placed.
 */
function entityInsertTopoSort(children) {
  const result  = [];
  const placed  = new Set([null]);   // null = root is always available
  const pending = [...children];

  while (pending.length > 0) {
    const before = pending.length;
    for (let i = pending.length - 1; i >= 0; i--) {
      const child = pending[i];
      // Collect all parent aliases this child depends on
      const parents = [
        child.parent ?? null,
        ...((child.fk_columns ?? []).map(f => f.parent ?? null)),
      ].filter(p => p !== 'self'); // self-ref depends only on itself
      if (parents.every(p => placed.has(p))) {
        result.push(child);
        placed.add(child.alias);
        pending.splice(i, 1);
      }
    }
    // Cycle or unresolvable dependency — append remainder to avoid infinite loop
    if (pending.length === before) {
      result.push(...pending);
      break;
    }
  }
  return result;
}

/**
 * Two-pass insert for self-referential tables.
 * Pass 1: insert all rows without the self-reference FK.
 * Pass 2: resolve parent references by match_key and update the FK.
 *
 * Each row may carry a `parent_<matchKey>` field containing the match_key
 * value of its parent row. The framework strips it and resolves the real FK.
 */
async function entityInsertSelfRef({ table, childRows, fkColumn, matchKey, traceId }) {
  const keyToId  = {};
  const inserted = [];

  // Pass 1: strip self-ref fields and bulk-insert all rows without the FK
  const parentRefs = [];
  const preparedRows = childRows.map(rawRow => {
    const row = { ...rawRow };
    parentRefs.push(row[`parent_${matchKey}`] ?? null);
    delete row[fkColumn];
    delete row[`parent_${matchKey}`];
    return row;
  });

  const batchResult = await insertRows(table, preparedRows);
  if (!batchResult.success) {
    throw new Error(`serv_entity_insert (self-ref) failed for "${table}": ${batchResult.error}`);
  }

  for (let i = 0; i < batchResult.rows.length; i++) {
    const id = batchResult.rows[i].id;
    keyToId[childRows[i][matchKey]] = id;
    inserted.push({ id, parentRef: parentRefs[i] });
  }

  // Pass 2: update FK for rows that reference a parent
  for (const { id, parentRef } of inserted) {
    if (!parentRef) continue;
    const parentId = keyToId[parentRef];
    if (!parentId) {
      console.warn('step-executor: serv_entity_insert self-ref parent not found', {
        table, fkColumn, parentRef, traceId,
      });
      continue;
    }
    await updateRows(table, [{ column: 'id', op: 'eq', value: id }], { [fkColumn]: parentId });
  }

  return inserted.map(({ id }) => ({ id }));
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

  if (tableName === 'PGC_Workflow' && Array.isArray(updates?.steps)) {
    const l1 = runLevel1StaticAnalysis(updates.steps);
    if (l1.issues.length > 0) {
      throw Object.assign(
        new Error(`PGC_Workflow update rejected — L1 validation failed (${l1.issues.length} issue(s))`),
        { l1Issues: l1.issues }
      );
    }
  }

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
//
// simulation_mode flag: run.state.simulation_mode is set true before path
// execution begins and cleared after. All step handlers already check this
// flag (returning mock output instead of calling real services). The simulate
// handler itself reads mock outputs from local_state — it does not call SERV
// or LLM. Simulation is entirely in-process.

async function executeSimulate({ step, localState, run, traceId }) {
  // ── Resolve inputs from local_state ─────────────────────────────────────
  const stepsKey       = step.input?.steps_key;
  const mockOutputsKey = step.input?.mock_outputs_key;   // optional
  const pathsKey       = step.input?.paths_key;          // optional
  const skeleton       = step.input?.skeleton === true;  // optional — skips serv required-field checks

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
    skeleton,
    traceId,
  });

  const passed = result.passed;
  return {
    outputValue: result,
    nextAction:  passed
      ? resolveNextAction(step.on_success, null)
      : resolveNextAction(step.on_else ?? 'next', null),
  };
}

// ---------------------------------------------------------------------------
// condition
// ---------------------------------------------------------------------------

/**
 * Pure control-flow step — evaluates an expression against local_state and
 * routes to on_success or on_else without performing any I/O.
 *
 * Two evaluation paths determined by whether the expression contains '{{':
 *
 *   Template path  (expression contains '{{'):
 *     Resolved via resolveTemplate. Truthy when non-empty and not one of the
 *     canonical falsy strings: "null", "undefined", "0", "false", or an
 *     unresolved "{{token}}". Preserves backwards-compatible behaviour for all
 *     existing {{token}} condition steps.
 *
 *   JS path (no '{{' in expression):
 *     Evaluated in the same sandboxed vm context as js_transform — local_state
 *     is available. Accepts any valid JS boolean expression the LLM naturally
 *     produces, e.g. local_state.items.length === 0 or count > 5 && active.
 *     If evaluation throws the step routes to on_else and logs the error.
 *
 * on_success / on_else accept any routing token (next, end, cancel, step:N,
 * or a bare step key). step:N format normalises to a bare key before return.
 *
 * No output_key is written — condition steps produce no state output.
 */
function executeCondition({ step, localState, traceId }) {
  if (!step.expression) throw new Error('condition step missing expression');
  if (!step.on_success) throw new Error('condition step missing on_success');
  if (!step.on_else)    throw new Error('condition step missing on_else');

  const usesTemplate = step.expression.includes('{{');
  let isTruthy;

  if (usesTemplate) {
    const resolved = resolveTemplate(step.expression, localState);
    isTruthy = resolved !== ''
      && resolved !== 'null'
      && resolved !== 'undefined'
      && resolved !== '0'
      && resolved !== 'false'
      && !resolved.includes('{{');

    console.info('step-executor: condition', {
      expression: step.expression,
      resolved,
      isTruthy,
      nextStep: String(isTruthy ? step.on_success : step.on_else).replace(/^step:/, ''),
      traceId,
    });
  } else {
    try {
      const result = runSandboxedExpression(step.expression, null, localState, traceId);
      isTruthy = Boolean(result);
    } catch (err) {
      console.warn('step-executor: condition js eval failed — routing falsy', {
        expression: step.expression,
        error: err.message,
        traceId,
      });
      isTruthy = false;
    }

    console.info('step-executor: condition', {
      expression: step.expression,
      evalMode:   'js',
      isTruthy,
      nextStep: String(isTruthy ? step.on_success : step.on_else).replace(/^step:/, ''),
      traceId,
    });
  }

  const rawNext  = isTruthy ? step.on_success : step.on_else;
  const bareNext = String(rawNext).startsWith('step:') ? String(rawNext).slice(5) : String(rawNext);

  return { outputValue: null, nextAction: `step:${bareNext}` };
}

async function executeNotify({ step, localState, traceId }) {
  const message = resolveTemplate(step.message_template ?? step.message ?? '', localState);

  console.info('step-executor: notify', { traceId });

  // run-workflow.mjs will enqueue the HUMAN_NOTIFICATION to SlackResultsQueue
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
  // Bare step key — pass through so resolveNextStep can handle the direct jump.
  return onSuccess;
}

// ---------------------------------------------------------------------------
// write_memory — persist a memory record to PGC_Memory (never fails the run)
// ---------------------------------------------------------------------------

/**
 * Build the PGC_Memory row from a write_memory step and current local_state.
 * Pure — no I/O. Exported for unit testing.
 *
 * @param {object} step       write_memory step definition
 * @param {object} localState Current frame local_state
 * @returns {object}          Row ready for insertRow('PGC_Memory', row)
 */
export function buildMemoryRow(step, localState) {
  const input = resolveInput(step.input ?? {}, localState);
  const {
    memory_type     = 'semantic',
    scope           = {},
    content_key,
    tags            = [],
    priority        = 5,
    source_workflow = null,
    source_step     = null,
  } = input;
  const content        = content_key ? String(localState[content_key] ?? '') : '';
  const token_estimate = Math.ceil(content.length / 4);
  return { memory_type, scope, content, tags, priority, token_estimate, source_workflow, source_step };
}

async function executeWriteMemory({ step, localState, run, traceId }) {
  try {
    const row = buildMemoryRow(step, localState);
    row.source_run_id = run?.id ?? null;

    const input = resolveInput(step.input ?? {}, localState);
    if (input.expire_prior === true) {
      const expireFilters = [
        { column: 'scope',       op: 'jsonb_contains', value: row.scope },
        { column: 'expires_at',  op: 'is_null' },
      ];
      if (row.tags?.length > 0) {
        expireFilters.push({ column: 'tags', op: 'jsonb_contains', value: row.tags });
      }
      const expireResp = await updateRows('PGC_Memory', expireFilters, { expires_at: new Date().toISOString() });
      if (!expireResp.success) {
        console.warn('step-executor: write_memory expire_prior failed (non-fatal)', { error: expireResp.error, traceId });
      }
    }

    console.info('step-executor: write_memory', { memory_type: row.memory_type, traceId });

    const resp = await insertRow('PGC_Memory', row);
    if (!resp.success) {
      console.warn('step-executor: write_memory insert failed (non-fatal)', { error: resp.error, traceId });
    }
  } catch (e) {
    console.warn('step-executor: write_memory error (non-fatal)', { error: e.message, traceId });
  }
  return {
    outputValue: null,
    nextAction:  resolveNextAction(step.on_success ?? 'end', null),
  };
}
