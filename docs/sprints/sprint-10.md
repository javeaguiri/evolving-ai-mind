# Sprint 10 — Viability Checkpoints

**Status: CLOSED 2026-08-22. Outcome: GO.** Scoped 2026-08-06. Branch
`sprint/10-viability-checkpoints`, merged to main. 9 PASS · 2 MARGINAL · 2 NOT MEASURED across 13
acceptance criteria. The go/no-go recommendation is in §AC11; the retro is immediately below.

**Checkpoint 1 CLOSED — PASS** (AC10, settled on standing evidence 2026-08-08).
**Checkpoint 2c VALIDATED LIVE 2026-08-09 — AC1 mechanism PASS**, cost half measured 3.4× on a
four-turn round against a ≥4× threshold; the per-turn read across session 1131 is 3.7×. **AC2
remains unexercised** — no `run_sql` call has been made in a validating round.
**AC5 CLOSED 2026-08-09.** AC3 and AC4 not started.
**Checkpoint 2 ANSWERED 2026-08-10 — the user's verdict: cost and stability objectives met, Novia
is the direction** (Session 11). **AC11 GO recommendation drafted**, provisional pending
Checkpoint 3.
**Checkpoint 3 — `process_receipt` RUNS END TO END as of 2026-08-16. AC8 MET** (runs 775/776
grocery, 778 restaurant → correct expense category, inventory untouched). Alias matching
proven live (776: 3 auto + 2 LLM-resolved). **AC7 still fails as specified** — aliases persist
but there is zero `vectorSearch`, so the whole inventory still goes to the LLM and cost per
receipt *rises* with pantry size (2,708 → 6,050 tokens across 775/776). **AC9 cannot pass on
that design.** The inventory domain was remodelled the same day (category as a shared lookup,
not a per-item child) — cause was a user instruction to run 768, **not** a `create_domain`
defect.

**Checkpoint 4 added mid-sprint 2026-08-11** (risk accepted by the user) — capability and
scheduling tools live, **AC12 MET**, **AC13 dry-run only**. Scheduling is **built for real** on
EventBridge Scheduler, not stubbed.

> **Next session — the pickup, in priority order. Updated 2026-08-22.**
>
> **AC4 is MET ($0.672) and AC2 is MET — see Session 15. Run 780 proves both of Novia's fixes
> live — see Session 16. Both Execution defects are FIXED AND DEPLOYED — see Session 17.**
>
> **1. THE RECEIPT RE-RUN. Everything else waits on it.** Same merchant as a prior receipt, so the
> comparison is third-against-first and not a new-merchant number. It measures **AC9** and it is the
> regression test for the duplication fix, which touches every `llm_call` in the system. Watch step
> 10's input tokens against run 780's 12,460.
>
> **2. AC11's table needs its pass, and it is the sprint deliverable.** It still marks AC8 NOT
> MEASURED and still says the receipt use case "has never run" and that "AC4 has no number" — all
> three contradict this document's own header. Pending the user's call on how AC7 and AC9 are marked.
>
> **3. Checkpoint 4 waits on the Spanish friend** (user decision, 2026-08-22). The "Convinced" half
> is judged by him; nothing on this side unblocks it.
>
> **Off this sprint by user decision (2026-08-22): the vector-threshold calibration.** It goes to
> **Novia, next sprint**. AC7's "threshold calibrated" clause therefore does not close here — the
> mechanism is proven, the calibration is not. Run 780's two wrong merges (`PANU BOL MIN SELEX` into
> *Rustic Sliced Bread*; `ARANDANOS DESH ALT` into *Blueberries 300g*) are the specimens to hand her,
> and the two thresholds are separate: step 8 is English→English on `name_embedding`, step 8c is raw
> string→raw string on `alias_name_embedding`.
>
> ---
>
> **Superseded pickup, kept for the record — updated 2026-08-19.**
>
> **0. FIRST, BY USER INSTRUCTION 2026-08-19: fix the vector threshold.** 0.4 was chosen for a
> cross-lingual comparison that no longer exists on either step, and run 780 shows it admitting
> wrong merges — `PANU BOL MIN SELEX` (mini bread rolls) folded into inventory 17 *Rustic Sliced
> Bread*, and `ARANDANOS DESH ALT` (dehydrated) into inventory 6 *Blueberries 300g* (fresh). Two
> separate thresholds to calibrate, not one: step 8 is English→English on `name_embedding`, step 8c
> is now raw-string→raw-string on `alias_name_embedding`, and memory 298's bands
> (auto ≥0.60 / fallback 0.40–0.59 for names; auto ≥0.82 / fallback 0.60–0.81 for aliases) were
> measured against **neither** of those pairings. **Probe first, against live rows** — the probes
> are free and settled three questions in one session today. **Then decide the route:** the
> calibration is mine to produce, but the workflow edit is a domain artifact, so it goes through
> Novia's `propose_workflow_fix` unless the user directs otherwise. Worth raising with her as one
> message together with the two engine defects, since a re-run measures all three.
>
> The rest of the queue:
>
> **A. ✅ DONE — both fixes applied and proven by run 780** (workflow 358 v4; see Session 16).
> **What replaces it: fix the two Execution defects run 780 exposed** — the `columns` projection
> dropped under `vectorSearch`, and every `llm_call` sending its resolved input twice. Both are
> system code, both are in backlog High Priority, and together they are what stands between
> AC9 and a measurement. Then recalibrate the alias threshold off 0.4, which was chosen for a
> cross-lingual comparison that no longer exists and which admitted two wrong merges on run 780.
>
> **B. The correction workflow.** `PGD_Inventory` 25 is "Ink Cartridge" and is a red wine
> (`CAPERUCITA TINTA`). Rename, merge, and write an alias — **keyed on the raw receipt string,
> never on the wrong English**, or buying real ink increments the wine. This is what makes the
> alias table load-bearing rather than redundant.
>
> **C. ✅ DONE — MASYMAS run in raw Spanish as run 780.** AC7's mechanism is proven live; AC9 is
> still unmeasured and now waits on A, not on the workflow. **Repeat a receipt after A** — that is
> the measurement.
>
> **D. The prefix forfeit is now the dominant cost term** — 58% of session 1161. A gate resume
> forfeits it too, which the sprint had not recorded. See backlog.
>
> ---
>
> **Superseded pickup, kept for the record — updated 2026-08-16.**
>
> **1. AC4 — hand Novia the cost-scaling defect, in a NEW session, symptom only.** This is the
> uncontaminated specimen and it is now *measured*, not merely suspected: step 10's input went
> 2,708 → 6,050 tokens between runs 775 and 776 as the pantry filled. State it as
> *"processing a receipt costs more each time, and it gets worse as the pantry fills up"* —
> **never the diagnosis**. Reaching it means reaching `vectorSearch`, so this closes AC7 as
> well. **Do not hand her `current_date`**: it is a fallback that only fires on a receipt with
> no readable date, so on every run so far it is latent — "the date is frozen" would be handing
> her the answer.
>
> **2. AC9 follows from 1, and only from 1.** A third same-merchant receipt on today's design
> measures a *bigger* number. The threshold is "third < first"; it cannot pass until the
> full-inventory send is gone.
>
> **3. Re-run the home intelligence conversation (AC13).** Scheduling is real, so session 1151's
> contradiction is gone at the source. Watch whether she describes it accurately *without* being
> pushed. Spanish if it is the rehearsal for the friend. **New caveat found 2026-08-16:** no step
> type reaches a `PGC_Capability` endpoint, so a scheduled workflow still cannot call anything
> external. If she proposes a workflow that polls a device, that is a second false claim of the
> same kind — read the proposal knowing half of it is unbuildable, or land `capability_call` first.
>
> **4. Have her create a schedule herself.** `schedule_workflow` has **never been called through
> Novia** — the 2026-08-11 smoke test bypassed her by putting the message on the queue directly.
> The AWS half is proven (run 771); her half is not.
>
> **Carry:** a validation finding against a workflow known to run is evidence about the validator
> first. Twice on 2026-08-16 a "broken workflow" was a broken check.
>
> **Carry into every scheduled build:** a `human_gate` inside a scheduled workflow wedges at
> `awaiting_human_gate` with nobody to answer it — demonstrated by accident on `ping_core` (run
> 771). The tool description warns her; nothing enforces it.

> **This sprint ends in a go/no-go decision.** Its deliverable is not a feature — it is a written
> recommendation on whether development continues, measured against thresholds committed *in this
> document, before any number is observed*.

> Read before implementing: `docs/sprints/sprint-09.md` §RETRO, `docs/Javear-use-cases.md`
> (Domains 2 and 4), and `docs/arch-minds-eye.md` §12.7.

---

## RETRO — read this before scoping Sprint 12

**Sprint 10 was the sprint that had to produce an answer rather than a feature.** It did. The
answer is GO, and the discipline that produced it — thresholds committed before measurement — is
the finding most worth carrying, because it was tested three separate times and held each time.

### 1. Fixing thresholds in advance only matters at the moment you want to move one

The rule was written into the sprint doc on day one and cost nothing until it cost something. Three
occasions:

- **AC1's cost half came in at 3.4× against its own ≥4× bar.** Marked MARGINAL, not rounded up. The
  per-turn read (3.7×) is better evidence and is recorded alongside — but the mark follows the
  criterion as written.
- **AC3's criterion demanded "registered AND running" against a baseline that was registered-only.**
  That asymmetry was real, and the criterion was corrected *on the reasoning*, not on the score. It
  is recorded as a framing correction with the argument attached, so a later reader can disagree
  with it.
- **AC9 was offered a PASS by inspection and declined one.** The qualitative evidence was real but
  evidenced AC7, not AC9's cost claim. Grading it would have manufactured the sprint's central
  result.

**The generalisation:** a threshold fixed in advance is worthless until it disagrees with you. Every
one of these was a small, defensible-sounding move. Sprint 11 should expect the same pressure on
whatever it commits to.

### 2. Pre-register the *measurement*, not only the threshold

AC9's number was going to be read off a receipt of unknown size. Committing the metric — per-item
tokens and per-item cost, with raw per-receipt cost explicitly *not* the criterion — into git
**before the run** is what made run 782 interpretable. The receipt turned out to have four items
and zero alias overlap; without the pre-registration, a 2.4× per-item drop would have been
extremely easy to write up as alias learning. It wasn't. It was two engine fixes.

**Carry:** when a number will be read off an event you do not control, fix *how* it will be read
before the event, and commit it where the timestamp is checkable.

### 3. Running the system found nearly everything; reading it found nearly nothing

Ten engine defects this sprint. Seven on 2026-08-16, two on 2026-08-19, one on 2026-08-22 — every
one surfaced by executing, not by review. The 08-22 defect is the sharpest case: the projection fix
was correct and complete, unit-tested, and the rows *still* carried `name_embedding: null`, found
only because the backlog entry said **re-probe rather than trust the response shape**. A fix
verified against its own tests is not verified against production.

**Carry:** budget for a live exercise of every fix, and write "re-probe" into the backlog entry
rather than into someone's memory.

### 4. Novia's failures were legible, and that is the maintainability evidence

She reached a real cost-scaling defect from a symptom alone in four turns for $0.104, self-corrected
an invented step type against `PGC_StepType`, and — shown a plain user observation about the wine —
reversed her own wrong diagnosis in one turn: *"Issue 3 as I originally framed it was wrong."* The
repairs she shipped were sometimes wrong (the `name_en` binding on step 8c), but they were wrong in
ways that were inspectable and correctable. That, not the cost figure, is Checkpoint 4's actual
premise, and it is the strongest evidence the sprint produced for it.

### 5. A validation finding against a workflow known to run is evidence about the validator

Twice on 2026-08-16 a "broken workflow" was a broken check. This was already on Sprint 9's
watch-list and recurred anyway. It stays on the list.

### 6. What this sprint did not resolve, stated so it is not rediscovered

- **The alias-learning cost claim is unproven.** Built, live, and unmeasured. Not a negative result
  — an absent one.
- **The threshold is uncalibrated and is now writing bad data.** Three wrong merges, one of which
  *persisted as an alias*, so it compounds. The correction workflow is not cleanup, it is
  containment.
- **Output tokens are now ~48% of a receipt run.** Every cost intervention so far has been on the
  input side. That well is largely dry.
- **Release-readiness has now been deferred five times.** The GO removed the stated justification.
  A fifth deferral needs to be a decision on the record, which is what Sprint 11's scope makes it.

### 7. For Sprint 12 scoping

Sprint 11 is deliberately a cleanup-and-usability sprint after a make-or-break one, and its items
come from *use* rather than from a plan — `/help`, the correction workflow, table scrolling in a
reveal window, recategorisation. **That is the right shape for the sprint after a GO**, but it means
Sprint 11's scope will grow as administrative workflows surface more dialog defects. Expect it, and
prefer recording new findings over absorbing them mid-sprint.

---

## Sprint Goal

**Establish whether evolving-mind-ai can sustain itself — economically, and as something a person
other than its author can rely on — by passing three checkpoints.**

If it passes, development pauses and the system enters use as a second-brain MVP, with the
project opened to outside contributors and its costs moved from development to maintenance and
collaboration. If it fails, it is an interesting science project and stops being more than that.

Both outcomes are acceptable answers. **An unclear outcome is not**, which is why the thresholds
below are fixed in advance and why each is stated as a number rather than a direction.

**Branch:** `sprint/10-viability-checkpoints`

---

## The three checkpoints

### Checkpoint 1 — Cost of ownership

Day-to-day running cost with no development activity. Currently estimated at **~$21/month** in
AWS charges — roughly 2× the original projection, and accepted.

**This checkpoint is measure-and-document, not build.** It passes unless the measurement
contradicts the estimate. Two things it must separate, because conflating them has already
distorted one sprint's reading:

| Cost class | What it is | Whose problem |
|---|---|---|
| **Fixed infrastructure** | RDS, Lambda, API Gateway, SQS — accrues whether or not the system is used | Checkpoint 1 |
| **Per-use LLM spend** | Perplexity gateway calls, per receipt / per query / per build | Checkpoints 2 and 3 |

The $21 figure is AWS only. **Checkpoint 3's per-receipt cost lands in this checkpoint's
category, not its own** — receipt processing is day-to-day use, and it recurs forever. That is
the whole reason the lazy-match design (below) is a cost decision rather than an implementation
detail.

**Threshold:** PASS if fixed cost ≤ $30/month. FAIL above $40/month.

**Settled 2026-08-08 on standing evidence — PASS. No Cost Explorer run.** AWS charges have held
at ~$21/month for many months with no development-driven variance, which is what this checkpoint
asked and answers it inside the threshold. A per-service breakdown would confirm a number that
has already been stable across several billing cycles.

**The cost risk is Perplexity API spend, not AWS**, and it is measured by Checkpoints 2 and 3 —
where it belongs, since it is the variable that development activity and per-receipt use actually
move. Checkpoint 1 is closed; the go/no-go turns on the other two.

---

### Checkpoint 2 — Cost and stability of creating and repairing workflows

**The central question of the project's second half.** `create_workflow`'s failure was
*stability*: 98 runs, 4 surviving workflows. Novia's risk is *cost*, and secondarily stability.

The hypothesis under test is the user's: **Novia produces a stable mechanism if generation cost
can be controlled — and she is innately more capable at repair and enhancement than
`create_workflow` ever was.** That is two claims, so this checkpoint takes two measurements.

#### 2a — Build cost (clean-room)

Novia rebuilds `edit_budget` from a Slack conversation, **without being shown workflow 357**.
Same request, no sight of the answer. The prohibition is what makes the number comparable to the
$2.73 that the original build cost.

Baselines, stated honestly in both directions:

| Path | Headline | What it actually delivered |
|---|---|---|
| `create_workflow` | $1.42 per paid build (run 729) | 4 surviving workflows from 98 runs — cost per *delivered working* workflow is far above $1.42 |
| Novia, Sprint 9 | $2.73 build | + $3.40 repair session that did not finish = **$6.13 all-in**, for one delivered workflow |

**Threshold — all-in cost to one registered *and running* workflow:**

| Band | Cost | Reading |
|---|---|---|
| **PASS** | ≤ $1.50 | At or below one `create_workflow` paid build, with categorically better stability. The economics work. |
| **MARGINAL** | $1.50 – $3.00 | Better than Sprint 9's $6.13, not clearly better than the alternative. Proceed only if 2b passes clearly and no repair was needed. |
| **FAIL** | > $3.00 | The transcript fix did not move the dominant cost. The economics do not work at household scale. |

"Running" is load-bearing and is the AC5 lesson: Sprint 9 counted a registered workflow and had
to correct itself. A build that registers but does not run is a **FAIL** at any price.

#### 2b — Repair cost (the half the user expects Novia to win)

Sprint 9's deferred AC8, reinstated as evidence rather than a leftover. Novia is handed a broken
workflow and the *symptom only* — never the diagnosis — and must reach the defect herself.

Specimen: D2 (`import_budget_spreadsheet` step 9 passes bare category names to a `serv_insert`
that needs row objects) and D3 (current date frozen at generation time in three places). **D1 is
no longer usable** — Sprint 9's L1 numeric-index check now catches it before it can reach a run,
and `edit_budget` v6 is repaired.

| Band | Cost | Reading |
|---|---|---|
| **PASS** | ≤ $1.00, defect reached unaided | The repair claim holds; this is where Novia beats a regenerating pipeline. |
| **MARGINAL** | ≤ $2.00, or reached with one hint | Works, but the advantage over regeneration is not decisive. |
| **FAIL** | > $2.00, or requires human diagnosis | The claimed advantage does not exist. |

#### 2c — The prerequisite: native tool calling

