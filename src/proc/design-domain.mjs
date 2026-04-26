// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/design-domain.mjs
// Handles POST /api/v1/proc/design-domain (HTTP) and
//         DESIGN_DOMAIN SQS WorkflowQueue messages (async).
//
// Transport-agnostic — no AWS SDK, no Slack SDK imports.
// UI-neutral — no Block Kit, no mrkdwn, no Slack action_ids.
// PROC emits structured data describing what the user needs to see and act on.
// The Experience tier (callback.mjs) translates that into the target UI format.
//
// Flow:
//   1. Validate userInput
//   2. Resolve create_domain workflow_id from PGC_Workflow
//   3. Insert PGC_WorkflowRun row (status: running)
//   4. Load create_domain prompt from PGC_Prompt
//   5. Call LLM → proposed_scaffold
//   6. Call review-output validate() — Ajv + semantic rules (2-attempt loop)
//   7a. Validation failed → update run status: failed, enqueue HUMAN_NOTIFICATION
//   7b. Validation passed → update run: status: awaiting_human_gate,
//       write state.proposed_scaffold, increment step_count + total_execution_ms
//   8. SQS: enqueue HUMAN_GATE with UI-neutral dialog spec
//      HTTP: return scaffold directly (no UI interaction)
//
// Also exports handleResumeGate() — called by run-workflow.mjs when a
// WORKFLOW_STEP/resume_gate message arrives for a create_domain run.
//
// Tech debt: handleResumeGate() contains create_domain-specific gate logic.
// Phase 2 item 5 (Step Processor) replaces this with generic execution from
// PGC_Workflow.steps declarative definitions.

import { ok, err }            from '../shared/lambda-utils.mjs';
import { enqueueCallback, enqueueWorkflow } from '../shared/sqs-callback.mjs';
import { callLlm }            from '../shared/llm-client.mjs';
import { validate }           from './review-output.mjs';
import { getRows, insertRow, updateRows } from '../shared/serv-client.mjs';

// System columns excluded from user-facing column summaries
const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at']);

