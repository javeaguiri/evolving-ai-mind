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
- **AC2 — Replay completes with zero LLM spend.** ✅ **CLOSED 2026-07-16.** A `create_workflow` run replayed
  from a complete corpus, walking the same path, reaches the same terminal state having made **zero**
  Perplexity calls. Verified against the LLM call count, not inferred. **Result:** run 721 (replaying 720's
  fingerprinted corpus) — 8 `llm_call`s, 8 `hit`, **0 breaks, 0 live calls**. With run 720: **16 `llm_call`s,
  0 live**, counted in `PGC_Session`. See Session 4.
- **AC3 — Record mode.** ✅ **CLOSED 2026-07-23.** `breakPolicy: always` breaks at every `llm_call`. The
  assembled prompt is readable over HTTP; a hand-supplied response resumes the run and is validated through
  `review-output` exactly as a live response is. A response that would fail validation **fails the run**.
  **Result:** run 728 (record replay of 722, policy flipped to `always` mid-run at the step-2 gate) — step 11
  broke (`reason=always`, 63,016-char prompt served over `GET`), a **valid** `supplied` response passed
  `review-output` and the run advanced to step 21; an **invalid** `supplied` response there **failed the run**
  with **0 live calls** (`allowLlmCorrection: !served` ⇒ false for `supplied`, so no correction call).
  Measured in `PGC_Session`: 3 sessions, `response_source` ∈ {replayed, recorded}, **live = 0**. See Session 10.
- **AC4 — Drift breaks, and says why.** Changing a downstream `js_transform`, editing a prompt, or
  answering a gate differently produces a break at the next affected `llm_call`, with a component-level
  drift report (which of prompt/input/user_input/model/schema/memory moved, plus a text diff) and a
  `local_state` diff against the source run. `use_recorded` accepts the recording and keeps the suffix free.
- **AC5 — Historical runs are replayable.** ✅ **CLOSED 2026-07-16 — achieved, and the AC was aimed at the
  wrong thing.** Run 719 replayed (run 720). No backfill script exists, and none should: **walking a run once
  mints its corpus**, because every `llm_call` fingerprints itself regardless of mode. The backfill as
  specified is impossible (assembly is lossy; `upsert-prompt` overwrites text in place), and the
  reconstructable version would fabricate a hash asserting an old response answers today's prompt — the
  silently-wrong-hit failure the fingerprint exists to prevent. **The AC is moot going forward:** replay is
  second by construction, so every corpus is fingerprinted by the run that made it. "Historical" now means
  only the six pre-A2 runs — a set that shrinks to zero and never grows.
- ~~**AC6 — Step 21t deleted / consolidation critic partitioned.**~~ **→ DROPPED (2026-07-23).** Both
  motivations dissolved: the **cost** (14% of `create_workflow` spend) is moot now that the replay harness makes
  iteration $0 — the whole sting was that every iteration was a live paid run; and the **correctness** risk (the
  critic false-positived in run 719, telling the designer to delete a required step) is contained by the step-24
  human review gate. The critic-partition idea is **abandoned**, not deferred. If the `PGD_Budgets.type` class of
  defect ever recurs, the answer is a deterministic check in `simulation-engine`, not an LLM critic — same
  conclusion that dropped the `create_domain` schema critic (Out of Scope). Analysis preserved in Track B and git.
- **AC7 — `research_workflow_domain` gated on new domains.** Skipped when the domain already exists in
  `PGC_Schema`.
- **AC8 — Measured spend drop.** A full `create_workflow` development cycle (design change → verify)
  costs **$0** in replay. **Revised 2026-07-16:** both per-run cuts are gone — AC7 dropped (Session 2, step 3
  is kept) and AC6 deferred to Sprint 9 — so AC8 now rests entirely on the replay loop, which is the item
  that actually mattered: the burden was never the per-*run* cost but the per-*success* multiplier of ~10 live
  runs to land one workflow. ✅ **PROVEN 2026-07-16:** runs 720 + 721 — **16 `llm_call`s, 0 live**, and run 721
  (clean corpus) completed its 8 with **zero breaks**, measured against `PGC_Session`. The dev cycle costs $0.
- **AC9 — D3: `notify` template audit.** **Re-scoped 2026-07-23.** Workflows generated by `create_workflow`
  emit markdown-formatted `notify` output, not raw JSON field dumps. Fixed at the creation prompt
  **`design_workflow_dialogs`**, never by patching generated workflows. (`generate_crud_workflows` was the
  other named fix site but is **obviated** — the generic `list_entity`/`get_entity`/… workflows handle CRUD and
  no per-domain workflow is generated; its orphaned prompt is a backlog cleanup.) **Rides behind C2** — the
  `edit_budget` run is what produces a generated workflow to audit.
- **AC10 — `edit_budget` validated end to end.** Run 719 reached L1 with a correct design; `action_key`
  (landed Sprint 7) was the last blocker. Register and run it from Slack.
