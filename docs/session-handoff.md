## Session 19 handoff — evolving-mind-ai

### Context

Session 18 completed Phase B of the Intent Preprocessor (PGC_/PGD_* table
prefix detection for direct CRUD), 50 unit tests for classify-intent-tiers,
the help workflow system commands fix, and the `run-workflow` dynamic confirm
gate write bug. The use case document is now the MVP roadmap.

Current git state: all session 18 changes committed.
Tag before starting: `v3.2-help-system-commands-complete`

---

### Structural note — the acorn/vm gap

The `js_transform` generic sandbox (acorn AST gate + `vm.runInNewContext`) is
the most consequential deferred item in the system. Every workflow that needs
computation — unit conversion, aggregation, quiz scoring — will use `llm_call`
as a workaround until the sandbox exists. Those workflows will need to be
rewritten once it lands. This is an accepted cost for the MVP, but it must
be implemented before the aggregation and cross-domain use cases are delivered,
not after. Session planning should treat the sandbox as a prerequisite for
UC-E4, UC-S4, UC-M2, and UC-P5, not a Phase 3 item.

The sandbox design is already in the architecture (Section 6.11). The
implementation work is:
1. Add `acorn` to the approved dependency registry (already listed as a
   candidate in Section 7a)
2. Implement the AST gate in `executeJsTransform` — reject async, reject
   network calls, reject file I/O
3. Replace built-in placeholders (`formatRecordList`, `buildHelpOptions`,
   `resolveHelpContent`, `buildEntitySchema`, `buildChildInserts`,
   `columnSummary`) with equivalent generic JS expressions run through the
   sandbox. The built-ins become the reference implementations.
4. Update architecture Section 6.11 to mark as complete

This should be planned as a dedicated session before any aggregation or
cross-domain workflow is attempted.

---

### Session 19 focus — easy MVP items and structural fixes

Do not add to the tech debt register for items in this session. Each item
below is either a bug fix that should have been correct from the start, or
a structural prerequisite for `create_workflow` testing.

---

### Step 1 — Small structural fixes (no new features)

These are correctness fixes, not enhancements. All are in `classify-intent.mjs`
or `run-workflow.mjs`.

**1a. UC 1.4 — `get_entity` id-based lookup**

`handoff()` in `classify-intent.mjs` currently posts an instructive error when
`record_id` is set on a `get_entity` result. The correct behaviour is to pass
`record_id` as `input.id` into the WorkflowRun input and let the workflow step
handle it.

In `classify-intent.mjs` `handoff()`, remove the `record_id` instructive error
block (lines ~329–343 in the current file). Add `record_id` to `workflowInput`
alongside `search_term`:

```js
...(result.record_id !== null ? { id: result.record_id } : {}),
```

In `seed_PGC_Workflow.json` `get_entity` step 1, the `serv_entity_query` step
needs to branch on `input.id` vs `input.search`. The step definition should
use `serv_entity_get` when `input.id` is set and `serv_entity_query` when
`input.search` is set. This requires either a `condition` step type (Phase 3)
or restructuring the workflow so `get_entity` has two paths — one for id, one
for name search. The cleanest MVP solution is to split into two separate steps
driven by which input field is populated, using `{{input.id}}` template
resolution to null-check. Propose the step definition before writing code.

**1b. `update_entity` missing fields guard**

In `classify-intent.mjs` `handoff()`, after `parsedId` is set and
`result.workflow_name === 'update_entity'`, check if `parsedUpdates` is null.
If so, post an instructive error without creating a WorkflowRun:

```js
if (result.workflow_name === 'update_entity' && parsedId !== null && !parsedUpdates) {
  // post: "To update a <domain> record I need at least one field=value pair..."
  return;
}
```

**1c. `classify-intent.mjs` domain derivation for non-entity Pass 1 matches**

Currently when Pass 1 matches a non-`_entity` intent category (e.g. `help`),
the domain is derived by stripping the verb prefix:
```js
domain = intentMatch.intent_category.replace(/^(get|list|add|update|delete|search)_/, '');
```
For `help`, this produces `domain: 'help'` — visible in the Session 18 logs.
The `help` workflow has no domain. The domain field should be `null` when no
domain alias resolves from userInput and the intent category is a system
workflow. This is a log cleanliness fix — it does not affect routing.

---

### Step 2 — Phase B unit tests (Groups 3–4)

Add a new `describe` block to `tests/unit/classify-intent-tiers.test.mjs`
covering the four Phase B functions added in Session 18. These are pure
functions — same pattern as the existing 50 tests, no network required.

Test matrix for `hasTablePrefix`:
- `"list PGD_Recipes"` → true
- `"list recipes"` → false
- `"PGC_Workflow"` → true
- `"pgd_recipes something"` → true (case-insensitive)
- `""` → false

Test matrix for `extractTableName`:
- `"list PGD_Recipes name=Pasta"` → `"PGD_Recipes"`
- `"update PGC_Workflow id=1"` → `"PGC_Workflow"`
- `"list recipes"` → null

