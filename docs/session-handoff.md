# evolving-mind-ai — Session 23 Handoff

**Date:** 2026-04-13
**Git tag:** `v3.2-local-state-sandbox-builtins-removed` (unchanged — nothing deployed this session)
**Last session:** 22 — create-workflow entry points, troubleshoot/fix workflow Tier 1 repair loop, fix_workflow system workflow, openapi.yaml cleanup

---

## Session 22 completion status

All design and seed work is complete. Nothing has been deployed this session.
The broken `create_workflow` v4 intentionally remains in the DB — the first test goal is to let the new Tier 1 repair loop find and fix it automatically.

---

## Files changed this session

| File | Change |
|---|---|
| `src/proc/create-workflow.mjs` | New — thin entry point for create_workflow workflow. Reads `req.body.domain` into `PGC_WorkflowRun.input.domain` |
| `src/ui/slackbot/create-workflow.mjs` | New — /create-workflow Slack slash command handler. Posts ACK via chat.postMessage, enqueues CREATE_WORKFLOW with domain:null |
| `src/proc/handler.mjs` | Added imports + SQS cases + HTTP routes for create-workflow, troubleshoot-workflow, fix-workflow |
| `src/ui/slackbot/handler.mjs` | Added import + route case for create-workflow |
| `src/proc/troubleshoot-workflow.mjs` | New — Level 1 static analysis on any registered or supplied workflow. Posts summary to Slack. autoFix=true chains to FIX_WORKFLOW |
| `src/proc/fix-workflow.mjs` | New — thin entry point (matches create-domain.mjs pattern). Resolves inputs from troubleshootResult or direct fields, creates PGC_WorkflowRun for fix_workflow, enqueues execute_top |
| `src/proc/run-workflow.mjs` | Two TROUBLESHOOT_WORKFLOW enqueue hooks: (1) step execution catch block, (2) Guard 1 stuck-step limit |
| `src/serv/templates/pgc/seeds/seed_PGC_Workflow.json` | Four condition step routing fixes in create_workflow v4 (steps 4, 9, 10, 11b: on_truthy/on_falsy changed to bare step keys). fix_workflow v1 added as a new system workflow (17 steps) |
| `src/serv/templates/pgc/seeds/seed_PGC_Prompt.json` | fix_workflow_steps v1 appended (entry 15). Includes output_schema with corrected_steps, changes_applied, optional context_updates and prompt_text_change |
| `src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json` | fix_workflow_steps added to inject_for on: step_type_contracts, routing_value_rules, step_usage_patterns, workflow_constraints |
| `docs/architecture.md` | Section 6.7 updated with TROUBLESHOOT_WORKFLOW→repair chain. Section 6.12 new — Right-Brain Self-Repair (three tiers, PROC module contracts, SQS message types, fix_workflow_steps prompt contract). Section 4.3.7 inject_for table updated. SQS message types table updated with TROUBLESHOOT_WORKFLOW and FIX_WORKFLOW |
| `docs/openapi.yaml` | Added: /ui/slack/create-workflow, /ui/slack/create-domain (was undocumented), /proc/create-workflow, /proc/troubleshoot-workflow, /proc/fix-workflow. Deleted: /ui/slack/command (phantom — no handler). TroubleshootWorkflowResponse and FixWorkflowResponse schemas added |
| `tests/unit/troubleshoot-fix-workflow.test.mjs` | New — 35 tests across 6 describe blocks. Pure functions only (runSimulation, buildTroubleshootSummary, validateCorrectedSteps, resolveFixInputs). Includes structural validation of fix_workflow workflow definition itself |

---

## Why create_workflow v4 is intentionally NOT reseeded

The broken create_workflow v4 condition routing bugs (steps 4, 9, 10, 11b) are left in the DB deliberately. The first test goal for Session 23 is to run `/create-workflow Spanish flashcard quiz` again, trigger the Guard 1 stuck-step at step 4, and observe the automated TROUBLESHOOT_WORKFLOW → FIX_WORKFLOW chain repair it. The seed file fix is present for reference and for post-repair verification that the fix matches.

---

## Deploy checklist — must be done before testing

