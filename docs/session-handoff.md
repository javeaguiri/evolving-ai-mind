## Session 20 handoff — evolving-mind-ai

### Context

Session 19 completed: `condition` step type, `get_entity` id-branch, `js_transform`
generic sandbox (acorn AST gate + `vm.runInNewContext`), `serv_entity_schema` step
type, intent fixes (Pass 1 domain derivation, `update_entity` missing fields guard,
UC 1.4 `record_id` threading), Slack block 3000-char chunking, `serv_entity_get`
not-found graceful handling, `extractSearchTerm` field=value prefix stripping.

Current git state: all session 19 changes committed.
Tag before starting: `v3.2-js-transform-sandbox-serv-entity-schema`

---

### What surfaced from the flash card domain

Creating the flash card domain exposed four structural gaps. These define all of
Session 20's work. They are ordered by dependency — each item unblocks the next.

---

### Item 1 — `delete-domain` + `add_table` smoke test before new schema work

Before designing the corrected flash card schema, confirm that the existing
`delete-domain` endpoint and `add_table` feature work correctly. This is the
path that will be used to drop and rebuild the flash card domain.

**Steps:**
1. Run `/create-domain` to confirm `delete-domain` cleanly removes all PGC and PGD
   artefacts for the flash card domain (tables, schema rows, entity schema,
   domain help, intent map rows, workflows).
2. Inspect the `delete-domain` implementation — confirm it removes from all six
   tables: `PGD_*` physical tables, `PGC_Schema`, `PGC_TableMap`, `PGC_EntitySchema`,
   `PGC_DomainHelp`, `PGC_IntentMap` (the five `*_entity` rows), `PGC_Workflow`
   (the five `*_entity` workflows).
3. Recreate the flash card domain with the corrected schema (Item 2).
4. Use `add_table` (if it exists in `create_domain`) to add the missing parent table.
   If `add_table` is not yet functional, document what is missing and fix it.

Share `delete-domain.mjs` and the current `create_domain` workflow definition at
session start.

---

### Item 2 — Corrected flash card schema design

The current flash card domain has two problems:

**Problem A — missing FlashCardSet parent table.**
Flash cards need a parent grouping concept (deck, set, topic) so the quiz workflow
can say "quiz me on the colours set" rather than querying all flash cards regardless
of topic. The correct schema has three tables:

```
PGD_FlashCardSets       — id, name, description, language, created_at, updated_at
PGD_FlashCards          — id, set_id (FK → PGD_FlashCardSets), front, back,
                           proficiency_level (integer 0–5), last_reviewed_at,
                           created_at, updated_at
PGD_FlashCardSessions   — id, set_id (FK → PGD_FlashCardSets), started_at,
                           completed_at, total_cards, correct_count,
                           created_at, updated_at
```

`PGD_FlashCardSessions` is the session/metrics table from the current domain,
correctly linked to a set rather than floating free.

**Problem B — session/metrics tables were created as a separate domain.**
The session metrics tables belong to the flash card domain, not to a separate domain.
When the domain is recreated, all three tables must be in the same domain with the
correct FK relationships.

**Entity design:**
- Entity `FlashCardSet` — root: `PGD_FlashCardSets`, children: `PGD_FlashCards`
- Entity `FlashCardSession` — root: `PGD_FlashCardSessions`, no child tables

The quiz workflow operates on a set (not the whole domain) and writes session rows
to `PGD_FlashCardSessions`.

**Before redesigning:** share the current generated schema from the flash card
domain create attempt (available via `/m list PGC_Schema` or CloudWatch logs from
the `create_domain` run) so the LLM prompt variance that produced the wrong design
can be diagnosed before the next run.

---

### Item 3 — `add_entity` child FK interdependency bug

`/m add flash cards` is failing due to table interdependencies. The symptom is that
`buildChildInserts` produces inserts for child tables before the root record id is
available, or the FK column name derived from `PGC_EntitySchema.joins` does not
match the actual physical FK column name.

