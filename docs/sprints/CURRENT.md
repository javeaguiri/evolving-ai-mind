# Sprint 8 — Replay Harness & Cost Stop

**Status: OPEN** — opened 2026-07-13.

---

## Sprint Goal

**Make the `create_workflow` development loop free.**

Perplexity spend is running ~$50/month against a $10 target. `create_workflow` is the entire bill;
running registered workflows costs nothing. The problem is not the architecture — it is that
**invoking the pipeline live is currently the only way to exercise it**, and of ~15 defects fixed on
2026-07-12, eleven were in deterministic code that never needed an LLM to find.

Sprint 8 leads with the **LLM replay harness** (`docs/arch-replay.md`), then takes the two cost cuts
that do not depend on it, then clears the work that was blocked behind it.

**Branch:** `sprint/08-replay-harness`

**Design reference:** `docs/arch-replay.md`

---

## Retro (from Sprint 7)

Full retro: `docs/sprints/sprint-07.md` §RETRO. The four findings that shape this sprint:

- **The cost problem is the test loop, not the architecture.** 42 `llm_call` steps across 7
  `create_workflow` runs. `design_workflow_process` runs twice per pass (steps 21 + 21t) = 39% of all
  spend. `research_workflow_domain` is another 17% and re-derives what `PGC_Schema` already holds.
- **The LLM was usually right; the harness was usually wrong.** `analyze_workflow_gaps` "hallucinated"
  a phantom column — it hadn't; the registry was lying. `design_workflow_process` wrote `{{edit_action}}`
  against a key nothing wrote — it was right; the gate genuinely discarded the button press.
  **Read the assembled prompt from `PGC_SessionEntry` before concluding the model misbehaved.**
- **Two consumers of one truth will always drift** (checklist rule 2e). Four separate Sprint 7 bugs
  had this shape. The replay design is constrained by it: recordings are *referenced by content*, never
  copied into the replaying run.
- **The consolidation critic is not earning its cost.** Across four live runs: found nothing → caught a
  real chain → found two real defects → **false-positived**, telling the designer to delete a step that
  was genuinely required. Keep the findings (21r); delete the re-design (21t).

---

## Acceptance Criteria

- **AC1 — Fingerprint recorded for every `llm_call`.** `PGC_Session` carries `request_fingerprint`,
  `fingerprint_hash`, `response_source`, `replayed_from_session_id`. Every live run writes them.
- **AC2 — Replay completes with zero LLM spend.** A `create_workflow` run replayed from a complete
  corpus, walking the same path, reaches the same terminal state having made **zero** Perplexity calls.
  Verified against the LLM call count, not inferred.
- **AC3 — Record mode.** `breakPolicy: always` breaks at every `llm_call`. The assembled prompt is
  readable over HTTP; a hand-supplied response resumes the run and is validated through
  `review-output` exactly as a live response is. A response that would fail validation **fails the run**.
- **AC4 — Drift breaks, and says why.** Changing a downstream `js_transform`, editing a prompt, or
  answering a gate differently produces a break at the next affected `llm_call`, with a component-level
  drift report (which of prompt/input/user_input/model/schema/memory moved, plus a text diff) and a
  `local_state` diff against the source run. `use_recorded` accepts the recording and keeps the suffix free.
- **AC5 — Historical runs are replayable.** Backfill fingerprints onto existing `PGC_Session` rows.
  Run 719 replays.
- ~~**AC6 — Step 21t deleted.**~~ **→ SPRINT 9** (deferred 2026-07-16). Revised into "partition the
  consolidation critic by who can judge it" — the original wording failed the non-expert test. The revision
  is no longer a seed edit: moving Tests 1–5 into `simulation-engine.mjs` is system code with unit tests,
  which is more than this sprint has left. Full design retained in Track B. **Nothing about it is urgent —
  the critic's false positive is contained by the step-24 gate today, and Sprint 8's remaining work
  (A6/A7/A8) is what makes iterating on it free.**
- **AC7 — `research_workflow_domain` gated on new domains.** Skipped when the domain already exists in
  `PGC_Schema`.
- **AC8 — Measured spend drop.** A full `create_workflow` development cycle (design change → verify)
  costs **$0** in replay. **Revised 2026-07-16:** both per-run cuts are gone — AC7 dropped (Session 2, step 3
  is kept) and AC6 deferred to Sprint 9 — so AC8 now rests entirely on the replay loop, which is the item
  that actually mattered: the burden was never the per-*run* cost but the per-*success* multiplier of ~10 live
  runs to land one workflow. **Demonstrated 2026-07-16:** run 720 replayed 8 `llm_call`s for 0 live calls,
  measured against `PGC_Session`. Remaining proof is a clean-corpus replay with **zero breaks** — `/replay 720`.