```cmd
sam build && sam deploy

node dev_scripts/upsert-workflow.mjs fix_workflow

node dev_scripts/upsert-prompt.mjs fix_workflow_steps

set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-system-context.mjs step_type_contracts
set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-system-context.mjs routing_value_rules
set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-system-context.mjs step_usage_patterns
set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node dev_scripts/upsert-system-context.mjs workflow_constraints
```

Do NOT run `upsert-workflow.mjs create_workflow` — broken v4 must stay for the repair test.

---

## Session 23 primary goal: Tier 1 repair loop end-to-end

### Test sequence

**Step 1 — Run unit tests**
```cmd
node --test tests/unit/troubleshoot-fix-workflow.test.mjs
```
Expected: 35 tests, all passing. Section 5 ("fix_workflow workflow definition") reads from the seed file — requires the seed to be committed at the correct path.

**Step 2 — Trigger the repair chain**
```
/create-workflow Spanish flashcard quiz
```
Expected sequence:
1. create_workflow v4 step 4 condition fails with `step "next" not found`
2. run-workflow.mjs catch block enqueues TROUBLESHOOT_WORKFLOW with autoFix:true
3. troubleshoot-workflow.mjs runs Level 1 → finds 4 condition routing violations
4. FIX_WORKFLOW enqueued with troubleshootResult
5. fix-workflow.mjs creates PGC_WorkflowRun for fix_workflow, enqueues execute_top
6. fix_workflow steps 1–4 execute: load broken steps, build fix_context, call LLM
7. Step 5 simulate: corrected steps pass Level 1
8. Step 6 human_gate: Slack shows "Fix ready for create_workflow (v4 → v5)" with diagnosis and changes. Options: Apply fix / Try again / Cancel
9. User clicks Apply fix
10. Steps 7–15: compute new version, serv_update PGC_Workflow, apply any context_updates, cancel affected runs
11. Step 16 notify: "create_workflow repaired (v4 → v5). Try again."

**Step 3 — Verify the fix**
```cmd
node dev_scripts/upsert-workflow.mjs create_workflow
```
Wait — before running this, check if the LLM fix matches the seed file fix:
```cmd
curl -s -X POST https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/serv/table/getRows -H "Content-Type: application/json" -d "{\"tableName\":\"PGC_Workflow\",\"filters\":[{\"column\":\"name\",\"op\":\"eq\",\"value\":\"create_workflow\"}],\"limit\":1}"
```
Inspect `version` (should be 5) and confirm condition step keys in the returned steps array.

**Step 4 — Re-run create_workflow**
```
/create-workflow Spanish flashcard quiz
```
Should now proceed past step 4 into the preference gate iterator.

---

## What to watch for

**Guard 1 timing** — Guard 1 fires after 3 consecutive idempotency hits on the same step. The step execution catch block fires immediately on the first failure. The test should hit the catch block path (immediate error), not the Guard 1 path (3 retries), because step 4's `executeCondition` throws immediately when `nextStep` is `"next"` and `findStep` returns null.

Actually — re-reading the code: `executeCondition` does NOT throw. It returns `{ nextAction: "step:next" }`. The throw happens in `executeTop` when `findStep(steps, "next")` returns null at the start of the next `execute_top` message. So the sequence is:
1. execute_top step 4: condition executes, returns nextAction "step:next", advances frame.current_step to "next"
2. execute_top "next": `findStep(steps, "next")` throws `step "next" not found`
3. catch block fires, TROUBLESHOOT_WORKFLOW enqueued

The stuck-step Guard 1 path would only fire if step 4 kept re-executing the same step repeatedly (idempotency hits). That's not what happens here — the failure is on the FOLLOWING execute_top message, not a repeated one. Verify this by checking CloudWatch — the error log should show the messageId of the second execute_top message, not a stuck-step message.

**fix_workflow_steps LLM quality** — The first run of the fix LLM has no `step_type_contracts` or `routing_value_rules` in PGC_SystemContext yet for `fix_workflow_steps` until after the upsert-system-context commands run. If those commands haven't been run, the LLM receives the prompt without contract injection. The prompt still contains the critical CONDITION STEP rule inline, so it may still produce correct output — but contract injection makes it more reliable.

**context_updates from LLM** — The LLM may produce `context_updates` recommending that `routing_value_rules` or `workflow_constraints` be updated to explicitly mention the condition step bare-key rule. If so, step 10 iterator will apply those updates. Check CloudWatch for `step-executor: serv_update` log lines targeting `PGC_SystemContext` after step 10.