Test matrix for `hasCrudVerb`:
- `"list PGD_Recipes"` → true
- `"show me PGD_Recipes"` → true
- `"something unrelated"` → false
- `""` → false

Test matrix for `matchCrudVerb` — full matrix covering all five actions:
- list with no filters → `serv_query`, no filters array
- list with field=value → `serv_query`, filters populated
- insert with fields → `serv_insert`, row populated
- insert with no fields → `{ ambiguous: true, action: 'insert' }`
- update with id + fields → `serv_update`, filters + updates
- update with id, no fields → `{ ambiguous: true, reason: 'no_fields' }`
- update with no id → `{ ambiguous: true, reason: 'no_id' }`
- delete with id → `serv_delete`, filters
- delete with no id → `{ ambiguous: true, action: 'delete' }`
- no verb matched → null

Run full suite after adding — confirm 50 existing + new tests all pass.

---

### Step 3 — `create_workflow` end-to-end test

`create_workflow` is the highest-leverage item in the system. It enables every
domain workflow that the use cases require. It has never been tested
end-to-end. This step proves it works or finds what is broken.

**Test case: Spanish vocabulary quiz workflow**

This is the recommended first `create_workflow` test because:
- Self-contained — no cross-domain reads, no external data, no unit conversion
- Uses only `llm_call`, `human_gate`, `serv_entity_query`, `notify`, and
  the `step:N` backward reference loop pattern
- Produces a visible, testable output in Slack
- Maps directly to UC-L4

**Before running `create_workflow`:**
- Confirm the vocabulary domain exists or create it via `/create-domain`
- Add a handful of vocabulary items via `/m add vocabulary...`
- Confirm `get_entity` and `list_entity` work on the vocabulary domain

**Run:**
```
/m create a workflow that quizzes me on Spanish vocabulary — presents one word
at a time in Slack, asks for the English translation, evaluates the response
using an LLM, records the result, and continues until 10 words have been
tested, then posts a summary score
```

**What to verify:**
- `create_workflow` completes all 12 steps including simulation
- The generated workflow definition is inspectable via `/m list PGC_Workflow`
- The quiz workflow runs end-to-end in Slack
- The loop pattern (step:N backward reference through a human_gate) satisfies
  Guard 3 cycle detection
- Results are written to a `PGD_QuizResults` table (the workflow should create
  or reference this)

**If `create_workflow` fails:** Read the CloudWatch logs and the
`PGC_WorkflowRun` state at the point of failure. Do not patch around failures
— identify whether the failure is in the LLM generation, the Ajv validation,
the simulation step, or the registration step. Each failure mode points to a
different fix.

---

### Step 4 — Architecture updates

After Steps 1–3 are verified, update `architecture.md`:

- Section 6.3a: document the UC 1.4 fix — `record_id` passed as `input.id`
  to workflow input; `get_entity` step 1 branching behaviour
- Section 6.3a: document the `update_entity` missing fields guard
- Section 6.3: fix the Pass 1 non-entity domain derivation note
- Section 7 Tech Debt Register: mark UC 1.4, update_entity guard, and Pass 1
  domain derivation as resolved
- Section 7 Tech Debt Register: elevate `js_transform` generic sandbox from
  Medium/Phase 3 to **High/pre-aggregation prerequisite** with the rationale
  that deferring it forces `llm_call` workarounds in aggregation workflows that
  will need to be rewritten
- Git tag table: add `v3.2-help-system-commands-complete` and the new
  Session 19 tag

---

### Key files needed at session start

Share these before any code work:

1. `docs/architecture.md` — current version
2. `src/proc/classify-intent.mjs` — for Steps 1a, 1b, 1c
3. `src/proc/classify-intent-tiers.mjs` — for Step 2
4. `tests/unit/classify-intent-tiers.test.mjs` — for Step 2
5. `src/serv/templates/pgc/seeds/seed_PGC_Workflow.json` — for Step 1a
   (get_entity step definition)

---

### Build order for sessions beyond Session 19

This is the structural sequence the MVP use cases impose. Each row is a
session-scale item.

| Order | Item | Unblocks |
|---|---|---|
| 1 | `js_transform` generic sandbox (acorn + vm) | UC-E4, UC-S4, UC-M2, UC-P5 |
| 2 | `serv_aggregate` step type (GROUP BY at DB) | UC-E4, UC-S4 |
| 3 | `get_entity` id branch (Step 1a above) | UC-R4, UC-S2, UC-L2 |
| 4 | Receipt parsing workflow (UC-P4, UC-E3) | Pantry and expense receipts |
| 5 | `create_workflow` for menu planning (UC-M1) | UC-M2 |
| 6 | Cross-domain `serv_entity_query` pattern | UC-P5, UC-M2, UC-S5 |
| 7 | User-defined aggregate view workflow | UC-S4, UC-E4 |
| 8 | Portfolio index comparison (UC-S5) | Stock MVP completion |
| 9 | Quiz result history + adaptive quiz (UC-L5, UC-L6) | Language learning completion |