- ~~**AC11 — `/chat` dead code removed.**~~ **→ BACKLOG (2026-07-23).** Deletion not yet decided — moved out
  of the sprint until the call is made. See `docs/backlog.md`.

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
| A6 — Drift report: **which `input` keys moved** | AC4 | 🔨 CODE-COMPLETE + deployed 2026-07-16 (`c32102c`) — `hashInputKeys` (hash + serialised size per key) → `request_fingerprint.input_keys`; `describeInputDrift` at the seam; notification renders it; `diffComponents` fixed to judge `COMPONENT_ORDER` (latent bug: it diffed the raw key union, so `input_keys` would have read as an 8th component). **Additive — not in the composite, so 720/721 keep hitting.** 16 new tests, 615 total. ✅ **CONFIRMED LIVE 2026-07-21 (run 724):** `input changed: user_design_notes (4→35 chars) | unchanged: domain, …, step_type_contracts, …` — the sentence that cost a scratchpad by hand. ✅ **`local_state` diff DONE 2026-07-23** — `describeStateDrift` (reuses the generic `hashInputKeys`/`diffInputKeys`; `computeFingerprint` now snapshots `stateKeys`, stored as `request_fingerprint.local_state_keys`, excluded from the composite so old recordings keep matching); rendered as a compact diagnostic `state` line (names what moved, counts what held still) + full detail on the GET report; never gates a break (arch-replay §8). +9 tests, 654 total |
| ~~A7 — fingerprint backfill / assembled-request hash~~ | AC5 | ❌ **STRUCK 2026-07-16 — unnecessary, not merely deferred.** Replay is second by construction: you cannot replay a run that never ran, and every run fingerprints itself. **A fingerprinted corpus is not a goal, it is a byproduct you cannot avoid.** Unfingerprinted corpora are a closed historical set (six pre-A2 runs) that shrinks to zero and never grows; 719 is already superseded by 720. The assembled hash also would **not** have fixed A9 — run 721 detected the drift correctly *with components* and offered `use_recorded` anyway. It adds nothing where components exist. See Session 5 |
| A8 — `dev_scripts/replay.mjs` developer loop | AC2, AC3 | 🔨 CODE-COMPLETE + pushed 2026-07-23 — thin wrapper over the three endpoints (start/poll/resume), no logic of its own. Dumps prompt-*.txt + break-*.json off the frame, waits for resume-<runId>.json or a Slack-button resolution, `--auto` for unattended payload-free resolves, `--record`/`--workflow --input` for record-from-scratch, **`--slack-channel`/`--slack-thread`** so a gated workflow's human gates render in Slack (the run 726/727 wedge fix). The three endpoints it wraps were **exercised live driving run 728's AC3 close** (start w/ callback, GET break report, two `supplied` resumes); the script's own file-loop still to be driven end-to-end against a gated run |
| A12 — **blast radius: name the steps a drifted key reaches** | AC4 | ✅ DONE 2026-07-21 — `computeBlastRadius` (pure over the workflow definition, reuses `extractTemplateRefs`) maps each drifted `input` key → the other `llm_call` steps reading its `local_state` root; stashed on the frame, rendered in the notification + GET report. 6 tests reproduce run 723's 11→{21,21r,21t}. ✅ **CONFIRMED LIVE 2026-07-21 (run 724):** notification + GET report both carried `blast_radius: {user_design_notes: [21, 21r, 21t]}`. **New 2026-07-16, proven live on run 723.** The notification offers `use_recorded` as *"free, keeps the suffix free"* — **false whenever the drift originates in a `local_state` key several steps read.** `user_design_notes` changed at the step-9 gate (4→123 chars) and is read by `llm_call` steps **11, 21, 21r, 21t**: accepting at 11 does not free the suffix, it defers the identical decision three more times. Fix: A6's report names the downstream readers — *"user_design_notes (4→123 chars) — also read by steps 21, 21r, 21t"* — computable straight from the workflow definition, no new data. Turns "accept?" into a decision with its cost visible. Feeds A9: a disposition should know a drift's blast radius, not just its component. **Third instance of the day's pattern — see Session 7** |
| A10 — **a break has no user-reachable exit** | AC3 | ✅ DONE 2026-07-21 — `/shutdown <runId>` now reaches `awaiting_llm_break` when named by id, never in a sweep (`buildActiveRunFilters`, pure + 3 tests). ✅ **CONFIRMED LIVE 2026-07-21 (run 725):** a break at step 11, then `/shutdown 725` → `shutdown: active runs found {count: 1}` → `cancelledCount: 1`. Before A10 the filter excluded `awaiting_llm_break`, so this was `count: 0` and the run wedged. **New 2026-07-16 — a wedge, found live.** `shutdown.mjs:39` filters `status IN ('running','awaiting_human_gate')`, so **`awaiting_llm_break` is invisible to `/shutdown`** — and the id filter is optional, so even a targeted `/shutdown 722` skips it. The only exit is HTTP, and the notification's curls need `$INTERNAL_API_KEY` in the developer's shell, which 403s at the edge when it is absent (silently — zero PROC invocations, see Session 3 finding 6). On 2026-07-16 every abort had to be fired by someone else's shell. **Half is deliberate** (`arch-replay` §7a made the status distinct so a blanket sweep never touches a dev break — right call), but it silently removed the *targeted* case too. Fix: `/shutdown <runId>` covers `awaiting_llm_break` **when named by id**, never in a sweep |
| A11 — **payload-free resolutions belong in Slack** | AC3 | ✅ DONE 2026-07-21 — Block Kit buttons for `abort`/`call_live`/`use_recorded` (one per candidate, A5b); `supplied` stays curl-only. A9 disposition gates which appear (`refused` → no `use_recorded` button). PROC emits UI-agnostic `breakActions` (`buildBreakActions`, 8 tests); callback.mjs renders; interactive.mjs → new `REPLAY_RESUME` SQS → same resume core as HTTP. Experience tier never writes the stack. ✅ **CONFIRMED LIVE 2026-07-21 (run 724):** break rendered **Call LLM + Abort only, no `use_recorded` button** (A9 `refused`); clicking Abort drove the full new path — `REPLAY_RESUME` SQS → shared resume core → `resume_llm` → run `cancelled`. **New 2026-07-16 — a design over-generalisation.** `arch-replay` §9: *"Resolution is over HTTP, not Slack — an LLM response is far larger than a Slack modal accepts."* True **for `supplied`** — the only resolution that carries a payload. `abort`, `use_recorded` and `call_live` carry **nothing** (`abort` is one word), and generalising from the one resolution that needs HTTP to all four produced a harness that cannot be driven from the interface it posts its own notifications to. Fix: Block Kit buttons for `abort` / `use_recorded` / `call_live` (with one button per candidate when `candidate_ids.length > 1`, per A5b); keep the curl for `supplied` only. **Same shape as the critic's Test 1** — a rule true of its originating case, generalised into an absolute. Sits behind A9, whose disposition decides which buttons are even offered |
| A9 — drift **disposition**, not detection | AC4 | ✅ DONE 2026-07-21 — `dispositionForDrift` (policy over the seven components already classified, no new hash) computed at the seam, stashed on the frame, drives the notification's `use_recorded` framing. `input` disambiguated via A6's per-key diff (`step_type_contracts`-only → intended; a question key → refused; no per-key data → caution). Headline = most severe component. 11 tests. ✅ **CONFIRMED LIVE 2026-07-21 (run 724):** `verdict: refused`, headline *"a DIFFERENT question was asked"* — because `user_design_notes` is a declared question key, not injected. Server-side GET report matched the notification. **Respecified 2026-07-16 — the gap was never detection.** Run 721 detected the drift correctly (`drift: input`, 6/7 identical) and **offered `use_recorded` anyway**, where accepting it discards 10KB of repair context. No new hash fixes this. Fix = a **disposition per component** over the hashes we already have (`memory` soft→serve; `prompt` hard→`use_recorded` is the *intended* resolution; **`input` hard→a different question was asked, discourage/refuse**; `schema` caught downstream by `review-output`). **Depends on A6's per-key `input` breakdown** — `input` is ambiguous: `step_type_contracts` moving is benign (step 11/`action_key`, accepting was right), the question-keys moving is fatal (step 23 pass 2). Also subsumes the old part (a): the ambiguity warning keys on `candidate_ids.length > 1`, but the danger occurs at N=1 |
| B1 — Partition the consolidation critic | AC6 | ❌ **DROPPED (2026-07-23)** — cost motivation dissolved by the replay harness ($0 iteration), correctness risk contained by the step-24 gate. Critic-partition idea abandoned. See AC6 |
| B2 — Gate `research_workflow_domain` on new domains | AC7, AC8 | ⬜ |
| B3 — Spend measurement against Sprint 7 baseline | AC8 | ⬜ |
| C1 — `notify` template audit (D3 carry-forward) | AC9 | ⬜ **re-scoped 2026-07-23** to `design_workflow_dialogs` only (`generate_crud_workflows` obviated — orphaned prompt, → backlog). **Rides behind C2**: audit the `notify` output of the workflow the `edit_budget` run generates once it runs clean |
| C2 — `edit_budget` end-to-end validation | AC10 | ⬜ |
| D1 — `/chat` dead code removal | AC11 | ➡️ **BACKLOG** (2026-07-23) — deletion undecided, moved out of sprint |

