# evolving-mind-ai — Session 27 Handoff

**Git tag:** `v3.2-session26-complete`  
**Date:** 2026-04-20  
**Session 26 focus:** pgvector implementation complete; `create_workflow` v4 three-call left brain design and implementation

---

## What was completed in session 26

### pgvector — fully implemented

| Item | Status |
|---|---|
| pgvector extension enabled on RDS | ✅ |
| `vector` added to `ALLOWED_TYPES` in `schema.mjs` | ✅ |
| `embed_source` persisted in `addColumn` → `PGC_Schema` | ✅ |
| `PGC_DomainHelp.embedding` column added | ✅ |
| `seed_PGC_Schema.json` PGC_DomainHelp entry updated with `embed_source` | ✅ |
| `embed-client.mjs` — Perplexity `pplx-embed-v1-4b`, base64 INT8 decode | ✅ |
| `table.mjs` — auto-embed on `insertRow`/`updateRows`; `vectorSearch` on `getRows` | ✅ |
| `serv-client.mjs` — `vectorSearch` param added to `getRows` wrapper | ✅ |
| `classify-intent.mjs` — `semanticDomainMatch` via SERV `getRows` `vectorSearch` | ✅ |
| `create-workflow.mjs` — domain resolution before `WorkflowRun` creation | ✅ |
| `backfill-embeddings.mjs` — unconditional backfill via `updateRows` | ✅ |
| Threshold calibrated at 0.40 for `pplx-embed-v1-4b` | ✅ |

**Confirmed working in production:** "spanish flashcard quiz" → `spanish_flashcards` at similarity 0.558 (threshold 0.40 ✅). Separation to next domain (recipes) is 0.11 — unambiguous.

**Key architectural decision recorded in Section 10:** Embedding computation belongs in the SERV tier. `embed_source` in `PGC_Schema.columns` is the single source of truth for what text to embed. Any table in the system gains semantic search by adding a vector column with `embed_source` — no code changes.

---

### create_workflow v4 — designed and implemented

**Root cause of previous failures:** The single `analyze_and_design_workflow` prompt was simultaneously classifying gaps, designing the process, designing dialogs, and writing prompts. At 3,245 output tokens it was at the model's reliable precision limit. Two structural schema contradictions were embedded in the output_schema:
- `dialog` field on `process_design` items declared `anyOf: [empty_object | null]` but the prompt instructed the LLM to put a step_label reference there — schema and prompt contradicted each other on every run
- `choice` gate options required `action` but `action` is semantically meaningless on choice options (which use `value`) — the LLM correctly omitted it, causing required-field violations on every run

**The v4 fix:** Three focused left-brain calls replacing the single monolith.

| Step | Prompt | Phase | Output | Token budget |
|---|---|---|---|---|
| 7 | `analyze_workflow_gaps` v1 | Phase 1 | `gap_analysis` | ~1,500 |
| 12 | `design_workflow_process` v1 | Phase 3 | `process_spec` (`process_design`, `state_map`) | ~2,000 |
| 13 | `design_workflow_dialogs` v1 | Phase 3 | `dialog_spec` (`dialog_designs`) | ~2,000 |
| 14 | `generate_workflow_steps` v7 | Phase 4 | `draft_workflow` | ~3,000 |

**Files changed:**

| File | Change |
|---|---|
| `seed_PGC_Prompt.json` | Added `analyze_workflow_gaps` v1, `design_workflow_process` v1, `design_workflow_dialogs` v1, `generate_workflow_steps` v7 |
| `seed_PGC_Workflow.json` | `create_workflow` bumped to v14 — 31 steps across 6 phases |
| `architecture.md` | Section 6.9 fully rewritten for v4; Section 10 updated with implemented pgvector design |

**Bug fixes also deployed this session:**
- `callback.mjs` — `action_id` uniqueness: index suffix appended to both `actions` and `list` case action_ids. Eliminated `duplicate action_id → invalid_blocks` Slack error.
- `analyze_and_design_workflow` v11 — `blocked_reason` made nullable; `state_map` `additionalProperties` corrected; `needs_preferences` added to DO NOT use list; domain Mode A/B/C guidance added.

---

## Session 27 startup checklist

1. Share `architecture.md` from session 26 outputs (or raw GitHub URL) — do not rely on memory
2. Read **Section 6.9** (v4 six-phase step structure) and **Section 10** (pgvector implementation) before writing any code
3. Confirm git tag `v3.2-session26-complete` is present on the repo
4. Run the end-to-end validation test described below

---

## Primary objective: end-to-end validation of create_workflow v14

Run `/m create workflow spanish flashcard quiz` in Slack and verify each phase passes.

### Phase 0–1 checkpoints (steps 1–6)

- Step 1 `serv_query PGC_Schema`: `domain_schema` should be non-empty — confirm flashcard tables are returned (proves `create-workflow.mjs` domain resolution is working and flowing into `input.domain`)
- Step 2 `research_workflow_domain`: right brain research completes; step has `on_failure: next` so a failure is non-blocking
- Steps 3/3a/3b: preference gates and research summary gate render correctly in Slack
- Step 6 `serv_query PGC_StepType`: `step_type_contracts` loaded

### Phase 1 left brain checkpoint (step 7)

- `analyze_workflow_gaps` passes Ajv on attempt 1 — narrow output schema should be reliable
- `gap_analysis.confidence` should be `"complete"` (flashcard domain exists, all tables present)
- `gap_analysis.schema_changes` should be empty or non-blocking only
- Phase 2 routing (steps 8–11c) should fall through to step 12 without any gates firing

### Phase 3 checkpoints (steps 12–13)