**Rescoped 2026-08-08 after the original diagnosis was disproved twice.** Neither measurement
above is meaningful until this lands.

**What it is not.** It is not the `PGC_Memory` tiebreaker: `assembleContext` runs once per round
(`minds-eye.mjs:148`) and its result is held constant across every turn, so a reshuffle cannot
explain a miss between turns four seconds apart — and the miss happens anyway. It is not a
gateway capability gap either: the gateway caches `input` fully on a byte-identical repeat.

**What it is.** We send the transcript as **one hand-rendered string**. A string has no internal
boundaries, so there is nothing to match a prefix against — the whole block misses on any change,
and an agentic loop changes it every turn by definition. Measured on the live gateway, same
model, same append operation:

| `input` shape | Appended turn |
|---|---|
| String (what we send today) | create 13,477 · **read 4,698** — the `instructions` block only |
| Hand-built `{role, content}` array | create 11,502 · **read 4,695** — the `instructions` block only |
| **Echoed `response.output` items** | create 10,132 · **read 16,539** — the *entire* turn-1 prefix |

In the third case `read` equals the previous turn's `create` exactly: instructions plus the whole
prior user turn came back at 0.1× while only genuinely new tokens were written at 1.25×. Turn 2's
input was 60% larger than turn 1's and cost 26% less. Canonical items carrying server-assigned
`call_id`s get per-item cache boundaries; a string does not.

**Fault domain: Execution — and it is the extend-not-prompt violation pattern, textually.**
`CLAUDE.md` names three clauses; this matches all three. The established standard is native
function calling, which the gateway supports for `anthropic/claude-sonnet-4-6` — Novia's exact
model. The proprietary shape invented instead is `{action, params, reasoning}` (`ACTION_SCHEMA`,
`minds-eye.mjs:36`). And the prompt rule forcing it is in `minds_eye_system_prompt` verbatim:
*"DO NOT revert to native tool-use formats, native API behavior, or any pattern not described
here."* That is not an accidental omission — it is a written instruction forbidding the standard.

Note the principle's stated boundaries are `step-executor.mjs`, `template-resolver.mjs`,
`table.mjs`, `review-output.mjs` and `serv-client.mjs`; this seam predates Novia and is not among
them. The test it states is what this change passes — the doc does not name the change.

**Three steps, smallest first:**

| # | Site | Change |
|---|---|---|
| **(i)** | `llm-client.mjs` | Accept a `tools` parameter and an item-array `input`. Purely additive — `callLlm`'s parsed-JSON contract is untouched, so every existing caller is unaffected. |
| **(ii)** | `minds-eye.mjs` | Emit the tool catalog natively; carry `response.output` items forward and return results as `function_call_output`. **The substantial part** — the loop, `PGC_SessionEntry` persistence, and the `__pending__`/`__cancelled__` gate entries are all built on our own entry shape. |
| **(iii)** | `minds_eye_system_prompt` | ✅ **DONE** — prose catalogs, the `{action, params}` envelope and the anti-native-tool-use rule retired. 14,920 → 10,236 chars (~1,171 tokens); v30 → v31. Every SOP, protocol and sequencing instruction kept: those say what to do and in what order, which no schema expresses. |

**Progress.** All three steps are code-complete and pushed; none of it has run yet. Step (ii) was
broken into five parts:

| | Work | State |
|---|---|---|
| 2a | 23 tool schemas in `PGC_SystemContext.minds_eye_tool_schemas`; `selectToolDefinitions` + `loadToolDefinitions` with a two-way drift check against the dispatch sets | ✅ DONE |
| 2b | `toInputItems(workingHistory)` — rebuild canonical items at round start, pairing `__pending__` with its resolution | ✅ DONE |
| 2c | The loop swap: `callLlmWithTools`, dispatch on `function_call.name`, append real `output` items | ✅ DONE |
| 2d | `instructions` absorbs both context blocks and the standing instruction; `buildUserMessage`, `latestDraftIndex` and draft supersession are deleted | ✅ DONE |
| 2e | Gate resume pairs a persisted `__pending__` with its resolution on rebuild | ✅ DONE — needed no code: `handleGateResume` already passes both entries, and 2b pairs them |

**Schemas live in `PGC_SystemContext`, not `PGC_Capability`.** `PGC_Capability` is the registry for
external *service* capabilities — a stock-price service, say — and adding one is intended to stay a
developer action rather than something Novia or a future add-capability workflow performs. That
fence is not yet enforced and the decision is open; either way it is not the agent's own tool
catalog. The rule that a step type's contract lives in `PGC_StepType` does not transfer here:
a new agentic behaviour is not a new step type.

**The 23-tool catalog is verified live, not assumed.** The gateway accepts it for
`anthropic/claude-sonnet-4-6`; the tools block costs ~3,162 tokens and **is cached** (a follow-up
call read 7,565 = instructions + tools and cost $0.0046 against $0.0335 cold); routing is sound
with 23 choices rather than one; and `read/prev` still hits 1.00 on append with the full catalog
loaded. Step (iii) removes the prose catalog from `instructions`, so the net size change is close
to neutral while schema enforcement is gained.

A5's guidance now rides in `run_sql`'s own description — *call `list_physical_tables` first,
double-quote CamelCase identifiers* — and the probe showed the model obeying it by reaching for a
listing tool before raw SQL. A tool description doing the work a prompt rule used to do is the
same principle as the rest of this rescope.

**Three defects die structurally rather than being fixed.** Sprint 9's largest finding — Novia
could not see her own work because `buildUserMessage` dropped a tool entry's `params` — becomes
impossible, because the params *are* `function_call.arguments`, echoed verbatim. Draft
supersession (the old fix (iii)) goes away with the re-rendering. And `ACTION_SCHEMA` is
currently **never sent** for Novia at all: `llm-client.mjs:59` gates `response_format` behind
`model.includes('sonar')`, so her output structure is enforced by prompt prose and nothing else.

**Resolved by a multi-turn probe: credit holds for the whole round, and there is a hard design
rule attached.** Eight turns in Novia's actual shape — one user turn, then a chain of tool
round-trips — gave `read` equal to the previous turn's entire `in` on **every** turn, with
`create` flat at the per-turn increment and per-turn cost flat while the transcript more than
doubled:

```
turn      in   create     read  prev in  read/prev        $
1     15,607   15,605        0        0          -  0.05973
2     18,541    2,935   15,605   15,607       1.00  0.01658
8     36,139    2,933   33,205   33,206       1.00  0.02185
```

Creation over the round: 172,279 tokens today against 36,138 — **4.8× at eight turns**, and
because today's cost grows quadratically while this grows linearly, a 20-turn round projects to
**~12×**.

**The rule: never append a user message mid-round.** The same probe run with a fresh user turn
injected each iteration — everything else identical — pinned `read` at the `instructions` block
and grew `create` linearly, which is today's failure profile exactly. One trailing user item
forfeits the whole prefix credit for that turn. The mechanism is not visible from outside; the
effect is measured twice with everything else held constant.

That rule is what shapes step (ii). Everything `minds-eye.mjs` currently appends to the per-turn
user message has to move or go:

| Today, in the per-turn user message | Under native tools |
|---|---|
| Standing instruction ("decide your next action") | Constant → into `instructions` |
| `layer1Context` / `layer2Context` | Constant within a round → into `instructions` |
| `truncationNotice` | Per-turn and volatile → needs another home, or an accepted one-turn cost |

So `buildUserMessage` does not get reordered. It mostly stops existing.

**No replay-corpus impact.** Verified: `minds-eye.mjs:31` imports `callLlm` directly from
`llm-client.mjs` and never touches `llm-harness.mjs`, which is where `computeFingerprint` runs
(`llm-harness.mjs:299`). Novia's calls are not fingerprinted and not in the corpus.

**A5 lands in the same deploy** — `run_sql` gives Novia no route to physical table names, which
cost ~$1.50 of session 1122's $3.40. Two statements close it: use `list_physical_tables` before
raw SQL, and double-quote CamelCase identifiers. Context content, no code.

**One live round validates 2c, A5, and 2b together.** The signals read from different places and
do not confound: the cache effect from `cache_read`/`cache_creation` in the usage logs, A5 from
whether any `run_sql` call fails on an identifier, 2b from whether she reaches the defect.

---

### Checkpoint 3 — The receipt use case

**The test vehicle that makes this a second brain rather than a demo.** One workflow, one entry
point: paste a receipt, and the system either adds items to home inventory using lazy name
matching, or files an expense to the right category.

Routing is the workflow's own decision, not the user's — a grocery receipt goes to inventory, a
restaurant, hotel, bus or airfare receipt goes to expenses. Picking the workflow before pasting
is precisely the friction this is meant to remove.

#### 3a — The inventory domain does not exist

Verified live 2026-08-06: domains are `system`, `recipes`, `_embed_test`, `flashcards`,
`budgets_expenses`. There is no pantry or inventory domain.

**Created via `create_domain` (v56), not by Novia.** Domain creation is a one-time cost per
domain, so it is not where the money is, and adding a second capability question would dilute a
make-or-break sprint. What `create_domain` costs and where it fails on this domain becomes the
evidence for the *separate* question of whether Novia should absorb it — decided by observation
in a later sprint, not by argument now.

**Known hazard, and inventory is the case that triggers it.** Sprint 9 found `create_domain`
emits derived-field maintenance rules with **no consumer** — `card_count` on the flashcards
domain reads 0 against 34 cards because the "application logic after insert" its memory row
delegates to does not exist. An inventory domain whose quantities increment from receipts is
exactly that shape. Sequence *do not denormalize* first: at household scale a count can be a
`COUNT(*)` or a view, and that asks whether the column should exist before building machinery to
maintain it.

#### 3b — Lazy matching: the design decision that sets the ongoing cost

`Javear-use-cases.md` UC-P4 specifies an `llm_call` receiving the raw receipt text plus the
current pantry list, returning a mapping. That works, and it **costs money on every receipt,
forever**, scaling with inventory size. It also contradicts `architecture.md` §1 — *"LLM is not
called twice for the same problem."*

**The design this sprint builds instead:**

1. Embed the receipt line; **vector-match** against the inventory item's `name_embedding`.
2. Anything above threshold resolves with no LLM call at all.
3. Only the residue below threshold goes to an `llm_call`.
4. A human gate confirms the mapping.
5. **Each confirmation writes an alias row** — so "EVOO 32OZ" resolves by similarity the first
   time and by stored alias every time after.

The cost per receipt *falls with use*. That is the evolving-mind thesis made measurable, and it
is what makes Checkpoint 1 hold as receipts accumulate rather than degrade.

**The mechanism already exists one layer down, and is invisible to workflows.** `vectorSearch` —
pgvector cosine similarity with a threshold — is implemented in `table.mjs:143` and exposed
through `getRows` (`serv-client.mjs:85`). But `serv_query` (`step-executor.mjs:807`) destructures
only `{ tableName, filters, orderBy, limit }` and never passes it on, and the `serv_query`
`input_contract` does not declare it.

**Fault domain: Execution.** The capability exists; the harness does not expose it. Pass-through
plus a contract field plus the `PGC_StepType` row — no new machinery, and the extend-not-prompt
principle applies directly.

Threshold calibration is its own task: `PGC_DomainHelp` uses 0.40 for `pplx-embed-v1-4b`
calibrated against domain nouns, and `arch-data.md` is explicit that this does not carry over to
a different kind of alias. Grocery abbreviations need their own calibration.

#### 3c — The workflow itself

Built by **Novia**, which makes it Checkpoint 2's second data point: a genuinely novel build with
a hard sub-problem, as opposed to 2a's controlled rebuild of something she has designed before.
2a measures cost cleanly; 3c measures whether the capability holds on unfamiliar ground.

**Threshold:** binary. PASS when a real grocery receipt adds correctly-matched items to
inventory, **and** a real restaurant or travel receipt files to the correct expense category,
both from Slack, both without hand-repair between the build and the run.

**Also measured:** cost to process one receipt, first time and third time. The two numbers
together are the alias-learning claim; one number alone is not.

---

### Checkpoint 4 — Readiness for someone who is not the author

**Added mid-sprint 2026-08-11, at the user's request, with the risk to the other checkpoints
explicitly accepted by the user.** A friend wants a home intelligence system. The ask is not the
home system: it is *"how ready is evolving-mind for general consumption"*, measured on a person
who did not build it.

This is a harder test than Checkpoint 2 and it is worth naming why. Every build so far has been
the author asking, in a domain the author designed, against workflows the author had already
shaped. This is a domain nobody designed for, requested by someone else, where Novia has only
general primitives and must reach the specific solution herself. It is also the first real probe
of the release-readiness question deferred four sprints running.

**Threshold — two parts, both required:**

| | Criterion |
|---|---|
| **Feasible** | The proposal must be buildable on this architecture. Assessed by the user. Already believed true; it fails only if Novia proposes something the system cannot express. |
| **Convinced** | The friend, after the conversation, is persuaded this could serve his need. Judged by him, reported by the user. |

**The build is deliberately minimal, and generality is the measurement.** Every home-specific
affordance added here is a thumb on the scale: if the primitives are pre-shaped toward lights and
thermostats, a good proposal proves nothing. Six general tools, no domain content.

| Tool | Class | State |
|---|---|---|
| `list_capabilities` | read | **Real** — reads `PGC_Capability` |
| `register_capability` | gated write | Stub |
| `call_capability` | gated write | Stub |
| `list_schedules` | read | Stub |
| `schedule_workflow` | gated write | Stub |
| `cancel_schedule` | gated write | Stub |

**A stub may not report success.** Each returns `{status: 'not_implemented', would_have: {...}}` —
the request a real implementation would have issued. A stub returning `{ok: true}` would have
Novia tell the friend the lights are on, and the whole value of a stubbed catalog is that she can
describe a mechanism truthfully, *including that it is not built*. The gate card says the same on
its face, because approving one of these approves a description.

**Gated while stubbed**, all four writes. Each one, once wired, acts on the physical world or
commits the system to acting on it unattended. Shipping them ungated and tightening later makes
the tightening something someone has to remember.

**What is already real is the strongest part of the demo.** Domain creation, workflow design,
L0/L1/L2 simulation, registration, `notify` steps and human gates all work today. Only the
outbound call and the unattended trigger are stubbed — so "tell me if the garage door is open" is
real end to end apart from the sensor read.

**Decision reversed, on the record.** Sprint 10 previously recorded that adding a capability was
*"intended to stay a developer action rather than something Novia performs — that fence is not
yet enforced and the decision is open."* It is now settled the other way: `register_capability`
is Novia's tool, gated.

**`PGC_Capability` extended under config control** — `src/serv/templates/pgc/PGC_Capability.json`
and the `seed_PGC_Schema.json` registry row, never direct DDL. Five columns (`endpoint`,
`method`, `auth_ref`, `input_schema`, `output_schema`), category `'external'`, and a method CHECK.
`auth_ref` holds an SSM parameter **name**, never a credential — the table is readable by anything
that can read PGC.

**Deployed live, and a bootstrap trap found on the way.** The schema change had to reach the
running database, not just the template: a registry that says `external` is not a valid category
is one Novia correctly reads as an implementation gap, and the demo turns on her *not* flagging
one that no longer exists.

Bootstrap is the wrong instrument. `createTableFromTemplate` issues `CREATE TABLE IF NOT EXISTS`,
so it cannot add a column to a table that already exists — while `seedPGCSchema` upserts
`ON CONFLICT DO UPDATE` and would refresh the registry row regardless. **Running bootstrap would
have made `PGC_Schema` assert five columns the database does not have**: the *"registry must never
assert what the database does not"* invariant, inverted, which is the exact defect class Session 9
recorded.

Applied instead through the routes that move both sides together — `addColumn` ×5,
`modifyConstraint` ×2 (`chk_capability_category` gains `external`, `chk_capability_method` is new),
`updateTable` for the description. Verified against `information_schema.columns` rather than
trusting the responses: all five columns exist physically, nullable, correct types; the registry
row carries 14 columns and 3 constraints; `PGC_Capability` holds **0 rows**.

The columns exist so that anything reading the registry sees the real contract. Nothing writes
them while the tools are stubbed.

---

## Acceptance Criteria

| # | Criterion | Checkpoint | Threshold |
|---|---|---|---|
| **AC1** | Novia's loop uses native function calling; in a live round `cache_read` exceeds the `instructions` block on **every** turn after the first and grows with the transcript, while `cache_creation` holds near the per-turn increment | 2c | Mechanism: binary. Cost: creation component down ≥ 4× |
| **AC2** | A5 — `run_sql` table-name guidance; no `run_sql` call in the validating round fails on an identifier | 2c | 0 identifier failures — **MET 2026-08-19** (session 1161: one `run_sql`, CamelCase double-quoted, no failure) |
| **AC3** | Novia rebuilds `edit_budget` clean-room, without sight of workflow 357, to a **running** workflow | 2a | ≤ $1.50 all-in |
| **AC4** | Novia diagnoses and repairs a defect given the symptom only. **Specimen changed** — D2/D3 were contaminated; the specimen used is the cost-scaling defect in her own build (workflow 358) | 2b | ≤ $1.00, unaided — **MET 2026-08-19 at $0.672** (session 1161: diagnosis $0.104, repair to v3 $0.568, defect reached unaided, `serv_vector_search` self-corrected against `PGC_StepType`). Under budget on the measured criterion |
| **AC5** | `serv_query` exposes `vectorSearch`; contract and `PGC_StepType` row updated; L0/L1 unaffected on all seed workflows | 3b | Regression-free |
| **AC6** | Inventory domain created via `create_domain`, with the derived-column question settled rather than inherited | 3a | Domain live, no unmaintained denormalized columns |
| **AC7** | Lazy matching resolves a real receipt's items against inventory, threshold calibrated, confirmations persisted as aliases | 3b | Named in 3b |
| **AC8** | One routing workflow, built by Novia, handles both receipt kinds end-to-end from Slack | 3c | Binary — both kinds — **MET 2026-08-16** (runs 775/776 grocery, 778 restaurant) |
| **AC9** | Per-receipt cost measured on first and third use of the same merchant | 3b | Third < first |
| **AC10** | ~~AWS fixed cost measured per-service for a full billing month~~ — **settled PASS 2026-08-08 on standing evidence: ~$21/month, stable for months. No measurement task.** | 1 | ≤ $30/month ✅ |
| **AC11** | **Written go/no-go recommendation** against every threshold above, with each marked PASS / MARGINAL / FAIL | — | Exists, and is unambiguous |
| **AC12** | Six general capability and scheduling tools declared and gated; the capability writes stubbed and incapable of reporting success; **scheduling built for real on EventBridge Scheduler**; `PGC_Capability` extended under config control | 4 | **MET 2026-08-11** — catalog v3 at 29 tools, schema live, Finnhub registered `planned`, scheduling validated end-to-end (run 771) |
| **AC13** | Novia proposes a home intelligence system from the general primitives alone, unprompted by home-specific content | 4 | Feasible **and** the friend is convinced — **dry run done (session 1151), not yet shown to the friend** |