---

## Out of Scope

Named explicitly so the deferral is a decision, not an oversight.

- **Release-readiness — test environment, README bootstrap, log hygiene.** Sprint 7's goal statement
  moved these to Sprint 8. **The cost stop preempts them.** Spend is an existential constraint on a
  project whose thesis is a low cost of ownership; release polish is not. These carry to Sprint 9.
  The replay harness is also a *prerequisite* for a sane test environment — it is the thing that makes
  a non-prod environment affordable to exercise.
- **Cross-domain `create_workflow`** (5 known gaps) — backlog.
- ~~**`create_domain` schema critic**~~ — **dropped 2026-07-16**, removed from the backlog. Superseded by
  the same evidence that revised B1: an LLM critic's findings land at a gate no non-expert can referee, and
  the item's own case makes the point — *"a non-technical user confirming a schema cannot evaluate a
  functional dependency."* Its two most valuable checks (unsourceable required column; functional dependency)
  were always **computable**, and computable checks do not need a critic wrapped round them. If the
  `PGD_Budgets.type` class of defect resurfaces, the answer is a deterministic check where schemas are
  validated — not a second LLM opining at a human who cannot judge it. Analysis preserved in
  `sprint-07.md` §retro and in git (`docs/backlog.md` before this commit).
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

**A6 — Drift report** *(revised 2026-07-16 — the load-bearing item)*
- Which components moved + a text diff of each.
- **Per-key within `input`, with sizes** — component-level alone is **not enough**, proven by runs 720/721.
  `drift: input` is ambiguous: `step_type_contracts` moving is benign (step 11, `action_key` — accepting the
  recording was right), while the question-keys moving is fatal (step 23 pass 2 — `draft_workflow` 10,405
  chars, `skeleton_error_summary` 416, `skeleton_validation` 3,457). **Identical signal, opposite correct
  answers.** Target: `input drifted — added: draft_workflow (10,405), skeleton_error_summary (416),
  skeleton_validation (3,457); step_type_contracts unchanged.` A9's disposition cannot fire correctly
  without this.
- A `local_state` diff against the source run at the same step — **diagnostic only.** It is never consulted
  to decide whether to break; the fingerprint decides. `local_state` divergence that never reaches a
  prompt has no LLM consequence and is correctly ignored by the control path.

**~~A7 — Fingerprint backfill / assembled hash~~ — STRUCK 2026-07-16**
- Neither version is needed. **Replay is second by construction** — you cannot replay a run that never ran,
  and every run fingerprints itself, so a fingerprinted corpus is a byproduct that cannot be avoided rather
  than a goal. Unfingerprinted corpora are a closed set of six pre-A2 runs, already superseded by 720 as a
  corpus, shrinking to zero and never growing.
- The backfill as originally specified is **impossible**: assembly is lossy (prompt + context + memory collapse
  into one string) and `upsert-prompt` overwrites text **in place** — `design_workflow_process` is one row at
  v23 with v1–v22 gone. The reconstructable version would **fabricate**, asserting an old response answers
  today's prompt, and would hit rather than break — the exact silently-wrong-hit failure the fingerprint exists
  to prevent.
- The assembled-hash replacement would **not** have fixed A9 either: run 721 detected the drift correctly with
  components alone and offered `use_recorded` anyway. **It adds nothing where components exist.**

**A9 — Drift disposition** *(new 2026-07-16 — replaces A7 as the correctness item)*
- The gap is **disposition, not detection**. The harness knows the request changed and still offers
  `use_recorded` as "free, keeps the suffix free".