- **AC9 — D3: `notify` template audit.** Generated domain workflows emit markdown-formatted `notify`
  output, not raw JSON field dumps. Fixed at the creation prompts (`generate_crud_workflows`,
  `design_workflow_dialogs`), never by patching generated workflows.
- **AC10 — `edit_budget` validated end to end.** Run 719 reached L1 with a correct design; `action_key`
  (landed Sprint 7) was the last blocker. Register and run it from Slack.
- **AC11 — `/chat` dead code removed.** Obviated by Novia.

---

## Track → AC Map

| Track item | AC(s) | Status |
|---|---|---|
| A1 — Schema migration: `PGC_Session` + `PGC_WorkflowRun` columns | AC1 | ✅ DONE 2026-07-15 — migrated + verified live (commit `891246f`) |
| A2 — Fingerprint computation at the seam | AC1 | ✅ DONE 2026-07-16 — deployed + **verified live**: run 720 wrote 7-component fingerprints on all 8 `llm_call`s |
| A3 — Break policy + corpus lookup in `llm-harness.mjs` | AC2 | ✅ DONE 2026-07-16 — verified live; `on_miss` broke at all 8 calls, served all 8 recordings, **0 live calls** |
| A4 — Break suspend / `resume_llm` in `run-workflow.mjs` | AC3, AC4 | ✅ DONE 2026-07-16 — verified live across 9 breaks; re-assembly fingerprint mismatch anomaly fired correctly when code was deployed mid-break |
| A5 — `/proc/replay` endpoints + `/replay` Slack cmd | AC2, AC3, AC4 | ✅ DONE 2026-07-16 — verified live: `/replay 719` → run 720; GET served the 20KB assembled prompt from the frame; 9 resumes incl. `sessionId` + `abort` |
| A5b — `use_recorded` names its recording (`sessionId`) | AC3 | ✅ DONE 2026-07-16 — commit `2b3858a`. Validated against `candidate_ids`; notification offers one named curl per candidate. **Load-bearing**: run 720 needed 1064 on step 21 pass 1 and 1067 on pass 2 |
| A5c — `unfingerprinted` is not drift | AC4 | ✅ DONE 2026-07-16 — commit `919e874`. Own verdict; no fabricated drift list |
| A6 — Drift report (component diff + `local_state` diff) | AC4 | ⬜ **Confirmed necessary.** Every diff on 2026-07-16 was run by hand in a scratchpad. The harness said *that* it drifted; a human said *what* |
| A7 — ~~Fingerprint backfill~~ → **assembled-request hash** | AC5 | ⬜ **Redesigned — see Session 3.** The original (recompute the composite from stored messages) is impossible: assembly is lossy and prompt text is overwritten in place. The replacement is an 8th `assembled` component, and it is a **correctness** mechanism, not a convenience — see the step-23 finding |
| A8 — `dev_scripts/replay.mjs` developer loop | AC2, AC3 | ⬜ Would have collapsed 2026-07-16's 9 manual curls into one command |
| A9 — Candidate offering is keyed on count, not on request equality | AC4 | ⬜ **New — real gap.** `candidate_ids.length > 1` triggers the ambiguity warning, but the danger is *this pass ≠ the recorded pass*, which occurs at N=1. Subsumed by A7's assembled hash |
| B1 — Partition the consolidation critic | AC6 | ➡️ **SPRINT 9** (2026-07-16). Revised design complete and evidence-backed — see Track B. Deferred because Tests 1–5 → `simulation-engine` is system code + tests, not the seed edit originally scoped |
| B2 — Gate `research_workflow_domain` on new domains | AC7, AC8 | ⬜ |
| B3 — Spend measurement against Sprint 7 baseline | AC8 | ⬜ |
| C1 — `notify` template audit (D3 carry-forward) | AC9 | ⬜ |
| C2 — `edit_budget` end-to-end validation | AC10 | ⬜ |
| D1 — `/chat` dead code removal | AC11 | ⬜ |

---

## Out of Scope

Named explicitly so the deferral is a decision, not an oversight.

