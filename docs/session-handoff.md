# evolving-mind-ai — Session 21 Handoff

**Date:** 2026-04-12  
**Git tag:** `v3.2-local-state-sandbox-builtins-removed`  
**Last session:** 20 — js_transform local_state sandbox, built-ins removed, add_table modal generic, existing_table_modifications, topological sort, word-boundary keyword matching  

---

## Session 20 completion status

All items complete. Spanish flashcards domain created end-to-end including:
- add_table modal flow fully working (PGD_FlashcardSets added with FK patched into PGD_Flashcards)
- 20 flashcards added via add_entity workflow
- FK ordering bug fixed (topological sort)
- PGC_Schema migration discipline established

### Files changed this session

| File | Change |
|---|---|
| `src/proc/step-executor.mjs` | `local_state` in sandbox; all built-ins removed; `buildDialog()` modal passthrough; `runSandboxedExpression` exported |
| `src/proc/classify-intent-tiers.mjs` | `matchWorkflowByKeywords` word-boundary regex; verb-first tiebreaker |
| `src/ui/slackbot/interactive.mjs` | Generic `buttonValue.modal` handler; `handleViewSubmission`; `handleViewClosed`; `notify_on_close` |
| `src/ui/slackbot/callback.mjs` | `actions` case spreads `btn.modal`; `text_input` gate early return; `textbox` no-op |
| `src/serv/templates/pgc/seeds/seed_PGC_Workflow.json` | All 7 workflows updated: expressions replace built-ins; `create_domain` v8 (modal, existing_table_modifications, topological sort, add_table option with modal descriptor); `list_entity` orderBy removed |
| `src/serv/templates/pgc/seeds/seed_PGC_Prompt.json` | `design_table` v2: `existing_table_modifications` in output schema and prompt |
| `src/proc/classify-intent.mjs` | `classify()` returns `{ result, entitySchemaRows }` via `wrap()` helper |
| `tests/unit/step-executor.test.mjs` | New file — 26 tests for `buildDialog` and `runSandboxedExpression` |
| `docs/architecture.md` | Session 20 updates (this handoff) |
| `docs/unit-test-setup.md` | `step-executor.test.mjs` section added |

### Deploy checklist (if not already done)

```cmd
sam build && sam deploy
node dev_scripts/upsert-workflow.mjs create_domain help get_entity list_entity add_entity
node dev_scripts/upsert-prompt.mjs design_table
```

### Outstanding DB migration (if not already done)

```sql
-- PGC_Schema must include the domain column added to PGC_EntitySchema
UPDATE "PGC_Schema"
SET columns = columns || '[{"name":"domain","type":"text","nullable":true}]'::jsonb
WHERE table_name = 'PGC_EntitySchema'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(columns) AS col
    WHERE col->>'name' = 'domain'
  );
```

### Word-boundary regression test to add

Add this test to `tests/unit/classify-intent-tiers.test.mjs` in the `matchWorkflowByKeywords` describe block:

```js
it('does not match keyword as substring inside a longer word — Spanish body text', () => {
  // "list" is a substring of "simplista" — must not match list_entity
  // "add" at position 0 must win
  const input = 'add flashcards\n\ncategoría o descripción simplista y generalizada';
  const result = matchWorkflowByKeywords(input, 'spanish_flashcards', workflowRows);
  assert.ok(result, 'expected a match');
  assert.equal(result.workflow_name, 'add_entity');
});
```

---

## Session 21 primary goal: `create_workflow`

### Context

`create_workflow` is the highest-leverage remaining feature. It enables users to define new
workflows in natural language from Slack — the system designs the steps, validates them via
simulation, and registers the workflow. Without it, every domain capability beyond basic CRUD
must be hand-coded.

The first test case (Session 19 handoff) is **the Spanish vocabulary quiz** — self-contained,
no cross-domain logic, no external APIs, tests the iterator/loop pattern.

`create_workflow` was previously implemented in Session 11 (`v3.2-create-workflow-complete`)
and is already in the DB. The Session 21 work is to run it against the quiz use case, identify
gaps, and fix them.

### Current state of create_workflow

The workflow exists at v2 (12 steps). Key steps:

| Step | Type | What it does |
|---|---|---|
| 1 | `human_gate confirm` | Confirm user intent and domain context |
| 2 | `llm_call generate_workflow_steps` | LLM designs the workflow steps |
| 3 | `human_gate review_object` | User reviews the draft steps |
| 4 | `js_transform` | Validate step structure (simulate) |
| 5 | `llm_call` | Correct invalid steps |
| 6–8 | `human_gate`, `serv_insert` | Name, description, confirm, register in PGC_Workflow |
| 9–10 | `serv_insert` (iterator) | Register PGC_IntentMap rows |
| 11 | `notify` | Done message |
| 12 | `end` | |