- A policy over the hashes already computed — no new hash: `memory` soft→serve; `prompt` hard→`use_recorded`
  is the **intended** resolution; **`input` hard→a different question was asked, discourage or refuse**;
  `model`→judgment; `schema`→already caught by `review-output` (`allowLlmCorrection: false` fails the run).
- **Depends on A6's per-key `input` breakdown** to distinguish benign `step_type_contracts` drift from a
  changed question.
- Subsumes the earlier framing: the ambiguity warning keys on `candidate_ids.length > 1`, but the danger
  (*this pass ≠ the recorded pass*) occurs at N=1 — step 23 pass 2, single candidate, no warning.

**A8 — Developer loop**
- `dev_scripts/replay.mjs`: start run → poll → on break, dump the assembled prompt + drift report to a
  local file → wait for a response file → POST the resolution → continue.
- A wrapper over the three HTTP endpoints. **No logic of its own.**

---

### Track B — Cost Cuts That Do Not Need the Harness

> **Track B is empty and closed.** B2 was dropped in Session 2 (step 3 is kept). B1 was **dropped 2026-07-23**
> (not deferred) — both its motivations dissolved: cost, by the replay harness making iteration free; correctness,
> by the step-24 gate containing the critic's false positive. The analysis below is kept only as the record of
> why, not as a plan.
>
> This leaves Sprint 8 resting entirely on Track A, which is the correct outcome: the per-run cuts were
> always secondary to the per-success multiplier the replay loop removes.

**B1 — Partition the consolidation critic — ❌ DROPPED (2026-07-23).** The idea is abandoned, not deferred.
Its cost motivation (14% of `create_workflow` spend) is moot now that replay makes iteration free, and its
correctness motivation is contained by the step-24 review gate. If the redundancy defect it targeted recurs,
the fix is a deterministic `simulation-engine` check, not an LLM critic at a gate no non-expert can referee
(the reasoning that also dropped the `create_domain` schema critic). The full analysis below is kept as the
record of why — it is no longer a plan.

**B1 (revised 2026-07-16) — Partition the consolidation critic by who can judge its findings** _(dropped — see above)_

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

**C1 — `notify` template audit (D3 carry-forward)** _(re-scoped 2026-07-23)_
- **Rides behind C2.** The audit target is a workflow `create_workflow` generates — so do it **after the
  `edit_budget` run completes clean** (C2), then inspect that workflow's `notify` output. Free to re-inspect
  via replay thereafter.
- Audit those `notify` steps for raw JSON / unformatted field dumps.
- Fix at the creation prompt **`design_workflow_dialogs`** so new workflows emit clean markdown by default.
  **Never patch generated workflows directly** — trace every defect to its creation-time prompt root.
- `generate_crud_workflows` was the other named fix site but is **obviated** (no per-domain CRUD workflows are
  generated anymore; the generic `list_entity`/`get_entity`/… handle it). Its orphaned prompt seed is a
  backlog cleanup, not part of this audit.
- No changes to `serv/entity.mjs` or the Slack renderer.

**C2 — `edit_budget` end-to-end validation**
- Run 719 reached L1 with a correct design; `action_key` (landed Sprint 7) was the last blocker.
- Register and run from Slack. This is also the first real test of the replay harness against a live design.

---

### Track D — Dead Code

**D1 — `/chat` removal → BACKLOG (2026-07-23).** Deletion is not yet decided; moved to `docs/backlog.md` until
the call is made. The removal recipe (chat.mjs both tiers, `CHAT_MESSAGE` SQS, route, openapi, doc updates) and
the guardrail (`/explain` + Novia + the replay corpus all read `PGC_Session`/`PGC_SessionEntry` — must stay
untouched) are preserved there.

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

### Session 4 — 2026-07-16 — AC2 CLOSED: the loop is free

**`/replay 720` → run 721: 8 `llm_call`s, 8 `status: 'hit'`, `drift: null`, ZERO breaks, ZERO live calls.**

That is AC2 in its literal wording — *"replayed from a complete corpus, walking the same path, having made zero
Perplexity calls, verified against the LLM call count, not inferred."* Measured across both runs:

| run | source | `llm_call`s | live | breaks |
|---|---|---|---|---|
| 720 | 719 (unfingerprinted) | 8 | **0** | 9 — every call, hand-resolved |
| 721 | 720 (fingerprinted) | 8 | **0** | **0** |

**Two runs, sixteen `llm_call`s, zero spend.** The sprint goal — *make the `create_workflow` development loop
free* — is met and demonstrated, not asserted.

**The difference between those two rows is the whole sprint.** Same workflow, same path, same recordings by
content. Run 720 walked an unfingerprinted corpus and needed a human at all nine breaks, including two where
the correct answer required diffing prompts in a scratchpad. Run 721 walked a fingerprinted one and needed
nobody. **A corpus is minted by walking a run once; every walk after it is free and unattended.**

**Step 21 is the proof in miniature.** It executes twice per path (design, then regeneration). In run 720 the
two recordings were indistinguishable and had to be named by hand — `sessionId: 1064` for pass 1, `1067` for
pass 2 — after establishing which was which from a text diff. In run 721 the composite hash selected 1072 and
1075 **automatically, correctly, silently**. That is the entire argument for keying on a content fingerprint
rather than `(run_id, step_id)`, executed rather than reasoned about.

#### The 9th break: right verdict, undecidable report

Both runs stop at step 23's second pass, where run 719's quota died on 2026-07-12 and no recording has ever
existed. Run 721's verdict is a genuine improvement on 720's:

- 720 (unfingerprinted): `unfingerprinted` — no comparison possible; offered a **wrong candidate**, unwarned.
- 721 (fingerprinted): `hard_drift (drift: input)` — **six of seven components byte-identical**, one moved,
  correctly attributed.

