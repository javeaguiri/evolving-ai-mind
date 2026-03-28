// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/seed_PGC_SystemContext.mjs
//
// Seeds PGC_SystemContext rows used by the create_workflow workflow.
// These rows are injected into the generate_workflow_steps and
// generate_workflow_paths LLM prompts at runtime — they are not
// inline prompt text. See architecture Section 6.8 for rationale.
//
// Three rows seeded:
//   step_type_contracts  — derived from live PGC_StepType rows at seed time
//   routing_value_rules  — canonical routing token rules (prose)
//   create_domain_example — Section 6.7 data flow summary (condensed)
//
// Run after deploy (and after seed_PGC_StepType.mjs has run):
//   set PGC_DATABASE_URL=<url> && node dev_scripts/seed_PGC_SystemContext.mjs
//
// Uses ON CONFLICT (key) DO UPDATE — safe to re-run.
// Re-running after adding new step types updates step_type_contracts automatically.

import pg from 'pg';

const { Client } = pg;

const PGC_DATABASE_URL = process.env.PGC_DATABASE_URL;
if (!PGC_DATABASE_URL) {
  console.error('PGC_DATABASE_URL is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Context row definitions
// ---------------------------------------------------------------------------

// routing_value_rules — prose block injected into generate_workflow_steps.
// Canonical definition of valid routing tokens and their semantics.
const ROUTING_VALUE_RULES = `
ROUTING VALUE RULES — every on_success, on_failure, and on_select field in a workflow step must use one of these exact tokens:

  next            — advance to the sequentially next step in the array
  end             — terminate the workflow run as completed
  cancel          — cancel the run and clear the stack (same effect as the user clicking Cancel)
  human_feedback  — when a step fails, pause execution and show the user a Retry/Skip/Cancel recovery gate
  step:<key>      — jump directly to the step with the given key (e.g. "step:3", "step:3a")

NOTES:
- "step:N" uses the actual step key string, not a position index. "step:3a" jumps to the step whose "step" field is "3a".
- Backward references (routing to an earlier step key) are safe ONLY when there is at least one human_gate on the path from the target back to the source. Without a gate, backward references create infinite loops.
- on_failure should be "human_feedback" for any step that calls an external service (llm_call, serv_query, serv_insert, serv_update, serv_delete). Use "cancel" only for non-recoverable logical failures.
- Every human_gate MUST have at least one option with action: "cancel". This is enforced by the static analysis validator.
- notify steps only support "next" and "end" in on_success — they have no on_failure.
- end steps have no routing fields.
`.trim();

// create_domain_example — condensed Section 6.7 data flow summary.
// Shows a working multi-step workflow with gates, iterators, LLM calls, and serv_insert.
const CREATE_DOMAIN_EXAMPLE = `
WORKED EXAMPLE — create_domain workflow (condensed data flow)

This is the canonical example of a correct workflow definition. Use it as the reference for step structure, template syntax, and data flow.

run.input = { userInput: "stock portfolio" }

Step 1  llm_call (prompt: "create_domain", user_input: "{{input.userInput}}")
        → output_key: "proposed_scaffold"
        → local_state.proposed_scaffold = { domain: "stock_portfolio", tables: [...] }
        → on_success: "next", on_failure: "human_feedback"

Step 2  js_transform (transform_type: "columnSummary", input_key: "proposed_scaffold.tables", output_key: "proposed_scaffold.tables")
        → enriches each table with columnSummary and domain fields
        → on_success: "next"

Step 3  human_gate (gate_type: "edit_list", context_key: "proposed_scaffold.tables")
        → options: [confirm→"step:3d", add_table→"step:3a", cancel→"cancel"]
        → on_success: "next", on_failure: "cancel"

Step 3a human_gate (gate_type: "text_input", output_key: "new_table_description")
        → user types table description, written to local_state.new_table_description
        → on_success: "next", on_failure: "cancel"

Step 3b llm_call (prompt: "design_table", inputs: domain, existing_tables, user_input)
        → output_key: "new_table"

Step 3c js_transform (merges new_table into proposed_scaffold.tables)
        → on_success: "step:3"  ← intentional backward reference (gate-bounded loop)

Step 3d human_gate (gate_type: "review_object", context_key: "proposed_scaffold.tables")
        → confirm → "next", cancel → "cancel"

Step 4  human_gate (gate_type: "confirm") — final DDL confirmation
        → confirm → "next", cancel → "cancel"

Step 5  iterator (items_key: "proposed_scaffold.tables")
          item_step: serv_schema createTable({{item}})
        → output_key: "created_tables"
        → on_complete: "next"

Step 6  llm_call (prompt: "generate_crud_workflows", inputs: domain, tables)
        → output_key: "generated" = { domainHelp, workflows, intentMapRows }

Step 7  human_gate (gate_type: "review_object", context_key: "generated.domainHelp")
        → confirm → "next", cancel → "cancel"

Step 8  serv_insert (tableName: "PGC_DomainHelp", row: "{{generated.domainHelp}}")

Step 9  iterator over generated.workflows
          item_step: serv_insert PGC_Workflow({{item}})

Step 10 iterator over generated.intentMapRows
          item_step: serv_insert PGC_IntentMap({{item}})

Step 11 notify "Domain {{proposed_scaffold.domain}} created."
        → on_success: "end"

Step 12 end

KEY PATTERNS FROM THIS EXAMPLE:
- Template syntax: {{key}}, {{key.field}}, {{key.0.field}}, {{item}}, {{item.field}}, {{input.field}}
- output_key establishes the local_state key that downstream steps reference
- Backward references (step:3) are safe here because every path back passes through step 3 (human_gate)
- serv_insert row values use template substitution: "{{generated.domainHelp}}" resolves to the full object
- The iterator item_step uses "{{item}}" to reference the current array element
`.trim();

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
  console.info('seed_PGC_SystemContext: connected');

  // Step 1 — read live PGC_StepType rows to build step_type_contracts content
  const stResult = await client.query(
    `SELECT step_type, description, input_contract, output_contract,
            on_success_options, on_failure_options, status
     FROM "PGC_StepType"
     WHERE status = 'live'
     ORDER BY step_type`
  );

  if (stResult.rows.length === 0) {
    console.error('seed_PGC_SystemContext: no live PGC_StepType rows found — run seed_PGC_StepType.mjs first');
    await client.end();
    process.exit(1);
  }

  console.info(`seed_PGC_SystemContext: found ${stResult.rows.length} live step types`);

  const stepTypeContracts = JSON.stringify(
    stResult.rows.map(r => ({
      step_type:          r.step_type,
      description:        r.description,
      input_contract:     r.input_contract,
      output_contract:    r.output_contract,
      on_success_options: r.on_success_options,
      on_failure_options: r.on_failure_options,
    })),
    null, 2
  );

  // Step 2 — upsert the three context rows
  const rows = [
    {
      key:          'step_type_contracts',
      section:      'rules',
      format:       'json',
      inject_always: false,
      inject_for:   ['create_workflow', 'generate_workflow_steps'],
      content:      stepTypeContracts,
      version:      1,
    },
    {
      key:          'routing_value_rules',
      section:      'rules',
      format:       'prose',
      inject_always: false,
      inject_for:   ['create_workflow', 'generate_workflow_steps', 'generate_workflow_paths'],
      content:      ROUTING_VALUE_RULES,
      version:      1,
    },
    {
      key:          'create_domain_example',
      section:      'examples',
      format:       'prose',
      inject_always: false,
      inject_for:   ['create_workflow', 'generate_workflow_steps'],
      content:      CREATE_DOMAIN_EXAMPLE,
      version:      1,
    },
  ];

  for (const row of rows) {
    const result = await client.query(
      `INSERT INTO "PGC_SystemContext"
         (key, section, content, format, inject_always, inject_for, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET
         content       = EXCLUDED.content,
         format        = EXCLUDED.format,
         inject_always = EXCLUDED.inject_always,
         inject_for    = EXCLUDED.inject_for,
         version       = "PGC_SystemContext".version + 1,
         updated_at    = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        row.key,
        row.section,
        row.content,
        row.format,
        row.inject_always,
        JSON.stringify(row.inject_for),
        row.version,
      ]
    );

    const wasInserted = result.rows[0]?.inserted;
    console.info(`  ${wasInserted ? 'inserted' : 'updated'}: ${row.key} (inject_for: ${row.inject_for.join(', ')})`);
  }

  console.info('seed_PGC_SystemContext: done');
  await client.end();
}

run().catch(err => {
  console.error('seed_PGC_SystemContext: failed', err.message);
  process.exit(1);
});