- **Release-readiness — test environment, README bootstrap, log hygiene.** Sprint 7's goal statement
  moved these to Sprint 8. **The cost stop preempts them.** Spend is an existential constraint on a
  project whose thesis is a low cost of ownership; release polish is not. These carry to Sprint 9.
  The replay harness is also a *prerequisite* for a sane test environment — it is the thing that makes
  a non-prod environment affordable to exercise.
- **Cross-domain `create_workflow`** (5 known gaps) — backlog.
- **`create_domain` schema critic** — backlog. Deterministic core first, LLM around it.
- **`create_workflow` domain-confirmation gate** (`input.domain: null` is legitimate in Mode C, so a
  typo silently builds a standalone workflow) — backlog.
- **`llm_call` token validation** (shared prompts silently hand the LLM its own literal `{{token}}`
  text) — backlog. Strong candidate for Sprint 9; the replay corpus makes it cheap to detect.
- **Render failure should fail the run** — backlog. A render failure in the Experience tier currently
  reports but leaves the run wedged at `awaiting_human_gate`.
- **SERV/SQS stubbing.** Decided: replay does **not** stub SERV. Stubbing would remove the tier where a
  large share of the defects actually live. Consequence — replayed runs perform real writes — is
  accepted and handled with a cleanup script, not an architectural change.

---

## Tracks

### Track A — The Replay Harness

> Design: `docs/arch-replay.md`. The seam is `llm-harness.mjs → executeLlmCall()` at the `callLlm`
> boundary. Everything above it (prompt load, context injection, memory retrieval, `resolveInput`,
> `assembleInstructions`) runs **for real** — that is what makes a replayed run evidence about prompt
> construction rather than a simulation of it. Everything below it (`review-output`, session write,
> memory write) also runs for real.

**A1 — Schema migration**
- `PGC_WorkflowRun`: `replay_source_run_id` (integer, nullable), `llm_break_policy` (text, nullable —
  `never` | `on_miss` | `always`; null ⇒ `never`).
- `PGC_WorkflowRun.status`: new value `awaiting_llm_break`. Distinct from `awaiting_human_gate` so a run
  paused for a developer is never confused with one paused for a user — by `/shutdown`, by gate tooling,
  or by a human reading the table.
- `PGC_Session`: `request_fingerprint` (jsonb), `fingerprint_hash` (text, indexed), `response_source`
  (text), `replayed_from_session_id` (integer, nullable).
- **No new table.** The corpus is a read over the diagnostics log the system already writes for every
  `llm_call` of every run.
- Update `docs/arch-data.md`.

**A2 — Fingerprint computation**
- Component hashes, not one opaque digest: `prompt` (text + version), `input` (`resolvedInput`),
  `user_input`, `model` (post-alias), `schema` (`output_schema`), `memory` (injected block).
- Keying on `(run_id, step_id)` is **unsound** — it still resolves after a path change and returns a
  response generated against a different prompt. A silently wrong hit is worse than a miss.
- Component-level (not composite-only) because memory retrieval is time-varying: `PGC_Memory` accumulates,
  so an identical run assembled a week later injects a different memory block. Under one hash that
  invalidates the whole corpus continuously; under components, memory-only drift is **soft**.
- Written on every `llm_call` regardless of mode — a live run populates the corpus for the next replay.

**A3 — Break policy + corpus lookup**
- `never` / `on_miss` / `always` — live / replay / record. **One mechanism, three policies.**
- Read from `run.llm_break_policy`. `run-workflow.mjs` already calls `loadRun()` on every step and
  `step-executor.mjs` already passes the whole run row into `executeLlmCall({ step, localState, run, traceId })`
  — the policy is **already in scope at the seam with no signature change anywhere**.
- ⚠️ `LOAD_RUN_COLUMNS` (`run-workflow.mjs:1270`) is an explicit whitelist. The two new columns must be
  added or they arrive `undefined` — failing closed to `never` and silently billing a run that was
  supposed to be free. **Unit test this specifically.**
- Not cached in the Lambda: one step is one invocation, warm containers are shared across concurrent runs
  (`BatchSize: 10`), and a cache would leak replay mode into a live user's run.
- Not carried in SQS: four producers enqueue `WORKFLOW_STEP` (including `interactive.mjs`, which is
  Experience tier and must not know what replay mode is), and the policy is mutable mid-run — a value
  copied into an in-flight message is stale by construction.