**But `drift: input` is not actionable, and this is a real finding.** `input` conflates two things with
opposite correct answers:

- `step_type_contracts` — injected system knowledge. This is what drifted at step 11 (`action_key`), where
  `use_recorded` was **defensible**.
- the question itself — `draft_workflow` (10,405 chars), `skeleton_error_summary` (416),
  `skeleton_validation` (3,457). This is what drifted at step 23 pass 2, where `use_recorded` is **wrong**.

Identical signal, opposite answers. The only way to tell them apart today is to diff raw text by hand.

**This sharpens A6.** Reporting which *component* moved is not enough — we already have that, and it is
ambiguous. A6 must report which **keys within `input`** moved, with sizes:
`input drifted — added: draft_workflow (10,405), skeleton_error_summary (416), skeleton_validation (3,457);
step_type_contracts unchanged.` That makes the decision obvious without a scratchpad.

**And A9 persists even with fingerprints.** `use_recorded` is still offered — framed as *"free, keeps the
suffix free"* — on a drift where accepting it discards 10KB of repair context. Its documented purpose is
**prompt** drift (*"a prompt edited in a way that should not change the answer"*). `input` drift means a
different question was asked, where accepting a recording is almost never right. **The soft/hard binary is
too coarse:** drift needs a third disposition — *this is a different question, `use_recorded` should be
discouraged or refused*.

#### Corrections to earlier claims in this sprint

- **`soft_drift` is still untested.** Predicted memory would drift between 720 and 721 and be forgiven. It did
  not move — `PGC_Memory` gained nothing in between, and these prompts mostly do not retrieve memory (budget 0
  when `memory_config` is absent). The component-level fingerprint's *justification* is that memory is
  time-varying; today it did not vary. **Not proven — do not claim it.**
- **Predicted the 9th break would be a `miss`.** It was `hard_drift` — because 720's recording is now
  fingerprinted, so a comparison was possible. Better than predicted.

#### AC status after Session 4

| AC | Status |
|---|---|
| AC1 — fingerprint per `llm_call` | ✅ written, and proven **reproducible** — run 721's 8 hits are the proof |
| AC2 — replay completes with zero spend | ✅ **CLOSED** — 16 `llm_call`s / 0 live across runs 720+721; 0 breaks on the clean corpus |
| AC4 — drift breaks and says why | ⚠️ half — breaks fire and attribute correctly, but `drift: input` is undecidable. A6 does not exist |
| AC3 — record mode | ❌ untouched — `breakPolicy: always` and `supplied` never exercised |
| AC5 — historical runs replayable | ↩️ reframed — achieved by walking a run once (`use_recorded`), not by a backfill script. A7 is now about making that walk *safe*, not possible |
| AC6 — critic partition | ➡️ Sprint 9 |
| AC7 | ❌ dropped (Session 2) |
| AC8 — measured spend drop | ✅ on the dev cycle ($0, measured). Per-run cuts gone with AC6/AC7 |

### Session 5 — 2026-07-16 — A7 struck; A9 is disposition, not detection

**One question dissolved A7: if a live run always precedes a replay, what unfingerprinted corpus is left?**
None — and not by convention. **Replay is second by construction.** You cannot replay a run that never ran,
and every run fingerprints itself (A2, deployed). A fingerprinted corpus is therefore not a goal to work
toward but a **byproduct that cannot be avoided**. Unfingerprinted corpora are a closed historical set — six
pre-A2 runs, already superseded by 720 as a corpus — that shrinks to zero and never grows. **A7 is struck as
unnecessary, not deferred.** AC5 closes with it.

**A7 was wrong four times in one day, and the pattern is the lesson.** Impossible → a convenience → a
correctness mechanism → unnecessary. Each position was re-derived from whatever evidence had just landed;
none asked *what problem is this for*. The user's question did. **When an item keeps changing its
justification, the item is the problem, not the evidence.**

**And the assembled hash would not have fixed A9 anyway.** Run 721 is the disproof, and it was already in
hand: it walked a **fingerprinted** corpus, detected the drift **correctly** (`drift: input`, six of seven
components byte-identical) — and offered `use_recorded` regardless, on a recording whose acceptance discards
10KB of repair context. An assembled hash would have detected exactly the difference the `input` hash already
detected. **It adds nothing where components exist.**

**So A9 is respecified: the gap is disposition, not detection.** The harness knows the request changed and
offers acceptance anyway. That needs no new hash — only a policy over the hashes already computed:

| component | what drift means | disposition |
|---|---|---|
| `memory` | accumulated since the recording | soft — serve, log |
| `prompt` | reworded | hard — but `use_recorded` is the **intended** resolution ("edited in a way that should not change the answer") |
| `input` | **a different question was asked** | hard — `use_recorded` almost always **wrong**; discourage or refuse |
| `model` | different model | judgment — the risk `use_recorded` already accepts |
| `schema` | output contract moved | caught downstream: `review-output` with `allowLlmCorrection: false` fails the run |

**A9 depends on A6, and that is the whole remaining shape of Track A.** `input` is ambiguous — only
`step_type_contracts` moving is benign (step 11, `action_key`, where accepting was right); the question-keys
moving is fatal (step 23 pass 2). The disposition cannot fire correctly without A6's per-key breakdown, and
A6's per-key breakdown is what makes the disposition decidable. **A6 + a disposition table = A9 solved, A7
deleted, A8 is pure ergonomics.**

#### Track A remaining, after Session 5

| item | status |
|---|---|
| A6 — drift report, **per-key within `input`, with sizes** | ⬜ the load-bearing item |
| A9 — disposition table over the existing components | ⬜ depends on A6 |
| A8 — `dev_scripts/replay.mjs` | ⬜ ergonomics only; collapses 9 curls to 1 |
| A7 | ❌ struck |
| AC3 — record mode (`breakPolicy: always`, `supplied`) | ⬜ **still never exercised** |
| `soft_drift` | ⬜ **still never exercised** — memory did not move between 720 and 721 |

