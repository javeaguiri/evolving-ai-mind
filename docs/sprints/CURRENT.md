# Sprint 10 — Viability Checkpoints

**Status: SCOPED 2026-08-06. Branch `sprint/10-viability-checkpoints` (to be cut from main).**

> **This sprint ends in a go/no-go decision.** Its deliverable is not a feature — it is a written
> recommendation on whether development continues, measured against thresholds committed *in this
> document, before any number is observed*.

> Read before implementing: `docs/sprints/sprint-09.md` §RETRO, `docs/Javear-use-cases.md`
> (Domains 2 and 4), and `docs/arch-minds-eye.md` §12.7.

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

#### 2c — The prerequisite: the transcript prefix-cache fix

Neither measurement above is meaningful until this lands. A cache-invalidation defect in our own
code, not a gateway limitation. Two causes in `minds-eye.mjs`: `buildUserMessage` orders `input`
as volatile context → transcript, when the transcript is the append-only part whose prefix is
stable; and `assembleContext` runs `ORDER BY priority DESC LIMIT 5` on `PGC_Memory` with no
tiebreaker while **35 of 100 rows tie at priority 8**, so byte zero of `input` can move between
identical queries.

Three-part fix: (i) deterministic secondary sort key on both `assembleContext` queries;
(ii) reorder `buildUserMessage` so turn N's input is turn N−1's plus an append; (iii) stop
rewriting history in place in the draft-supersession branch. Expected ~12× cut on the creation
component. Full diagnosis in `docs/backlog.md`.

**A5 lands in the same deploy** — `run_sql` gives Novia no route to physical table names, which
cost ~$1.50 of session 1122's $3.40. Two statements close it: use `list_physical_tables` before
raw SQL, and double-quote CamelCase identifiers. Context content, no code.

**One live round validates the fix, A5, and 2b together.** The signals read from different
places and do not confound: the cache effect from `cache_read`/`cache_creation` in the usage
logs, A5 from whether any `run_sql` call fails on an identifier, 2b from whether she reaches the
defect.

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

## Acceptance Criteria

| # | Criterion | Checkpoint | Threshold |
|---|---|---|---|
| **AC1** | Transcript prefix-cache fix lands; a live Novia round shows `cache_read` climbing past its pinned 4041 while `cache_creation` flattens | 2c | Creation component down ≥ 5× |
| **AC2** | A5 — `run_sql` table-name guidance; no `run_sql` call in the validating round fails on an identifier | 2c | 0 identifier failures |
| **AC3** | Novia rebuilds `edit_budget` clean-room, without sight of workflow 357, to a **running** workflow | 2a | ≤ $1.50 all-in |
| **AC4** | Novia diagnoses and repairs D2 or D3 given the symptom only | 2b | ≤ $1.00, unaided |
| **AC5** | `serv_query` exposes `vectorSearch`; contract and `PGC_StepType` row updated; L0/L1 unaffected on all seed workflows | 3b | Regression-free |
| **AC6** | Inventory domain created via `create_domain`, with the derived-column question settled rather than inherited | 3a | Domain live, no unmaintained denormalized columns |
| **AC7** | Lazy matching resolves a real receipt's items against inventory, threshold calibrated, confirmations persisted as aliases | 3b | Named in 3b |
| **AC8** | One routing workflow, built by Novia, handles both receipt kinds end-to-end from Slack | 3c | Binary — both kinds |
| **AC9** | Per-receipt cost measured on first and third use of the same merchant | 3b | Third < first |
| **AC10** | ~~AWS fixed cost measured per-service for a full billing month~~ — **settled PASS 2026-08-08 on standing evidence: ~$21/month, stable for months. No measurement task.** | 1 | ≤ $30/month ✅ |
| **AC11** | **Written go/no-go recommendation** against every threshold above, with each marked PASS / MARGINAL / FAIL | — | Exists, and is unambiguous |

---

## Out of Scope

| Item | Why |
|---|---|
| **Release-readiness — test environment, README bootstrap, log hygiene** | **Deferred a fourth time, by explicit decision 2026-08-06.** The reasoning is sound: handoff infrastructure is not worth building for a project that may be cancelled, and the go/no-go comes first. **The operational consequence is accepted, not overlooked** — without a test environment this sprint validates against prod, which is the same condition that caused Sprint 9 to defer AC8. Plan for it. **Becomes Sprint 11's opening item if the decision is go**, at which point it stops being tech debt and becomes the handoff itself: a contributor who cannot stand the system up cannot contribute. |
| **Extending Novia to create domains** | The question is real and stays open. Answering it needs evidence from `create_domain` running against a genuinely new domain, which AC6 produces. Deciding it in advance, inside a make-or-break sprint, would put two capability questions on one result. |
| **Archetype / dialog-strategy registry** | Still parked. One real build now exists, so the "revisit with evidence from real builds" condition is technically met — but the evidence points at cost and repair, not at a shape shortage. Revisit if a Checkpoint 3 build shows Novia reinventing a procedure she has already written. |
| **`create_workflow` repairs of any kind** | Retired by the direction. `design_workflow_dialogs` v19 is spliced. Do not run it. |
| **`/chat` dead code removal** | Independent, still undecided. |
| **Richer episodic memory, `PGC_Memory` dedup/TTL** | Unchanged from Sprint 9. |

---

## Sequencing

The dependency chain is strict and should not be run out of order:

```
2c  transcript fix + A5          ──┐
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

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] L0/L1/L2 pass on every workflow built this sprint
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated — `serv_query` `vectorSearch`, any new step type
- [ ] `docs/arch-step-types.md` updated for the `serv_query` contract change
- [ ] `docs/arch-data.md` updated — inventory domain schema
- [ ] `docs/Javear-use-cases.md` updated — Domain 2 status, and the stale `quiz_flashcards` /
      `study_flashcards` entries corrected against the live workflow list
- [ ] `docs/backlog.md` updated
- [ ] `docs/sprints/CURRENT.md` → `docs/sprints/sprint-10.md` with outcome notes
- [ ] **AC11 — the go/no-go recommendation is written, and every threshold is marked**

---

## 2C starting kit — everything needed to begin, verified 2026-08-06

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