**Diagnosis steps:**
1. Run `/m add flash cards front=hola back=hello` and share the CloudWatch error.
2. Inspect the `PGC_EntitySchema` row for the FlashCard entity — specifically the
   `joins` array and `aggregations` array — to confirm the FK column derivation is
   correct.
3. Check whether `buildChildInserts` is reading `fk_column` correctly from the
   assembled schema produced by `serv_entity_schema`.

Share the CloudWatch log from the failing `add` attempt and the `PGC_EntitySchema`
row for the FlashCard entity.

---

### Item 4 — Flash card quiz workflow design

This is the most significant item in Session 20 and the reason for the corrected
schema. The quiz workflow is the primary probe for `create_workflow` — it surfaces
framework gaps systematically. The design must be correct before running
`create_workflow`, not patched after.

**What the quiz workflow requires that does not yet exist:**

| Requirement | Current state | What is needed |
|---|---|---|
| Work on a named set | No set concept yet | `FlashCardSet` entity (Item 2) |
| Per-card proficiency tracking | No `proficiency_level` column yet | Corrected schema (Item 2) |
| Session tracking | Session tables exist but floating | Linked to set (Item 2) |
| Loop N cards from a set | `iterator` exists | `serv_entity_query` with set filter |
| Evaluate translation quality | `llm_call` exists | New `evaluate_translation` prompt in PGC_Prompt |
| Update proficiency after evaluation | `serv_update` exists | `update_entity` or direct `serv_update` |
| Score summary at end | `js_transform` expression sandbox exists | `items.reduce(...)` expression |
| Write session record | `serv_insert` exists | Step in workflow |

**Workflow design to confirm before running `create_workflow`:**

```
Step 1  serv_entity_query — fetch N cards from the named set (filter: set_id, limit: N)
          output_key: quiz_cards

Step 2  serv_insert PGD_FlashCardSessions — create session record
          output_key: session

Step 3  iterator over quiz_cards
          item_step:
            Step 3a  human_gate text_input — show front, ask for translation
            Step 3b  llm_call evaluate_translation — score the response
            Step 3c  js_transform expression — increment correct counter
            Step 3d  serv_update PGD_FlashCards — update proficiency_level
                     (condition: correct → level+1, incorrect → max(level-1, 0))

Step 4  js_transform expression — compute final score
          expression: "items.reduce((a,r) => a + (r.correct ? 1 : 0), 0)"
          input_key: quiz_cards (augmented with results during iterator)

Step 5  serv_update PGD_FlashCardSessions — write completed_at, correct_count

Step 6  notify — post score summary

Step 7  end
```

**Before building the quiz workflow:** the `evaluate_translation` prompt must exist
in `PGC_Prompt`. Design and seed this prompt at session start. It receives
`front` (the word shown), `expected` (the correct translation), `given` (the user's
answer) and returns `{ correct: boolean, feedback: string }`.

**The iterator limitation:** the current `iterator` step type executes a single
`item_step`. Steps 3a–3d above require four sequential steps per card, which the
iterator cannot currently express as a sub-sequence. Two options:

- **Option A — `sub_workflow` step type** (Phase 3, not yet built). Each iterator
  item pushes a child workflow frame. This is the architecturally correct solution.
- **Option B — flatten the loop** using `condition` + backward references. Quiz N
  cards by maintaining a `current_index` counter in `local_state` and looping via
  `step:N` backward jumps. This is implementable today with existing step types.

**Recommend Option B for Session 20** — it exercises the `condition` step type and
backward reference pattern without requiring `sub_workflow`. The loop structure:

