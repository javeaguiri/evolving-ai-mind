# evolving-mind-ai — Session 23 Handoff

**Git tag at session start:** `v3.2-local-state-sandbox-builtins-removed`  
**Suggested tag at session end:** `v3.2-session23-choice-gate-repair-loop`  
**API base:** `https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod`

---

## What was completed this session

### 1. Tier 1 repair loop — end-to-end confirmed working
- `fix_workflow` ran end-to-end: detected 1 dead routing target in `create_workflow`, LLM fixed it, merged back via step 4b, wrote v12 to DB
- `isLlmError` discriminator in `run-workflow.mjs` extended to cover `llm_call validation failed` — validation failures no longer trigger TROUBLESHOOT_WORKFLOW (prompt quality ≠ workflow structure defect)

### 2. create_workflow v13 — right brain gate flow
- Step 3 `js_transform`: produces `{ value, label, description, on_select }` options — no label concatenation
- Step 3a `js_transform`: formats `right_brain_research.findings` into `research_summary` for display
- Step 3b `human_gate confirm`: always fires after right brain — shows findings, decisions made, question count. User can Cancel before the expensive left brain LLM call
- Step 4 condition → step 5 iterator → each gate now uses `gate_type: "choice"` with lettered buttons

### 3. Iterator human_gate suspension — system fix
- `executeIteratorInline` in `run-workflow.mjs` now detects `result.nextAction === 'suspend'`
- Pushes gate frame with `step_ref.options` resolved to live array (not template string)
- Iterator frame stays on stack at `current_index` — resume_gate re-enters correctly

### 4. resume_gate — stepRef.options.find fix
- When gate frame is pushed from iterator, `resolvedStepRef` stores the live options array
- Fixes `(stepRef.options ?? []).find is not a function` crash on user response

### 5. choice gate type — new first-class gate type
- `step-executor.mjs` `buildDialog`: new `case 'choice'` emits `description_list` field + lettered action buttons
- `callback.mjs` `dialogToBlocks`: new `case 'description_list'` renders `*A* — label: description` lines above buttons
- `run-workflow.mjs` `resume_gate`: `choice` matches on `option.value` (HTML radio semantics), writes selected value to `output_key`
- `PGC_StepType` `human_gate` row needs manual update — see deploy checklist below

### 6. LLM API — response_format + maxOutputTokens
- `llm-client.mjs`: `response_format: { type: "json_schema", json_schema: { name: "output", schema: outputSchema, strict: false } }` added when `outputSchema` is present
- `max_output_tokens` wired end-to-end: `PGC_Prompt.max_output_tokens` → `callLlm` → `callLlmWithCorrection`
- Reduces field-name hallucination at model level, not just at Ajv correction time

### 7. analyze_and_design_workflow prompt rewrite
- Prompt id 25 rewritten with explicit `DO NOT use` field list, concrete examples for `process_design` and `dialog_designs` items
- `max_output_tokens: 4000` set
- Not yet validated — 4 failed runs in `PGC_Prompt.error_log` pre-rewrite

### 8. WORKFLOW_ERROR Slack overflow fix
- `callback.mjs` `postWorkflowError`: raw AJV error JSON no longer posted to Slack block
- Three summary cases: validation failure → error count + "logged for improvement"; LLM error → first 200 chars; structural → first 500 chars
- Full error remains in CloudWatch and `PGC_Prompt.error_log`

### 9. create_workflow routing — step 10 on_falsy dead target
- `create_workflow` v11 → v13: step 10 `on_falsy` corrected from dead target `"11"` to `"11a"`
- Seed synced from live DB v10 as authoritative source

---

## Files changed this session

| File | Change |
|---|---|
| `run-workflow.mjs` | `isLlmError` extended; iterator human_gate suspension; `resolvedStepRef` options fix; `choice` gate `value`-based matching and `output_key` write |
| `step-executor.mjs` | `case 'choice'` in `buildDialog`; `description_list` field type; `isChoice` flag on actions builder |
| `callback.mjs` | `postWorkflowError` human-readable summary; `case 'description_list'` in `dialogToBlocks` |
| `llm-client.mjs` | `response_format` json_schema; `max_output_tokens` param on both functions |
| `review-output.mjs` | `max_output_tokens` forwarded to `callLlmWithCorrection` |
| `seed_PGC_Workflow.json` | `create_workflow` v13: step 3 expression (value/label/description options), step 5 item_step `gate_type: choice`; step 10 on_falsy fix |
| `seed_PGC_Prompt.json` | `analyze_and_design_workflow` rewritten; `max_output_tokens: 4000` |

---

## Deploy checklist for next session

```cmd
sam build && sam deploy

rem Workflows
node dev_scripts/upsert-workflow.mjs create_workflow
node dev_scripts/upsert-workflow.mjs fix_workflow

rem Prompts
node dev_scripts/upsert-prompt.mjs analyze_and_design_workflow
node dev_scripts/upsert-prompt.mjs research_workflow_domain
node dev_scripts/upsert-prompt.mjs classify_intent_tier2
node dev_scripts/upsert-prompt.mjs fix_workflow_steps

rem Step types — manual edit required first (see below)
node dev_scripts/upsert-step-type.mjs human_gate
```

### Manual edit required — seed_PGC_StepType.json human_gate row

Apply before running `upsert-step-type.mjs`:

**`input_contract[gate_type].description`:**
```
confirm | edit_list | text_input | review_object | choice
```

