# Sprint 9 — Novia Builds Workflows

**Status: IN PROGRESS. Scoped and branched 2026-07-29 — `sprint/09-novia-builds-workflows`.**
Track A complete (A1–A4 ✅) as of 2026-07-30. Track B is the next work.

> Read before implementing: `docs/sprints/sprint-08.md` §RETRO, and `docs/arch-minds-eye.md`
> §12 (the dissolution proposal) — specifically §12.7 for what is settled and what is open.

---

## Sprint Goal

**Move workflow creation into Novia, bridging this system's conventions to the code-writing
capability she already has.**

Sprint 8 proved the `create_workflow` development loop is free. The 2026-07-26 evaluation
concluded the pipeline is not converging regardless — 98 runs, 4 surviving workflows,
`generate_workflow_steps` at v49 with the defect class moved from structural to semantic. The
direction set in §12 is to dissolve it. This sprint is the capability evaluation that decision
is gated on.

### The framing rule — read this before writing anything for Novia

Novia can already write code. What she cannot know is **this system's conventions**: that a
workflow is a step array with particular routing fields, that `local_state` carries values
between steps, that a human gate is a UI widget contract with caps and a rendering tier that
must not be told domain vocabulary.

Everything written for her bridges those conventions to a skill she has. It states **what the
engine accepts** and **what each tier owns**. It does not state how to design.

**The overstepping test, applied to every line written this sprint:** is this statement of the
form *"the engine accepts X"* or *"this tier owns Y"*? If instead it is a fill-in-the-blank
structure, an ordering she must follow, or a syntax she must emit — we have overstepped, and
that line comes out. Templates and archetypes are explicitly parked (see Out of Scope): they
would commit to a shape before there is any evidence she needs one.

**Branch:** `sprint/09-novia-builds-workflows` (cut from main 2026-07-29)

---

## Acceptance Criteria

| # | Criterion |
|---|---|
| **AC1** | A convention bridge exists as `PGC_SystemContext`, injected into `minds_eye_system_prompt`, and passes the overstepping test line by line. |
| **AC2** | The bridge sources registry facts **by query, not transcription** — step types from `PGC_StepType`, gate mechanics from the `human_gate` contract, prompt names from `PGC_Prompt`. No hand-maintained list of anything that already exists as a row. |
| **AC3** | **L0** runs inside `simulation-engine.mjs` as a level below L1, with its schema composed from `PGC_StepType.input_contract` and never hand-authored. Runs on both a sketch and a filled array, replacing the `skeleton: true` flag threaded through `runSimulation`. |
| **AC4** | `register_workflow` exists as a gated Novia tool (`GATED_WRITE_TOOLS`), writing `PGC_Workflow` + `PGC_IntentMap`. |
| **AC5** | **Novia builds one new workflow end-to-end from a Slack request** — designed in conversation, simulated, registered, and then *run successfully*. No `create_workflow` involvement at any point. |
| **AC6** | Turn and action budgets support a full build. Session compression at the turn-limit gate (§6.1) is exercised deliberately rather than incidentally. |
| **AC7** | **Quiz dialog fixed at the contract, not the threshold.** `human_gate` carries option-set properties; `callback.mjs` renders from them. `flashcard_quiz_session` step 12 renders six buttons again **and** `edit_budget` step 3 still renders a dropdown. |
| **AC8** | Novia diagnoses and repairs `edit_budget` step 5 unaided — Generation fault domain, no code change. Fallback: hand-repair and record why she could not. |
| **AC9** | **Cost per delivered working workflow measured** for the Novia path, against the `create_workflow` baseline of ≈$1.42 per paid build (run 729). This is the §12.7 OQ1 evidence the dissolution decision is gated on. |

---

## Out of Scope

