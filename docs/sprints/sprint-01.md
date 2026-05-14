# Sprint 1 — Engine Expressiveness

**Goal:** Expand two general engine capabilities that benefit all workflows and all domains — richer human gate rendering and self-healing post-write validation. No domain-specific logic.

**Branch:** `sprint/01-engine-expressiveness` (create before first code change)

---

## Scope

### Track A — Reveal Gate Field

Add a `reveal` optional field to existing `human_gate` step types (`choice`, `text_input`, `review_object`). Composable — does not add a new gate type.

**Step definition shape:**
```json
{
  "gate_type": "choice",
  "reveal": {
    "button_label": "Show Definition",
    "content": "{{some.template}}"
  },
  "options": [...]
}
```

**Engine changes:**
- `step-executor.mjs` — `buildDialog`: detect `reveal` field, resolve template in `content`, include in HUMAN_GATE SQS payload
- `src/ui/slackbot/callback.mjs` (SlackCallbackListenerFunction) — render a "Reveal" button; clicking it opens a Slack modal showing the resolved content without resuming the gate
- `src/ui/slackbot/interactive.mjs` — handle `peek_reveal` action: open modal, do NOT enqueue `resume_gate`
- L1 validation: if `reveal` present, `reveal.content` must be a non-empty string; `reveal.button_label` must be a non-empty string

**PGC_StepType + SystemContext:** Update contracts and `step_type_contracts` context entry to document `reveal`.

### Track B — Post-Write L1 Validation (Task 11)

When a workflow is saved (via `upsert-workflow` dev script or the `create_workflow` PROC endpoint), immediately run `runLevel1StaticAnalysis` on the steps array. If issues are found, reject the write with a structured error listing all failures.

**Changes:**
- `src/serv/` — `POST /api/v1/serv/schema/upsert` (or whichever endpoint `PGC_Workflow` writes go through): add L1 validation call before DB write. Since SERV has no access to `step-executor.mjs` (PROC tier), L1 validation runs in PROC before the SERV call.
- `src/proc/run-workflow.mjs` or `create_workflow` handler: call `runLevel1StaticAnalysis(steps)` before calling `servPost` to persist the workflow.
- Return value: `{ valid: false, issues: [...] }` → 422 response with issue list.
- `dev_scripts/upsert-workflow.mjs`: surface L1 errors clearly in terminal output.

### Track C — ping_core Updates

Update the `ping_core` workflow artifact (`seed_PGC_Workflow.json` + upsert) to:

1. **Fix condition step (step 8):** Add a preceding choice gate (`8p`) letting the user pick "True" or "False" path. js_transform converts to boolean. `on_truthy` → `8y` ("TRUE path confirmed"), `on_falsy` → `8n` ("FALSE path confirmed"). Both converge on `9f`. Demonstrates that both branches actually route correctly.

2. **Add reveal test (step 6, new):** After text input special button test, add a `choice` gate with a `reveal` field. The reveal hides a definition; user clicks "Show Definition" to see it, then picks the correct answer. Labels it "Test 6 of 10 — Reveal Gate".

3. **Fix numbering:** Standardize all `message_template` headers to "Test X of 10" across all 10 visible test steps.

| # | Test | Step |
|---|------|------|
| 1 | Choice gate | 2 |
| 2 | Text input | 3 |
| 3 | Multiline input | 4 |
| 4 | Modal via special_button | 5 |
| 5 | Text input special button | 5b |
| 6 | **Reveal gate** (new) | 6r |
| 7 | Review object | 7 |
| 8 | Condition step | 8p → 8 → 8y/8n |
| 9 | Follow-up button | 9f |
| 10 | Notify | 9 |

---

## Out of Scope

- Nested template L1 detection (backlog)
- `PGC_WorkflowRun.session_id` FK migration (Task 10)
- domain:null Pass 2 fix (Task 12)
- Task 9 (`analyze_and_design_workflow` field name validation)
- Any domain-specific workflow or artifact changes

---

## Acceptance Criteria

- [ ] `reveal` field renders a button in Slack; clicking it opens a modal with resolved content; gate is not resumed
- [ ] `reveal.content` template tokens resolve correctly at render time
- [ ] L1 catches missing/invalid `reveal` fields (button_label empty, content empty)
- [ ] Post-write L1 rejects a workflow with known-bad steps before DB write; returns structured issue list
- [ ] `upsert-workflow.mjs` surfaces L1 errors clearly
- [ ] ping_core runs end-to-end: all 10 tests pass, numbering shows "X of 10", condition shows both paths, reveal step works
- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] Simulate Level 1+2 pass on ping_core

---

## Sprint Close Checklist

- [ ] Unit tests pass
- [ ] L1+L2 simulation pass on ping_core
- [ ] `CLAUDE.md` Current State updated
- [ ] `docs/architecture.md` updated (reveal field, L1 post-write gate)
- [ ] `docs/data-architecture.md` updated if any schema changes
- [ ] `docs/backlog.md` updated
- [ ] This file renamed to `docs/sprints/sprint-01.md` with outcome notes

---

## Outcome

**Status:** Complete — merged to main 2026-05-14.

**Acceptance criteria met:**
- ✅ `reveal` field renders inline `task_card` above gate buttons (no click required)
- ✅ `reveal.content` template tokens resolve correctly at render time
- ✅ L1 catches missing/empty `reveal.button_label` and `reveal.content`
- ✅ Post-write L1 rejects workflows with bad steps before DB write; 422 with issue list
- ✅ `upsert-workflow.mjs` surfaces L1 errors clearly
- ✅ `ping_core` v16 end-to-end: all 10 tests pass, "Test X of 10" numbering, condition both paths verified, reveal step works
- ✅ 225/225 unit tests pass
- ✅ L1+L2 simulation passes on ping_core (0 issues)

**Retro notes:**
- Condition step seeds had `step:N` routing format in `on_truthy`/`on_falsy` — schema requires bare keys. Fixed 10 occurrences across 4 workflows. L1 enforces this going forward.
- `reveal` UX iterated: started as modal (`views.open`), moved to thread `chat.postMessage`, then to inline `task_card` in the gate message. Final form (inline, always visible) validated in prod.
- `simulation-engine.mjs` extraction was prerequisite work not in original scope but necessary to avoid duplication.