---

## Known open issues entering Session 23

| Item | Priority | Notes |
|---|---|---|
| fix_workflow Level 2/3 post-fix validation | Medium | Currently only Level 1. Add mock_outputs + simulation_paths to fix_workflow_steps output schema; fix_workflow step 5 passes them to simulate for full path validation. Backlog item per Session 22 architecture discussion |
| create_workflow step 1 domain filter | High | When domain:null, serv_query PGC_Schema with filter `domain = null` may return 0 rows depending on SQL NULL handling. Need to verify SERV getRows handles null filter value correctly (IS NULL vs = null). If not, step 1 needs a condition pre-check |
| Tier 2 context update effectiveness | Medium | After fix_workflow applies context_updates, verify the updated rows are actually injected into generate_workflow_steps on the next create_workflow run. Check CloudWatch for context injection log line in executeLlmCall |
| seed_PGC_Workflow.json create_workflow v4 condition fixes | Low | The corrected condition steps are in the seed file (v4 with fixes). After the automated repair runs and produces v5, verify the steps match. If the LLM's fix differs structurally but passes Level 1, both are valid |

---

## Backlog items from Session 22 (carried forward)

| Item | Priority | Notes |
|---|---|---|
| `orderBy` field in `PGC_EntitySchema` | Low | `display_order_column`; `list_entity` reads it; `create_domain` step 6 populates |
| `toEntityName()` dead code in `classify-intent.mjs` | Low | Remove once all domains recreated with `domain` column |
| Word-boundary regression test | Low | Add to `classify-intent-tiers.test.mjs` |
| `create_domain` v9 — L/R architecture | Low | Deferred until right-brain loop running |
| Type 5 ambiguity pre-check in `create_workflow` | Low | Pre-step clarification gate when userInput is too vague |
| Sub-workflow return-to-caller after `create_domain` | Backlog | Requires sub_workflow step type |
| `generate_workflow_paths` schema consistency | Medium | Verify live DB v1 output_schema shape vs what executeSimulate Level 2 expects |
| Tier 3 scheduled maintenance loop | Backlog | PGC_WorkflowStats, usability patterns, PGC_ImprovementQueue — defer details |

---

## Architecture decisions made this session (for architecture.md git tag)

1. **troubleshoot-workflow is a PROC module, not a workflow** — pure diagnostic, no human gate, fire-and-forget SQS. Returns TroubleshootWorkflowResponse.

2. **fix-workflow is a thin PROC entry point** — matches create-domain.mjs pattern exactly. All logic (LLM call, simulation, human gate, DB writes, run cancellation) lives in the fix_workflow PGC_Workflow definition and is driven by the Step Processor.

3. **fix_workflow is a system workflow in PGC_Workflow** — 17 steps. executeLlmCall handles PGC_SystemContext injection for fix_workflow_steps automatically via inject_for. The 2-attempt correction loop in validate() handles LLM output failures. Human confirmation gate is a standard human_gate step.

4. **Three-tier right-brain self-repair** documented in Section 6.12: Tier 1 reactive (this session), Tier 2 proactive context update (Tier 2 improvement implemented via context_updates in fix_workflow step 10), Tier 3 scheduled maintenance (Backlog).

5. **Guard 1 and step error catch both enqueue TROUBLESHOOT_WORKFLOW** — connecting the existing safety layer to the new repair layer. autoFix:true on both enqueues chains automatically to FIX_WORKFLOW.

6. **Unit tests test pure logic only** — runSimulation, buildTroubleshootSummary, validateCorrectedSteps, resolveFixInputs, and structural validity of fix_workflow's own step array. No mock.module (not available in Node v22). Integration testing via curl.

---

## Key files needed at Session 23 start

```
src/proc/troubleshoot-workflow.mjs  — verify autoFix chain
src/proc/fix-workflow.mjs           — verify thin entry point
src/proc/run-workflow.mjs           — verify two TROUBLESHOOT_WORKFLOW hooks
src/proc/handler.mjs                — verify all four new routes wired
src/serv/templates/pgc/seeds/seed_PGC_Workflow.json  — verify fix_workflow present
```