---

## Out of Scope

| Item | Why |
|---|---|
| **Release-readiness — test environment, README bootstrap, log hygiene** | **Deferred a fourth time, by explicit decision 2026-08-06.** The reasoning is sound: handoff infrastructure is not worth building for a project that may be cancelled, and the go/no-go comes first. **The operational consequence is accepted, not overlooked** — without a test environment this sprint validates against prod, which is the same condition that caused Sprint 9 to defer AC8. Plan for it. **Becomes Sprint 11's opening item if the decision is go**, at which point it stops being tech debt and becomes the handoff itself: a contributor who cannot stand the system up cannot contribute. |
| **Extending Novia to create domains** | The question is real and stays open. Answering it needs evidence from `create_domain` running against a genuinely new domain, which AC6 produces. Deciding it in advance, inside a make-or-break sprint, would put two capability questions on one result. |
| **Archetype / dialog-strategy registry** | **Parked, and Session 10 argues for dropping it rather than revisiting.** The stated condition was to revisit *if a Checkpoint 3 build shows Novia reinventing a procedure she has already written*. The Checkpoint 3 build did the opposite: she called `read_workflow` on `import_budget_spreadsheet` and took its shape before drafting her own 24 steps. The live artifacts already are the registry, they cost nothing to maintain, and unlike a curated set they cannot go stale against the workflows they describe. |
| **`create_workflow` repairs of any kind** | Retired by the direction. `design_workflow_dialogs` v19 is spliced. Do not run it. |
| **`/chat` dead code removal** | Independent, still undecided. |
| **Richer episodic memory, `PGC_Memory` dedup/TTL** | Unchanged from Sprint 9. |

---

## Sequencing

The dependency chain is strict and should not be run out of order:

```
2c  native tools + A5           ──┐
                                   ├──►  AC3 (2a build cost)     ──┐
                                   └──►  AC4 (2b repair cost)    ──┤
                                                                   │
3b  serv_query vectorSearch  ──┐                                   │
3a  inventory domain         ──┴──►  AC7 (lazy match)  ──►  AC8 (3c routing workflow)
                                                                   │
                                                                   └──►  AC11 go/no-go
```

**Nothing in Checkpoint 2 is measurable before 2c lands** — that is the whole reason AC8 was
deferred out of Sprint 9. **AC8 (the routing workflow) is built by Novia**, so it sits behind
Checkpoint 2 as well as behind its own prerequisites; it is the second capability data point, not
a parallel track.

AC10 is closed — see Checkpoint 1. It contributes a PASS to AC11 and no work.

---

## Test Scenarios

All workflow runs and all Novia sessions are triggered **by the user from Slack** — never by curl.

1. **Cache validation** — one Novia round of any kind after 2c deploys. Read the usage logs for
   `cache_read` / `cache_creation`. This is AC1 and AC2 together.
2. **Clean-room rebuild** — `/novia`, request `edit_budget`'s functionality from scratch. Novia
   must not be shown workflow 357. AC3.