export async function handle(req) {
  const { userInput, workflowRunId } = req.body ?? {};
  const callback = req.callback ?? req.body?.callback ?? null;
  const traceId = req.traceId ?? req.correlationId;

  if (!userInput?.trim()) {
    if (req.source === 'sqs' && callback) {
      await enqueueCallback(callback, {
        type:    'HUMAN_NOTIFICATION',
        traceId,
        message: 'Usage: /create-domain <description>',
      });
      return;
    }
    return err(400, 'userInput is required', req.correlationId);
  }

  const startedAt = new Date();

  try {
    const result = await runDesignDomain({
      userInput:     userInput.trim(),
      workflowRunId,
      callback,
      traceId,
      startedAt,
      source:        req.source,
    });

    if (req.source === 'http') {
      return ok(result, req.correlationId);
    }

  } catch (error) {
    console.error('design-domain: unhandled error', { error: error.message, traceId });
    if (req.source === 'http') {
      return err(500, `design-domain failed: ${error.message}`, req.correlationId);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// handleResumeGate — called by run-workflow.mjs for create_domain runs.
//
// Operates entirely on the data bag (PGC_WorkflowRun.state).
// Enqueues UI-neutral payloads — no Slack constructs produced here.
//
// Tech debt: removed when Phase 2 item 5 implements generic Step Processor
// execution from PGC_Workflow.steps declarative definitions.
// ---------------------------------------------------------------------------

export async function handleResumeGate({ run, userResponse, responseData, gateType, callback, traceId, req }) {
  const workflowRunId = run.id;

  switch (userResponse) {

    case 'remove_table': {
      const tableName = responseData?.tableName;
      if (!tableName) {
        if (req.source === 'http') return err(400, 'responseData.tableName is required for remove_table', req.correlationId);
        console.warn('design-domain: remove_table missing tableName', { workflowRunId, traceId });
        return;
      }

      const scaffold = run.state?.proposed_scaffold;
      if (!scaffold) throw new Error(`WorkflowRun ${workflowRunId} has no proposed_scaffold in state`);

      if (!scaffold.tables.some(t => t.tableName === tableName)) {
        if (req.source === 'http') return err(400, `Table "${tableName}" not found in proposed_scaffold`, req.correlationId);
        console.warn('design-domain: remove_table — tableName not in scaffold', { tableName, workflowRunId, traceId });
        return;
      }

      // Parent tables (referenced by FK) cannot be removed while child tables exist
      if (buildReferencedSet(scaffold.tables).has(tableName)) {
        if (req.source === 'http') {
          return err(409, `Table "${tableName}" is referenced by a foreign key — remove the child table first`, req.correlationId);
        }
        // Re-post gate unchanged with a warning — gate stays open
        await enqueueCallback(callback,
          buildGatePayload(scaffold, workflowRunId, traceId, {
            warning: `"${tableName}" cannot be removed \u2014 another table references it. Remove the child table first.`,
          })
        );
        return;
      }

      // Splice table from data bag
      const updatedScaffold = {
        ...scaffold,
        tables: scaffold.tables.filter(t => t.tableName !== tableName),
      };

      await updateRows(
        'PGC_WorkflowRun',
        [{ column: 'id', op: 'eq', value: workflowRunId }],
        { state: { ...run.state, proposed_scaffold: updatedScaffold } }
      );

      console.info('design-domain: table removed from scaffold', {
        tableName, remaining: updatedScaffold.tables.length, workflowRunId, traceId,
      });

      if (req.source === 'http') {
        return ok({ success: true, action: 'resume_gate', workflowRunId, gateStatus: 'open' }, req.correlationId);
      }
      await enqueueCallback(callback, buildGatePayload(updatedScaffold, workflowRunId, traceId));
      return;
    }

    case 'confirm': {
      if (gateType === 'final_confirm') {
        // User confirmed final gate — hand off to create-domain to execute DDL.
        // Must go to WorkflowQueue so ProcFunction handles it, not SlackResultsQueue.
        // Tech debt: Phase 2 item 5 drives this generically from PGC_Workflow.steps.
        const scaffold = run.state?.proposed_scaffold;
        if (!scaffold) throw new Error(`WorkflowRun ${workflowRunId} has no proposed_scaffold in state`);

        await updateRows(
          'PGC_WorkflowRun',
          [{ column: 'id', op: 'eq', value: workflowRunId }],
          { status: 'running', step_count: (run.step_count ?? 0) + 1 }
        );

        console.info('design-domain: final confirmed — enqueuing CREATE_DOMAIN', { workflowRunId, traceId });

        if (req.source === 'http') {
          return ok({ success: true, action: 'resume_gate', workflowRunId, gateStatus: 'creating' }, req.correlationId);
        }

        // Enqueue to WorkflowQueue — proc/handler.mjs routes CREATE_DOMAIN → create-domain.mjs
        await enqueueWorkflow({
          type:         'CREATE_DOMAIN',
          traceId,
          workflowRunId,
          userInput:    scaffold.domain,
          scaffold,
          callback,
        });
        return;
      }

      // gateType === 'review_tables' (or unset) — user happy with table list,
      // advance to final confirmation gate
      const scaffold = run.state?.proposed_scaffold;
      if (!scaffold) throw new Error(`WorkflowRun ${workflowRunId} has no proposed_scaffold in state`);

      await updateRows(
        'PGC_WorkflowRun',
        [{ column: 'id', op: 'eq', value: workflowRunId }],
        { status: 'awaiting_human_gate', step_count: (run.step_count ?? 0) + 1 }
      );

      console.info('design-domain: review confirmed, advancing to final gate', { workflowRunId, traceId });

      if (req.source === 'http') {
        return ok({ success: true, action: 'resume_gate', workflowRunId, gateStatus: 'confirmed' }, req.correlationId);
      }

      await enqueueCallback(callback, buildFinalConfirmPayload(scaffold, workflowRunId, traceId));
      return;
    }

    case 'cancel': {
      await updateRows(
        'PGC_WorkflowRun',
        [{ column: 'id', op: 'eq', value: workflowRunId }],
        { status: 'cancelled' }
      );

      console.info('design-domain: run cancelled by user', { workflowRunId, traceId });

      if (req.source === 'http') {
        return ok({ success: true, action: 'resume_gate', workflowRunId, gateStatus: 'cancelled' }, req.correlationId);
      }

      if (callback) {
        await enqueueCallback(callback, {
          type:          'HUMAN_NOTIFICATION',
          traceId,
          workflowRunId,
          message: 'Domain creation cancelled.',
        });
      }
      return;
    }

    default:
      console.warn('design-domain: unknown userResponse', { userResponse, workflowRunId, traceId });
      if (req.source === 'http') return err(400, `Unknown userResponse "${userResponse}"`, req.correlationId);
  }
}

// ---------------------------------------------------------------------------
// Core design logic
// ---------------------------------------------------------------------------

async function runDesignDomain({ userInput, workflowRunId, callback, traceId, startedAt, source }) {

  const workflowResp = await getRows('PGC_Workflow', [{ column: 'name', op: 'eq', value: 'create_domain' }], undefined, 1);
  if (!workflowResp.success || workflowResp.count === 0) throw new Error('create_domain workflow not found in PGC_Workflow');
  const workflowId = workflowResp.rows[0].id;

  let runId = workflowRunId ?? null;
  if (!runId) {
    const runResp = await insertRow('PGC_WorkflowRun', {
      workflow_id:  workflowId,
      trace_id:     traceId,
      triggered_by: source === 'sqs' ? 'slack' : 'api',
      status:       'running',
      input:        { userInput },
      callback:     callback ?? null,
      started_at:   startedAt.toISOString(),
    });
    if (!runResp.success) throw new Error(`Failed to insert PGC_WorkflowRun: ${runResp.error}`);
    runId = runResp.row.id;
    console.info('design-domain: WorkflowRun created', { runId, traceId });
  } else {
    await updateRows('PGC_WorkflowRun', [{ column: 'id', op: 'eq', value: runId }],
      { status: 'running', started_at: startedAt.toISOString() });
  }

  const promptResp = await getRows('PGC_Prompt', [{ column: 'intent_category', op: 'eq', value: 'create_domain' }],
    { column: 'version', direction: 'desc' }, 1);
  if (!promptResp.success || promptResp.count === 0) throw new Error('create_domain prompt not found in PGC_Prompt');
  const promptRow  = promptResp.rows[0];
  const promptText = promptRow.prompt_text.replace('{{userInput}}', userInput);

  console.info('design-domain: prompt loaded', { promptId: promptRow.id, version: promptRow.version, traceId });

  const llmStart = Date.now();
  const scaffold  = await callLlm(promptRow.model, promptText, `Design a database domain for: "${userInput}"`, promptRow.output_schema, traceId);
  const llmMs     = Date.now() - llmStart;

  console.info('design-domain: LLM returned scaffold', { domain: scaffold.domain, tables: scaffold.tables?.map(t => t.tableName), llmMs, traceId });

  const validationStart  = Date.now();
  const validationResult = await validate({ intentCategory: 'create_domain', output: scaffold, traceId });
  const totalMs          = Date.now() - llmStart;

  if (!validationResult.valid) {
    console.warn('design-domain: validation failed after 2 attempts', { runId, traceId });
    await updateRows('PGC_WorkflowRun', [{ column: 'id', op: 'eq', value: runId }], {
      status: 'failed',
      error:  { type: 'validation_failed', message: 'Scaffold failed validation after 2 attempts', errors: validationResult.errors },
      step_count: 1, total_execution_ms: totalMs,
    });
    if (source === 'sqs' && callback) {
      await enqueueCallback(callback, {
        type:          'HUMAN_NOTIFICATION',
        traceId,
        workflowRunId: runId,
        message: 'Domain design failed \u2014 the LLM produced an invalid schema after 2 attempts. Please try again or rephrase your description.',
      });
      return { success: false, runId, validationFailed: true };
    }
    return { success: false, runId, errors: validationResult.errors, attempt: validationResult.attempt };
  }

  const finalScaffold = validationResult.correctedOutput ?? scaffold;

  console.info('design-domain: validation passed', { attempt: validationResult.attempt, traceId });

  await updateRows('PGC_WorkflowRun', [{ column: 'id', op: 'eq', value: runId }], {
    status: 'awaiting_human_gate',
    state:  { proposed_scaffold: finalScaffold },
    step_count: 1, total_execution_ms: totalMs,
  });

  console.info('design-domain: WorkflowRun updated to awaiting_human_gate', { runId, traceId });

  if (source === 'http') {
    return {
      success: true, runId, domain: finalScaffold.domain,
      tables:  finalScaffold.tables.map(t => ({ tableName: t.tableName, description: t.description })),
      attempt: validationResult.attempt, validatedAt: new Date().toISOString(),
    };
  }

  await enqueueCallback(callback, buildGatePayload(finalScaffold, runId, traceId));

  return { success: true, runId };
}

// ---------------------------------------------------------------------------
// buildGatePayload — HUMAN_GATE dialog spec for the review_tables gate.
//
// Returns the complete HUMAN_GATE message payload ready for enqueueCallback.
// callback.mjs renders this via dialogToBlocks() — no Slack constructs here.
//
// Shape emitted:
// {
//   type:          'HUMAN_GATE',
//   gate_type:     'edit_list',
//   workflowRunId: number,
//   dialog: {
//     fields: [
//       { type: 'typography', value: string },
//       { type: 'list', label: string, items: [{ id, primary, secondary, secondaryAction? }] },
//       { type: 'typography', value: string },   // optional warning
//       { type: 'actions', buttons: [...] },
//     ]
//   },
//   traceId: string,
// }
// ---------------------------------------------------------------------------

function buildGatePayload(scaffold, workflowRunId, traceId, { warning = null } = {}) {
  const tables           = scaffold.tables ?? [];
  const referencedTables = buildReferencedSet(tables);

  const listItems = tables.map(table => ({
    id:        table.tableName,
    primary:   table.tableName,
    secondary: (table.columns ?? [])
      .filter(c => !SYSTEM_COLUMNS.has(c.name))
      .slice(0, 4)
      .map(c => c.name)
      .join(', ') || null,
    // Parent tables (referenced by FK) cannot be removed — omit secondaryAction.
    ...(referencedTables.has(table.tableName) ? {} : {
      secondaryAction: {
        label:   'Remove',
        action:  'remove_table',
        style:   'danger',
        confirm: `Remove ${table.tableName} from this domain?`,
      },
    }),
  }));

  const fields = [
    {
      type:  'typography',
      value: `Here's my plan for domain ${scaffold.domain}. You can remove child tables you don't need, or add one that's missing.`,
    },
    {
      type:  'list',
      label: `${tables.length} table(s) proposed`,
      items: listItems,
    },
    ...(warning ? [{ type: 'typography', value: `\u26a0\ufe0f ${warning}` }] : []),
    {
      type:    'actions',
      buttons: [
        { label: 'Looks good',   action: 'confirm',   style: 'primary' },
        {
          label:  'Add a table',
          action: 'add_table',
          modal:  {
            title:       'Add a table',
            input_label: 'Describe the table',
            placeholder: 'What it stores and how it relates to the other tables.',
            multiline:   true,
          },
        },
        { label: 'Cancel', action: 'cancel' },
      ],
    },
  ];

  return {
    type:          'HUMAN_GATE',
    gate_type:     'edit_list',
    workflowRunId,
    dialog:        { fields },
    traceId,
  };
}

// ---------------------------------------------------------------------------
// buildFinalConfirmPayload — HUMAN_GATE dialog spec for the final_confirm gate.
// ---------------------------------------------------------------------------

function buildFinalConfirmPayload(scaffold, workflowRunId, traceId) {
  return {
    type:          'HUMAN_GATE',
    gate_type:     'confirm',
    workflowRunId,
    dialog: {
      fields: [
        {
          type:  'typography',
          value: `Ready to create domain *${scaffold.domain}* with ${scaffold.tables.length} table(s). This will create the physical database tables.`,
        },
        {
          type:    'actions',
          buttons: [
            { label: 'Create it', action: 'confirm', style: 'primary' },
            { label: 'Cancel',    action: 'cancel' },
          ],
        },
      ],
    },
    traceId,
  };
}

function buildReferencedSet(tables) {
  return new Set(
    tables.flatMap(t =>
      (t.foreignKeys || []).map(fk => fk.references?.table).filter(Boolean)
    )
  );
}