**Known gap:** The `generate_workflow_steps` prompt (step 2) was written before Session 21's
changes. It may reference `transform_type` built-ins in its output schema or examples. These
are now removed — the prompt must produce `expression`-based `js_transform` steps.

**The prompt must also know about `local_state`** as a sandbox binding so it can generate
expressions that read cross-key values.

### Quiz workflow design (Option B — flat loop)

The quiz workflow cannot use `sub_workflow` (MVP backlog). It uses a flat loop pattern:
a backward step reference from the end of one quiz iteration to the start of the next,
anchored by a `human_gate` (Guard 3 safe).

```
step 1: serv_entity_query — load N flashcards from PGD_Flashcards (filtered by set_id)
step 2: js_transform — shuffle cards, init index=0, score={passed:0,failed:0}
step 3: js_transform — pick current card: items[local_state.index]
step 4: human_gate confirm — show card front, wait for user to flip
step 5: human_gate text_input — show back, user types their answer
step 6: llm_call evaluate_translation — LLM scores the answer (pass/fail + feedback)
step 7: js_transform — increment index, update score
step 8: human_gate confirm — show result + feedback, "Next card" button
  on_select: "next card" → step:3 (backward ref — loop anchor is step 8's gate)
  on_select: "finish" → step:9
step 9: serv_insert — write quiz result to PGD_ReviewLogs (one row per card)
step 10: notify — post summary score
step 11: end
```

Guard 3 requirement: the backward reference (step 8 → step 3) is safe because the path
from step 3 back to step 8 contains at least one `human_gate` (steps 4, 5, 8).

### generate_workflow_steps prompt — what needs updating

The prompt must be updated to:

1. Remove any `transform_type` examples — replace with `expression` examples
2. Add `local_state` to the sandbox description so generated expressions use it correctly
3. Add the quiz as a worked example (alongside the existing `create_domain` example)
4. Ensure the output schema accepts backward step references (`on_select: "step:N"`)
5. Ensure the output schema accepts `text_input` gate type for step 5

### evaluate_translation prompt — needs seeding

A new prompt `evaluate_translation` must be seeded into `PGC_Prompt` before the quiz workflow
can run. The prompt receives `{{ term }}`, `{{ definition }}`, and `{{ user_answer }}` and
returns `{ result: "pass"|"fail", feedback: string, score: 0-100 }`.

### Session 21 task sequence

1. Read `architecture.md` Section 6 (step types) and Section 9 (create_workflow build order)
2. Share current `seed_PGC_Workflow.json` and `seed_PGC_Prompt.json`
3. Share current `step-executor.mjs` (to verify simulate step is still correct)
4. Inspect the live `generate_workflow_steps` prompt from DB:
   ```sql
   SELECT prompt_text, output_schema, version FROM "PGC_Prompt"
   WHERE intent_category = 'generate_workflow_steps';
   ```
5. Update `generate_workflow_steps` prompt: remove built-in references, add `local_state`,
   add quiz example
6. Seed `evaluate_translation` prompt
7. Run `/m create workflow Spanish vocabulary quiz` and trace through the gates
8. Fix any step validation or simulation failures
9. Smoke-test quiz end-to-end in Slack

### Human_feedback routing prerequisite

`on_failure: "human_feedback"` is used in `create_workflow` but the routing must be verified
as working before trusting the workflow. If LLM step correction fails, the workflow must surface
the error rather than silently advancing. Confirm in the first run.

---

## Key files needed at session start

```
src/proc/step-executor.mjs             — verify simulate step current state
src/serv/templates/pgc/seeds/seed_PGC_Workflow.json
src/serv/templates/pgc/seeds/seed_PGC_Prompt.json
src/proc/classify-intent.mjs           — may need entity schema fixes for quiz domain
```

Or share the raw GitHub URLs.

---

## Backlog items confirmed this session (add to tech debt register)

| Item | Priority | Notes |
|---|---|---|
| `orderBy` field in `PGC_EntitySchema` | Low | Add `display_order_column` to entity schema; `list_entity` reads it when present; `create_domain` step 6 populates it from first non-system non-FK column of root table |
| `PGC_Schema` migration discipline | Medium | Every `ALTER TABLE` on a PGC table must be paired with `UPDATE PGC_Schema SET columns = columns \|\| '[{...}]'` — cannot rely on bootstrap templates alone for live instances |
| `toEntityName()` dead code in `classify-intent.mjs` | Low | Remove once all domains recreated with `domain` column populated |
| Word-boundary regression test | Low | Add to `classify-intent-tiers.test.mjs` (template above) |