| Item | Why |
|---|---|
| **Bounded translation drift** | Dropped. It relaxes a constraint that exists only because the routing skeleton locks, and §12.11 showed the drift it was permitting is a dialog strategy expanding an interaction point — dissolved structurally, not by relaxing a rule. Remove from backlog High Priority at close. |
| **Archetype / dialog-strategy seed content** | Parked behind the framing rule. Writing procedures and strategies as data commits to a shape before Novia has shown what she needs. Revisit in Sprint 10 with evidence from real builds. |
| **The §12.11 / §12.12 notation** | `{{slot:name}}`, `include`/`bind`, `for_each`/`{{each}}` are an invented mini-language — the exact pattern `CLAUDE.md` warns against. Parked with the registry. The *findings* in those sections stand; the notation does not. |
| **`PGC_DialogStrategy` table; bootstrapping `PGC_Archetype`** | Follows the registry. Both stay committed and unbootstrapped. |
| **`create_workflow` prompt repairs** | The four design prompts are retired by the direction. Repairing them is work on documents with no future, and prompt edits churn every replay fingerprint recorded against them. **Do not run `create_workflow` this sprint** (`design_workflow_dialogs` v19 is spliced — §12.8). |
| **Release-readiness** | Test environment, README bootstrap, log hygiene. Preempted twice now; carries to Sprint 10. |
| **`/chat` dead code removal** | Deletion still undecided; independent of this sprint. |

---

## Tracks

### Track A — The convention bridge

The prep work. Nothing in Track B can be judged until this exists, because the whole question is
whether conventions alone are enough.

- **A1** ✅ **DONE** — `workflow_convention_bridge` (`PGC_SystemContext` id 45, v1, 7.8 KB).
  Covers what a workflow is (step array, routing fields, terminal steps), how `local_state`
  carries values, `{{token}}` resolution, the execution guards, and where the
  Procedure/Experience boundary falls.
  **Loaded on demand, not resident** — the user's call, taken to keep the baseline Novia prompt
  concise. Novia fetches it by key exactly as the `sop_*` rows are fetched; `query_table` is a
  `READ_TOOL`, and read tools do not increment `actionCount` (`minds-eye.mjs:495` vs `:547`), so
  the fetch costs one turn and zero actions. `loadPrefsAndPrompt` is untouched — **A1 is
  entirely data**.
  `minds_eye_system_prompt` v27 → v28, net shorter: a WORKFLOW STEP ARRAYS precondition pointing
  at the bridge before designing, proposing **or repairing** a step array (the trigger covers
  `propose_workflow_fix`, since AC8 is a repair task and D1 is itself a token-resolution
  defect); and the hand-transcribed 13-name step type list deleted in favour of a
  `PGC_StepType` query — the list was stale by six types (`serv_upsert`, `serv_schema`, all four
  `serv_entity_*`), the same defect A3 measured in `step_type_contracts`, sitting in the prompt
  this sprint is judged against.
  Written from the engine source, not from the prose rows — five of their claims are wrong; see
  the `stale` block of §12.13.
- **A2** ✅ **DONE** — Gate mechanics come from the `human_gate` `input_contract` in
  `PGC_StepType`, queried. Four rules that existed only in the duplicates are now in the contract:
  the 40-field ceiling (an engine render limit, previously only in prompt prose); the
  `action` vs `on_select` distinction and `on_select`'s valid tokens; that a `reveal` does not
  route and must not be paired with a matching option; and that bare and `step:`-prefixed keys
  are both accepted. The `iterator` `item_step` already carried its choice-only rule — no edit
  needed.
- **A3** ✅ **DONE (audit)** — Step type knowledge is queried from `PGC_StepType`, never
  transcribed. `step_usage_patterns` (16.6 KB) and `step_type_contracts` (22 KB) do not migrate
  into the bridge. Audit result recorded in `arch-minds-eye.md` §12.8.
- **A2/A3 sequencing — the duplicates are not deleted yet, deliberately.** Deleting a
  `PGC_SystemContext` row whose `{{token}}` still appears in a prompt hands the LLM the literal
  token text (the standing backlog defect), and removing the token means editing the four design
  prompts — out of scope this sprint, and prompt edits churn every replay fingerprint recorded
  against them. `step_type_contracts`, `human_gate_dialog_rules` and the `human_gate` block in
  `workflow_constraints` are `inject_for` the create_workflow family only, so they are inert for
  Novia. **They die with the prompts.** Confirm removal at the point those prompts are retired.