### Session 6 — 2026-07-16 — A6 built; two wedges found by using it

**A6's core landed and deployed** (`c32102c`): per-key hashes + sizes of `resolvedInput` written as
`request_fingerprint.input_keys`, diffed at the seam, rendered in the notification. **Additive by
construction** — `input_keys` is not in `COMPONENT_ORDER` and not in the composite, which run 722 proved
live: replaying 721's **pre-A6** corpus still produced **8 hits, 0 breaks, 0 live calls**, and minted an
A6-era corpus as a byproduct. Had `input_keys` gone into the composite, that re-mint would have been another
nine-break slog instead of eight silent hits.

**A prerequisite fix, a latent bug either way:** `diffComponents` iterated the *union of keys present* in both
fingerprints, so the moment `input_keys` appeared in a stored map it would have been diffed as an eighth
component and polluted every drift list. It now judges `COMPONENT_ORDER` — the components we defined, not
whatever keys happen to be in the object.

**Nearly shipped the sprint's own anti-pattern.** The per-key diff was first written into `getReplay`, which
would have made the report a *second derivation* of what the seam already held — checklist rule 2e, the
pattern behind four Sprint 7 bugs, inside the sprint that keeps citing it. It is now computed once at the
break and read off the frame by both the GET and the notification.

#### Two wedges, found by using the thing rather than reading it

1. **A break has no user-reachable exit (A10).** `shutdown.mjs` filters
   `status IN ('running','awaiting_human_gate')`, so `awaiting_llm_break` is invisible to `/shutdown`, id
   filter or not. The only exit is HTTP, whose curls need `$INTERNAL_API_KEY` in the developer's shell — and
   when it is absent the request 403s **at the edge**, invoking nothing and logging nothing, so no news reads
   as good news (Session 3 finding 6, now bitten twice). Every abort on 2026-07-16 was fired from a different
   shell than the one being blocked. **The distinct status was right; removing the targeted case with it was
   not.**

2. **Payload-free resolutions belong in Slack (A11).** `arch-replay` §9 justifies HTTP-only resolution with
   *"an LLM response is far larger than a Slack modal accepts"* — true of `supplied`, the only resolution
   carrying a payload, and generalised to all four. `abort` is one word. The result is a harness that cannot
   be driven from the interface it posts its notifications to. **This is the same shape as the critic's Test
   1** — a rule true of its originating case, promoted to an absolute, and wrong everywhere the originating
   case's assumptions do not hold. Two instances in one day is a pattern worth naming: **when a rule is
   derived from one specimen, write down what about that specimen made it true.**

#### The graceful-degradation path, confirmed live

Run 722's step-23 break reported `input_diff: null` — **correct**. Its candidate (session 1085) is a **721**
recording, made before A6, so there are no per-key hashes to compare. The harness said nothing rather than
claiming "unchanged", and the notification omitted the line. Absent data is unknowable — the same error, had
it guessed, as calling an unfingerprinted recording `hard_drift`.

**A6's payoff needs an A6-era corpus on the candidate side**, which is what run 722 now is: 8 sessions, all
carrying `input_keys`. Step 11's `user_design_notes` is **4 chars** — the literal string `null`, because the
step-9 gate was skipped. Typing anything there on a replay of 722 moves exactly one key.

### Session 7 — 2026-07-16 — A6 proven live; the day's pattern named

**A6 works.** Run 723 (replaying 722's A6-era corpus) broke at step 11 with the step-9 gate answered
instead of skipped, and the notification said, unprompted:

```
input   changed: user_design_notes (4→123 chars)  |  unchanged: domain, domain_schema,
        prompt, right_brain_research, step_type_contracts, userInput, user_preferences
```

One key moved, seven held still, sizes included. **That is the sentence that cost four file diffs and a
scratchpad to assemble by hand this morning.** AC4's "says why" is real. The two cases that were
indistinguishable at 10:00 — a benign contract edit and a materially different question — now read
differently at a glance.

**Day's spend: 25 `llm_call`s across runs 720–723, `response_source: live` = 0.** Counted in `PGC_Session`.
A harness built, deployed and debugged against live traffic, for nothing.

#### THE PATTERN — three instances in one day, and it belongs in the retro

**A rule true of its originating specimen, promoted to an unconditional.**

| claim | true of | promoted to | consequence |
|---|---|---|---|
| critic Test 1 — *"This is always removable"* | run 700, where the gate's options diverged **immediately** | all button-interpretation steps | proposed bypassing `upsert_budgets` — **a budget editor that silently never saves** |
| `arch-replay` §9 — *"resolution is over HTTP; an LLM response is far larger than a Slack modal accepts"* | **`supplied`**, the only resolution carrying a payload | all four resolutions | `abort` — one word — requires a shell with `$INTERNAL_API_KEY`; a break has no user-reachable exit (A10/A11) |
| break notification — *"free, **keeps the suffix free**"* | step-local drift (a prompt reworded at one step) | all drift | false for a `local_state` key several steps read: `user_design_notes` is read by 11, 21, 21r, 21t, so accepting at 11 defers the same decision three more times (A12) |

Each was written from a real case and was correct about it. Each then travelled to a case whose assumptions
did not hold, and stated its conclusion with no trace of the conditions that made it true.

**The rule to carry forward: when a rule is derived from one specimen, write down what about that specimen
made it true.** Test 2 in the same critic prompt does exactly this — *"NOT a finding: a re-query AFTER a
write"* — and Test 2 has never false-positived. The discipline is available; it was simply not applied.

Corollary, and the reason this keeps costing us: **the failure is silent by construction.** An
over-generalised rule does not error. It confidently produces a wrong answer that looks like a right one —
a workflow that never saves, a notification you cannot act on, a "free" resolution that defers its cost.

#### Sprint 8's own lesson, restated

Sprint 7's retro said *"the cost problem is the test loop, not the architecture"* and *"11 of ~15 defects
were in deterministic code."* Sprint 8 built the loop — and then **the loop immediately found five defects
in itself and its own design**, every one deterministic, none needing an LLM to detect, and none visible
without something comparing two runs byte-for-byte: the unordered `PGC_StepType` read, `diffComponents`
diffing the raw key union, A10, A11, A12. **The harness's first user was the harness.**

### Session 8 — 2026-07-21 — A9 + A12: detection becomes decision

**A9 (disposition) and A12 (blast radius) both landed** — the two items Session 5 named as "the whole
remaining shape of Track A". Neither cost a Perplexity call: both are pure functions over data the harness
already computes, exercised by unit tests. 633 tests pass (+18).

- **A9 — `dispositionForDrift`** (`replay-corpus.mjs`, computed at the seam): a policy over the seven
  components already classified, **no new hash** — Session 5's disproof of the assembled hash stands. Maps
  each drifting component to a verdict (`intended` / `refused` / `caution` / `judgment` / `downstream` /
  `reuse`); the headline is the **most severe**, so a benign prompt reword can never mask a changed question.
  The `input` verdict consumes A6's per-key diff: `step_type_contracts`-only → intended (step 11/`action_key`,
  where accepting was right); a question key → refused (step 23 pass 2, where it discards 10KB of repair
  context); no per-key data → caution. This is the two-cases-one-signal problem from Sessions 4/5, now
  resolved deterministically.