```
Step 1   serv_entity_query — fetch cards       output_key: quiz_cards
Step 2   serv_insert — create session          output_key: session
Step 3   js_transform expression — init        "{ index: 0, correct: 0, total: items.length }"
           input_key: quiz_cards               output_key: quiz_state
Step 4   condition — check loop termination    expression: "{{quiz_state.index}} < {{quiz_state.total}}"
           on_truthy: "5"  on_falsy: "9"
Step 5   human_gate text_input — show card     output_key: user_answer
Step 6   llm_call evaluate_translation         output_key: evaluation
Step 7   js_transform expression — advance     update quiz_state (index++, correct if right)
Step 8   serv_update — update proficiency      → step:4 (loop back)
Step 9   notify — score summary
Step 10  serv_update — write session results
Step 11  end
```

This design needs Guard 3 cycle detection review before simulation — the backward
reference at step 8 → step 4 contains a `human_gate` in the path (step 5), satisfying
the safe-loop rule (Section 6.7: a backward reference is safe if the path from target
back to source contains at least one `human_gate`).

**Confirm this design before running `create_workflow` in Session 20.**

---

### Step-by-step work order for Session 20

| Step | Work | Prerequisite |
|---|---|---|
| 1 | Inspect and run `delete-domain` on flash card domain | None |
| 2 | Diagnose `add_entity` FK bug from existing logs | None (parallel) |
| 3 | Design corrected flash card schema (3 tables, correct FKs) | Step 1 complete |
| 4 | Recreate flash card domain with corrected schema | Step 3 |
| 5 | Test `add_table` for the missing FlashCardSet parent | Step 4 |
| 6 | Verify `/m add flash cards` with corrected schema | Step 4 |
| 7 | Seed `evaluate_translation` prompt into `PGC_Prompt` | Step 4 |
| 8 | Confirm quiz workflow Option B design | Step 7 |
| 9 | Run `create_workflow` for the quiz | Step 8 |
| 10 | Smoke-test the quiz end-to-end in Slack | Step 9 |

---

### Key files needed at session start

1. `src/proc/delete-domain.mjs` — for Item 1 inspection
2. `src/serv/templates/pgc/seeds/seed_PGC_Workflow.json` — `create_domain` steps to check `add_table`
3. CloudWatch log from the failing `/m add flash cards` attempt — for Item 3 diagnosis
4. `PGC_EntitySchema` row for the FlashCard entity — query via `/m list PGC_EntitySchema`
5. `docs/architecture.md` — current version (updated in Session 19 close)
6. `src/serv/templates/pgc/seeds/seed_PGC_Prompt.json` — to add `evaluate_translation`

---

### Tech debt items surfaced in Session 19 (not yet in register)

Add these to the Section 7 register at the start of Session 20:

| Item | Priority | Notes |
|---|---|---|
| `serv_entity_query` and `serv_entity_get` missing from `seed_PGC_StepType.mjs` | ~~Low~~ | ✅ Fixed Session 19 — both added to seed file alongside `serv_entity_schema` |
| `condition` step unresolved template treated as truthy | ~~Medium~~ | ✅ Fixed Session 19 — `!resolved.includes('{{')` guard added to `isTruthy` check |
| `extractSearchTerm` passes `field=value` prefix into search | ~~Low~~ | ✅ Fixed Session 19 — leading `fieldname=` stripped before returning `search_term` |
| `serv_entity_get` throws on not-found instead of graceful empty result | ~~Medium~~ | ✅ Fixed Session 19 — `isNotFound` check returns `[]` and routes `on_success` |
| `WORKFLOW_NOTIFY` Slack block exceeds 3000-char limit on large entities | ~~Medium~~ | ✅ Fixed Session 19 — `postWorkflowNotify` in `callback.mjs` chunks text on newlines into ≤2800-char section blocks |
| `iterator` cannot express multi-step per-item sequences | Medium | Requires `sub_workflow` step type (Phase 3) or flat loop pattern. Quiz workflow uses flat loop (Option B) as MVP workaround. |
| `delete-domain` completeness unknown | Medium | Unverified whether it removes all six artefact types. Verify in Session 20 Step 1. |