- **A4** ✅ **DONE** — Overstepping test applied line by line; the cut list is defined and
  populated in `arch-minds-eye.md` §12.13. A4 did not say what the artifact *is*, so it is
  defined there: a register of rules considered for the bridge and not carried, each with a
  disposition — `registry` (already a queryable row), `overstep` (a design instruction, and
  therefore an archetype candidate), `stale` (wrong against the code). 8 / 11 / 6 rows.
  Five of the eleven oversteps are loop and save-and-continue topology across four rows — one
  procedure stated five times in four places. Reopen if a real build needs a cut rule.

### Track B — Novia builds a workflow

- **B1** ✅ **DONE** — **L0** in `simulation-engine.mjs` (AC3). `runLevel0ShapeCheck`
  composes every assertion from `PGC_StepType.input_contract`: the contract's `field`
  names already encode placement (`input.tableName` vs `gate_type`), so a required field
  is a dot path resolved against the step, and adding a step type changes what L0
  enforces with no code change. Absorbs L1's `serv_step_missing_required_input` — a
  hand-written map of 5 of the 19 types — and adds `unknown_step_type`.
  **`skeleton` is gone.** §12.7 **OQ6 closed**: L0 is a `level` selector (0/1/2, default
  2) on `runSimulation` and the existing endpoint, not a new tool — Novia gets
  "validate, then simulate" as `simulate_workflow { steps, level: 0 }` with no new
  surface. `input.skeleton: true` is accepted in `step-executor` as the retired spelling
  of `level: 0`. L1's four `!skeleton` branches are now unconditional.
  Contracts are passed in, never fetched — the engine stays pure.
  **New file** `src/proc/step-type-registry.mjs` is the single `PGC_StepType` read for
  all four consumers; deliberately not shared with `llm-harness.mjs`'s own read, which
  is fingerprint-load-bearing for the replay corpus. Absent contracts → `ran: false`,
  never a silent pass.
  **Two defects found by pointing L0 at the existing seeds**, both fixed:
  (a) **Contract fault** — the `write_memory` contract declared `memory_type`, `scope`,
  `content_key` and five others at the step root, but `buildMemoryRow`
  (`step-executor.mjs:1742`) reads every one from `step.input`. The registry was
  misstating the engine; `create_domain` step 16c was right all along.
  (b) L0's own false positive — `output_key` is not required inside an `item_step`,
  since the iterator collects return values into its own `output_key` on the parent
  frame (`run-workflow.mjs:1425`). One structural rule about nesting, not a per-type
  exception list.
  11 new unit tests (687 → 698). All 11 seed workflows pass L0.
- **B2** ✅ **DONE** — `register_workflow` gated write tool (AC4).
  `{ name, domain?, description, steps, intentPhrases?, intentKeywords? }` → one
  `PGC_Workflow` row at v1 + one `PGC_IntentMap` row per phrase, plus one for the
  workflow's own name (`source`: `name` vs `auto`). Two boundaries: it **refuses to
  write a step array that fails L0+L1+L2** (one verdict computed once, shown in the
  gate and re-checked at execution; issues returned so the next turn can correct), and
  it **creates but never updates** — an existing name is an error naming
  `propose_workflow_fix`. A failed intent-map write is reported, not swallowed.
  `minds_eye_system_prompt` v28 → v29 for the tool catalog entry. 13 new unit tests
  (698 → 711), against the real exported `buildIntentMapRows` and `deriveScope`.