**A4 — Break suspend and `resume_llm`**
- Reuse the existing suspension machinery — the same stack-frame push/persist/SQS-resume cycle
  `human_gate` uses. Not a parallel engine.
- Suspend: stash `{ instructions, userInput, fingerprint, candidate }` on a break frame, set
  `awaiting_llm_break`, notify Slack with a **pointer** (run ID, step, drift summary) — not the payload.
- **The break notification is the interface.** It carries a literal, runnable curl for every resolution
  — real base URL, `$INTERNAL_API_KEY` referenced as an env var so no key material is ever rendered,
  and both run IDs labelled (replay vs source). A break that makes the developer go hunting for the
  route shape has handed over a chore instead of a decision. Format: `arch-replay.md` §5.
- At a break the assembled prompt lives on the **break frame**, not in `PGC_SessionEntry` — the session
  row is written after a response exists. `GET /proc/replay/{runId}` serves it from the frame.
- Resume endpoint writes `{ resolution, response }` onto the break frame; the `resume_llm` SQS message
  carries `workflowRunId` only. A hand-supplied `design_workflow_process` response can approach SQS's
  256KB limit; the frame is `jsonb` and has no such ceiling.
- Resolutions: `use_recorded` | `call_live` | `supplied` | `abort`.
- On resume the step re-executes from the top, so assembly runs again (free). The re-assembled
  fingerprint is **verified** against the one stashed on the frame. A mismatch is surfaced as an anomaly,
  never silently accepted.
- Real `human_gate` steps in a replayed run stay real — rendered in Slack, answered in Slack.

**A5 — `/proc/replay` endpoints**
- `POST /proc/replay` — `{ sourceRunId?, workflow?, input?, breakPolicy, callback }`. Always creates a
  **new** `PGC_WorkflowRun`; copies `workflow_id` + `input` from the source run; **never copies the source
  run's session entries** (recordings are looked up by content — copying would be a second copy of one
  truth, checklist rule 2e). `sourceRunId` omitted + `breakPolicy: always` = record a corpus from scratch
  for a workflow that has never run.
- `GET /proc/replay/{runId}` — status; full break report when broken.
- `POST /proc/replay/{runId}/resume` — `{ resolution, response?, breakPolicy? }`. Resolution is over
  **HTTP, not Slack** — an LLM response is far larger than a Slack modal accepts.
- **Uniform across every workflow — system or evolving. No per-workflow case.** All three existing entry
  paths (`create-domain.mjs`, `create-workflow.mjs`, `classify-intent.mjs` `handoff()`) converge on the
  same two operations: insert `PGC_WorkflowRun` with `workflow_id` + `input`, enqueue `execute_top`.
  Their only pre-run work is computing `input` — already persisted in the source run. `POST /proc/replay`
  is a **fourth entry point of identical shape**.
- Known limits, stated not discovered: `classify-intent`'s Tier 2/3 sonar calls fire before a run exists
  and are **outside the seam**; Novia (`minds-eye.mjs`) runs its own loop and is **not replayable**.
  Neither is in the measured bill.
- Slack: `/replay` (list recent runs + whether each is replayable), `/replay <runId>`,
  `/replay <runId> record`. No workflow name needed — the run row knows its `workflow_id`.
- Recording a workflow that has **never run**: no source to clone, so `workflow` + `input` are supplied
  directly over HTTP with `breakPolicy: always`. Also how synthetic fixtures are built.
- `openapi.yaml` **spec-first**, before implementation.

**A6 — Drift report**
- Which components moved + a text diff of each.
- A `local_state` diff against the source run at the same step — **diagnostic only.** It is never consulted
  to decide whether to break; the fingerprint decides. `local_state` divergence that never reaches a
  prompt has no LLM consequence and is correctly ignored by the control path.

**A7 — Fingerprint backfill**
- `dev_scripts/backfill-fingerprints.mjs` — recompute the composite hash for existing `PGC_Session` rows
  from their stored system/user `PGC_SessionEntry` messages. Makes the seven measured `create_workflow`
  runs immediately replayable.

**A8 — Developer loop**
- `dev_scripts/replay.mjs`: start run → poll → on break, dump the assembled prompt + drift report to a
  local file → wait for a response file → POST the resolution → continue.
- A wrapper over the three HTTP endpoints. **No logic of its own.**

---

### Track B — Cost Cuts That Do Not Need the Harness

