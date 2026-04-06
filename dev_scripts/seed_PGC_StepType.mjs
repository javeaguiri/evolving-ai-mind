// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/seed_PGC_StepType.mjs
//
// Seeds PGC_StepType rows for all live step types.
// Records the valid routing value contracts used by:
//   - The simulate step type (Level 1 static analysis)
//   - The generate_workflow_steps LLM prompt (injected at runtime)
//   - The routing value semantic validation rule in review-output.mjs
//
// Run after deploy whenever a new step type goes live:
//   set PGC_DATABASE_URL=<url> && node dev_scripts/seed_PGC_StepType.mjs
//
// Uses ON CONFLICT (step_type) DO UPDATE — safe to re-run.
// Existing rows are updated so routing contracts stay current.

import pg from 'pg';

const { Client } = pg;

const PGC_DATABASE_URL = process.env.PGC_DATABASE_URL;
if (!PGC_DATABASE_URL) {
  console.error('PGC_DATABASE_URL is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Valid routing token sets
// ---------------------------------------------------------------------------
// on_success_options and on_failure_options list the valid token values per
// step type. "step:N" is a pattern (N = any step key), not a literal — document
// this in the description field so the LLM understands it correctly.
//
// on_select_options applies only to human_gate — one entry per option button.

const STANDARD_ON_SUCCESS = ['next', 'end', 'step:N'];
const STANDARD_ON_FAILURE = ['human_feedback', 'cancel', 'step:N'];
const GATE_ON_SUCCESS      = ['next', 'end', 'step:N'];
const GATE_ON_FAILURE      = ['cancel', 'step:N'];
const GATE_ON_SELECT       = ['next', 'end', 'cancel', 'step:N'];

// ---------------------------------------------------------------------------
// Step type definitions
// ---------------------------------------------------------------------------

const STEP_TYPES = [
  {
    step_type:   'llm_call',
    description: 'Calls an LLM using a named prompt from PGC_Prompt. Resolves template variables from local_state into the prompt. Runs the 2-attempt validation/correction loop. Writes the validated output object to output_key.',
    input_contract: [
      { field: 'input.prompt',    type: 'string',  required: true,  description: 'intent_category key into PGC_Prompt — identifies which prompt to use' },
      { field: 'output_key',      type: 'string',  required: true,  description: 'local_state key where the validated LLM output object is written' },
      { field: 'on_success',      type: 'string',  required: false, description: 'Routing token — defaults to "next"' },
      { field: 'on_failure',      type: 'string',  required: false, description: 'Routing token — use "human_feedback" for recoverable failures' },
    ],
    output_contract: [
      { field: 'output_key', type: 'object', description: 'The validated LLM output object written to local_state[output_key]' },
    ],
    on_success_options: STANDARD_ON_SUCCESS,
    on_failure_options: STANDARD_ON_FAILURE,
    status: 'live',
  },
  {
    step_type:   'js_transform',
    description: 'Runs a named built-in JavaScript transformation on a local_state array. Currently only columnSummary is implemented — enriches table objects with a columnSummary display string and domain field. Generic sandbox is Phase 3.',
    input_contract: [
      { field: 'transform_type', type: 'string', required: true,  description: 'Built-in transform name — currently only "columnSummary"' },
      { field: 'input_key',      type: 'string', required: true,  description: 'Dot-path into local_state resolving to an array of objects' },
      { field: 'output_key',     type: 'string', required: true,  description: 'Dot-path where the enriched array is written back to local_state' },
      { field: 'on_success',     type: 'string', required: false, description: 'Routing token — supports step:N for backward loops' },
    ],
    output_contract: [
      { field: 'output_key', type: 'array', description: 'The enriched array written to local_state[output_key]' },
    ],
    on_success_options: STANDARD_ON_SUCCESS,
    on_failure_options: STANDARD_ON_FAILURE,
    status: 'live',
  },
  {
    step_type:   'human_gate',
    description: 'Suspends workflow execution and presents a dialog to the user. Execution resumes when the user clicks an option button. Gate types: confirm (read message, click button), edit_list (review and remove items), text_input (type free text), review_object (review key/value summary). Each option has its own on_select routing token.',
    input_contract: [
      { field: 'gate_type',         type: 'string',  required: true,  description: 'confirm | edit_list | text_input | review_object' },
      { field: 'message_template',  type: 'string',  required: true,  description: 'Message shown to user — supports {{template}} substitution' },
      { field: 'context_key',       type: 'string',  required: false, description: 'Dot-path into local_state for the data shown in the dialog (required for edit_list and review_object)' },
      { field: 'options',           type: 'array',   required: true,  description: 'Array of { label, action, on_select } objects — must include at least one with action: "cancel"' },
      { field: 'output_key',        type: 'string',  required: false, description: 'Only for text_input — the local_state key where the typed value is written on submit' },
      { field: 'on_success',        type: 'string',  required: false, description: 'Default routing when no on_select override applies' },
      { field: 'on_failure',        type: 'string',  required: false, description: 'Routing on gate execution error — not user cancellation' },
    ],
    output_contract: null,
    on_success_options: GATE_ON_SUCCESS,
    on_failure_options: GATE_ON_FAILURE,
    on_select_options:  GATE_ON_SELECT,
    status: 'live',
  },
  {
    step_type:   'serv_schema',
    description: 'Creates a physical PostgreSQL table via SERV-Schema createTable. Also registers the table in PGC_Schema and PGC_TableMap. Used in iterators driven by a tables array from an LLM call.',
    input_contract: [
      { field: 'input',      type: 'object', required: true,  description: 'Full table definition object — tableName, target, columns, foreignKeys, constraints, triggers. May be "{{item}}" inside an iterator.' },
      { field: 'on_failure', type: 'string', required: false, description: 'Routing token' },
    ],
    output_contract: [
      { field: 'output_key', type: 'object', description: '{ tableName, status: "created" }' },
    ],
    on_success_options: STANDARD_ON_SUCCESS,
    on_failure_options: STANDARD_ON_FAILURE,
    status: 'live',
  },
  {
    step_type:   'serv_insert',
    description: 'Inserts a single row into any PGC or PGD table. Table must be registered in PGC_TableMap with allow_insert: true. Returns the inserted row including generated id.',
    input_contract: [
      { field: 'input.tableName', type: 'string', required: true,  description: 'Table name — must be registered in PGC_TableMap' },
      { field: 'input.row',       type: 'object', required: true,  description: 'Row object — system columns (id, created_at, updated_at) are populated automatically' },
      { field: 'output_key',      type: 'string', required: false, description: 'local_state key where the inserted row object is written' },
      { field: 'on_success',      type: 'string', required: false, description: 'Routing token' },
      { field: 'on_failure',      type: 'string', required: false, description: 'Routing token' },
    ],
    output_contract: [
      { field: 'output_key', type: 'object', description: 'The inserted row including populated id' },
    ],
    on_success_options: STANDARD_ON_SUCCESS,
    on_failure_options: STANDARD_ON_FAILURE,
    status: 'live',
  },
  {
    step_type:   'serv_query',
    description: 'Reads rows from a PGC or PGD table with optional filters, ordering, and limit. Writes the rows array to output_key. Empty result (no matching rows) is not an error — returns an empty array.',
    input_contract: [
      { field: 'input.tableName', type: 'string',  required: true,  description: 'Table name — must be registered in PGC_TableMap' },
      { field: 'input.filters',   type: 'array',   required: false, description: 'Array of { column, op, value } filter objects. Ops: eq, neq, gt, gte, lt, lte, like, in, is_null, not_null' },
      { field: 'input.orderBy',   type: 'object',  required: false, description: '{ column, direction } — direction is "asc" or "desc"' },
      { field: 'input.limit',     type: 'integer', required: false, description: 'Maximum number of rows to return' },
      { field: 'output_key',      type: 'string',  required: true,  description: 'local_state key where the rows array is written' },
      { field: 'on_success',      type: 'string',  required: false, description: 'Routing token' },
      { field: 'on_failure',      type: 'string',  required: false, description: 'Routing token' },
    ],
    output_contract: [
      { field: 'output_key', type: 'array', description: 'Array of row objects — empty array if no rows matched' },
    ],
    on_success_options: STANDARD_ON_SUCCESS,
    on_failure_options: STANDARD_ON_FAILURE,
    status: 'live',
  },
  {
    step_type:   'serv_update',
    description: 'Updates rows in a PGC or PGD table matching the given filters. Filters must be non-empty — unfiltered mass updates are rejected. Returns updatedCount and updated rows.',
    input_contract: [
      { field: 'input.tableName', type: 'string', required: true,  description: 'Table name — must be registered in PGC_TableMap with allow_update: true' },
      { field: 'input.filters',   type: 'array',  required: true,  description: 'Non-empty filter array — must scope to specific rows (e.g. id = N)' },
      { field: 'input.updates',   type: 'object', required: true,  description: 'Object of column → new value pairs' },
      { field: 'output_key',      type: 'string', required: false, description: 'local_state key where { tableName, updatedCount, rows } is written' },
      { field: 'on_success',      type: 'string', required: false, description: 'Routing token' },
      { field: 'on_failure',      type: 'string', required: false, description: 'Routing token' },
    ],
    output_contract: [
      { field: 'output_key', type: 'object', description: '{ tableName, updatedCount, rows: [...updated rows] }' },
    ],
    on_success_options: STANDARD_ON_SUCCESS,
    on_failure_options: STANDARD_ON_FAILURE,
    status: 'live',
  },
  {
    step_type:   'serv_delete',
    description: 'Deletes rows from a PGC or PGD table matching the given filters. Filters must be non-empty — unfiltered mass deletes are rejected. Best practice: precede with serv_query + human_gate so the user confirms which records are deleted.',
    input_contract: [
      { field: 'input.tableName', type: 'string', required: true,  description: 'Table name — must be registered in PGC_TableMap with allow_delete: true' },
      { field: 'input.filters',   type: 'array',  required: true,  description: 'Non-empty filter array — must scope to specific rows (e.g. id = N)' },
      { field: 'on_success',      type: 'string', required: false, description: 'Routing token' },
      { field: 'on_failure',      type: 'string', required: false, description: 'Routing token' },
    ],
    output_contract: [
      { field: 'output_key', type: 'object', description: '{ tableName, deletedCount }' },
    ],
    on_success_options: STANDARD_ON_SUCCESS,
    on_failure_options: STANDARD_ON_FAILURE,
    status: 'live',
  },
  {
    step_type:   'simulate',
    description: 'Dry-runs a workflow step array through three validation levels without calling real services. Level 1: static analysis — routing values, dead targets, missing templates, gate structure. Level 2: path execution using mock_outputs and simulation_paths decision scripts. Level 3: skip-path analysis (advisory). Used by create_workflow to validate generated steps before registration.',
    input_contract: [
      { field: 'input.steps_key',        type: 'string', required: true,  description: 'Dot-path into local_state resolving to the steps array to simulate' },
      { field: 'input.mock_outputs_key', type: 'string', required: false, description: 'Dot-path to mock_outputs object — required for Level 2. If absent, runs Level 1 only.' },
      { field: 'input.paths_key',        type: 'string', required: false, description: 'Dot-path to simulation_paths array — required for Level 2. If absent, runs Level 1 only.' },
      { field: 'output_key',             type: 'string', required: true,  description: 'local_state key where the SimulateWorkflowResponse object is written' },
      { field: 'on_success',             type: 'string', required: false, description: 'Routing token — taken when all levels pass' },
      { field: 'on_failure',             type: 'string', required: false, description: 'Routing token — taken when any level fails. Typically "step:N" to route back to a review gate.' },
    ],
    output_contract: [
      { field: 'output_key', type: 'object', description: 'SimulateWorkflowResponse — { passed, paths_run, paths_passed, paths_failed, static_analysis, path_results, skip_path_warnings }' },
    ],
    on_success_options: STANDARD_ON_SUCCESS,
    on_failure_options: STANDARD_ON_FAILURE,
    status: 'live',
  },
  {
    step_type:   'notify',
    description: 'Sends a message to the user via the callback channel (Slack or any UI). The message_template is resolved against local_state. Does not block — fire and forget. Typically the second-to-last step before "end".',
    input_contract: [
      { field: 'message_template', type: 'string', required: true,  description: 'Message text — supports {{template}} substitution from local_state' },
      { field: 'notify_type',      type: 'string', required: false, description: 'SQS message type — defaults to WORKFLOW_NOTIFY' },
      { field: 'on_success',       type: 'string', required: false, description: 'Routing token — typically "end" on the final notify step' },
    ],
    output_contract: null,
    on_success_options: ['next', 'end'],
    on_failure_options: [],
    status: 'live',
  },
  {
    step_type:   'iterator',
    description: 'Executes a single item_step once per element of an array in local_state. Sequential only — one item at a time, one SQS hop per item. Collects results into an array at output_key. Items must be an array written by a prior step.',
    input_contract: [
      { field: 'items_key',     type: 'string', required: true,  description: 'Dot-path into local_state resolving to the array to iterate over' },
      { field: 'item_step',     type: 'object', required: true,  description: 'Step definition executed once per item. Use {{item}} or {{item.field}} to reference the current element.' },
      { field: 'output_key',    type: 'string', required: false, description: 'local_state key where collected results array is written after all items complete' },
      { field: 'on_complete',   type: 'string', required: false, description: 'Routing token after all items complete — defaults to "next"' },
      { field: 'on_failure',    type: 'string', required: false, description: 'Routing token if an item_step fails' },
    ],
    output_contract: [
      { field: 'output_key', type: 'array', description: 'Array of outputValue from each item_step execution' },
    ],
    on_success_options: STANDARD_ON_SUCCESS,
    on_failure_options: STANDARD_ON_FAILURE,
    status: 'live',
  },
  {
    step_type:   'condition',
    description: 'Evaluates a template expression against local_state and routes to one of two named steps without performing any I/O. Truthy: non-empty, non-"null", non-"undefined", non-"0". on_truthy and on_falsy are bare step keys (e.g. "2", "3") — the executor prefixes them to step:N internally. No output_key is written.',
    input_contract: [
      { field: 'expression', type: 'string', required: true,  description: '{{template}} expression resolved against local_state — e.g. "{{input.id}}"' },
      { field: 'on_truthy',  type: 'string', required: true,  description: 'Bare step key to route to when expression is truthy — e.g. "2"' },
      { field: 'on_falsy',   type: 'string', required: true,  description: 'Bare step key to route to when expression is falsy — e.g. "3"' },
    ],
    output_contract:    null,
    on_success_options: [],
    on_failure_options: [],
    status: 'live',
  },
  {
    step_type:   'end',
    description: 'Terminal step — marks the workflow run as completed. No input or output fields. Every workflow must have exactly one end step as its final step.',
    input_contract:  [],
    output_contract: null,
    on_success_options: [],
    on_failure_options: [],
    status: 'live',
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const client = new Client({
  connectionString: PGC_DATABASE_URL,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  await client.connect();
  console.info('seed_PGC_StepType: connected');

  let inserted = 0;
  let updated  = 0;

  for (const row of STEP_TYPES) {
    const result = await client.query(
      `INSERT INTO "PGC_StepType"
         (step_type, description, input_contract, output_contract,
          on_success_options, on_failure_options, requires_capability, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (step_type) DO UPDATE SET
         description          = EXCLUDED.description,
         input_contract       = EXCLUDED.input_contract,
         output_contract      = EXCLUDED.output_contract,
         on_success_options   = EXCLUDED.on_success_options,
         on_failure_options   = EXCLUDED.on_failure_options,
         status               = EXCLUDED.status,
         updated_at           = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        row.step_type,
        row.description,
        JSON.stringify(row.input_contract),
        row.output_contract ? JSON.stringify(row.output_contract) : null,
        JSON.stringify(row.on_success_options),
        JSON.stringify(row.on_failure_options),
        null,
        row.status,
      ]
    );

    const wasInserted = result.rows[0]?.inserted;
    if (wasInserted) inserted++; else updated++;
    console.info(`  ${wasInserted ? 'inserted' : 'updated'}: ${row.step_type}`);
  }

  console.info(`seed_PGC_StepType: done — ${inserted} inserted, ${updated} updated`);
  await client.end();
}

run().catch(err => {
  console.error('seed_PGC_StepType: failed', err.message);
  process.exit(1);
});