3. **Blind repair** — hand Novia `import_budget_spreadsheet` and the symptom ("the category
   import inserts nothing"), never the diagnosis. AC4.
4. **Grocery receipt** — paste real Apple Photos OCR text from a supermarket. Items match
   inventory by similarity; unmatched go to the LLM; the gate confirms; aliases persist. AC7.
5. **Same merchant, third receipt** — the alias-learning measurement. AC9.
6. **Service receipt** — a restaurant, hotel, bus or airfare receipt through the *same* entry
   point, landing in the right expense category. AC8's second half.

---

## AC11 — Go / No-Go Recommendation

**FINAL, 2026-08-22.** Checkpoints 1, 2 and 3 are answered. Checkpoint 4 is not, and cannot be
answered from this side — its deciding half is a judgement by a person outside the project.

### Recommendation: **GO.**

Development continues, and **Novia replaces `create_workflow` as the way workflows are built.** The
system sustains itself economically at household scale, the build mechanism is stable across two
genuinely different builds, and the receipt use case runs end to end from Slack in a language the
system was never tuned for. What the sprint set out to demonstrate and **did not** is stated in full
below rather than folded into the recommendation.

### Every threshold, marked

| # | Criterion | Threshold | Verdict | Evidence |
|---|---|---|---|---|
| **AC10** | AWS fixed cost | ≤ $30/mo | **PASS** | ~$21/mo, stable across several billing cycles |
| **AC1** | Native tool calling — mechanism | binary | **PASS** | `cacheRead` = the previous turn's entire `inputTokens`, every turn after the first |
| **AC1** | Native tool calling — cost | ≥ 4× | **MARGINAL** | 3.4× on a four-turn round; 3.7× per-turn across session 1131. Below its own bar, recorded as measured rather than rounded up |
| **AC2** | `run_sql` identifier guidance | 0 failures | **PASS** (n=1) | session 1161: one `run_sql`, `"PGD_Inventory"` double-quoted, no identifier failure. One call is one call — not a rate |
| **AC3** | Build cost to a workflow | ≤ $1.50 | **PASS**, substitute evidence | The clean-room `edit_budget` rebuild was never run. Cost comes from the `process_receipt` build: **$1.376** against the $1.42 `create_workflow` baseline, registered-to-registered |
| **AC4** | Repair, unaided | ≤ $1.00 | **PASS** | session 1161, **$0.672** all-in — defect reached unaided from a symptom, repaired to workflow 358 v3 with per-item `vectorSearch` |
| **AC5** | `serv_query` exposes `vectorSearch` | regression-free | **PASS** | contract, executor pass-through, `query_table`; all 15 seed workflows swept, no new failures |
| **AC6** | Inventory domain, no unmaintained derived columns | binary | **PASS** | run 766, one table, `item_count`/`level` gone with the padding table |
| **AC7** | Lazy matching with persisted aliases, **threshold calibrated** | named in §3b | **MARGINAL** | Mechanism proven live on run 780 and again on 782: per-item `vectorSearch` on both tables, same-language alias search, 84 aliases persisted as raw strings. **The calibration clause is unmet** — 0.4 was chosen for a cross-lingual comparison that no longer exists on either step, and it has now admitted three wrong merges across two runs. Assigned to Novia, Sprint 11 |
| **AC8** | One routing workflow, both receipt kinds | binary | **PASS** | runs 775/776 grocery, 778 restaurant → correct expense category, inventory untouched. Built by Novia, no hand-repair between build and run |
| **AC9** | Per-receipt cost, first vs third, same merchant | third < first | **NOT MEASURED** | See below. The mechanism runs; no receipt has yet demonstrated cost falling *because the system learned* |
| **AC12** | Capability + scheduling tools, gated | binary | **PASS** | catalog v3 at 29 tools, `PGC_Capability` under config control, scheduling validated end-to-end on EventBridge Scheduler (run 771) |
| **AC13** | Novia proposes a home intelligence system | feasible **and** convinced | **NOT MEASURED** | Dry run done (session 1151). The "convinced" half is judged by the friend and reported by the user; it has not been shown to him |

**On the vocabulary.** AC11 asks for PASS / MARGINAL / FAIL. Two criteria are marked **NOT
MEASURED** instead, deliberately: forcing an unrun criterion into one of three grades would
manufacture a result, which is the specific failure the fixed-in-advance thresholds exist to
prevent. An unmeasured criterion is a gap in the evidence, not a grade.

### AC9 — the one thing this sprint set out to show and did not

**The claim.** Cost per receipt *falls* with use, because each confirmed match writes an alias and
the next receipt from that merchant resolves it without an LLM call. This is the evolving-mind
thesis in its most measurable form, and it is what makes Checkpoint 1 hold as receipts accumulate
rather than degrade.

**What is proven.** Every part of the machine. Per-item `vectorSearch` on both tables (run 780),
same-language alias matching (14 alias candidates where the cross-lingual binding returned none),
84 aliases persisted as raw receipt strings, and two Execution defects removed on 2026-08-22 that
had been inflating every measurement.

**What is not proven.** That the cost actually falls *because of the aliases*. The engine fixes cut
step 10's per-item input from **831 tokens to 349** between runs 780 and 782, but run 782's four
items were entirely new vocabulary — `auto_matched: 0`, and the run wrote four fresh aliases rather
than consuming any of the 84 already stored. The fall is attributable to the fixes, not to learning.
**Reporting it as AC9 would be attributing a real number to the wrong cause.**

The measurement protocol was pre-registered in git before run 782 precisely so this distinction
could be drawn afterwards rather than argued about. It did its job: caveat 2 — *"an absence of
opportunity, not a failure of the mechanism"* — is exactly what happened.

**What would close it.** One receipt from the same merchant whose items overlap the alias table.
It is a shopping trip, not an engineering task, which is why the sprint closes without it rather
than waiting on it. Carried to Sprint 11 as a standing observation.

**A cost finding that outlived the criterion.** Output tokens are now **48% of a receipt run's
spend** ($0.01252 of $0.02625 on run 782). Input-side optimisation has largely done its work;
neither fix touches output, and the next material cost reduction is not on the input side.

### What the GO rests on

1. **Cost, registered-to-registered.** $1.376 against $1.42, for materially more delivered — a
   workflow, ten intent phrases, two prompts, threshold calibration, domain exploration and a
   design conversation. The baseline's cost per *delivered working* workflow is several multiples
   of $1.42 once 4-surviving-from-98-runs is priced in.
2. **Stability, categorically different in kind.** Two builds, two clean registrations, no
   regeneration loop, against 98 runs for 4 survivors. **n = 2** — stated as two, not as a rate.
3. **Repair, now measured.** AC4 at $0.672, unaided, from a symptom — the defect reached in four
   turns, an invented step type self-corrected against `PGC_StepType`.
4. **The use case runs.** A real grocery receipt in raw Spanish and a real restaurant receipt route
   correctly, from Slack, with no hand-repair between build and run.
5. **Experience.** Not a measured criterion. The user's judgement: materially better than the
   `create_workflow` dialogue.

### What the GO does not claim

- **That cost per receipt falls with use.** AC9 is unmeasured. The mechanism is built and proven;
  the economic claim that rests on it is not. This is the sprint's single largest evidence gap.
- **That the matching is accurate enough to trust unattended.** AC7's calibration clause is unmet
  and the consequence is live bad data: `PANU BOL MIN SELEX` (mini bread rolls) into *Rustic Sliced
  Bread*, `ARANDANOS DESH ALT` (dehydrated) into *Blueberries 300g* (fresh), and on run 782
  `PAN MOLD INT ALTEZ` into *Rustic Sliced Bread* — **which then persisted as an alias**, so the
  error compounds on every future shop. `PGD_Inventory` 25 is a red wine recorded as "Ink
  Cartridge". A correction workflow is Sprint 11 work, not a nicety.
- **That the system is ready for someone who is not the author.** AC13's deciding half is
  unmeasured, and release-readiness has been deferred four sprints running.
- **That stability is a rate.** Two builds is two builds.

### Conditions on the GO

1. ✅ **DONE, one path outstanding — 2026-08-11.** The restart cost is fixed on the `respond`-tool
   path (validated session 1151, ratio 1.00). **A typed follow-up after a *prose* reply still
   forfeits the round's prefix credit**, and a gate resume forfeits it too — measured at 58% of
   session 1161's spend. Backlog, High Priority.
2. ✅ **DONE — 2026-08-16/19/22.** Receipts run end to end; AC7's mechanism and AC8 resolve from
   them. AC9 does not, and is carried.
3. ✅ **DONE — AC4 measured at $0.672** on an uncontaminated specimen.
4. **Release-readiness becomes Sprint 11's opening item**, per the standing decision — deferred
   four times on the grounds that handoff infrastructure is not worth building for a project that
   might be cancelled. **That condition no longer holds: the decision is GO.** Sprint 11 scoping
   placed `/help` and the correction workflow ahead of it by explicit user choice; the deferral is
   now a fifth one and should be recorded as a decision rather than an outcome.

---

## Sprint Close Checklist

- [x] `node --test tests/unit/*.test.mjs` passes — **997 tests, 0 failures** (937 → 981 → 997 across the sprint)
- [x] L0/L1/L2 pass on every workflow built this sprint — **357 v6 and 358 v4 both `passed: true` at level 2** (2026-08-22, standalone `/proc/simulate-workflow`). Remaining issues are advisory `unreferenced_writes` only
- [x] `CLAUDE.md` "Current State" updated
- [x] `docs/architecture.md` updated — `serv_query` `vectorSearch`, the `getRows` projection contract, the `llm_call` user-message contract
- [x] `docs/arch-step-types.md` updated for the `serv_query` contract change
- [x] `docs/arch-data.md` updated — inventory domain schema
- [x] `docs/Javear-use-cases.md` updated — Domain 2 status, and the stale `quiz_flashcards` /
      `study_flashcards` entries corrected against the live workflow list
- [x] `docs/backlog.md` updated
- [x] `docs/sprints/CURRENT.md` → `docs/sprints/sprint-10.md` with outcome notes
- [x] **AC11 — the go/no-go recommendation is written, and every threshold is marked** — **FINAL
      2026-08-22**, recommendation **GO**. See "AC11 — Go / No-Go Recommendation" above.

---

## Outcome

**GO.** Sprint 10 closes with **9 PASS, 2 MARGINAL, 2 NOT MEASURED** across 13 acceptance criteria,
and a written recommendation that development continues with Novia replacing `create_workflow`.

| Checkpoint | Result |
|---|---|
| **1 — Cost of ownership** | **PASS.** ~$21/mo AWS, stable |
| **2 — Cost and stability of workflow creation** | **PASS.** $1.376 build, $0.672 repair, two clean registrations |
| **3 — The receipt use case** | **PASS on its binary threshold** (AC8). The cost half (AC9) is unmeasured and the calibration half (AC7) is marginal |
| **4 — Readiness for someone who is not the author** | **NOT ANSWERED.** Built and dry-run; the deciding half is the friend's judgement |

**The sprint's own thesis, stated honestly:** every part of the alias-learning machine is built and
proven live, and the one number that would show it paying for itself does not exist yet. That is a
gap in evidence, not a negative result — and it is carried to Sprint 11 as an observation rather
than a task, because it resolves on an ordinary shopping trip.

**What this sprint was actually good at, and the retro's main finding:** every significant defect
was found by *running the thing*, not by reading it. Seven engine defects on 2026-08-16, two more on
2026-08-19, and a third on 2026-08-22 that surfaced only because the backlog entry said *re-probe
rather than trust the response shape*. The reviewing eye found almost nothing the running system
did not.


---

## 2C starting kit — SUPERSEDED 2026-08-08

> **Kept as the record, not as instructions.** Its premise — that the prefix-cache miss is caused
> by `buildUserMessage` ordering and the `PGC_Memory` tie — was disproved by the logs and four
> gateway probes (see Sessions 3 and 4). Fixes (ii) and (iii) below would have measured zero. The
> SERV composite `orderBy` blocker it found was real and is fixed (`5f82c8b`); the tiebreaker it
> enables is still worth applying on its own merits, but it is not the cache fix. **Work the
> rescoped 2c above instead.**

### Original text, verified 2026-08-06

Branch `sprint/10-viability-checkpoints` is cut from main and pushed. Start here; nothing below
needs re-deriving.

### The three changes, at their current line numbers

| # | Site | Current state | Change |
|---|---|---|---|
| **(i)** | `minds-eye.mjs:1518` — `assembleContext` | `getRows('PGC_Memory', [], { column: 'priority', direction: 'desc' }, 5)` — no tiebreaker | Add a deterministic secondary key (`id`). **See the blocker below — this is not a one-liner.** |
| **(ii)** | `minds-eye.mjs:1569` — `buildUserMessage` | `parts.push(layer1Context)` `:1572`, layer2 `:1573`, transcript `:1610`, standing instruction `:1619`, notice `:1625`; joined `\n\n---\n\n` at `:1627` | Transcript **first** (it is the append-only part), then the context blocks, then the instruction, then the notice. Turn N's input becomes turn N−1's plus an append. |
| **(iii)** | `minds-eye.mjs:1598-1602` — draft supersession | Rewrites an earlier entry's rendering when a newer array is submitted | Stop rewriting in place. **Lowest priority** — it invalidates only from that entry onward, on submit turns, where (i) and (ii) invalidate everything on every turn. |

### Blocker found while verifying — (i) needs a SERV change first

**SERV supports no secondary sort key at all.** `normalizeOrderBy` (`table.mjs:846`) returns a
single `{ column, direction }`, and `table.mjs:138` validates exactly one column name.

The string form is a **silent trap**: `"priority DESC, id ASC"` splits on whitespace to
`column: "priority"`, `direction: "desc,"` — which fails the `=== 'desc'` test at `:852` and
falls back to **ascending**. It would not error; it would quietly invert the sort and return the
five *lowest*-priority memories.

So (i) is two changes, not one: extend `normalizeOrderBy` and the `orderBy` validation to accept
a composite sort, then use it. **Fault domain: Execution** — a multi-column `ORDER BY` is
standard SQL, which is the extend-not-prompt case exactly. Check `getRows`
(`serv-client.mjs:85`) and `serv_query` (`step-executor.mjs:807`) for pass-through, and whether
`orderBy` appears in any fingerprint component before changing its shape.

### The load-bearing fact, re-verified live today

`PGC_Memory` holds **100 rows**: `{ priority 2: 10, priority 3: 36, priority 5: 19, priority 8: 35 }`.
**35 rows tie at priority 8**, and `LIMIT 5` draws five of those 35 with no tiebreaker — Postgres
guarantees no stable order for ties, so which five return, and in what order, can differ between
identical queries. That block sits near byte zero of `input`, so a reshuffle invalidates the whole
transcript behind it.

### Riding the same deploy

**A5** — `run_sql` table-name guidance into `minds_eye_system_prompt`
(`src/serv/templates/pgc/seeds/seed_PGC_Prompt.json`, then `upsert-prompt.mjs`). Two statements:
use `list_physical_tables` before writing raw SQL, and double-quote CamelCase identifiers
(unquoted, Postgres folds `PGC_WorkflowRunStep` to lowercase → relation does not exist).

### How it gets validated

Deploy (`sam build && sam deploy --no-confirm-changeset`, then the seed upsert), then **one live
Novia round from Slack — the user runs it.** Read the usage logs: `cache_read` should climb past
its pinned 4041 while `cache_creation` flattens. That single round closes **AC1 and AC2**, and
sets up **AC4**. Expected ~12× cut on the creation component; AC1's threshold is ≥ 5×.

No test environment, so this validates against prod — the accepted consequence of the Out of
Scope decision above.

---

## Session Notes

### Session 1 — 2026-08-06 — Scope

Scoped directly from the user's statement of the three checkpoints. Three decisions taken.

**Release-readiness deferred a fourth time**, deliberately. Raised as a candidate fourth
checkpoint on the grounds that the stated goal — soliciting open-source contribution — makes
"can someone other than the author run this?" inseparable from "can this project sustain
itself?". The user's sequencing is coherent and was accepted: handoff infrastructure is not worth
building for a project that may be cancelled. Recorded in Out of Scope with its consequence
named, so the fourth deferral is a decision on the record rather than a pattern.

**Checkpoint 2 split into two measurements.** The user's framing — balancing initial generation
cost against repair and enhancement cost — contains two claims, and Sprint 9's orphaned AC8 is
precisely the repair measurement. It stops being a leftover and becomes half of the central
hypothesis.

**Thresholds fixed before measurement.** Sprint 9's AC9 was *measured*, which is what it asked
for, and the pull was to book it as met and read $2.73 generously. A checkpoint whose passing
grade is set after the score is not a checkpoint.

Two findings from verifying live state rather than reading the docs:

1. **No inventory domain exists.** Checkpoint 3 needs a domain created, not only a workflow.
   `Javear-use-cases.md` is also stale — it lists `quiz_flashcards` and `study_flashcards` as
   working, and neither exists as a `PGC_Workflow` row.
2. **`vectorSearch` is built and unreachable.** Implemented in `table.mjs:143`, exposed via
   `getRows`, and never passed through by `serv_query` (`step-executor.mjs:807`). The hardest-
   sounding part of Checkpoint 3 — lazy name matching — is a pass-through and a contract field
   away, not new machinery. This is what makes the vector-first design affordable enough to
   prefer over UC-P4's per-receipt `llm_call`, which would have charged for every receipt forever
   and contradicted the system's founding principle.

### Session 2 — 2026-08-08 — SERV composite orderBy investigation

**Checkpoint 1 closed on standing evidence.** The user's call: AWS has held at ~$21/month for
months, the variance that matters is Perplexity spend, and that is already measured by
Checkpoints 2 and 3. A Cost Explorer run would have confirmed a stable number at the cost of a
task. AC10 marked PASS, sequencing updated.

**The 2C blocker verified against prod, not inferred.** `orderBy: "priority DESC, id ASC"` on
`PGC_Memory` returned five **priority 2** rows — the lowest — with ids in no order at all. The
composite string form does not error and does not sort: it silently inverts direction and drops
the second key. Any generated workflow writing standard SQL `ORDER BY` today gets quietly wrong
data back.

**The tie problem is 2.6× wider than measured two days ago.** `PGC_Memory` has grown 100 → **270
rows**; `{2: 15, 3: 97, 5: 67, 8: 91}`. **91 rows tie at priority 8**, drawn 5 at a time with no
tiebreaker.

Three things the starting kit did not have:

1. **L0 and the replay fingerprint are both unaffected**, so the shape change is safe. L0's
   contract loop skips non-required fields and checks presence only (`simulation-engine.mjs:134`)
   — `input_contract.type` is descriptive, never enforced. `fingerprint.mjs` hashes `resolvedInput`
   for `llm_call` steps only, and `orderBy` is a `serv_*` input that never appears there.
2. **There are two orderBy render sites, not one.** `entity.mjs:270` (`listEntities`) builds its
   own `ORDER BY` and never calls `normalizeOrderBy` — it reads `orderBy.column` directly at
   `:237`, so a string form fails with `orderBy column "undefined" not found`. Same defect class,
   different symptom, live step type (`serv_entity_list`). The fix is shared, not local to
   `table.mjs`.
3. **Only one of `assembleContext`'s two queries is actually nondeterministic.** `PGC_Workflow` is
   15 rows with unique names under `LIMIT 50`. The `id` tiebreaker goes on both regardless — so it
   rests on a rule rather than on a uniqueness nothing enforces.

**Adjacent finding, not this fix:** `memory-client.mjs:162` retrieves with `LIMIT 500` per scope
and re-sorts in JS on a 3-key comparator, so the `memory` fingerprint component is stable at 270
rows — and stops being stable when a scope passes 500. Backlog.

### Session 4 — 2026-08-08 — The fix exists, on this gateway. 2c rescoped to native tool calling.

Session 3 concluded 2c was not buildable. **That conclusion was wrong**, and the correction came
from a Perplexity multi-turn code sample the user supplied. Two more probes, $0.12.

**The distinguishing variable is the shape of `input`, not the gateway.** Session 3 tested a
string and a hand-built `{role, content}` array; both got credit for the `instructions` block
only. Echoing `response.output` items verbatim — carrying server-assigned `call_id`s — behaves
completely differently:

```
A. turn 1  (string input)          in 16,541   create 16,539   read      0   $0.06311
B. turn 2  (appended item array)   in 26,672   create 10,132   read 16,539   $0.04679
C. repeat of B (byte-identical)    in 26,672   create      0   read 26,671   $0.01162
```

`read` on B equals `create` on A **exactly**. Turn 2's input was 60% larger than turn 1's and
cost 26% less. Canonical items get per-item cache boundaries; a string is one opaque block. Session
3's "per block, all-or-nothing" reading was right about the string path and wrong to generalise.

**Native tool calling also works** for `anthropic/claude-sonnet-4-6` and coexists with
`instructions`: the probe got back `output: ["function_call"]` with `call_id=toolu_01AqHNY...`
and `arguments={"order_id": "ORD-98712"}`, then answered correctly from a `function_call_output`.

**So no provider switch is needed.** The Anthropic-direct option explored earlier in the session
is not required — no second provider, no embedding migration (the stored `pplx-embed-v1-4b`
vectors stay put), no split billing, no new key.

**Estimated at ~4–5× on the creation component**, re-derived from 08-01's 1.44M cache-write
tokens: ~$0.43 read plus ~$0.75 increments against $5.40. The increment figure is the soft one,
which is why AC1's cost threshold is set at ≥4× and its mechanism half is binary.

**One unknown gates the rewrite:** the probe tested a single append, and Anthropic's native API
allows at most four cache breakpoints per request. A 20-turn round may earn credit only for the
last few items. A multi-turn probe comes before step (ii).

Also found while checking blast radius: `ACTION_SCHEMA` is passed at `minds-eye.mjs:514` but
`llm-client.mjs:59` gates `response_format` behind `model.includes('sonar')` — so it has **never
been sent** for Novia. Her output structure is enforced by prompt prose alone. Native tool schemas
fix that as a side effect.

### Session 5 — 2026-08-08 — Step 1 landed; multi-turn credit confirmed and bounded by one rule

**Step 1 is in (`37ca58d`).** `callLlmWithTools` in `llm-client.mjs`, additive — `callLlm`'s
parsed-JSON contract untouched, so no existing caller changes behaviour. `postToGateway` extracted
because the key check, abort ceiling, timeout-vs-transport split and non-2xx handling were
byte-identical in both existing callers and a third copy was the wrong answer; the timeout message
text is deliberately unchanged because `classifyLlmFailure` matches on it. 805 unit tests.

**Two probes, and the first one's design was wrong.** The multi-turn probe injected a fresh user
message every iteration to force tool calls, and `read` stayed pinned at the `instructions` block
across all eight turns — which reads as "the single-append win does not generalise". But that
shape is multi-turn chat, not an agentic loop: Novia receives a user message at the start of a
round and on a gate resume, never between tool round-trips. Re-run in her actual shape, credit held
at 1.00 on every turn.

The wrong probe turned out to be the more valuable one, because the contrast isolated the rule now
recorded in 2c above: **a trailing user message forfeits the round's prefix credit.** Had step (ii)
been written without knowing that, it would have shipped a loop that looked correct, passed
review, and measured nothing — the exact failure mode of the fix this sprint started with.

Probe spend to date across all six probes: **$1.31**.

### Session 6 — 2026-08-08 — 2C deployed, not yet exercised

All three steps are live in prod. `sam build && sam deploy --no-confirm-changeset` succeeded;
`upsert-system-context.mjs` inserted `minds_eye_tool_schemas` (**id 46, 23 tools**) and updated
`minds_eye_system_prompt` **v30 → v31**; `upsert-step-type.mjs` carried `serv_query`'s composite
`orderBy` contract. Verified against the live rows: the prompt is 10,236 chars and none of
`native tool-use formats`, `── READ TOOLS`, `── OUTPUT` or `"action":` survives in it.

**Nothing has run.** Unit tests cover `toInputItems`, `selectToolDefinitions` and
`callLlmWithTools`; the assembled loop has never executed. The next `/novia` round is the
integration test and closes AC1 and AC2 together.

**What to read.** `llm-client: callLlmWithTools response` logs `itemTypes`, `inputTokens`,
`cacheCreation`, `cacheRead` and `cost` for every turn:

```
aws logs tail /aws/lambda/evolving-mind-ai-proc --follow --region us-east-2
```

| Signal | Pass | What failure looks like |
|---|---|---|
| **AC1 mechanism** | `cacheRead` exceeds the instructions+tools block (~7,900) on every turn after the first, and grows with the transcript | `cacheRead` pinned flat — the shape regressed to what three weeks of logs already show |
| **AC1 cost** | `cacheCreation` stays near the per-turn increment rather than tracking `inputTokens` | creation climbing with the transcript |
| **AC2** | no `run_sql` call fails on an identifier | a relation-does-not-exist error |
| Loop health | `itemTypes` is `["function_call"]` most turns | `[]`, or repeated `respond` on turn 1 |

**Rollback**, if the round misbehaves: `git checkout main && sam build && sam deploy
--no-confirm-changeset`, then re-run both upsert scripts from main — the seed rows are the other
half of the deploy and reverting code alone would leave v31 and row 46 in place.


### Session 7 — 2026-08-09 — Two pre-validation fixes; deployed, round still not run

Both found by reading code rather than by a failing run, and both change what the first live
round will measure — so they land before it, not after.

**Batch writes were described inconsistently across four artifacts.** `serv_insert`'s
`PGC_StepType` row claimed the array path "calls `addRows`" — there is no `addRows` in
`serv-client.mjs` and no such case in `table.mjs`; the path is `insertRows` →
`POST /serv/table/insertRow` with a `rows` key. `serv_update`'s row never said it **has no
batch form** (one statement, one set of values applied to every matching row), while
`serv_insert` advertised "one row or a batch" — so assuming a `serv_update` equivalent was a
reasonable read. `serv_db_step_shapes` labelled `serv_insert` "create one row" and showed only
that form. Corrected in `PGC_StepType` (the authority Novia reads — the convention bridge
deliberately delegates step shape to it) and in both `create_workflow`-facing context rows.

**Fault domain Execution, one real bug behind it:** a batch insert builds every VALUES tuple
from the FIRST row's column list and validates only that row's names against the schema. A row
with a different key set cannot fail — a column row 0 lacks is dropped, one row 0 has that it
lacks goes in as null. It succeeds and the data is wrong. `findColumnSetMismatch` rejects it.

**The premise correction worth recording:** `edit_budget` v6 *does* batch — steps 9a and 16 are
`serv_upsert` with row arrays, no iterator. The per-row-write iterators are all in system
workflows (`create_workflow` 20/23g, `create_domain` 22, `fix_workflow` 10/15, `add_entity` 2f),
and `fix_workflow`'s are legitimate: each item needs its own filters.

**A resumed round was throwing away the prefix credit 2c just bought.** `toInputItems`
synthesised `call_id` as `call_<seq>` and rebuilt `arguments` from `params` — which has already
had `reasoning`/`message`/`advisory` stripped out of what the model actually sent. So the
rebuilt array diverged from the cached one at the first tool call, and everything after it was
re-created at 1.25× instead of read at 0.1×: **~$0.12 per resume on a 35k transcript**, against
AC3's $1.50 all-in threshold.

The function's own comment justified this — *"a round always opens with a user message, and a
user message forfeits prefix credit for its turn regardless."* True of the `followup` path.
**False of the two that do not append one** — the continue gate and an approved action gate both
re-enter with the transcript ending on a tool result, the shape that earns full credit. Each
tool entry now persists the raw `items` the gateway returned and they are replayed verbatim;
`items` is additive, so `/explain`, `chat.mjs` and `deriveScope` are unaffected and pre-existing
entries fall back to the synthesised form. Also applied: the `id` tiebreaker on
`assembleContext`'s `PGC_Memory` read — it sits in `instructions`, ahead of the whole transcript,
so a reshuffle between rounds invalidated the entire cached prefix. Both composite sorts verified
deterministic against prod.

**Deployed:** `sam deploy` + `upsert-step-type` (3 updated) + `upsert-system-context` (2 updated),
verified against the live rows. 823 → 839 unit tests.

**AC4 interaction, flagged not decided.** The `serv_insert` contract now states that elements must
be row objects and that an array of bare values is rejected — which is exactly D2's defect
(`import_budget_spreadsheet` step 9). That makes the blind repair easier. Repairing the registry
is still right — Sprint 9's recurring finding is that a wrong registry makes a correct read look
like invention, and a measurement taken against a lying registry measures the registry. But if
AC4 wants the cleaner reading, **use D3 (the frozen generation-time date, untouched by this)**.
`import_budget_spreadsheet` itself was deliberately left broken.

### Session 8 — 2026-08-09 — 2C validated live. AC1 mechanism PASS. Checkpoint 3 opened.

**The native loop ran for the first time, and AC1's mechanism is unambiguous.** Session 1131:

```
turn   in       create   read    read/prev-in   cost
1      7,434    7,432        0       —          $0.0302
2      8,273      840    7,432      1.00        $0.0068
3      8,665      392    8,272      1.00        $0.0059
4     10,197    1,532    8,664      1.00        $0.0284
```

`read` equals the previous turn's entire `in` on every turn after the first; `cacheCreation`
holds at the per-turn increment while the transcript grows. Round cost **$0.071**.

**AC1's cost half is 3.4×, below its own ≥4× threshold — recorded as measured, not rounded up.**
Creation totalled 10,196 against ~34,569 for the old shape. The ratio grows with round length
(old cost quadratic in turns, new linear), so a longer round clears 4×; a four-turn round is
thin evidence either way. **AC2 is not exercised** — no `run_sql` call was made.

**Three defects found by running it, none of which unit tests could have caught.**

1. **Parallel tool calls 400'd the round.** Turn 1 returned TWO `function_call` items; the loop
   echoed both into `input` but `turn.output.find(...)` executed one, so turn 2 sent two calls
   and one result. Pre-existing 2c defect — the loop had never executed. Novia's behaviour was
   *correct*: two independent lookups in one round trip is cheaper than two turns. Fixed by
   dispatching every call, one session entry per call, one turn counted per round trip.
2. **`run_workflow` had no input contract.** She dispatched `create_domain` with
   `{domain, description}`; step 1 reads `input.userInput`; `candidate_domain` became `''`; with
   no request text the design prompts invented **`daily_journaling`** and asked for approval of
   it, table names null (run 762). Neither end errors — an unread key is discarded silently, an
   unsupplied one resolves to undefined. `expectedRunInput` now derives the contract from the
   steps (two patterns: `{{input.x}}` tokens, and `input_key: "input"` + `items.x`), surfaced on
   `read_workflow` and enforced as a pre-dispatch refusal on `run_workflow`.
3. **`create_domain` would invent a domain rather than ask** (v56 → v58). Guard added at 1a/1b/1c
   — and per the user, the gate asks for a **description, not a name**: `input.userInput` feeds
   `research_domain_schema`, and the name is derived downstream. Also fixed the duplicate
   pre-check, which slugified the whole request and compared for equality, so it only ever fired
   when the user typed the bare slug. Now a semantic match against `PGC_DomainHelp` at the
   calibrated 0.40. Verified live: *"track my monthly budget and spending categories"* →
   `budgets_expenses` 0.4756; *"somewhere to keep my recipes"* → `recipes` 0.5445; the inventory
   request → no match, proceeds. The old check missed all three.

**AC5 closed early, all three gaps** — `serv_query` contract + executor pass-through, and
`query_table` for Novia's own probing. Calibration evidence against `PGD_Ingredients` (34 rows,
`name_embedding` live): `"EVOO 32OZ"` → olive oil **0.5155** (next 0.2519); `"ORG TOM DICED 14.5"`
→ diced tomatoes **0.3609** (next 0.1585); a bus-ticket line tops out at 0.2048. **The default
0.75 would have missed every true match** — the "does not transfer" warning made concrete before
it could surface as "lazy matching doesn't work". First consumer shipped the same day:
`create_domain`'s duplicate check.

