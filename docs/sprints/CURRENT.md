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
| **(iii)** | `minds_eye_system_prompt` | Retire the prose tool catalog and the anti-native-tool-use rule. Large prompt shrink; `ACTION_SCHEMA` stops being dead weight because tool schemas are enforced server-side. |

**Progress.** (i) done — `5f82c8b` … `37ca58d`. Step (ii) is broken into five parts, of which the
first is done:

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

## Acceptance Criteria

| # | Criterion | Checkpoint | Threshold |
|---|---|---|---|
| **AC1** | Novia's loop uses native function calling; in a live round `cache_read` exceeds the `instructions` block on **every** turn after the first and grows with the transcript, while `cache_creation` holds near the per-turn increment | 2c | Mechanism: binary. Cost: creation component down ≥ 4× |
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