- Step 12 `design_workflow_process`: `process_spec.process_design` should contain no `dialog` field on any item — this is the structural fix; verify in `PGC_WorkflowRun.state`
- Step 12: `process_spec.state_map` should document all local_state keys
- Step 13 `design_workflow_dialogs`: `dialog_spec.dialog_designs` options should use `value` on choice options and `action` on confirm options — no AJV violations

### Phase 4 checkpoint (step 14)

- `generate_workflow_steps` v7 produces a valid step array
- Check that `dialog_designs` entries were correctly joined to `process_design` entries by `step_label` — look at `draft_workflow.steps` in `PGC_WorkflowRun.state`
- Step 15 review gate renders correctly in Slack — no `invalid_blocks` error

### Phase 5 checkpoints (steps 16–19)

- Step 16 Level 1 static analysis passes — routing references valid, no dead targets
- Steps 17–18 mock and path generation complete
- Step 19 Level 2+3 simulation passes (or identifies fixable issues)

### Phase 6 (steps 20–23)

- Steps 21–22 insert to `PGC_Workflow` and `PGC_IntentMap`
- Step 23 notify confirms workflow is registered
- Verify the new workflow appears in `PGC_Workflow` via a `getRows` curl

**Diagnostic path for any step failure:**

1. `PGC_WorkflowRun.error` — the step key and error message
2. `PGC_Prompt.error_log` for the relevant `intent_category` — AJV errors from both correction attempts
3. CloudWatch logs: `aws logs tail /aws/lambda/evomind-proc --follow`

---

## Known open issues

### 1. `research_workflow_domain` generates wrong preference questions (Medium priority)

**Symptom:** Right brain produces questions about browser data persistence and initial card set size — standalone app concerns — rather than workflow behaviour questions (quiz grading method, score tracking, session length).

**Root cause:** Step 2's input does not pass `domain_schema` to the right brain prompt. Without schema context, the right brain does not know a `PGD_Flashcards` table already exists and treats the request as a greenfield app build.

**Fix (prompt + seed only, no code):**
- `research_workflow_domain` v2: add `domain_schema` input variable; add Mode A instruction — "when domain_schema is non-empty, ask only about workflow behaviour (how the workflow should work), not about data storage architecture (which tables to create or where to store data)"
- `seed_PGC_Workflow.json`: add `"domain_schema": "{{domain_schema}}"` to step 2's input
- `seed_PGC_Prompt.json`: add v2 entry
- Deploy: `node dev_scripts/upsert-prompt.mjs research_workflow_domain` + `node dev_scripts/upsert-workflow.mjs create_workflow`

### 2. `generate_workflow_steps` v7 is untested end-to-end (High priority — will surface in session 27)

The updated prompt has not been exercised against real inputs. The input contract change from `design_spec` (monolith) to `process_design` + `state_map` + `dialog_designs` (three separate inputs) is structurally correct but prompt tuning may be needed after the first live run. The `PGC_Prompt.error_log` will capture any AJV violations.

### 3. `create_domain` may not auto-embed new DomainHelp rows (Low priority)

New domains created after the pgvector deploy should have `embedding` populated automatically because `PGC_DomainHelp` has `embed_source` in `PGC_Schema` and `table.mjs` `insertRow` reads it. This has not been verified on a live `create_domain` run. If a new domain is created and `embedding` is null on the `PGC_DomainHelp` row, the fix is to run `backfill-embeddings.mjs` — or confirm that `table.mjs` is correctly reading `embed_source` from the schema registry.

### 4. UC 1.1 fix — Pass 2 keyword scan excludes `domain: null` workflows (Low priority, pre-existing)

`matchWorkflowByKeywords` excludes workflows where `domain` is null from keyword matching. System workflows (`create_workflow`, `help`, `ping`, `shutdown`) have `domain: null` and can only be reached via Tier 3 heavy-lift or explicit alias. This causes unnecessary Tier 2 sonar calls for known system commands. Fix deferred — addressable as a prompt update to the Tier 2 classification prompt or a code change to include `domain: null` workflows in Pass 2 scanning.

---

## Next milestone after session 27 validation

Once `create_workflow` end-to-end validation succeeds and the `flashcard_quiz` workflow is successfully registered, the next integration probe is **running the generated workflow against real flashcard data**:

- `/m quiz me on spanish flashcards` — verify the generated workflow is triggered via the Intent Preprocessor
- Verify the quiz loop runs (one card at a time), score is tracked, and the session ends cleanly
- Any framework gaps surfaced are fixed at the framework level — not patched in the generated workflow

This validates the full self-extension loop: user asks for a workflow → brain designs and registers it → workflow is immediately callable → produces correct results on real domain data.

---

## Deployment commands reference

```cmd
rem Deploy code changes
sam build && sam deploy

rem Upsert new/updated prompts
node dev_scripts/upsert-prompt.mjs analyze_workflow_gaps
node dev_scripts/upsert-prompt.mjs design_workflow_process
node dev_scripts/upsert-prompt.mjs design_workflow_dialogs
node dev_scripts/upsert-prompt.mjs generate_workflow_steps

rem Upsert create_workflow v14
node dev_scripts/upsert-workflow.mjs create_workflow

rem Tail logs
aws logs tail /aws/lambda/evomind-proc --follow
aws logs tail /aws/lambda/evomind-serv --follow
aws logs tail /aws/lambda/evomind-callback --follow

rem Verify domain embeddings
curl -s -X POST https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/serv/table/getRows -H "Content-Type: application/json" -d "{\"tableName\":\"PGC_DomainHelp\",\"vectorSearch\":{\"column\":\"embedding\",\"queryText\":\"spanish flashcard quiz\",\"threshold\":0,\"limit\":5}}"
```