**Novia's Checkpoint 3 proposal (session 1131) — good surface, one structural gap.** She found
the existing domain and categories, gated before every write, kept the expense path alive for
non-grocery receipts, and answered the Spanish problem *better than the sprint had assumed* —
translate in the parse step so matching happens in one language, rather than betting on
cross-lingual embedding similarity. **But her step 6 is UC-P4**: an `llm_call` per receipt
holding the whole inventory list, which §3b rejects on cost and `architecture.md` §1 forbids.
Passing embeddings into an LLM is inert. **No alias learning at all.** Cause is visible in the
tool trace — four calls, none to `PGC_StepType`, so she never saw the `vectorSearch` contract
and used invented step type names throughout (`db_insert`, `llm`). Sprint 9's AC2 (reads the
registry unprompted) did **not** reproduce this round.

**Earlier the same day, before the round:** batch-write contract corrected across four artifacts
(`serv_insert`'s description named `addRows`, which does not exist; `serv_update` never said it
has no batch form), a silent data-loss bug fixed in SERV (a heterogeneous batch took its column
list from row 0 and null-filled the rest), and the resume path taught to replay the gateway's own
items so a gate resume keeps its prefix credit (~$0.12 per resume at a 35k transcript).

**Open, carried:** AC2 unexercised; AC1 cost needs a longer round; `workflow-schema.json` was
found stale against `PGC_StepType` twice in one commit (`vectorSearch`, composite `orderBy`) —
L0 checks required fields by presence and never rejects an invented one, so the JSON schema is
the only layer that catches a made-up field name and it has to track the contract. Two new
backlog items: session lifecycle (never-closing sessions replay everything and freeze a stale
picture of the registry) and the duplicate `design_table` prompt rows.

**The push-back was run, and she reached the design unaided.** Asked only *"can the item matching
be done without an LLM call on every receipt, and how would this get cheaper the more receipts it
processes?"* — with vector search never mentioned — she returned: pgvector cosine as the primary
matcher, LLM fallback on the sub-threshold residue **batched into one call** rather than per item,
and alias learning as a normalised `InventoryAlias` child table carrying its own
`alias_embedding`, with the match query taking the best score across both embeddings. That is §3b's
design plus two things §3b does not have — the batched residue, and an alias embedding that lets a
Spanish receipt string match an English canonical name without re-translating. She also
self-corrected the inert "pass embeddings to the LLM" step from her first proposal.

**Her one real error is the numbers, and it is the interesting one.** She proposes a confidence
threshold of **0.82**, calibrating down from **0.70**. Measured against `PGD_Ingredients`, true
grocery matches land at **0.36–0.52** — so both figures sit above every true positive and would
read as "vector matching does not work". Her instinct is right (she says explicitly the threshold
should be observed, not guessed) but she guessed the range, and **she still has not read
`PGC_StepType`** — no tool calls at all on that turn — so she does not know `query_table` now takes
`vectorSearch` and could settle it against 34 live rows in one call.

**Session 1131 cost $0.4216 over 26 calls** (matches `minds_eye_turn_count` exactly), **$0.0162 per
turn** against Sprint 9 session 1121's $0.0598 — **3.7× cheaper per turn**, a better read on 2c's
cost half than the 3.4× off a single four-turn round. Two full proposals, domain exploration, a
triggered workflow and a redesign for $0.42, against AC3's $1.50 for a build.

**`turn_limit` 12 → 30** (preferences row, live). 2c inverted which budget binds: the turn-limit
round did 12 turns in **54 seconds** against a 195s budget, stopping with 72% of its wall clock
unspent and without answering. Wall clock should bind now — watch for `round budget reached` in
the logs to confirm.

**Next session:** create the inventory domain via `create_domain` v58 — its guard and semantic
duplicate check are unexercised — then Novia builds the receipt workflow. Do **not** hand her the
threshold: tell her it is an empirical question she can settle herself and that `PGD_Ingredients`
has 34 rows with live embeddings. Whether she reaches for `query_table` + `vectorSearch` closes
both the calibration question and the registry-reading gap in one move; if she asks for the
numbers instead, that is a finding too.

### Session 9 — 2026-08-10 — Run 763: my own fix broke `create_domain`. Inventory domain live, AC6 not met.

**Run 763 died at step 2 on `getRows failed: text.trim is not a function`, and I introduced it**
in `6babf17` the day before. v57 declared `output_key: "domain_request,candidate_domain"` over an
object-returning expression; deleting `candidate_domain` left one key and the object return, and
the engine destructures an object only when the comma list names more than one key. So
`local_state.domain_request` held `{ domain_request: "inventory" }`, and step 2's
`vectorSearch.queryText` was an object where SERV embeds plain text.

**The undetected half was worse than the failure.** Step 1a — the v57 guard that refuses to invent
a domain when none was described — is a `condition` on `{{domain_request}}`, and an object renders
as a non-empty string, so it passes every falsy test at `step-executor.mjs:1673-1678`. With empty
input the guard routed to step 2 instead of the gate. Run 763 cleared it only because a request
was supplied. **The guard remains unexercised** — worth one deliberate empty-input run.

**`fix_workflow` is not at fault and needs no change.** `TROUBLESHOOT_WORKFLOW` fired
automatically 3s after the failure and reported `passed: true, issueCount: 0` over all 46 steps at
L2 with contracts loaded. The repair layer worked; nothing had asked the right question.

**Simulation reproduced the defect exactly and then didn't look at it.** The L2b smoke test writes
each `js_transform`'s real computed output into `mockState`, so at step 2 it held
`{ domain_request: "" }` — the bug, faithfully modelled. `STEP_INPUT_CONTRACTS` declared one field
for `serv_query`: `filters`. AC5 added `vectorSearch` to the `input_contract`, the executor
pass-through and `workflow-schema.json` and missed this fourth artifact — the third sprint running
in which a correct read looked like invention because the registry was incomplete.

Five fixes, `cd55ba1` and `af1dc62`, both deployed:

| # | Fix | Fault domain |
|---|---|---|
| 1 | Steps 1 and 1c return the trimmed string itself (v58 → **v59**) | Contract (artifact) |
| 2 | `vectorSearch` validator on `serv_query` — **types only, never emptiness**: SERV embeds `queryText` as plain text so a non-string is a design defect, while an empty string is what every correct workflow resolves to under mock input | Validation |
| 3 | `resolveOutputWrites` (`state-utils.mjs`) — one `output_key` rule for engine and simulator | Validation |
| 4 | `queryText`'s type stated at the SERV boundary, beside the presence check already there | Contract (SERV) |
| 5 | A comma list over a scalar, null or array now **throws** instead of writing a key literally named `"a,b"` | Execution |

Verified rather than asserted: against the real 46-step array the v58 form now fails with
`queryText must be a string ... got {"domain_request":""}` and the repaired form passes clean;
all 15 seed workflows swept against a stashed baseline with **no new failures** (the three
pre-existing FAILs unchanged). `create_domain` dropped 5 issues → 3, both losses false positives
the old propagation created: step 16d declares `sorted_tables,ddl_items` and the simulator handed
the whole object to each key, making 16k's `tables.concat` and 17's `items_key` look broken.
839 → **895 unit tests**.

**Fix 5's siting mattered more than the throw.** The `output_key` write sits after the audit row is
stamped `completed` and outside the `try` wrapping `executeStep`, so throwing there would have
escaped unhandled — no audit, no run status, no `TROUBLESHOOT_WORKFLOW`. Writes are resolved
inside the `try` and applied at the original site, so the `llm_break` early return still precedes
any `local_state` mutation.

**Residual, deliberate:** the simulator's mock branch for non-`js_transform` steps does not route
through `resolveOutputWrites`, so a comma list on a `serv_query` is caught at runtime rather than
at registration. Routing it would make every `llm_call` with a comma list write nothing into mock
state, and the false-positive unresolved-token findings would cost more than the gap.

#### Inventory domain created — AC6 evidence

`create_domain` v59 produced `PGD_Items` and `PGD_ItemLocations`, plus `PGC_EntitySchema` rows 44
(`Item`) and 45 (`Itemlocation`). Run 764: 54 steps, 5m 01s, **completed**.

**Cost to create the domain: $0.1054**, five live LLM calls across both runs.

| Run | Step | Prompt | Model | Cost |
|---|---|---|---|---|
| 763 (failed) | — | — | — | **$0.0000** |
| 764 | 5 | `research_domain_schema` | `claude-haiku-4-5` | $0.01215 |
| 764 | 10 | `create_domain` | `claude-sonnet-4-5` | $0.03707 |
| 764 | 10 (retry) | `create_domain` **correction, 11 validation errors** | `claude-sonnet-4-5` | $0.03967 |
| 764 | 16g | `propose_domain_view` | `claude-sonnet-4-5` | $0.01630 |
| 764 | 17b | `generate_domain_aliases` | `perplexity/sonar` | $0.00024 |
| | | | **Total** | **$0.10543** |

Two things this says. **The failed run was free** — it died at step 2 and the first `llm_call` is
step 5, so the defect cost a restart, not money. And **the single most expensive call in the run
was the retry**: `review-output` rejected `create_domain`'s first response with 11 errors, and
correcting it cost $0.03967 — more than the call it was correcting, and **38% of the domain's
whole price**.

#### The 11 errors, and why observation 3 below is downstream of one of them

Attempt 1 produced **one** table, `PGD_Items`, 13 columns, 10 carrying a `description` key.

| Count | Ajv error | Cause |
|---|---|---|
| 1 | `/tables must NOT have fewer than 2 items` | active schema (prompt id 17 v28) sets `minItems: 2` on `tables` |
| 10 | `must NOT have additional properties` | 10 columns carried `description`; the column sub-schema is `additionalProperties: false` |

**The ten are a template mismatch.** The prompt's exact-shape block puts `description` on the
*table* object and shows only `id`, `created_at`, `updated_at` as columns — structural columns
nobody annotates. The model generalised table → column, which is a fair read of a fill-in-the-blank
that never shows a described domain column and never says the key set is closed. Fault domain
**Contract**: allow `description` on columns, or show one domain column with its permitted keys.

**The one is why `item_count` and `level` exist.** Attempt 1 was a coherent single-table inventory
design. The schema rejected it on cardinality alone, and the model's repair was to invent
`PGD_ItemLocations` — carrying both derived columns and their check constraints. **The second table
was manufactured to satisfy a rule, not designed.** `minItems: 2` also reads as a rule from one
specimen: flashcards, recipes and budgets are naturally multi-table; an inventory is not. It cost
the retry *and* the two columns AC6's threshold rejects.

**Fixed the same day — the table count is now a suggestion, not a rule.** `minItems: 2` removed
from `tables` in **both** `create_domain` (v28 → **v29**) and `revise_domain_schema` (v14 → **v15**);
`maxItems: 10` kept. Changing only `create_domain` would have left an asymmetry where a one-table
domain can be created but never revised. The guidance moved into the prompt as advice that states
the failure mode rather than a count: *"Table count follows the domain, not a target … never add a
table to reach a count — a table invented to satisfy a number arrives with nothing to hold and no
workflow maintaining it."* A schema can only say "add a table"; it can never say "reconsider",
which is why this rule could not live there. `minItems: 3` on `columns` is untouched and stays a
rule — it encodes the mandatory `id`/`created_at`/`updated_at` trio, not a design opinion.
Deployed via `upsert-prompt.mjs`; verified on the live rows.

**The correction prompt names the location but not the property.** `llm-client.mjs:347` renders
`- [/tables/0/columns/3] must NOT have additional properties`. Ajv supplies the offending key in
`params.additionalProperty`, and `review-output.mjs:208-214` **preserves `params`** — it is simply
never rendered. The model inferred `description` correctly, but that is inference, not instruction.
One line makes it deterministic.

**Note for anyone reading the session record instead of the code:** `PGC_SessionEntry`'s copy of the
correction prompt is **lossy** — `llm-harness.mjs:529` renders `- ${e.message}` and drops the
location `llm-client.mjs:347` actually sent. The diagnostic replica understates what the model was
told.

Three `PGC_Prompt` rows share `intent_category: create_domain` (ids 1, 5, 17). Untidy, but not a
tie — selection is `version DESC LIMIT 1`, so id 17 v28 wins deterministically.

Embedding spend is **not included and not measured** — `embed-client` logs no cost line, in PROC
or SERV. At this volume (a handful of strings) it is immaterial, but the total above is LLM calls
only.

#### Rebuilt after the fix — run 766, and AC6 MET

The user dropped the domain (`delete-domain`, 11:38) and re-ran. **Run 766 produced one table.**

```
PGD_Inventory (12): id, created_at, updated_at, name, name_embedding, category,
                    quantity, units, location, status, date_acquired, expiry_date
```

Registered, queryable, `PGC_EntitySchema` id 46 with no joins. **`item_count` and `level` went with
the invented table, so AC6's threshold — no unmaintained denormalized columns — is met.** The rest
of the delta against run 764 is generation variance, not loss: `unit`→`units`,
`purchase_date`→`date_acquired`, `notes` dropped, defaults on `category` gone.

**A column ceiling was suspected and does not exist.** `columns` carries `minItems: 3` and no
`maxItems` — a floor cannot drop a column, and both columns thought missing (`units`,
`expiry_date`) are present.

**Naming drift, second specimen:** run 764 produced `PGD_Items`, run 766 `PGD_Inventory` — singular
and domain-named, against `PGD_Recipes`/`PGD_Cards`/`PGD_Expenses` everywhere else. Feeds the domain
validator backlog item.

**Enum inconsistency — CLOSED as a decision, not a defect.** The user's call: the domain was
specified for **domestic** use, and controlled vocabularies read as a professional-inventory
requirement. Accepted; no change. Recorded with one caveat for whoever meets it next — `status` got
a CHECK in *both* runs while `units` and `category` got none in either, so the split is more likely
arbitrary than driven by the use-case selection. Relevant only if receipt matching later surfaces
`pcs`/`pieces` variants, at which point the cause will not be the setting.

Three observations on the schema from the first attempt (run 764), retained as the evidence trail:

**1. Enums are inconsistent, not absent.** `status` got
`chk_items_status: status IN ('new','good','damaged','expired','unusable')`. `unit` (default
`'pieces'`) and `category` (default `'Uncategorized'`) are bare text with no constraint — one of
three enum-shaped columns constrained. The consequence is not only typing: system workflows render
enum-driven form fields deterministically off `PGC_Schema.constraints`, so `status` presents as a
dropdown and the other two as free text. **The two want different answers**, which is what makes
identical treatment the defect: `unit` is a closed set where free text invites
`pcs`/`pieces`/`piece` and quietly breaks quantity aggregation, while `category` is open-ended and
probably should not be a text column at all — `budgets_expenses` models the same idea as
`PGD_SpendingCategories` + `category_id`. Fault domain **Contract**, at `design_table`.

**2. `parent_id`'s FK was designed and then lost in registration.** *(Corrected later the same
session — the first reading, that generation omits FKs, was wrong.)* `create_domain` emitted it:
`{"name":"fk_itemlocations_parent","column":"parent_id","references":{"table":"PGD_ItemLocations","column":"id"},"onDelete":"CASCADE"}`.
`PGC_Schema.constraints` for that table holds one unique and two checks and **no FK** — and none
exists for `budgets_expenses` either, whose `category_id` appears on three tables. So the loss is
in registration, not in generation: the **registry asserts less than the database**, the Sprint 9
invariant inverted. Whether the physical constraint exists is **unverified** — there is no route
to `pg_constraint` through the SERV API. The hierarchy is reachable regardless, because
`PGC_EntitySchema` id 45 declares the self-join explicitly:
`{"type":"LEFT","table":"PGD_ItemLocations","alias":"itemlocations","on":"itemlocations.parent_id = r.id"}`.
On the name, there is a real tension rather than a defect: the convention elsewhere is
FK-names-the-target (`category_id` → `PGD_SpendingCategories`), which for a self-reference gives
`item_location_id` and reads worse. **Before renaming, establish whether reference-table FK
resolution infers the target table from the column name** — if it does, `parent_id` is
unresolvable and that join is the only thing carrying it.

**3. AC6 is not met, on its own written threshold.** `PGD_ItemLocations.item_count integer
default 0` (with `chk_itemlocations_count`) is `card_count` again — the §3a hazard, and AC6 reads
*"Domain live, no unmaintained denormalized columns"*. Nothing increments it; it will read 0
forever while items accumulate. `level integer default 0` is the same shape, derivable by walking
`parent_id`. The recorded sequencing decision — *do not denormalize first; at household scale a
count can be a `COUNT(*)` or a view* — is unapplied, and `PGC_Schema.type` / `select_sql` /
`createView` already exist for it. **Settle this before Checkpoint 3 builds on the schema**, or the
sprint's test vehicle runs on a domain with two lying columns.