- **B3** ✅ **DONE** — Turn and action budgets (AC6). Three parts.
  **Budgets raised** — `minds_eye_preferences` v3 → v4: `turn_limit` 8 → 12,
  `max_actions_per_session` 5 → 8 (`max_lifetime_turns` stays 100 — a DB constraint).
  **Pacing instruction** — `minds_eye_system_prompt` v29 → v30. `turn_limit` is a
  *per-invocation* budget, so raising it moves the boundary rather than removing it; the
  instruction has Novia choose her own stopping points — something the user could accept or
  reject, with whatever must survive the stop written down first — so the round ends
  somewhere legible. **Placed in the operating prompt, not the bridge**: how Novia paces
  herself is her operating protocol, and naming `create_workflow`'s four phases as required
  stops would have re-imported the pipeline's ordering into the one artifact whose purpose
  is to carry conventions instead (§12.5 deletes that orchestration content outright).
  **Per-turn progress line** — every *successful* turn posts a one-line notification built
  from the `reasoning` the decision already carries, so no second model call. Reported: read,
  housekeeping, inline-write and trigger tools. Not reported: `respond` and gated writes,
  which already produce the message the user reads. Failed tool calls are skipped —
  an attempt about to be corrected describes flailing, not progress; the error still reaches
  the model through the tool result. 14 new unit tests (711 → 725).
- **B4** — Drive one build end-to-end from Slack (AC5). **User runs this**, per convention.
- **B5** — Instrument the cost measurement (AC9). Novia's own turns are not fingerprinted
  (`minds-eye.mjs` calls `callLlm` directly, bypassing `llm-harness.mjs`), so her reasoning is
  not replayable — the measurement is of live spend, and that is the honest number to compare.

### Track C — The quiz dialog

**Fault domain: Contract.** `callback.mjs` behaves reasonably on what it is given; the
`human_gate` contract has no field in which a workflow can characterise an option set beyond its
size, so the renderer counted. Full diagnosis: `arch-minds-eye.md` §12.8.