> **Track B is empty as of 2026-07-16.** B2 was dropped in Session 2 (step 3 is kept). B1 moved to Sprint 9 —
> its revision turned out to be system code, not a seed edit. The design below is complete and carries the
> evidence; it is a Sprint 9 scope item, retained here so the reasoning is not re-derived.
>
> This leaves Sprint 8 resting entirely on Track A, which is the correct outcome: the per-run cuts were
> always secondary to the per-success multiplier the replay loop removes.

**B1 (revised 2026-07-16) — Partition the consolidation critic by who can judge its findings**

> Supersedes the original B1 ("delete 21t, keep 21r, surface findings at the step-24 gate"). That plan
> fails the **non-expert test**: it ends at a gate saying *LLM-1 says delete this step, LLM-2 says keep it —
> you decide*. This product is a secondary brain for households. The person at that gate entered their
> grocery spend; they cannot referee workflow topology, and must never be asked to.

**Why the original plan fails**

- Adjudicating **one** finding from run 719 took four DB reads (the routing graph, the critic's output,
  the Test 1 rule text, `action_key`'s contract) plus simulating what happens when a write is skipped.
- The stake is not aesthetic. Run 719's design is `edit_budget_gate → upsert_budgets (SHARED WRITE) →
  check_gate_action → {load_existing_budgets | notify_complete}`. The critic proposed routing `update` and
  `done` straight from the gate with *"`upsert_budgets`… likely removed entirely"* — **a budget editor that
  silently never saves, on both paths.** That is not a preference question.

**The critic did not misunderstand. It obeyed.** (Fault domain: **Instruction**, not Generation.)

- Test 1 states an absolute: *"This is always removable."* It carries no exception, while Test 2 directly
  beneath it carries two (*"NOT a finding: a re-query AFTER a write…"*). The author knew to write exceptions.
- Test 1 was **over-fitted to its specimen**. Commit `13973cee` was built from run 700, where steps 15+16
  interpreted a button whose options diverged *immediately* — genuinely removable. Generalising that one true
  case to "always" made it false wherever options converge on a shared step first.
- **The system already contains the refutation and the critic cannot see it.** `action_key`'s contract
  (`f06a700`) says: *"a save-and-continue loop, where 'Save' and 'Done' both run the SAME write and diverge
  only AFTER it — the decision has to survive the write… Routing the two buttons to separate chains instead
  would duplicate the write."* `review_workflow_redundancy` does **not** inject `step_type_contracts`, so it
  has never seen this and would repeat the error today. Two contradicting statements of one truth, with
  nothing reconciling them (checklist rule 2e, in a new form).

**The partition — the deciding question is "can a non-expert answer it?"**

| Test | What it actually asks | Nature | Home |
|---|---|---|---|
| 1 Button-interpretation | do the gate's options converge on a shared step before diverging? | graph reachability | `simulation-engine` |
| 2 Duplicate producers | same output key, same inputs, nothing mutating between? | data-flow | `simulation-engine` |
| 3 Redundant reads | already in `local_state`, unmutated? | data-flow | `simulation-engine` |
| 4 Pass-through steps | output materially identical to input? | data-flow | `simulation-engine` |
| 5 Split steps | two adjacent same-type steps, no branching, same data? | graph adjacency | `simulation-engine` |
| 6 Parallel presentation chains | *"would a user, seeing the second gate with no memory of the first, know they were looking at a different thing?"* | **semantic** | LLM — gate in experience terms |
| 7 User asked for fewer screens | design vs. what the user actually requested | **semantic** | LLM — gate in experience terms |

Tests 1–5 are **structure**: computable, and a household user can neither judge nor care. Deterministic or
nothing — an LLM guessing at static analysis is strictly worse than the static analysis, because it
false-positives and then needs a referee who doesn't exist.

Tests 6–7 are **experience**, and here the non-expert is the *right* judge — the finding is about what they
will see. *"Your design shows the budget view twice, once before editing and once after. Want it once, looping
back after each edit?"* is a question they can answer. Test 6's own disambiguator is already phrased that way,
and it earned its place: added by `3de304f` after run 702 designed one screen twice
(`comprehensive_view` / `updated_comprehensive_view`) and the five structural tests all returned `findings: []`
because the keys differed. **The most costly form of redundancy was not computable — which is exactly why it
needs an LLM, and exactly why the other five do not.**

**Actions**

1. **Delete 21t.** Unreviewed advice must never author a design — that is where the catastrophe lands.
   14% of spend, and the risk of a critic overruling a correct designer.
2. **Move Tests 1–5 into `simulation-engine.mjs`** as static checks. Test 1 carries the exception the prompt
   lacks: options converging on a shared step before diverging is **required** structure, not redundancy.
   Deterministic, no LLM, no gate, no false positive on a graph property.
3. **Narrow 21r to Tests 6–7.** Surface at the step-24 gate phrased in **user-experience terms** — screens
   seen, not steps merged. The user decides *what* they see; the system decides *how* it is wired.
4. Note `3de304f` already put the preventive rule in `design_workflow_process` (*"a screen the user must see
   again after a change is a LOOP, not a copy"*). Test 6 is the safety net for when that is ignored — measure
   whether the net still catches anything before paying for it again.

**Backing out `13973cee` is the right direction but is not a `git revert`.** It is seed-only
(`seed_PGC_Prompt.json`, `seed_PGC_Workflow.json`, `backlog.md`) — an artifact change, correctly placed. But
ten commits have touched those seeds since, including `f06a700` (`action_key`) and `3de304f` (Test 6), so it
needs surgical removal from the current seeds. The commit **pre-registered its own deletion** — *"If this
proves to be noise, delete it"*, citing the `runRoutingValueRules` precedent. This executes that exit
condition rather than reversing a decision.

**What deleting the critic outright would lose.** `13973cee`'s root-cause diagnosis still stands and is not
addressed by deletion: *"The pipeline is additive by construction… nothing in the chain ever merges or
deletes — there is no point at which a step can die. Nothing gives the LLM a cost signal for step count."*
Run 700's complexity also **hid a real bug** (*"step 18 saved the budget rows before step 19 applied the user's
edit"*). Removing the counterweight is only safe because Tests 1–5 become static checks that run on every
design — a stronger counterweight than an LLM that reads the design once.

- Edit `seed_PGC_Workflow.json` + `seed_PGC_Prompt.json` → `upsert-workflow.mjs create_workflow`,
  `upsert-prompt.mjs`. Extend `simulation-engine.mjs` (system code — Execution domain) with unit tests per
  test moved.

**B2 — Gate `research_workflow_domain` on new domains**
- 17% of all spend. For an existing domain it re-derives findings already present in `PGC_Schema`.
- Add a `condition` step: skip when the domain already exists in the schema registry.
- Edit `seed_PGC_Workflow.json` → `upsert-workflow.mjs create_workflow`.

**B3 — Spend measurement**
- Baseline is Sprint 7's measurement (2026-07-12): 42 `llm_call` steps, 7 runs, 1,456s of LLM time.
- Re-measure after B1+B2 and after the harness lands. **Measured, not estimated** — the numbers come from
  `PGC_Session`, which already records every call.

---

### Track C — Blocked Behind the Harness

> Both require generating workflows. They ride **behind** Track A by construction — that is the whole point.

**C1 — `notify` template audit (D3 carry-forward)**
- Audit `notify` templates across generated domain workflows for raw JSON / unformatted field dumps.
- Fix at the **creation prompts** (`generate_crud_workflows`, `design_workflow_dialogs`) so new workflows
  emit clean markdown by default. **Never patch generated workflows directly** — trace every defect to its
  creation-time prompt root.
- No changes to `serv/entity.mjs` or the Slack renderer.

**C2 — `edit_budget` end-to-end validation**
- Run 719 reached L1 with a correct design; `action_key` (landed Sprint 7) was the last blocker.
- Register and run from Slack. This is also the first real test of the replay harness against a live design.

---

### Track D — Dead Code

**D1 — `/chat` removal**
- Obviated by Novia. Remove `ui/slackbot/chat.mjs`, `proc/chat.mjs`, the `CHAT_MESSAGE` SQS type, the route,
  and the `openapi.yaml` entry.
- Confirm `PGC_Session`/`PGC_SessionEntry` usage by `/explain` and Novia is untouched — **the replay corpus
  depends on those tables.**
- Update `docs/architecture.md` (message-type table, directory structure) and `docs/arch-session.md`.

---

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] Simulate Level 1+2 pass on any new or modified workflows
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated — `arch-replay.md` in the doc index; new SQS action (`resume_llm`),
      new run status (`awaiting_llm_break`), new PROC routes, any `.mjs` added/removed
- [ ] `docs/arch-data.md` updated — `PGC_Session` + `PGC_WorkflowRun` column additions
- [ ] `openapi.yaml` updated — `/proc/replay` routes (spec-first, before implementation)
- [ ] `README.md` updated if bootstrap/infra changed
- [ ] `docs/backlog.md` updated — items completed, new items added
- [ ] `docs/sprints/CURRENT.md` → `docs/sprints/sprint-08.md` with outcome notes
- [ ] **Spend re-measured and recorded** — the sprint's own success criterion

---

## Session Notes

### Session 1 — 2026-07-13 — Scope

- Read Sprint 7 retro. Cost stop confirmed as the sprint driver.
- Designed the replay harness with the user (`docs/arch-replay.md`).
- Two design decisions taken against the original carry-forward sketch:
  - **Key on a content fingerprint of the assembled request, not on `(run_id, step_id)`.** A run+step key
    still resolves after a path change and returns a response generated against a different prompt.
  - **Reference the corpus, do not copy it into the replaying run.** Copying session entries would create a
    second copy of one truth — the exact pattern behind four Sprint 7 bugs.
- Established that `local_state` divergence needs no comparison logic: it manifests as prompt drift, and the
  fingerprint detects that exactly. The `local_state` diff is reporting, not control flow.
- Verified against the code that replay is **uniform across all workflows** — the three existing entry paths
  converge on the same two operations, so `POST /proc/replay` is a fourth entry point of identical shape.
  No per-workflow case for `create_domain` / `create_workflow`.
- Break notification designed as the developer **interface**, not a status report — literal runnable curl
  per resolution, both run IDs labelled, no key material rendered.

**Scope approved. Implementation starts 2026-07-14 — begin with Track B** (both are seed edits, need nothing
built, and cut ~31% of live-run spend before the harness exists).

Sprint 8 is docs-only on the branch so far: `arch-replay.md` + `CURRENT.md`. No code written.

### Session 2 — 2026-07-15 — Reprioritize: Track A leads

- **Track B deferred until `create_workflow` is more stable.** Reversal of the Session 1 "begin with
  Track B" call. Rationale: Track B is a per-*run* optimization (~14% off each live invocation once B2/step 3
  is dropped), but the real burden is the per-*success* multiplier — 10+ live runs to land one working
  workflow. Replay (Track A) collapses that multiplier to ~1 real run + N free replays, which dominates any
  single-run saving. The 21t false-positive (run 719) is a stability concern, not a cost one — revisit the
  consolidation-critic rework once the loop is free enough to iterate on safely.
- **B2 dropped, not just deferred.** Step 3 (`research_workflow_domain`) is kept — the user sees value in it.
  This removes AC7 and ~17% from AC8's projected cut; the measured target for AC8 is now whatever B1 alone
  yields when it eventually lands (~14%), plus the replay-driven $0 dev-cycle.
- **B1 direction, when revisited:** delete 21t + 21s, keep 21r (findings-only), surface
  `redundancy_review.findings` at the step-24 gate; accepted findings ride the existing
  `Regenerate with feedback → step 21` back-edge so `design_workflow_process` stays the single author.
  Rejected: folding consolidation into `generate_workflow_steps` — it breaks the translation-is-not-design
  invariant and staleness of the locked `routing_skeleton`.
- **New order: Track A first**, starting at A1 (schema migration + `arch-data.md`), then A2 fingerprint at the
  seam. A5's `/proc/replay` routes are spec-first — `openapi.yaml` before implementation.

### Session 3 — 2026-07-16 — The harness runs; AC2 met and measured

**`/replay 719` → run 720. Eight `llm_call`s, eight recordings served, `response_source: live` count = 0.**
Measured against `PGC_Session`, not inferred. Track A (A1–A5) is done and verified live rather than
code-complete. Run 720 aborted by choice at the 9th break (below); its 8 fingerprinted sessions are
retained — a cancel does not unwind the corpus.

**The replay is the backfill.** Every `llm_call` writes its fingerprint regardless of mode, so serving a
recording still records a *true* fingerprint computed from assembly that actually ran, plus
`replayed_from_session_id` provenance. Run 720 is now a properly fingerprinted corpus for `create_workflow`
built at zero cost — the outcome AC5 was reaching for, reached without a backfill script existing. Walking
an old run once with `use_recorded` mints a corpus for any workflow. **This is why A7 was nearly dropped and
then reinstated for a different reason — see below.**

#### Findings, in order of how much they cost to learn

1. **The harness found a defect in the harness.** (Fixed, commit `92b6e9b`.) The `PGC_StepType` read had no
   `ORDER BY` and no column scope. Row order is whatever the heap returns, so updating any step type
   relocates its row and reshuffles the injected array — which reaches both the prompt and the `input`
   fingerprint, arrays being order-significant. `updated_at` was serialised into the prompt too, so a
   *touched* row looked like a *changed* request. Left alone, the free loop would have quietly stopped being
   free on the next step-type edit or autovacuum. Deterministic, no LLM needed to find it, and invisible
   without something comparing two runs byte-for-byte. **This is the Sprint 7 lesson recurring: the cost
   problem is the test loop.** Bonus: the injection is now ~1.1KB smaller per call.

2. **`use_recorded` is unsafe on an unfingerprinted corpus, and `candidate_ids.length` does not detect it.**
   Run 720's 9th break was step 23's *second* pass — a repair pass carrying a 10KB draft, a 3.4KB simulation
   result and the `{{edit_action}}` error feedback. Session 1069 (the *first* pass) was offered as the sole
   candidate, **with no ambiguity warning**, because the step recorded only once. Accepting it would have
   discarded every byte of repair context, regenerated the same broken output, and reported success. The
   warning added earlier that day keys on *candidate count*; the actual danger is *this pass is not the pass
   the recording came from*, which occurs at N=1. **The signal that does detect it is request equality** —
   see A7.

3. **A7 was wrong twice, in opposite directions.** First read: impossible (true for the *composite*, since
   assembly is lossy and `upsert-prompt` overwrites prompt text in place — `design_workflow_process` is one
   row mutated to v23, v1–v22 gone). Second read: a convenience for old runs, deprioritise. **Both wrong.**
   The stored `PGC_SessionEntry` system/user messages *are* directly comparable to a replaying run's
   assembled instructions, byte-for-byte — proven by hand at step 3 (identical) and step 11 (848 bytes
   apart). That cannot attribute drift to a component, but it answers the question that decides
   serve-vs-break: **is this the same request?** The design intent on 2026-07-13 was sound; only A2's
   seven-component composite is unreachable from stored data. The fix is an **8th `assembled` component**,
   complementary to the seven: components attribute difference, `assembled` proves identity. It is what makes
   `use_recorded` safe on any unfingerprinted corpus, and it closes A9 for free.
   **Caveat, stated not discovered:** `model` and `schema` are not in the assembled text. Schema drift is
   already caught downstream (`review-output` with `allowLlmCorrection: false` fails the run); model drift is
   the risk `use_recorded` already accepts.

4. **Real drift, correctly caught.** Step 11 broke because `human_gate` gained `action_key` at
   2026-07-12T15:46 — 75 minutes *after* run 719 ran that step. So 719's `analyze_workflow_gaps` is
   `action_key`-blind, and `action_key` was 719's blocker. Accepted deliberately: run 720 is a faithful
   replay of 719, blind spot included.

5. **The deterministic tier reproduces exactly.** Run 720's real `simulate` independently produced
   `- [routing] Step notify_complete: ... not reachable`, byte-identical to the feedback line in session
   1067's prompt. That confirmed 1064 = first pass, 1067 = regeneration, from evidence rather than inference.

6. **A break the developer cannot act on is worse than no break.** The first resume never reached AWS:
   `$INTERNAL_API_KEY` unset in the shell → `x-api-key: ` → API Gateway 403 at the edge → zero PROC
   invocations → silence. "Never render key material" is right, but the notification assumes an environment.
   A 403 gives the developer nothing to go on, and no news reads as good news.

#### Not proven today — do not claim these

- **AC3** — record mode (`breakPolicy: always`) and `supplied` were never exercised.
- **AC4** — half. Breaks fired and said *why*; A6's report does not exist. Every diff was manual.
- **AC2** — met on spend (0 calls, measured); the run did not reach a terminal state (aborted by choice).

#### Path forward

- **The harness:** A7 (assembled hash — correctness, do first), A6 (drift report), A9 (subsumed by A7),
  A8 (dev loop). Then exercise AC3 properly.
- **`edit_budget` (C2/AC10) needs quota — replay cannot rescue it.** Every recording predates `action_key`
  (07-12 15:46), so the corpus can only reproduce the blind design. It needs **one** live `create_workflow`
  run against today's `action_key`-aware prompts. A2 is deployed, so that run fingerprints itself and every
  iteration after it is free. **One paid run, then free forever** — which is the sprint's thesis, now
  demonstrated rather than asserted.