### Session 10 — 2026-08-10 — Novia calibrates the threshold herself, and reads a workflow for its shape

Session 1131 continued into the receipt build. Turn count 36, action count 0 — nothing written yet.

**She settled the calibration empirically, unprompted, and in both languages.** Eight
`query_table` + `vectorSearch` probes against `PGD_Ingredients` (entries 22–29), then `write_memory`
(entry 30) so it is not re-derived next session:

| Score | Case |
|---|---|
| 1.00 | exact English (`broccoli`) |
| 0.68 | English near-synonym with qualifier |
| 0.60 | Spanish clean food name → English (`sal de mar` → sea salt) |
| 0.49 | Spanish ground-form with qualifier; 2nd place 0.39 |
| 0.47 | Spanish + label noise (`BROCOLI ORGANICO 500G`) |
| 0.38 | Spanish near-synonym + noise — she flags this "dangerously low" |
| ≤0.29 | unresolvable — **`zanahorias` tops out at 0.20 with the wrong item first** |
| 0.21 | ceiling for genuinely unrelated items |

Better evidence than the 0.36–0.52 band this sprint recorded, because it finds the **failure** case:
cross-lingual similarity collapses on `zanahorias`. That is the data justifying her own earlier
design call to translate in the parse step rather than bet on cross-lingual embedding distance —
she now has the numbers for a decision she had already reasoned to. **AC7's calibration task is
answered, by her.** The registry-reading gap from the previous round is closed in the same
stretch: `workflow_convention_bridge` plus four passes over `PGC_StepType` (entries 37–41).

**The archetype came from an artifact, not a registry.** Entry 44 is `read_workflow` on
`import_budget_spreadsheet`, immediately before submitting 24 steps to `simulate_workflow`. **This
is the evidence the parked archetype-registry item was waiting for, and it points away from
building one:** the Out of Scope note said revisit *"if a Checkpoint 3 build shows Novia reinventing
a procedure she has already written"* — she did the opposite, and a live workflow cannot go stale
against itself the way a curated registry would.

**Simulation refused the draft, correctly** — 24 steps, 3 issues, all L0 shape: `human_gate` steps 1
and 4 missing the required `on_cancel`. Caught before registration.

**The round budget is confirmed working, and this is the first time it has been exercised.**

```
proc/minds-eye: round budget reached — ending round
  turnsThisRound: 3   elapsedMs: 184,410   longestTurnMs: 102,977   budgetMs: 195,000
```

Three turns, 184s of 195s, longest turn 103s; `turn_limit: 30` never in play. Session 8 raised the
turn limit precisely so wall clock would bind, and it does. **What matters is the manner:** Sprint
9's AC6 failure was a *silent* death — Lambda hit 240s mid-turn, nothing caught it, no notification,
no session write, the work gone and the SQS message already deleted. Here the guard saw another
103s turn would not fit, ended the round, posted the continue gate, and the user resumed. The
carried AC6 round-budget item is **closed**. Cost note for AC3: at ~61s per turn a round buys three
turns, so a 24-step build is several continues — cheap, since the Session 7 resume fix preserves
prefix credit on each, but interactive rather than unattended.

#### `process_receipt` registered — workflow 358, and it is UC-P4

24 steps, v1, domain `inventory`, 10 `PGC_IntentMap` phrases. Passed L0+L1+L2 —
`register_workflow` refuses anything that does not.

**What is right.** One entry point serving both receipt kinds (step 6 branches on `is_grocery`;
the expense write at step 5 runs for every receipt, so the non-grocery path stays alive) — that is
AC8's actual requirement. Two gates before any write (step 4 reviews the reconstructed receipt,
step 11 the match plan). Quantity increments read-then-write through 12a→12b→12c rather than
trusting a counter — **she did not reproduce the `item_count` hazard**. Every batch insert guarded
against an empty array (12d, 12g, 12i); writes batched, not per-row iterators. Alias rows written
at 12j.

**Two defects, and the second is the sprint's central design decision.**

**(1) It cannot run.** `parse_receipt` and `match_inventory_items` both return **zero rows** from
`PGC_Prompt`. Step 3 dies with `prompt not found`. `register_workflow` validated shape, routing and
data flow and never checked that the prompts its `llm_call` steps name exist. By AC3's own rule —
*a build that registers but does not run is a FAIL at any price* — this is not delivered. Raised as
a backlog item (Validation).

**(2) Zero `vectorSearch`. Zero embedding references. In 24 steps.**

```
step 7:  serv_query PGD_InventoryAlias  limit 500  -> inventory_aliases
step 8:  serv_query PGD_Inventory       limit 500  -> inventory_items
step 10: llm_call match_inventory_items   receives both, whole
```

Every receipt ships the entire inventory and the entire alias list to an LLM. **Cost per receipt
grows with inventory size, and aliases make the payload bigger rather than the matching cheaper** —
the exact inverse of §3b, where cost per receipt falls with use, and a direct contradiction of
`architecture.md` §1. **AC7 is not met by this workflow.**

The sharp part is not that she reached for an LLM. It is that `PGD_Inventory.name_embedding` and
`PGD_InventoryAlias.alias_name_embedding` both exist, the `serv_query` contract now exposes
`vectorSearch`, and **she derived the calibration bands for precisely this two turns earlier in the
same session and wrote them to memory.** Mechanism, columns and numbers all present; the artifact
uses none of them. Session 8's push-back produced the correct design unaided once already — so the
question to re-ask is the same one, without supplying the answer: *can the item matching be done
without an LLM call on every receipt?* Whether she connects her own numbers to her own design is a
capability signal worth having, and it is cheap.

#### Cost — session 1131 benchmark

| Round | Turns | Window | Start | Cost |
|---|---|---|---|---|
| A | 10 | 12:45:34–12:46:39 | cold, 22,295 | $0.24870 |
| B | 3 | 12:59:59–13:02:57 | cold, 37,997 | $0.34999 |
| C | 1 | 13:04:39 | **warm**, read 45,431 | $0.11057 |
| D | 2 | 13:06:14–13:06:26 | cold, 56,244 | $0.24521 |
| | **16** | | | **$0.95447** |

Plus **$0.4216** recorded for the 08-09 portion → **session all-in ≈ $1.376**, against the $1.42
`create_workflow` paid build and Sprint 9's $2.73. *Accounting caveat:* `minds_eye_turn_count`
reads 36 while 26 recorded + 16 measured = 42; today's 16 come straight from `callLlmWithTools`
log lines, so the gap is in turn persistence, not in the money.

**Within a round the 2c mechanism is flawless** — `cacheRead` equals the previous turn's entire
`inputTokens` on every turn, holding at 56k; round A's nine follow-on turns cost $0.162 combined.
**All the cost is in cold starts: $0.451 across three turns, 47% of the day.**

**And a clean natural experiment isolates why.** Rounds C and D both resumed after a **95-second**
gap; C read 45,431 tokens, D read **zero**. Same gap, opposite outcome — so this is not cache TTL.
The difference is what the resume carried: a bare continue keeps the prefix, while a resume where
the user types a reply (entry 43, *"I approve with the following…"*) appends a user message, and
the recorded rule is that **one trailing user message forfeits the round's whole prefix credit**.
Expected behaviour, now priced: **$0.219 for that single turn, scaling with transcript length.**
Worth knowing before AC3 — a build steered by typed replies costs materially more than one steered
by button clicks, and neither the rule nor the price was visible until now.

**Read the $1.376 carefully: it is inside AC3's PASS band and it is not AC3.** Not clean-room
(design conversation, schema walkthrough and calibration all preceded it), and the workflow does
not run. As an **AC8** data point: encouraging on price, incomplete on delivery.

#### The two prompts, and why the missing rows were not her fault

`parse_receipt` (id 126) and `match_inventory_items` (id 127) now exist, v1, scoped
`domain: inventory`, `workflow_name: process_receipt`. **Craft is good**: `input_variables`
declared with descriptions, `output_schema` complete and matching the JSON the prompt text asks
for, and **every `{{token}}` the prompt declares is supplied by the calling step** — which is
precisely the failure class sitting in the backlog unfixed.

**Her diagnosis of the gap was accurate, and understated the system's share.** She reported it as
*"primarily a system gap, but I should have caught it"*. Verified against the live
`PGC_StepType.llm_call` contract, it is very nearly all system. Two optional fields are declared
there: `prompt_category` (*"snake_case slug for a domain-specific prompt not yet in PGC_Prompt"*)
and `prompt_draft` (*"Full prompt text… **Consumed by `design_workflow_prompts` to insert a new
`PGC_Prompt` row**"*). **She supplied both, on both `llm_call` steps** — 1,383 and 1,544 characters
of draft, still sitting in workflow 358. She read the registry and did what it says.
`design_workflow_prompts` is a `create_workflow`-family step and `register_workflow` bypasses
`create_workflow` entirely, so on her path the declared consumer does not exist — and
`create_workflow` is retired by this sprint's direction, so that consumer is on a path we tell
people not to run. **Same shape as `create_domain`'s derived-field rules with no consumer, and the
fourth instance of "a correct registry read produces a wrong outcome when the registry describes
machinery that is not there."** Backlog item revised accordingly: the fix is for
`register_workflow` to *consume* `prompt_draft` first, and refuse only when no draft was supplied.

**Three defects in what she wrote.**

**(1) D3 reproduced, in a fresh build.** Step 3 carries `"current_date": "Monday, August 10, 2026"`
— a literal, frozen at generation time — and `parse_receipt` uses it as the fallback for a missing
purchase date. Every receipt processed after today gets filed to 10 August 2026. **This is the
exact defect class AC4's D3 specimen tests**, reproduced independently, which says the fault is
habitual rather than particular to `import_budget_spreadsheet`. It also means AC4 on D3 measures
whether she can find a bug she writes by reflex — worth knowing before reading that result.

**(2) The output shape mimics the architecture it does not implement.** The prompt returns
`auto_matched` / `llm_resolved` / `new_items`, and `auto_matched` carries `confidence: "HIGH"`.
That tiering implies one path resolved without an LLM. **Both tiers come from the same LLM call,
and the confidence is the model's self-report.** A reviewer reading the gate will see
"auto-matched: 12 items" and conclude the cheap deterministic path ran. UC-P4 is not merely
expensive here — it is now *disguised*, which is worse, because the gate makes it look like §3b
was implemented.

**(3) `max_output_tokens` is null** on `match_inventory_items`, whose output is three arrays
covering every line of a receipt. A long grocery receipt relies on the default ceiling holding.

**D2 is now unusable for AC4.** She read `import_budget_spreadsheet`'s full step array in this
session, and D2 (bare category names into a `serv_insert`) is in it. Session 7 already preferred
D3 because the `serv_insert` contract fix had made D2 easier; this settles it — "reached the defect
unaided" is no longer measurable on a workflow she has just read. **Use D3.**

### Session 11 — 2026-08-10 — Checkpoint 2: the user's verdict

**The user's call, recorded as taken: Checkpoint 2's cost and stability objectives are met, and
Novia is the way forward.** The reasoning, and the one correction it makes to this document.

**Compare registered-to-registered.** AC3 was written as *registered **and running***, but the
$1.42 it compares against is a *registered* `create_workflow` build — and `create_workflow`'s
output has needed repair as a matter of course. Holding Novia to "running" against a baseline of
"registered" was an asymmetry in the criterion, not a standard. **This is a correction to AC3's
framing, not a threshold relaxed after seeing the result** — the distinction matters because
Session 1 fixed these thresholds precisely to prevent the latter.

| | Cost | Delivered |
|---|---|---|
| `create_workflow` (run 729) | $1.42 | one registered workflow; **4 survived from 98 runs** |
| Novia (session 1131) | **$1.376** | registered workflow + 10 intent phrases + 2 prompts + threshold calibration + domain exploration + design dialogue |

Marginally cheaper for materially more, and the baseline's cost *per delivered working workflow* is
several multiples of $1.42 once 4-from-98 is priced in. **2a: PASS** on the ≤$1.50 band.

**Experience is not a measured criterion and is the user's to judge:** "100% better via Novia".

**Adaptation, as evidence.** `read_workflow` used as an archetype rather than reinventing shape;
the alias and category tables identified as missing and added; thresholds calibrated unprompted and
written to memory; the inert "pass embeddings to the LLM" step self-corrected in session 8. And the
cross-domain build is architecturally exact, not merely convenient: `create_domain`'s own prompt
says *"Cross-domain relationships are managed at the workflow level, not the DB level"*, and
workflow 358 — registered under `inventory` — queries `PGD_SpendingCategories`, writes
`PGD_Expenses`, then writes three inventory tables, with **no cross-domain FK and no schema
coupling**. She met the stated rule without being pointed at it.

**Restart cost is the acknowledged remaining work, and it is precisely identified** — not
cold-start, not TTL. Rounds C and D resumed 95 seconds apart and one read 45,431 tokens while the
other read zero. It is the typed-reply forfeit: $0.219 at a 56k transcript, growing linearly. A
scoped, contained fix in `minds-eye.mjs`, not a property of the approach.

**Two qualifications recorded alongside the verdict, not against it.**

1. **n = 2.** Stability rests on `edit_budget` (357) and `process_receipt` (358) — both L0/L1/L2
   clean, both registered first time, no regeneration loop. Categorically unlike 98 runs, and still
   two. The record should say two rather than imply a rate.
2. **2b has no number.** AC4 was never run. The repair claim can reasonably be judged on observed
   behaviour — she diagnosed her own inert-embedding step, and her `prompt_draft` account was
   accurate against the live contract — but that is qualitative. **AC11 should mark AC4
   "not measured", not fold it into a PASS.**

### Session 12 — 2026-08-10 — Hardcoded dates: the contract caused them. Deployed.

**The user rejected the first framing and was right to.** "She did not know `new Date()` exists" is
not an explanation — that is programming 101. The question they asked instead is the useful one:
*what intrinsics and standard libraries are actually permitted?* Measured through the real gate:

| | |
|---|---|
| **Available** | the entire ECMAScript standard library — `Date` (`new Date()`, `Date.now()`), `Math`, `JSON`, `RegExp`, `Map`, `Set`, `Intl`, `Promise` as a value, `parseFloat`, `parseInt` |
| **Blocked** (AST denylist) | `require`, `eval`, `fetch`, `XMLHttpRequest`, `Function`/`new Function`; member access on `process`, `global`, `__dirname`, `__filename`; `import`, `await`, `async` |

**`PGC_StepType.js_transform` described this as a *"pure* synchronous JS IIFE… 200ms timeout"** —
wrong on all three counts: the engine allows 500ms, deliberately puts `Date` in the sandbox, and
the environment is not pure. **That word is why the dates were hardcoded.** An author who takes
"pure" seriously will not call `Date.now()`, concludes the current date must arrive from outside
the transform, and passes it in as a step input — where the only thing to put is a literal.
**Her reasoning was correct and the contract's was wrong.** Fault domain **Contract**, not
Instruction and certainly not Generation.

**Shipped and deployed:** contract corrected and upserted (verified on the live row); advisory L1
`frozen_date_literal` check, which walks a step input at any depth, skips strings carrying
`{{tokens}}`, and names the run-time route. **Warning, not failure** — a literal date is legitimate
when the workflow means that specific date, and no static check separates the two.

**L1 gained a severity concept to carry it.** Every L1 issue was hard by construction and
`staticIssues.length > 0` returned early, so an advisory finding would have blocked registration
*and* suppressed Levels 2a/2b. No pre-existing L1 issue sets `severity`, so the hard-issue filter
is provably a no-op for all of them; warnings now reach `static_analysis.issues` on the passing
paths, which previously hardcoded `[]`. All 15 seed workflows sweep identical to baseline — no
false positives on real specimens. 895 → **901** unit tests.

**Backlog, the open half:** the sandbox object
`{ JSON, Math, Array, Object, String, Number, Boolean, Date }` reads as an allowlist and is not one
— `vm.runInNewContext` supplies every intrinsic regardless, which is why `parseFloat` works while
absent from it, and the contract itself tells authors to use `parseFloat`. Three questions to
settle: whether a denylist is the intended model, whether to delete the decorative sandbox object
or make it real, and a stated position on `Date.now()`/`Math.random()` making `js_transform`
non-deterministic.

### Session 13 — 2026-08-11 — Typed-reply fix validated live; Checkpoint 4 built and dry-run

**GO Condition 1 is met on the path that matters, and the round found the path that is still
open.** Session 1151, three turns, **$0.079**:

```
turn   in       create   read    read/prev-in   cost
1      8,672    8,670        0       —          $0.03384
2      9,788    1,117    8,670      1.00        $0.02095   -> responded
   (typed follow-up: "Can you translate your proposal to Spanish")
3     10,759      971    9,787      1.00        $0.02429
```

Turn 3 is the measurement: a **typed** reply, and the prefix held at 1.00 where the forfeit would
have pinned `read` to the instructions+tools block. Only 971 tokens were created for a turn whose
input had grown by ~1,000.

**The gap, found by running it rather than by reading code.** Turn 3 returned
`itemTypes: ['message']` — she answered in prose without calling `respond` — so the loop stored
the entry with `entryItems = []`. Verified against the live session: **seq 3 carries 1 item, seq 5
carries 0.** The fix keys off those items, so a typed follow-up *after a prose reply* still
forfeits. `toInputItems` cannot recover it from persisted state; the `respond` call has to be
synthesised at the point the prose reply is stored. Backlog.

**Also shipped, in order:** the `followup` fix (`b982c99`); six capability and scheduling tools,
gated and honestly stubbed (`1caca50`); `PGC_Capability`'s five external columns deployed live via
`addColumn`/`modifyConstraint`/`updateTable` (`d8f3df1`); Finnhub registered as three `planned`
rows with a new `seed_PGC_Capability.json` wired into bootstrap (`71200f8`). 901 → **920** unit
tests.

**The bootstrap trap, recorded because it nearly cost the invariant.** `createTableFromTemplate`
issues `CREATE TABLE IF NOT EXISTS` and cannot add a column to an existing table, while
`seedPGCSchema` upserts unconditionally — so `POST /serv/bootstrap` would have made `PGC_Schema`
assert five columns the database lacks. Applied through the schema routes instead, which move both
sides in one call, and verified against `information_schema.columns`.

#### The dry run — AC13's rehearsal, and one statement that must not reach the friend

**What worked, and some of it is behaviour three sprints have been chasing.** She called
`list_capabilities` **first, unprompted, before designing anything** — the registry-reading
behaviour that failed to reproduce in Session 8. She read the Finnhub rows and generalised the
pattern correctly to "your devices need the same registrations", naming real targets (Home
Assistant, Hue, Ecobee, Nest). She flagged the stub herself: *"Capability registration is currently
stubbed — `call_capability` is not yet fully live for external network calls."* She closed by
asking which platform the user owns rather than assuming one. Asked to translate, she produced
fluent Spanish with every table and technical term intact — which matters, because the friend
speaks only Spanish.

**The defect: she asserted that scheduling works.** Her caveat covers `call_capability` and then
says *"the automation logic and data layer can be fully built today; the live device triggers would
activate once that is enabled"* — while listing "workflows that trigger every 30 min" as buildable.
There is no scheduler at all. **Cause is visible in the trace: she never called `list_schedules`**,
made one tool call in the whole round, and generalised "capabilities are stubbed" into "everything
else is fine." `schedule_workflow`'s description does say NOT YET IMPLEMENTED, so this is weighting,
not absence of information.

**Read the round for what it is.** Three turns, one tool call, no `PGC_StepType` read, no steps
drafted, nothing simulated — against Session 10, where she read an archetype workflow, calibrated
thresholds against live data and submitted 24 steps. This was a good *sales* answer, not a design.
AC13's "feasible" half is supported; the "convinced" half is untested until the friend sees it, and
**it should not be shown carrying the scheduling claim** — that is the one statement he could later
discover was false, which costs more than the gap it conceals.

#### Scheduling built for real — AC12 extended, and the stub retired the same day

Session 1151's defect (she asserted scheduling worked when it did not) had two possible
answers: make her say it is unbuilt, or build it. The user chose build, on the grounds that the
friend's use case *is* periodic home checks — a demo whose central mechanism is stubbed is
materially weaker than one that fires.

**Amazon EventBridge Scheduler, targeting the queue that already exists.** A schedule can only
deliver a *static* payload, but starting a workflow needs a `PGC_WorkflowRun` row that does not
exist until it fires — so the schedule sends a `SCHEDULED_RUN` message to `SYSSQSWorkflow` and
PROC creates the run. That is `architecture.md` §3.2's **Category 1 verbatim** (a
fire-and-forget entry message carrying no `workflowRunId`), so scheduling adds **no new
execution path** and the Step Processor cannot distinguish a scheduled run from a Slack one.