- **C1** ✅ **DONE** — `option_source` (`authored | derived`) on the `human_gate` contract.
  One property, not the two §12.3 named: `ordered` is not carried, because nothing in the
  rendering rule reads it — buttons and dropdowns both preserve order, and a contract field
  with no consumer is speculative surface.
  **The default is inferred, not declared** (the user's call). `resolveOptionSource`
  (`step-executor.mjs`) reads the fact off the step where it is already stated: `options`
  given as a `{{template}}` reference, or an option carrying `iterator`, are derived by
  definition of where their entries come from. §12.8 called that signal an accident; it is
  not — it is the definition. An explicit declaration overrides it.
  `buildDialog` resolves it onto every dialog it emits, since `iterator` is expanded and
  stripped before the payload is built — which is precisely why the renderer could not
  have this and was left counting.
- **C2** ✅ **DONE** — `callback.mjs` reads `dialog.option_source` and picks the bound:
  derived collapses past `CHOICE_DROPDOWN_THRESHOLD` (5, unchanged); authored stays inline
  until `ACTIONS_ELEMENT_LIMIT` (25, Slack's cap on one actions block). Both bounds stay in
  the Experience tier and a workflow can raise neither — a declared property cannot ask for
  a message Slack rejects. Not a threshold bump.
  `dialogToBlocks` is now **exported and tested directly**: the test file carried a 214-line
  "faithful copy" of it that had already drifted, and four further copied helpers
  (`buildListSelect`, `buildSelectOptionText`, `truncateOption`, `buildObjectArrayTable`)
  died with it. All ten pre-existing `dialogToBlocks` describes now run against the real
  function. 14 new tests (725 → 739).
  **AC7 needs no workflow edit.** `flashcard_quiz_session` step 12 has no `iterator` → its
  six authored options are buttons again; `edit_budget` step 3 carries one → still a
  dropdown. C3 is therefore live verification, not repair.
- **C3** — Verify `flashcard_quiz_session` step 12 and `edit_budget` step 3 (AC7). No repair
  needed — the inferred default covers both. Verified live from Slack by the user.
- **C4** — While in `callback.mjs`: the literal `**` in a gate message (run 735) is the same file
  and still needs a repro to pin the block path. Opportunistic, not an AC.

### Track D — Capability evaluation on known-broken specimens

Three live defects with known-correct answers, which makes them the cleanest possible test of
Novia's Generation-domain scope. Found while writing §12.11 / §12.12.

- **D1** — `edit_budget` step 5 returns zero rows on every run. `selected_period` is the string
  `"2026-07"` and the step filters on `{{selected_period.0}}` / `.1`; `resolvePath`
  (`template-resolver.mjs:63`) applies a numeric key to a non-array by falling through to
  `cur[key]`, so it queries year `2`, month `0`. The form is therefore always built from an empty
  `existing_budgets`. **This is AC8.**
- **D2** — `import_budget_spreadsheet` step 9 passes an array of bare category names to a
  `serv_insert` whose column needs row objects.
- **D3** — The current date is frozen at generation time in three places
  (`edit_budget` step 2 `'2026-07'`; `import_budget_spreadsheet` step 1 `new Date('2026-07-02')`
  and step 2's literal date string). Three instances makes it a generation habit, not a one-off.
- **D4** — **Validation add:** L1 should flag `{{key.N}}` numeric indexing on a value that is not
  a known array. D1 passed L1 silently. Carried from the Sprint 8 backlog item; the only part of
  the dropped drift item that survives.

---

## Track → AC Map

| Track | ACs |
|---|---|
| A | AC1, AC2 |
| B | AC3, AC4, AC5, AC6, AC9 |
| C | AC7 |
| D | AC8 |

---

## Test Scenarios

All workflow runs are triggered **by the user from Slack** — never by curl.

1. **Quiz regression** — run `flashcard_quiz_session` to the rating gate. Six buttons, one click
   to grade. Then `edit_budget` to the period gate: still a dropdown.
2. **Greenfield build** — a Slack request to Novia for a workflow that matches none of the four
   surviving shapes. Watch for: does she query the registries, or invent? Does she ask a question
   whose answer changes the design, or ask nothing?
3. **Repair** — hand Novia `edit_budget` and the symptom ("the form always shows zeros"), not the
   diagnosis. Does she reach step 5?
4. **Budget exhaustion** — a build that hits the turn limit, to exercise compression (AC6).

---

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] L0/L1/L2 pass on the workflow Novia built
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated — §1.5 for any new tool or validation level
- [ ] `docs/arch-simulation-engine.md` updated for L0
- [ ] `docs/arch-minds-eye.md` §12.7 updated with the OQ1 answer (AC9)
- [ ] `docs/arch-data.md` — no schema change expected; confirm
- [ ] `docs/backlog.md` — bounded drift removed, D4 retained, new items added
- [ ] `docs/sprints/CURRENT.md` → `docs/sprints/sprint-09.md` with outcome notes

---

## Session Notes

### Session 1 — 2026-07-29 — Scope

Sprint scoped from a session that started as a quiz-dialog bug report and became a design
review. Sequence: the quiz rating gate turned out to be `CHOICE_DROPDOWN_THRESHOLD` catching six
authored options; that exposed `gate_type` as an enum conflating what is shown, what is asked and
which widget draws it; that settled §12.7 OQ2 (two tables) and produced the §12.10 distillation
of the four surviving workflows.

Writing `scoped_row_editor` and `ingest_and_insert` out in full (§12.11, §12.12) then produced
the notation this sprint parks. The user's call, and the right one: `{{slot:name}}`,
`include`/`bind` and `for_each` are an invented mini-language, and inventing a syntax an LLM must
emit is the violation pattern `CLAUDE.md` names explicitly. The findings in those sections stand
— that a strategy expands an interaction point, that nesting is inlining, that the shared
fragment is not about foreign keys — but they are evidence, not a design to build against yet.

Three scoping decisions taken: registry out of scope (bridge only), minimal L0 in
`simulation-engine`, and the broken specimens used as Novia's capability evaluation rather than
hand-repaired.

### Session 2 — 2026-07-29 — A2/A3 prep

`step_type_contracts` turned out to be a hand-maintained *copy* of the `PGC_StepType` rows —
identical field names, transcribed rather than referenced — carrying 17 of 19 step types and a
`human_gate` entry missing three fields the live row declares, one of them required. The
argument for querying the registry did not need making; it was already measurable. Full audit in
`arch-minds-eye.md` §12.8.

The `human_gate` and `condition` contracts were updated and upserted (`upsert-step-type.mjs`:
17 ok, 2 updated). 687 unit tests pass. Note the DB is ahead of any branch that lacks this seed
change — re-running `upsert-step-type.mjs` from an older tree would revert those two rows.
The routing-format contradiction between
`workflow_constraints` (`step:N`) and the `condition` contract (bare keys) was resolved by
describing what the engine does — `step-executor.mjs:1637` and `run-workflow.mjs:1711` strip the
prefix, so both forms are identical after normalisation. Picking a canonical form would have
invented a constraint the engine does not have, which is the bridge's failure mode rather than
its job. Closes the backlog item "Condition step routing format".

### Session 3 — 2026-07-29 — Merge, branch, and section 12 status

`design/archetype-registry` merged to main (`--no-ff`, 687 tests passing), and
`sprint/09-novia-builds-workflows` cut from it. Sprint 9 is formally started: Retro ✅, Scope ✅,
Prep ◐ (A2/A3 done, A1/A4 remain), Branch ✅.

`arch-minds-eye.md` §12's header still read "Not scoped, not decided, no implementation" — false
on all three counts and the first thing a reader met. Replaced with a dated status and a
per-subsection map so settled, parked, direction-only and register content are distinguishable.
The bridge-don't-template constraint moved there too: it governs how §12.11 and §12.12 are read,
and would otherwise have been archived with this sprint doc.

**Next:** A1 — write the convention bridge as a `PGC_SystemContext` row injected into
`minds_eye_system_prompt` — with A4's cut list kept alongside it. A1 is smaller than it looked at
scoping time: gate mechanics and step contracts are now queryable from `PGC_StepType`, so the
bridge covers only what is not already a row — what a workflow is, how `local_state` carries
values, `{{token}}` resolution, and where the Procedure/Experience boundary falls.

### Session 4 — 2026-07-30 — Track A closed, Track B built, deployed

Track A (A1, A4) and Track B's three code items (B1, B2, B3) all landed. Deployed to prod;
L0 verified live through `POST /proc/simulate-workflow` with `level: 0`. **B4 — the
end-to-end build from Slack — is the only Track B item left, and the user runs it.**

Two decisions taken in session that changed what was scoped:

**The bridge is loaded on demand, not always resident.** The user's call, to keep the
baseline Novia prompt concise. Novia fetches it by key like the `sop_*` rows; `query_table`
is a `READ_TOOL` and read tools do not increment `actionCount`, so it costs one turn and
zero actions. `loadPrefsAndPrompt` never changed — A1 came out as pure data. The trigger was
widened past new builds to cover repairs, since `propose_workflow_fix` writes step arrays too
and AC8 is a repair task whose defect (D1) is itself a token-resolution bug.

**Pacing went into the operating prompt, not the bridge.** The user proposed stopping at each
`create_workflow` phase; naming those phases as required stops would have re-imported the
dissolved pipeline's ordering into the artifact whose purpose is to avoid exactly that. Agreed
and rewritten as a principle — stop when holding something the user could accept or reject —
and placed in `minds_eye_system_prompt`, where an operating protocol belongs.

Three defects surfaced by the work rather than looked for:

1. **`write_memory`'s contract misstated the engine** — eight fields declared at the step root
   that `buildMemoryRow` reads from `step.input`. Found the moment L0 was pointed at the
   existing seeds. Contract fault; fixed and upserted.
2. **Five prose claims in the `create_workflow` context rows are wrong against the code** —
   most consequentially that an unresolved `{{token}}` "resolves to an empty string", when
   `resolveTemplate` returns the literal token text. Recorded in the §12.13 `stale` block; the
   bridge states the true behaviour.
3. **`on_else` on a `serv_*` or `llm_call` step is not a branch the engine takes.** Only
   `condition` and `simulate` read it; everything else throws and fails the run. Four prose
   rows say or imply otherwise.

Live seed state: `minds_eye_system_prompt` v30, `minds_eye_preferences` v4,
`workflow_convention_bridge` v1 (id 45), `PGC_StepType` `write_memory` + `simulate` updated.
725 unit tests pass.

**Next:** B4 (user-run). Watch whether Novia fetches `workflow_convention_bridge` unprompted
before designing — that single observation tests A1's precondition wording and is the cheapest
read available on whether archetypes are needed at all (§12.13's `overstep` rows).