**`input_contract[options].description`:**
```
Array of option objects — must include at least one with action/value: "cancel". Shape by gate_type: confirm/edit_list/review_object use { label, action, on_select }; choice uses { value, label, description, on_select } where value is the machine identifier written to output_key, label is the short button text (e.g. "A", "B"), and description is the explanatory sentence displayed above the buttons.
```

**`description` (top-level)** — append to existing gate types list:
```
, choice (single-select with question heading, lettered buttons A/B/C, and per-option description lines — output_key written with selected value)
```

---

## DB state at session end

| Item | State |
|---|---|
| `create_workflow` | v10 in DB (step 10 dead target). Seed is v13. Needs `upsert-workflow.mjs create_workflow` |
| `fix_workflow` | v1 in DB (missing step 4b). Seed is 18-step. Needs `upsert-workflow.mjs fix_workflow` |
| `analyze_and_design_workflow` (prompt id 25) | Rewritten in seed, not yet upserted. 4 failed runs in `error_log` |
| `PGC_WorkflowRun 219` | `awaiting_human_gate` at step 5 iterator index 0. Will error on resume with old code. Cancel or let expire |

Cancel run 219 before testing:
```cmd
curl -s -X POST https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/proc/shutdown -H "Content-Type: application/json" -d "{\"workflowRunId\":219}"
```

---

## First test after deploy

```
/m create workflow Spanish flashcard quiz
```

Expected flow:
1. Step 1: `serv_query PGC_Schema` → `domain_schema: []` (domain still null — see open issue)
2. Step 2: `research_workflow_domain` → valid on attempt 1 (response_format now applied)
3. Step 3: `js_transform` → `preference_gates` with `value/label/description` options
4. Step 3a: `js_transform` → `research_summary`
5. Step 3b: `human_gate confirm` → shows right brain findings → **you must click Continue**
6. Step 4: condition on `preference_gates.length` → routes to step 5 (if questions) or step 6
7. Step 5: iterator → **each gate should now suspend properly and show A/B/C buttons**
8. Step 6: `serv_query PGC_StepType`
9. Step 7: `analyze_and_design_workflow` → **first test of rewritten prompt + response_format**

Watch for: step 7 validation result (valid on attempt 1 would confirm response_format working)

---

## Open issues — priority order

### Blocking (must fix before end-to-end works)

**1. `analyze_and_design_workflow` prompt (id 25)** — 100% validation failure rate across 4 runs.
Prompt rewritten + `response_format` added this session. Not yet tested.
See `docs/prompt-issues.md` Issue 2.
If still failing after deploy: share CloudWatch error output and the exact AJV errors.

**2. `domain: null` on `create_workflow` runs** — `input.domain` is never resolved before
CREATE_WORKFLOW SQS dispatch. `research_workflow_domain` and `analyze_and_design_workflow`
receive no schema context. The right brain cannot surface domain-specific preference questions
(e.g. "Evaluate answers by LLM or self-report?") without knowing what tables exist.
Fix: resolve domain in `classify-intent.mjs` `resolveTier3Route()` before enqueuing,
and add `domain_schema` as an input to `research_workflow_domain`.

### High (next session)

**3. Tier 1 post-write validation** — after `fix_workflow` step 8 and `create_workflow` step 19
write to `PGC_Workflow`, run Level 1 simulation on the written step array immediately.
If dead routing targets are found, fail and notify rather than letting the user discover
at runtime. This is NOT Tier 3 maintenance — blocking defects must be caught pre-execution.

### Medium

**4. `fix_workflow_steps` prompt text** — still says "complete array — not a diff".
Update to "return only the steps you changed" now that step 4b handles the merge.
`max_output_tokens` can also be lowered (was 5000 tokens for 27 steps; now ~800 for 4 steps).

**5. `research_workflow_domain` invalid JSON** — occasional sonar web-search mid-response
interruption. Investigate `tools: []` to disable web search.

---

## Architecture decisions made this session

**[DECISION] `choice` gate type is the correct gate for preference questions.**
`confirm` was being repurposed for multi-option choices by hand-crafting button labels.
`select_one` was limited to flat entity lists via `context_key` only.
`choice` is the first-class gate type for single-select with question, labelled options,
and descriptions — modelled on HTML radio button semantics.
`confirm` and `select_one` are unchanged; no existing workflow breaks.

**[DECISION] TROUBLESHOOT_WORKFLOW does not fire on LLM errors.**
Validation failures and LLM response failures are prompt/service quality issues.
Workflow structure analysis cannot fix them. The discriminator covers:
`/LLM (returned|call timed)|llm_call validation failed/i`

**[DECISION] Tier 1 post-write validation is NOT Tier 3.**
Dead routing targets in a newly written workflow are blocking defects — the user
cannot retry until fixed. They must be caught immediately after every `PGC_Workflow`
write, not on a scheduled maintenance pass. Classified as Tier 1 reactive.

**[DECISION] `response_format: json_schema` is now applied to all Agent API calls
when `output_schema` is present.** This enforces schema at the model level and is
the primary defence against field-name hallucination, not the Ajv correction loop.
`strict: false` — our schemas use `additionalProperties: false` which handles
strictness at Ajv validation time.

**[DECISION] WORKFLOW_ERROR Slack messages show human-readable summaries only.**
Raw AJV error JSON (5000+ chars) cannot be posted to a single Slack block (3000-char
limit). Full error detail belongs in CloudWatch and `PGC_Prompt.error_log`.

---

## Prompt issues log

See `docs/prompt-issues.md` for full details on all 4 active prompt quality issues.
This document should be committed to the repo and updated each session.
