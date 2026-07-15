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
- **AC6 — Step 21t deleted.** The consolidation re-design is removed from `create_workflow`. 21r's
  findings survive and are surfaced at the step-24 review gate for a human to accept or reject.
- **AC7 — `research_workflow_domain` gated on new domains.** Skipped when the domain already exists in
  `PGC_Schema`.
- **AC8 — Measured spend drop.** A full `create_workflow` development cycle (design change → verify)
  costs **$0** in replay. AC6+AC7 together remove ~31% of live-run spend, measured against the Sprint 7
  baseline, not estimated.
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
| A2 — Fingerprint computation at the seam | AC1 | 🔨 CODE-COMPLETE 2026-07-15 — `fingerprint.mjs` + seam write; 7th component `system_context` added; 15 unit tests. Pending `sam deploy` to write on live runs |
| A3 — Break policy + corpus lookup in `llm-harness.mjs` | AC2 | 🔨 CODE-COMPLETE 2026-07-15 — `replay-corpus.mjs` (source-first→global lookup, soft/hard drift), seam decision + serve path, `allowLlmCorrection` zero-spend guard; 11 unit tests. Break signal (`llm_break`) emitted but **inert until A4**. Pending deploy |
| A4 — Break suspend / `resume_llm` in `run-workflow.mjs` | AC3, AC4 | 🔨 CODE-COMPLETE 2026-07-15 — break-before-audit suspend, `awaiting_llm_break` guard, `llm_break` frame resume path, `resume_llm` action, break-resolution consumption in `llm-harness` (use_recorded/supplied/call_live/abort), runnable-curl notification; 6 unit tests. Resume **producer** (endpoints) is A5. Pending deploy |
| A5 — `/proc/replay` endpoints | AC2, AC3, AC4 | ⬜ |
| A6 — Drift report (component diff + `local_state` diff) | AC4 | ⬜ |
| A7 — Fingerprint backfill script | AC5 | ⬜ |
| A8 — `dev_scripts/replay.mjs` developer loop | AC2, AC3 | ⬜ |
| B1 — Delete `create_workflow` step 21t | AC6, AC8 | ⬜ |
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

> Both are deletions. Land them early — they cut ~31% of live-run spend in week one rather than at close.

**B1 — Delete `create_workflow` step 21t**
- 14% of all spend. The consolidation re-design re-runs the entire design to apply the critic's findings.
- Scoreboard across four live runs: found nothing → caught a real chain → found two real defects →
  **false-positived**, telling the designer to delete a genuinely required step (the Update/Done divergence
  happens *after* a shared write, so the decision must survive the write).
- **Keep 21r** (the findings, 5%). Surface them at the **step-24 review gate** for a human to accept or reject.
- Removes both the cost and the risk of a critic overruling a correct designer.
- Precedent: Sprint 4's `runRoutingValueRules` was a heuristic check whose false positives made it
  net-negative; the correct fix was deleting it, not tuning it.
- Edit `seed_PGC_Workflow.json` → `upsert-workflow.mjs create_workflow`.

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