- **A12 — `computeBlastRadius`** (`run-workflow.mjs`, where the step definitions are in scope): for each
  drifted `input` key, the other `llm_call` steps reading its `local_state` source root. Reuses
  `extractTemplateRefs` (exported from `simulation-engine.mjs` — checklist "reuse before adding"). A unit
  test reproduces run 723's exact case: break at 11 → `{ user_design_notes: ['21','21r','21t'] }`.
- **Both stashed on the break frame, read by the notification and the GET report** — computed once, never
  re-derived (checklist rule 2e, the pattern this sprint keeps citing). The notification's unconditional
  *"free, keeps the suffix free"* — the third instance of the day's over-generalisation pattern — is **gone**,
  replaced by a disposition headline plus, when a drifted key reaches downstream, the named readers.

**Still not seen on a live break.** Every test is deterministic and reproduces the live cases from memory,
but A9/A12 have not yet rendered on an actual replay break — the next replay that drifts (e.g. answering the
step-9 gate on a replay of run 722/723) is the live confirmation, and it is free.

**Track A remaining:** A10/A11 (the two wedges — a break with no user-reachable exit; payload-free
resolutions belong in Slack), A8 (dev loop, ergonomics), AC3 (record mode, still never exercised), the A6
`local_state` diff, and `soft_drift` (still never exercised — memory has not moved between corpora).

### Session 9 — 2026-07-21 — A10 + A11: a break is driveable from Slack

**Both wedges closed — a break now has a user-reachable exit, from the interface it posts to.** Neither
cost a Perplexity call; both are system code with unit tests. 645 tests pass (+11 over Session 8).

- **A10 — `/shutdown <runId>` reaches `awaiting_llm_break`.** `shutdown.mjs` filtered
  `status IN ('running','awaiting_human_gate')`, so a break was invisible to `/shutdown` even when named.
  Fix: a **named** id also matches `awaiting_llm_break`; a **sweep** never does — the id filter is the
  distinction (`buildActiveRunFilters`, pure + 3 tests). Honours arch-replay §7a (a blanket sweep must never
  destroy a dev break) while restoring the targeted case §7a removed with it.
- **A11 — payload-free resolutions are Slack buttons.** `abort`/`call_live`/`use_recorded` render as Block
  Kit buttons (one per candidate when a step recorded twice, A5b); **`supplied` stays curl-only** — it is the
  one resolution carrying a payload, which is the *actual* reason §9 wanted HTTP. The over-generalisation
  (all four over HTTP) is corrected to *the one that carries data*.
  - **A9 governs which buttons appear.** On a `refused` disposition the `use_recorded` button is withheld —
    the curl remains, but the easy accept of a different question is not offered. A9 + A11 compose.
  - **Tiers stay clean.** PROC (`run-workflow.buildBreakActions`, 8 tests) decides *what* is offered and emits
    UI-agnostic `breakActions`; `callback.mjs` only maps them to Block Kit; `interactive.mjs` enqueues a new
    `REPLAY_RESUME` SQS message; `replay.mjs` routes it through the **same resume core** as the HTTP endpoint
    (refactored to share one path). The experience tier never writes the execution stack — PROC does.
- **Docs:** `architecture.md` SQS table (`REPLAY_RESUME`; resume no longer "HTTP-only"); `arch-replay.md`
  §5 + §9 (buttons for payload-free resolutions; the corrected HTTP boundary).

**Deployed and CONFIRMED LIVE — one free break proved four features at once (run 724).** Branch deployed to
prod (`sam deploy`, no seed upserts — all code). `/replay 722`, answering the step-9 gate (`user_design_notes`
4→35 chars) instead of skipping, broke at step 11 and rendered, unprompted:

- **A6** — `input changed: user_design_notes (4→35 chars) | unchanged: domain, …, step_type_contracts, …`
- **A9** — `⛔ a DIFFERENT question was asked` (`verdict: refused`, because `user_design_notes` is a *declared*
  question key, not harness-injected — the generalised injected-vs-declared split, deciding correctly live)
- **A12** — `⤷ user_design_notes is also read by steps 21, 21r, 21t`
- **A11** — buttons **Call LLM + Abort only, no `use_recorded`** (A9 withheld it); the `use_recorded` curl
  stayed in the text as the escape hatch
- **GET `/proc/replay/724`** returned the same `disposition`/`blast_radius`/`input_diff` off the frame —
  not re-derived (rule 2e)