| Piece | Note |
|---|---|
| `shared/scheduler-client.mjs` | Only `@aws-sdk/client-scheduler` import — PROC is cloud-agnostic by rule, same isolation `sqs-callback.mjs` gives SQS |
| `proc/scheduled-run.mjs` | `callback: null`, because nobody is waiting. Refuses an orphaned schedule loudly rather than retrying forever |
| `schedule_workflow` | Refuses a workflow that is not registered; `FlexibleTimeWindow: OFF`; upserts rather than returning a conflict the caller cannot resolve |

**Why it took three deploys, and the finding underneath.** The first two rolled back: the
deploying identity is `BastionEC2Role`, whose IAM grants had been narrowed after initial
creation to maintain existing roles but not create new ones — and EventBridge Scheduler requires
a `RoleArn` on every target, with no roleless option. **The template was never the
non-portable part**: a fresh install's deployer must already hold `iam:CreateRole`, since the
stack creates two roles today. So the grant went into `template.yaml` as well, scoped to the
stack's name prefix, with `DependsOn: BastionRole` so CloudFormation grants before it creates.
An earlier security objection to this was **withdrawn on evidence** — `iam:AttachRolePolicy`,
`iam:PutRolePolicy` and `iam:PassRole` are already `Resource: "*"` on that role, so it could
attach `AdministratorAccess` to any existing role and pass it. `CreateRole` does not raise the
ceiling.

**The smoke test earned its keep twice.** A `SCHEDULED_RUN` message failed on
`chk_triggered_by` — `'schedule'` was not an accepted value. Fixing it exposed a **pre-existing
drift**: the live constraint already carried `'minds_eye'` and `'intent_classify'` while the
template carried neither, so `run_workflow`'s own `triggered_by` had never been under config
control. Live constraint and both template artifacts now agree on all seven values. The re-run
produced run **771** — `triggered_by: 'schedule'`, `callback: null`, steps executed — and then
stopped at `awaiting_human_gate`, **demonstrating by accident the exact hazard
`schedule_workflow`'s description warns about**: a scheduled run has nobody to answer a gate.
Run cancelled. 920 → **937** unit tests.

**Cost:** EventBridge Scheduler is billed per invocation and schedules themselves are free to
hold, so at household frequencies the scheduler is rounding error. **The cost that matters is
what the scheduled workflow does** — a workflow making an `llm_call` every 15 minutes is the
thing that would move Checkpoint 1's ~$21/month, not the trigger. Worth stating in
`schedule_workflow`'s guidance before anyone schedules an LLM-bearing workflow.

### Session 14 — 2026-08-16 — Checkpoint 3 runs end to end. AC8 met; seven engine defects on the way

**`process_receipt` works, both kinds, from Slack, with no hand-repair between build and
run — AC8 MET.** Three live runs did it:

| Run | Receipt | Outcome |
|---|---|---|
| 775 | ALDI, €35.95 | 14 items, 14 aliases, expense 197 |
| 776 | ALDI JAVEA II, €56.23 | **3 auto-matched + 2 LLM-resolved**, 7 new, expense 198 |
| 778 | EL BANCALET, €7.50 | `is_grocery: false` → step 6 routed 6→13, inventory untouched, expense 199 to *Dining Out* |

Run 776 is the first time alias matching has demonstrably matched anything — 775's inventory
was empty, so its `auto_matched: 0` proved nothing.

**AC7 is closer but still fails as specified.** Aliases persist and match, but there is still
**zero `vectorSearch`**: steps 7/8 read the whole inventory and step 10 sends all of it to the
LLM. Step 10's input went 2,708 → 6,050 tokens between runs 775 and 776 — **cost per receipt
rises with pantry size**, the inverse of §3b. **AC9 therefore cannot pass on the current design**
and a third receipt would measure a bigger number, not a smaller one. This is the
uncontaminated AC4 specimen: a real design defect in Novia's own build, statable as a symptom
("processing a receipt costs more each time") without the diagnosis.

**The inventory domain was remodelled — and the attribution was corrected on the record.**
`PGD_InventoryCategory` held 14 rows for 6 distinct names because it was modelled as a *child*
of an item (`inventory_id` FK, unique on `(inventory_id, name)`), so every item minted its own
private category. Run 766's `create_domain` output did **not** produce that: it designed one
table with `category` and `location` as separate text columns. The live tables came from **run
768**, whose input was *"inventory with a 1:m relationship to a category table…"* — the user's
own instruction. **No generator defect, so no creation-time prompt root to trace**, which is
why the artifacts were fixed directly rather than through `create_domain`.

Category is now a shared lookup (`uq_inventorycategory_name`, `fk_inventory_category` ON DELETE
SET NULL, `name_embedding` populated), items carry `category_id`, and the axis conflation is
closed: the prompt now states that a category is *what the item is, never where it is kept*.
`pantry` was retired and its three items remapped to `bakery`/`spreads`/`sauces`. Verified by
run 776 writing **0 new category rows** for 7 new items, where the old design would have written 7.

**Seven engine defects found and fixed, six of them Execution.** Every one was found by running
the thing, not by reading it:

| Fix | Found by |
|---|---|
| A reveal over an empty collection emitted a container with zero `child_blocks` — Slack rejects it, failing the whole gate message and wedging the run at `awaiting_human_gate` | Run 774 |
| `serv_query` never forwarded a `columns` projection, so vector columns rode into prompts | Reading step 8 before run 776 — 28 × 2560 floats would have shipped |
| `{{tokens}}` in a reveal's `button_label` reached Slack verbatim | User's run 776 report |
| Same omission in `item_action.label`, `input_label`, `placeholder`, `special_buttons` | Audit after the above |
| `item_label_template` used a private regex accepting only single-word keys | Writing its contract entry |
| **L2 returned a 500 on any gate whose `options` is a `{{template}}` reference** — `.find` on a string throws. `register_workflow` gates on L0+L1+L2, so **no workflow with a runtime-built option set could be registered at all** | Verifying the contract change |
| L0 rejected `notify` steps using `message` — the engine reads `message_template ?? message` | **User pushback on a false positive I reported** |

Also added: `addForeignKey` and `addUniqueConstraint` (`createTable` was the only place either
could ever be created, and `updateTable` would have made the registry assert what the database
does not); L0 `one_of`; the `human_gate` contract gained six fields it never declared.

**Two reporting failures of mine, both corrected by the user.** I reported
`flashcard_quiz_session` as failing L0 when it works — the contract was wrong, not the workflow.
And a sweep script read a 500 as a validation failure. Both times "the tool says it is broken"
was the tool. Worth carrying: **a validation finding against a workflow known to run is evidence
about the validator first.**

**937 → 981 unit tests.** All 16 live workflows now sweep clean at L0+L1 — zero issues, zero
500s, which was not true at the start of the day.

**Filed, not fixed:** no step type reaches a `PGC_Capability` endpoint (so a scheduled workflow
cannot call anything external — `call_capability` is Novia's agent tool, a different execution
path); and `/help` never shows a domain's workflows or how to start one, though `PGC_IntentMap`
already holds the phrases.

### Session 15 — 2026-08-19 — AC4 diagnosis reached unaided, $0.104. AC2 met.

**The symptom, stated verbatim and nothing more:** *"Processing a receipt costs more in LLM tokens
each time, and it gets worse as the pantry fills up."* The LLM-token framing narrows the cost axis
away from AWS deliberately; it names no step, no mechanism and no fix.

**Session 1161 — four turns, four tool calls, $0.10404.**

```
turn      in   create     read   read/prev in        $
1      8,851    8,849        0            —    0.03594
2     15,676    6,826    8,849         1.00    0.03115
3     18,039    2,363   15,675         1.00    0.01666
4     18,234      195   18,038         1.00    0.02029
```

`read_memory` → `read_workflow` → `query_table` (PGC_Prompt) → `run_sql`. She named step 10
`match_inventory_items` as the culprit, steps 7/8 as flat reads at `limit: 500`, and the root cause
as *"a vector pre-filter that was never implemented at the DB query level — the vector columns are
never used to pre-filter."* **Verified against the live workflow: steps 7/8/9 all carry
`vectorSearch: null`.** Her Option A ("columns already optimised") is also correct — that was the
2026-08-16 projection fix.

**"Unaided" carries one qualifier, recorded rather than argued away.** Her first move recovered her
own build notes (memory 309/310/311), and the thresholds she proposes — 0.60 / 0.82 — are quoted
from them, along with the "vector matching runs on English-translated names only" design line. The
*diagnosis* came from `read_workflow`; the *fix parameters* came pre-computed from her past self.
That is the memory layer working as designed, and it is not a hint from the user — but it makes the
number a diagnosis cost, not a from-cold reasoning cost.

**The stale-memory hazard resolved itself.** Memory 310 asserts `PGD_InventoryCategory` is a
per-item child table, which stopped being true on 2026-08-16. Memory 306 — the remodelling note —
returned in the same result set and corrected it. No intervention needed.

**One real error, and it is the thing to watch on the repair.** Her Option B proposes a
`serv_vector_search` step type, which does not exist; the mechanism is `serv_query` with a
`vectorSearch` input object, declared in the contract. **She never read `PGC_StepType` this round**,
so she invented a plausible name that L0 would reject at registration. Whether she reads the
contract when told to implement separates an Instruction finding from a Generation one.

**AC2 met in passing.** One `run_sql`, `"PGD_Inventory"` correctly double-quoted per the guidance
now carried in the tool's own description, no identifier failure — the first `run_sql` in any
validating round. **AC1's mechanism reconfirmed**: `read/prev in` = 1.00 on every turn after the
first.

#### The repair — v3, and the bound is narrower than it reads

**Told to do Option B and to check `PGC_StepType` first, she did both.** `process_receipt` v3, 27
steps: the two bulk reads are gone, replaced by iterators over `parsed_receipt.items` running
`serv_query` with `vectorSearch` per item — `PGD_Inventory` at top-8 and `PGD_InventoryAlias` at
top-5, both threshold 0.4 — each followed by a `js_transform` that flattens and dedupes on row id.
She read the contract and **self-corrected the `serv_vector_search` error** without being told.

Her before/after table is accurate against the live row, with one exception: *"everything from step
10 onward is untouched"* is wrong at step 10 itself, whose input bindings moved to
`{{inventory_candidates}}` / `{{alias_candidates}}`. The prompt text is untouched; the step is not.

**The scaling claim is directionally right and its bound is looser than stated.** The prompt now
carries at most `8 × items` inventory rows and `5 × items` alias rows, and no term mentions pantry
size — so "scales with the receipt, not the pantry" holds. But the *hard* cap is 8N, not her
estimated 20–50: an 18-item receipt caps at 144 rows against a 51-row pantry, so at today's size
the cap does not bind and the entire saving comes from the 0.4 threshold's selectivity. **The
guarantee is structural; the saving today is threshold-driven, and has not been measured on a run.**

#### The alias search was left in the wrong language — found by probe, not by running it

Step 8c queries `alias_name_embedding` with `{{item.name_en}}`, but every stored alias is the raw
OCR string (`name_original`, written by step 12i). Measured directly against the live table:

```
query "ground coffee"          → CAFE MOLIDO TUESTE NAT   0.392   ← correct alias, below the 0.4 floor
query "CAFE MOLIDO TUESTE NAT" → CAFE MOLIDO TUESTE NAT   1.000
                                 CAFE MOL. NAT: DESCAFE   0.594
query "sweet potato"           → PATATA ROJA              0.307
                                 BATATA GRANEL            0.233   ← correct alias, out-ranked
```

Cross-lingual similarity does not merely score low — it **scrambles the ordering**, so the rows that
clear 0.4 are noise. Same-language matching is excellent, which is what makes the fix a single token.

**No receipt can surface this, and that is the finding.** Inventory names were created from
`name_en` and `parse_receipt` emits `name_en` again every run, so the inventory search always has a
clean same-language match to offer (`sweet potato → Sweet Potato` 0.961). The alias path is
therefore **strictly redundant while translation is stable**, and its failure presents as a silent
non-improvement rather than a visible defect. Probing is the only cheap way to see it.

#### The case that makes aliases load-bearing — and it was already in the data

`PGD_Inventory` **id 25 is "Ink Cartridge", quantity 1**. Its alias row 30 reads **`CAPERUCITA
TINTA`** — a red wine. In general Spanish *tinta* is ink; in wine labelling it is also a red-grape
term, so **"ink" is a defensible reading of the input** and no `parse_receipt` prompt rule fixes it.
No fault domain in the triage table covers this: it is a case that *requires* a human correction.

That retires the "redundant" reading above. Translation here is stably **wrong**, so the inventory
path finds ink every time and can never recover it. Only an alias keyed to the raw string can — and
only if step 8c queries with `name_original`. **The one-token fix is what makes corrections stick.**

#### The language review — user-worded, and it found a second real bug

Asked *"review the process receipt workflow for language translation related issues"* — no
diagnosis, one tool call, reasoning over the transcript she already held:

| # | Her finding | Verdict |
|---|---|---|
| 1 | `name_en` exists by step 8 | Non-issue, correctly cleared |
| 2 | **Frozen `current_date` in step 3** | **Correct** — verified live as `"Monday, August 10, 2026"`, nine days stale. D3's defect class, found unprompted in a review about something else |
| 3 | Aliases stored Spanish, searched English | **Right diagnosis, wrong fix** |
| 4 | `name_original` lost if the alias write is skipped | Minor — and contradicted by her own Issue 3 fix, which discards it unconditionally |
| 5 | Prompt implies Spanish-only; currency enum `USD/MXN/EUR` | Cosmetic |

**Her Issue 3 fix was to store `name_en` as the alias string.** That duplicates the inventory index
exactly (`PGD_Inventory.name` *is* `name_en`), cannot express the wine case, and would bake a bad
translation in permanently while *appearing* healthy as alias scores jumped. **The analytical error
is a misapplied measurement:** she quotes memory 298's bands correctly, but they were measured
Spanish-query → **English** names and say nothing about Spanish → Spanish. She wanted a monolingual
vector space — the right instinct, applied to the wrong side of the comparison.

**Shown the counterexample as a plain user observation** — *"There's an item called Ink Cartridge.
It's not ink, it's a red wine, Caperucita Tinta. How would your alias fix handle that?"* — **she
reversed it**: *"Issue 3 as I originally framed it was wrong."* She reached Option A unaided —
`queryText: {{item.name_original}}`, keep storing the raw string, no schema change — on the correct
reasoning that `name_en` is unstable and `name_original` is stable, and stated the real trade-off
(two stores, two Spanish names, two alias rows) accurately.