**A11's button round-trip confirmed end-to-end:** clicking **Abort** drove `REPLAY_RESUME` SQS → `handler` →
`replay.mjs` shared resume core → frame write → `resume_llm` → `run-workflow` → run `cancelled`. The one path
that had only been unit-tested. **Run 724: 1 llm_call session, `replayed`, 0 live calls** — the whole
five-feature validation cost **$0**.

**A10 also confirmed live (run 725, 2026-07-21):** a second break at step 11, resolved with `/shutdown 725` →
`active runs found {count: 1}` → cancelled. The targeted shutdown now reaches a break; before A10 the filter
excluded `awaiting_llm_break` and the run had no exit. Both wedges are now proven live. **Track A remaining:** A8 (dev loop), AC3 (record mode, still never
exercised), the A6 `local_state` diff, `soft_drift` (still never exercised).

### Session 10 — 2026-07-23 — A8 built; AC3 closed live; a gated-replay wedge found and fixed

**A8 (`dev_scripts/replay.mjs`) and AC3 both landed.** A8 is the thin wrapper the sprint has wanted since
Session 3's nine hand-curls — start / poll / on-break dump prompt+report / wait for a resume file / resume,
plus `--auto`, `--record`, record-from-scratch, and (added this session) `--slack-channel`. 645 tests still
pass — the script is pure I/O over the three endpoints, no logic to unit-test (arch-replay §9).

**AC3 closed live on run 728 — record mode, `supplied` both ways, 0 live calls.** Not driven by the script in
the end (see the wedge below); driven directly against the endpoints A8 wraps, which is the same code path.
- Step 3 **served** from recording 1086 — because `always` was flipped **mid-run at the step-2 gate** and the
  flip landed after step 3 had already run. An accidental but clean proof that **the policy is read from the
  run row on every step** (arch-replay §7a), not cached, not carried in SQS.
- Step 11 broke (`reason=always`); the **63,016-char assembled prompt was readable over `GET`**; a **valid**
  `supplied` response (run 722's recorded gap_analysis, guaranteed schema-valid) passed `review-output` and
  the run advanced to step 21.
- Step 21: an **invalid** `supplied` response **failed the run** — `allowLlmCorrection: !served` is `false` for
  `supplied` (`llm-harness.mjs:467`), so an invalid hand-supplied response triggers **no** correction call. The
  failure test is therefore **free**, and that is the literal AC3 wording ("a response that would fail
  validation fails the run") proven, not asserted.
- `PGC_Session` for run 728: 3 llm_call sessions, `response_source` ∈ {replayed, recorded}, **live = 0**.

**The wedge, found by using it (the sprint's recurring pattern, now on its sixth instance).** `create_workflow`
has human gates at steps 2, 2d, 6, 9 — *before and between* its `llm_call`s — and a replayed run keeps them
**real** (arch-replay §5). Driving a record run purely from the dev script / HTTP path **cannot answer a human
gate** (no HTTP path; they render in Slack), and worse: the HTTP `POST /proc/replay` I first used carried **no
`callback`**, so run 726's gate fired into nothing and the run wedged **invisibly** at `awaiting_human_gate` —
zero Slack output, no news reading as good news. The fix is two-part: (1) `--slack-channel` on A8 so a gated
replay's gates render in Slack while the script drives the `llm_call` breaks over HTTP — the hybrid that
actually works; (2) the AC3 run itself was driven as that hybrid — **user answers the gates in Slack, I resolve
the `supplied` breaks over HTTP**. This is the intended division (arch-replay §5/§9): gates are experience-tier
and stay in Slack; `supplied` is the one resolution that needs HTTP because it carries a payload.

**A minor finding, logged not fixed:** in `always` mode `lookupRecording` is not called, so `candidate_session_id`
is null and no `use_recorded` is offered — correct — but `dispositionForDrift` still produced the headline
*"✅ recorded response answers the same request — use_recorded is safe"* on the step-11 break. Harmless (no
button is rendered, per `buildBreakActions`' `candidate_session_id != null` guard), but the headline is
misleading for record mode where there is no candidate. Backlog candidate: suppress the disposition headline
when `candidate_session_id == null`.

**Track A remaining:** the A6 `local_state` diff (free system code), `soft_drift` (still never exercised —
memory has not moved between corpora), and driving A8's own file-loop end-to-end against a gated run via
`--slack-channel`. Then sprint close (merge, docs, retro, **spend re-measure**).

**A6 `local_state` diff landed (same session, no live calls).** The last real code item in Track A.
`describeStateDrift` mirrors `describeInputDrift` exactly but over the **full frame `local_state`**, not just
`resolvedInput` — reusing the generic `hashInputKeys`/`diffInputKeys` (checklist "reuse before adding"; both
were already generic over any object). `computeFingerprint` now also snapshots `stateKeys`, written to
`request_fingerprint.local_state_keys`; like `input_keys` it is **not a component and not in the composite**, so
`diffComponents` (which iterates `COMPONENT_ORDER` only) ignores it and every pre-A6 recording keeps hitting.
It is **diagnostic only** (arch-replay §8) — never consulted to decide a break, deliberately broader than the
input diff so it surfaces state that diverged upstream but has not yet reached a prompt (and may reach a later
one, feeding A12's blast radius). Rendered as a compact `state` line in the notification (names what moved,
**counts** what held still — `local_state` can span 20+ keys) and in full on the GET report. +9 unit tests
(654 total). Not yet seen on a live break — the next drifting replay is the free confirmation. **Track A code
is now complete;** what remains is exercise (`soft_drift`, A8's file-loop live) and sprint close.

**Deferred (backlog):** `21c` redesign gate keeps the stale warning instead of a `🔄 Regenerating…` message —
confirmed to be D4 (sprint-07 §515) working as designed, not a flaw; needs an opt-in per-option confirmation
override (`on_select_message`/`clear_content`), never a default change. Logged to `backlog.md` Medium Priority
with a `21c` seed follow-up. Branch deployed to prod, validated live, **not yet merged to main** (sprint-close
step). **Session closed 2026-07-21.**