**This is the sprint's first evidence on maintainability, and it is Checkpoint 4's actual premise.**
A defect was reached, a wrong fix proposed, and the wrong fix reversed — by an owner supplying an
observation anyone would make, never a diagnosis. Until now Checkpoint 4 rested on a sales
conversation.

**One gap she did not revisit: the 0.4 threshold.** It was chosen for cross-lingual matching. Once
both sides are the same language, memory 298's own bands are auto ≥0.82 / fallback 0.60–0.81, and
`PAN MOLDE RUSTICO` clears 0.402 against a coffee query. Not a correctness problem — the LLM
arbitrates — but it spends tokens on junk candidates, which is what v3 existed to stop.

#### Cost — AC4 is under budget; the prefix forfeit is now the dominant term

| | |
|---|---|
| **AC4 as specified** (diagnosis + repair, turns 1–12) | **$0.672** against ≤ $1.00 — **MET** |
| Language review + self-correction (turns 13–15) | $0.437 — additional scope, not AC4 |
| **Session 1161 total** | **$1.109** |
| **Of which prefix forfeits** | **$0.647 — 58%** |

**AC4 did not overrun.** The session total exceeds $1.00; the measured criterion does not, and the
extra spend bought two further defects found and a wrong fix reversed. The user's reading — that the
objective is met — is recorded, and the accounting supports it without needing the allowance.

**Four full forfeits, and one is a path the sprint has not recorded.** Every round restart
re-creates the entire transcript, and the cost grows linearly with it:

```
turn  in       create   read   cause
5     19,184   19,182   0      typed reply after a prose response — GO Condition 1's known path
11    46,457   46,456   0      GATE RESUME after propose_workflow_fix approval — NOT the known path
13    47,627   47,625   0      typed reply after a prose response
15    52,164   52,162   0      typed reply after a prose response   ($0.209)
```

Turn 11 is new. Step 2e records gate resume as *"DONE — needed no code"*, and the `__pending__`
pairing does work; the **prefix** still misses completely on the rebuild. First candidate cause is
the `instructions` block differing between rounds — `assembleContext` re-runs on resume and
`PGC_Memory` still has no tiebreaker with ~91 rows tied at priority 8, so byte zero can move between
rounds even though it cannot move within one. **That is the tiebreaker fix dismissed in the
superseded 2C kit** — correctly dismissed for within-round misses, never tested against this case.

GO Condition 1 records this as *"$0.219 per occurrence at a 56k transcript"*, framed as contained.
It is now measured four times in one session as **the majority of all spend**, growing with the
transcript. On this evidence it is the main remaining cost lever and the one change that would make
conversational maintenance cheap. Promoted to backlog High Priority.

#### Open, carried to the next session

1. **Apply both fixes** — step 8c `queryText` → `{{item.name_original}}`, and the `js_transform`
   for `current_date`. She has offered; neither is applied.
2. **Recalibrate the alias threshold** once matching is same-language — 0.4 is loose.
3. **A correction workflow** — rename an item, merge a duplicate, write an alias keyed on the raw
   string. `PGD_Inventory` 25 is its first test case and is wrong in the pantry right now. **Key it
   on the raw receipt string, never on the wrong English** — otherwise buying real ink makes wine.
4. **Then the MASYMAS receipt, in raw Spanish OCR** — ~18 items, a new merchant, growing the pantry
   51 → ~65. It closes AC7, measures AC9, and tests the threshold's real selectivity at the point
   where the 8N cap stops binding. Pasting the English rendering would make the alias table
   same-language by accident and render the fix untestable.

### Session 16 — 2026-08-19 — Run 780: both fixes work live; the number is inflated by two engine defects

**Workflow 358 v4, 28 steps, registered 10:24 and run at 10:28. Both of Novia's offered fixes are
applied and both are proven by the run, not by inspection.**

| Fix | Evidence from run 780 |
|---|---|
| Step 1b `js_transform` — `new Date().toISOString().slice(0, 10)` | `current_date = 2026-08-19`. The receipt carried no readable date, so `parse_receipt` fell back to it and produced `purchase_date = 2026-08-19`. **First live exercise of D3's fallback path with a real date** |
| Step 8c — `queryText: {{item.name_original}}` on `alias_name_embedding` | **`alias_candidates = 14`**, where the `name_en` binding returned effectively none. Step 8 correctly left on `{{item.name_en}}` → `inventory_candidates = 15` from a 51-row pantry |

**The receipt was pasted as raw Spanish**, as the pickup required — 14 of 15 `name_original` values
are Spanish (`PEPINO HOLANDES`, `BONIATO ROJO`, `CHOC NEG 85% VALOR`) and all 13 aliases written are
raw strings, so the alias table stayed monolingual. Outcome: 15 items → 2 auto-matched, 7
LLM-resolved, 6 new; 6 items inserted; expense recorded; 81 steps, no errors. **Run cost $0.1095**
($0.0409 parse + $0.0686 match).

**Step 10's input measured 12,460 tokens against run 776's 6,050 — and the comparison does not
hold.** Run 780 is 15 items against 12, a 51-row pantry against 28, and a rewritten prompt (v2).
The pantry contribution *is* now bounded — 15 + 14 candidates instead of all 51 items and 56
aliases — so the scaling design is working. The absolute figure is inflated by two Execution defects,
**both verified by direct probe rather than inferred**:

1. **`columns` is ignored when `vectorSearch` is present.** Same table, same projection:
   `{"columns":["id","name"], "vectorSearch":{…}}` returns **16 columns**; without `vectorSearch` it
   returns 3. Candidate rows arrive at ~346 chars instead of ~45 — roughly 8× — carrying
   `created_at`, `updated_at`, `description`, `location`, `condition`, `notes`, `value`,
   `expiry_date`, almost all null. **Vectors are still nulled, so `52e2393`'s protection holds**;
   this is the projection not surviving the vector path.
2. **The payload is sent twice.** `llm-harness.mjs:424` sends `userInput || JSON.stringify(resolvedInput)`
   as the user message while `assembleInstructions` has already substituted the same `{{tokens}}`
   into the system prompt. Confirmed in the diagnostic: `Rustic Sliced Bread` appears exactly once
   in each message. This affects **every `llm_call` whose prompt inlines the tokens it is passed**,
   which is the authoring convention. Recorded as a design question, not a patch — the harness
   cannot know the prompt already embedded them.

Together these are most of the 12,460; the projection alone is ~6,600 chars of dead weight and the
duplication doubles what remains. **AC9's blocker has changed character**: it is no longer a design
flaw in the workflow but two engine defects sitting on a working design.

**Two matching-quality findings, which are the 0.4 threshold showing up in live data.**
`PANU BOL MIN SELEX` (mini bread rolls) was aliased to inventory 17, **Rustic Sliced Bread** — a
different product folded into an existing one. `ARANDANOS DESH ALT` (dehydrated blueberries) matched
inventory 6, **Blueberries 300g** — fresh, the exact conflation the pre-run probe predicted at 0.551.
Neither is an engine fault: the LLM arbitrated on candidates a loose threshold admitted. Both
strengthen the case for recalibrating off 0.4 now that matching is same-language.

### AC9 — measurement protocol, PRE-REGISTERED 2026-08-22 before any number was observed

**Committed to git before the run, deliberately.** The sprint's rule is that thresholds are fixed
before measurement; this is the same rule applied one level down, to *how* the threshold is read.

**Two user decisions taken here.** AC9 is read on the **second** same-merchant receipt, not the
third — MASYMAS has had exactly one run (780), runs 775/776 are a different merchant *and* predate
the `vectorSearch` design, so a literal third-against-first needs two more shopping trips. AC9 will
therefore be marked on second-against-first with **"third was not reached" stated plainly in the
mark**, never elided. And the second receipt **is a short one**, which is precisely why the metric
has to be settled first: a 4-item receipt costs less than a 15-item receipt whether or not a single
alias hits, so raw per-receipt cost would pass the threshold for a reason unrelated to learning.

| | Metric | Run 780 baseline | Direction that supports the claim |
|---|---|---|---|
| **Primary** | Step 10 input tokens **per receipt item** | 12,460 / 15 = **831** | Lower |
| **Primary** | Run cost **per item** | $0.1095 / 15 = **$0.0073** | Lower |
| **Supporting** | Items auto-matched, as a count and a share | **2 of 15 (13%)** | Higher |
| **Reported, not the criterion** | Raw per-receipt cost | **$0.1095** | Confounded by item count |

**Two caveats recorded in advance, not after:**

1. **Small n is noisy.** On a handful of items the auto-matched share swings on one or two products.
   Report the count alongside the percentage; do not lead with a percentage of four.
2. **The reading depends on vocabulary overlap.** Run 780 wrote 13 raw-string aliases. If the second
   receipt's items are among them, those aliases should fire. If the items are all new products,
   little learning will show — and that is **an absence of opportunity, not a failure of the
   mechanism**. State which case it was; a bare number without this is not evidence either way.

**Also true of this run:** the duplication fix touches every `llm_call`, so this is simultaneously
the regression test for all 15 seed workflows. A step-10 token figure that falls for the engine fix
rather than for aliases is expected and is a *different* claim from AC9 — separate the two in the
write-up by comparing per-item tokens against 831 *and* naming the fixes as a contributing cause.

### Session 17 — 2026-08-22 — Both Execution defects fixed and deployed. AC9's blocker is gone.

**User decisions taken at the top of the session, and they reshape what is left:**

| Decision | Consequence |
|---|---|
| **Vector-threshold tuning goes to Novia, next sprint** | Pickup item 0 leaves this sprint. AC7's outstanding clause — "threshold calibrated" — does not close here |
| **Checkpoint 3 is satisfied** | It passes on its own binary threshold, which is AC8, and AC8 is met (runs 775/776/778) |
| **Checkpoint 4 waits on the Spanish friend's availability** | AC13's "Convinced" half is judged by him; it cannot be scheduled from this side |
| **AC9 to be measured, not passed by inspection** | The user's initial position was PASS by inspection on qualitative evidence; on the argument below it was changed to measure it |

**On AC9 and inspection.** The qualitative observation offered was that some inventory items are
categorized via vector search. That is real, and it is evidence for **AC7** — lazy matching
resolving items and persisting aliases, already recorded as mechanism-proven-live on run 780. AC9
asks a different question: does per-receipt cost *fall* on repeat use of the same merchant, third
against first. The only same-merchant progression measured runs the other way (2,708 → 6,050 tokens
across 775/776), and nothing has been measured since the mechanism landed. Grading it PASS would
have been the one move AC11's own vocabulary note rules out — *"forcing an unrun criterion into one
of three grades would manufacture a result, which is the specific failure the fixed-in-advance
thresholds exist to prevent."* On a make-or-break sprint, on the criterion that *is* the economic
thesis, that is the worst place to blur. **Agreed: fix the two defects, then measure.**

**Both Execution defects are fixed, deployed to prod, and the first is re-probed live.**

| Defect | Fix | Evidence |
|---|---|---|
| `columns` dropped under `vectorSearch` | `getRows` built its select list inside the standard branch only. Built once above the branch now, so both paths project and both validate `columns` | Re-probe, same table and projection: **16 columns → 3**, row 0 **377 chars → 75**. A 5× cut per candidate row, against the 8× estimated in backlog |
| Every `llm_call` sent its input twice | `assembleInstructions` returns `{ instructions, inlinedKeys }`; `buildStepUserMessage` sends only the residue | Unit-tested directly. Not yet measured live — the receipt re-run is the measurement |

**A third defect surfaced from re-probing rather than trusting the response shape**, which is what
the backlog entry asked for. With the projection fixed the row still carried `name_embedding: null`:
the truncation pass walks every vector column in the *schema* and assigned `clean[col]`
unconditionally, so for a column the projection excluded `v` is `undefined`, `v == null` is true, and
the key is written back in as null. The projection honoured by the SELECT, then partly undone on the
way out. Fixed, redeployed, re-probed: `{"id": 17, "name": "Rustic Sliced Bread", "similarity":
0.5116...}`, 75 chars. **Whole-row reads are unchanged** — 16 columns, vector truncated to
`'[0,-8...'` — so `52e2393`'s protection holds.

**On the duplication fix, three things that make it a fix rather than a gamble:**

1. **Detection happens during substitution, not by scanning `prompt_text` up front.** `contextMap` is
   substituted before `resolvedInput`, so a context value containing `{{item}}` puts that token into
   the text before the input pass reaches it. A raw scan would miss it and send the value twice
   anyway. There is a unit test for exactly this case.
2. **No input key is lost.** Every key either reaches the prompt or reaches the user message. A
   prompt declaring no tokens is unchanged; an explicit `user_input` still wins. Asserted directly.
3. **Fingerprints do not move.** `computeFingerprint` hashes `resolvedInput` and `userInput`, never
   the effective user message, so recorded replay corpora keep hitting. The user message is still
   fully determined by hashed components. The diagnostic `PGC_SessionEntry` records what was actually
   sent, so run-780-style evidence stays honest.

**Scope, stated plainly:** the duplication fix touches **every `llm_call` in the system**, not only
`process_receipt`. That is where most of the saving is, and it also means the receipt re-run is the
regression test for all 15 seed workflows. 997 unit tests pass, 16 of them new. No seed changed.

**What is now open.** The receipt re-run, which measures AC9 and regression-tests the duplication fix
in one go. And **AC11's table has gone stale against this document's own header** — it still marks
AC8 NOT MEASURED ("358 registered and never run") and its "What the GO does not claim" section still
says the receipt use case *"has never run"* and that *"AC4 has no number"*, when AC4 is $0.672 and
marked PASS two rows above. The sprint's deliverable cannot ship contradicting itself; the pass is
pending the user's call on how AC7 and AC9 are marked.

### Session 3 — 2026-08-08 — 2C is not buildable. The premise was wrong.

**The transcript prefix-cache fix does not exist.** It was diagnosed as a cache-invalidation
defect in our own code. It is a gateway capability gap, and no change to `minds-eye.mjs` moves it.
`minds-eye.mjs` was not modified. Four probes against the live gateway, $0.34 all in.

**Evidence 1 — the logs already refuted the diagnosis.** 100 usage records over three weeks:
`cache_read_input_tokens` is either 0 (first turn) or **exactly 4041** — the `instructions`
block — on every call, every session, every model. Not one byte of `input` has ever been served
from cache. Meanwhile `cache_creation` = `input_tokens` − 4041 on every turn.

The within-round sequence is what kills the memory-shuffle explanation. 08-02, nine consecutive
turns seconds apart, `cache_read` flat at 4041 while `input` grew 5,293 → 22,768:

```
07:11:20  in  5,293   create  1,250   read 4041
07:11:24  in  5,828   create  1,785   read 4041
07:11:44  in 11,919   create  7,876   read 4041
07:11:56  in 22,768   create 18,725   read 4041
```

`assembleContext()` runs **once per round** (`minds-eye.mjs:148`) and its result is held constant
across every turn inside `runReasoningLoop`. So within that round both context blocks were
identical strings and the transcript grew by pure append — and the prefix still missed. The
`PGC_Memory` shuffle can only move byte zero *between* rounds. It cannot cause a miss four
seconds apart. Fixes (i), (ii) and (iii) would have measured zero.

**Evidence 2 — three request shapes, one answer.** Cache matching is **per block,
all-or-nothing**; there is no prefix matching inside a block.

| Shape | Result |
|---|---|
| `input` string, byte-identical repeat | full hit, ~12× cheaper — `input` **is** cacheable |
| `input` string, append-only | read 4,695 (instructions only), re-created 13,477 |
| `messages` history array | HTTP 400 `unknown field "messages"` |
| `input` as role array, append-only | accepted, semantically honoured, read 4,695 — caches identically to a string |

**Evidence 3 — the 1.25× write premium is mandatory.** Nine opt-out candidates: six rejected as
unknown fields, three (`store: false`, two cache-control headers) accepted and silently ignored.
The multiplier held at 1.25× on every call. The gateway auto-caches and exposes no control.

Billing multipliers, matched to three decimals against probe cost: uncached **1.0×**, cache write
**1.25×**, cache read **0.1×**.

**What this means.** Every Novia turn pays 1.25× on the entire transcript and can never pay less.
Round cost is **quadratic in turns** — roughly `1.25 × rate × t × N²/2` — which is why 08-01 was
59 calls for $6.71 at a mean of 24k tokens per call, and why session 1122's repair burned $3.40
without finishing. This is the shape of the loop, not a misconfiguration.

**The fix is inverted from what was scoped.** Not reordering *within* `input` — moving
round-stable content **out of `input` and into `instructions`**, where it is read at 0.1× instead
of written at 1.25×. `layer1Context` and `layer2Context` qualify. Real, nearly free, and small
(~800 tokens/turn). The transcript cannot move, because it changes every turn.

**The only lever on the dominant cost is sending less transcript.** Compaction, and the per-tool-
result cap at `minds-eye.mjs:1592` — 15,000 chars *each*, uncompacted, forever. That makes
carry-forward **item 4, session compression, the front of the queue** rather than the back: it was
sequenced behind the cache fix, and the cache fix does not exist.

**Consequences for the ACs — needs a rescope decision.** AC1 is unachievable as written; its
mechanism does not exist. AC3 and AC4 name 2c as their prerequisite and their thresholds were set
against Sprint 9 costs carrying this penalty. AC2 (A5) is unaffected — it is prompt content and
still worth deploying.

The SERV composite `orderBy` work stands on its own: it fixed a live silent-wrong-data bug and
still makes `PGC_Memory` retrieval deterministic, which matters to the replay corpus regardless.
