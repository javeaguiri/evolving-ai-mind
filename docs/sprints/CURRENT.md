# Sprint 11 — Usability and Administration

**Status: SCOPED 2026-08-22. Branch `sprint/11-usability-and-admin`.**

> **Read before implementing:** `docs/sprints/sprint-10.md` §RETRO (especially items 1, 2 and 3),
> `docs/backlog.md` §High Priority, and `docs/arch-minds-eye.md` §12.

---

## Sprint Goal

**Make what the system already does discoverable, correctable, and pleasant to use.**

Sprint 10 answered whether the project should continue. It should. What it also showed is that a
household second brain accumulates two kinds of debt the moment it is genuinely used: **things the
user cannot find** and **things the user cannot fix**. `process_receipt` has run five times and is
invisible in `/help`. Aliases and categories accumulate automatically and have no maintenance path,
so a single mis-match compounds on every subsequent shop.

Neither is a research question. Both are ordinary product work, and this sprint is deliberately
shaped as ordinary product work after a make-or-break one.

**Branch:** `sprint/11-usability-and-admin`

---

## Why this shape

The items below came from **use**, not from a plan — which is the right source, and also means the
scope will grow as the administrative workflows surface more dialog defects. That is expected. The
standing instruction is to **record new findings in `docs/backlog.md` rather than absorb them
mid-sprint**, unless the user says "add to sprint".

---

## Tracks

### Track A — `/help` tells the truth (opening item)

**The case, reported from use.** Selecting a domain at `/help`'s level-1 gate renders step 4's
`js_transform`, which composes the panel from **`PGC_DomainHelp.commands` and nothing else**. It
never names a workflow and never says how to start one. Live, on three domains:

| Domain | `/help` says | Reality |
|---|---|---|
| `inventory` | five generic `/m` CRUD lines | never mentions `process_receipt` (358), the domain's only real workflow |
| `budgets_expenses` | `/m import budget`, `/m budget report` | never mentions `edit_budget` (357) — registered, intent-routed, invisible |
| `flashcards` | `/m review`, `/m study`, `/m quiz` | the domain holds exactly one workflow; **two of the three route nowhere** |

**The drift runs in both directions** — it under-reports everything built since the domain was
created and over-reports workflows that were deleted. **The answer is already stored and nothing
reads it:** `PGC_Workflow` rows carry `domain`, `name`, `description` and `intent_keywords`.

**Acceptance:** AC1.

### Track B — The inventory correction workflow

Four verbs over the same two tables, designed as **one** workflow rather than four:

1. **Rename** an item (`PGD_Inventory` 25 is a red wine recorded as "Ink Cartridge")
2. **Merge** a duplicate into another item, moving quantities and aliases with it
3. **Recategorise** an item, and **aggregate** two `PGD_InventoryCategory` rows that mean the same thing
4. **Fix an alias** — repoint or delete one that resolves to the wrong product

**This is containment, not cleanup.** An alias hit is precisely the path that avoids human review,
so a wrong alias applies itself silently on every future shop. Run 782 stored `PAN MOLD INT ALTEZ`
(wholemeal sliced bread) against inventory 17 *Rustic Sliced Bread*.

**Non-negotiable:** aliases are keyed on the **raw receipt string**, never on the English rendering.
Keying the wine's correction on "Ink Cartridge" would make a real ink purchase increment the wine.

**Built by Novia**, per the Sprint 10 direction. This is also the sprint's second data point on
whether she handles a *maintenance* workflow as well as she handled a greenfield one.

**Acceptance:** AC2.

### Track C — The vector thresholds, calibrated by Novia

**Two thresholds, not one**, and memory 298's bands were measured against neither pairing:

| Step | Comparison | Column |
|---|---|---|
| 8 | English → English | `name_embedding` |
| 8c | raw string → raw string | `alias_name_embedding` |

0.4 was inherited from a cross-lingual comparison that no longer exists on either step. **Three
wrong merges are the specimens:** `PANU BOL MIN SELEX` (mini bread rolls) → *Rustic Sliced Bread*;
`ARANDANOS DESH ALT` (dehydrated) → *Blueberries 300g* (fresh); `PAN MOLD INT ALTEZ` → *Rustic
Sliced Bread*.

Probes against live rows are free. The workflow edit is a domain artifact, so it goes through
`propose_workflow_fix`.

**Acceptance:** AC3.

### Track D — Administrative workflows, and the dialog defects they surface

The user will identify further administrative workflows during the sprint. **Two dialog defects are
already known and are in scope:**

**D1 — A table inside a reveal window cannot be scrolled vertically.** Left/right works; up/down
does not, so any table taller than the viewport has unreachable rows. This bounds every workflow
that presents a list for review — choosing which duplicate to merge means seeing all of them.
**Fault domain: Experience.** Establish what Block Kit actually permits before designing; the answer
may be pagination at the renderer, which would be a **contract change** between `/proc` and
`/ui/slack`, not a rendering tweak. No domain vocabulary in `/ui/slack` either way.

**D2 — Recategorise / aggregate categories.** Covered by Track B, listed here because it was
reported as a dialog problem: there is no route to it from any surface the user touches.

**Acceptance:** AC4.

### Track E — Retest `edit_budget`

Workflow 357 is at v6 and its runtime half has never been validated end-to-end through the Novia
path. This is Sprint 10's AC5 second half, carried.

**Acceptance:** AC5.

---

## Acceptance Criteria

| # | Criterion | Track | Threshold |
|---|---|---|---|
| **AC1** | `/help` names every registered workflow for a domain, and names no command that routes nowhere | A | Binary, verified live on `inventory`, `budgets_expenses` and `flashcards` |
| **AC2** | One correction workflow performs rename, merge, recategorise and alias-fix; `PGD_Inventory` 25 and the `PAN MOLD INT ALTEZ` alias are both corrected through it | B | Binary, from Slack, no raw SQL |
| **AC3** | Both thresholds calibrated against live rows and applied via `propose_workflow_fix`; the three known wrong merges no longer auto-resolve | C | Binary, evidenced by probe output before and after |
| **AC4** | A table taller than the reveal viewport is fully reachable by the user | D | Binary, verified live |
| **AC5** | `edit_budget` runs end-to-end from Slack | E | Binary |
| **AC6** | Release-readiness: **decided, not defaulted** — either scoped into this sprint or deferred with a written reason | — | A decision exists on the record |

**AC6 exists because release-readiness has now been deferred five sprints running (7, 8, 9, 10, and
by this scope, 11).** The GO removed its stated justification — *"handoff infrastructure is not
worth building for a project that may be cancelled"*. This AC does not require the work; it requires
that the fifth deferral be a decision rather than an outcome.

---

## Standing observations — not tasks

These resolve on events outside the sprint's control. **Record them when they happen; do not
schedule them.**

| # | Observation | Resolves when |
|---|---|---|
| **AC9 (Sprint 10)** | Per-receipt cost falls with use — third < first, same merchant | An ordinary shop produces a MASYMAS receipt whose items overlap the alias table. **Protocol pre-registered** in `sprint-10.md`: per-item step-10 input tokens against the **831** baseline, per-item cost against **$0.0073**, auto-matched count as support. Raw per-receipt cost is explicitly *not* the criterion |
| **AC13 (Sprint 10)** | Novia's home-intelligence proposal convinces the friend | The user shows it to him. Built and dry-run (session 1151); the deciding half is his judgement |

---

## Out of Scope

| Item | Why |
|---|---|
| **Output-token cost reduction** | Now ~48% of a receipt run and the largest remaining cost term, but **unmeasured and undiagnosed**. Backlog entry raised as a pointer, not a diagnosis. Measure before optimising; a sprint that opens with an optimisation target and no measurement repeats Sprint 9's AC9 |
| **The prefix forfeit on the prose-reply path and gate resume** | Real and worth 58% of one session, but it is Novia-loop cost, not usability. Backlog, High Priority |
| **`create_domain`'s unconsumed derived-field rules** | Unchanged. Sequence *do not denormalize* first |
| **`create_workflow` repairs of any kind** | Retired by the Sprint 10 direction. `design_workflow_dialogs` v19 is spliced. Do not run it |
| **`/chat` dead code removal** | Independent, still undecided |

---

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] L0/L1/L2 pass on every workflow built or modified this sprint
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated if any `.mjs` added/removed/renamed or any decision made
- [ ] `docs/arch-data.md` updated if any schema changes
- [ ] `docs/arch-workflow-patterns.md` / `docs/arch-step-types.md` updated if the reveal contract changes
- [ ] `README.md` updated if environment setup or bootstrap changed
- [ ] `docs/backlog.md` updated — items completed, new items added
- [ ] `docs/sprints/CURRENT.md` → `docs/sprints/sprint-11.md` with outcome notes and a retro
- [ ] **AC6 — the release-readiness decision is written down**

---

## Session Notes

### Session 1 — 2026-08-22 — Sprint 10 closed, Sprint 11 scoped

Sprint 10 closed **GO**: 9 PASS, 2 MARGINAL, 2 NOT MEASURED. Both Execution defects blocking AC9
were fixed, deployed and re-probed the same day, and a third surfaced from the re-probe. AC9 itself
could not be measured — run 782's receipt had zero vocabulary overlap with the alias table — and is
carried here as a standing observation rather than a task.

Sprint 11's items came from the user's own use of the system, in this order: `/help`, the inventory
correction workflow, further administrative workflows to be identified, and a retest of
`edit_budget`. Two dialog defects were reported alongside them: vertical scrolling in a reveal
window, and the absence of any route to recategorise or aggregate an inventory category.

### Session 2 — 2026-08-23 — Track A implemented; awaiting live verification

`/help` now reads live workflows rather than a stored snapshot. The design question the track
opened with — write-time maintenance vs read-time derivation — was settled on **read-time**, on
the grounds that a bilingual or personalised invocation phrase added *after* registration is
exactly what a stored caption cannot learn. `PGC_IntentMap` is read live for that reason.

**The mechanism behind the under-report, found in this session:** `register_workflow` writes
`PGC_Workflow` and `PGC_IntentMap` and never `PGC_DomainHelp`, while `delete-workflow.mjs` step 7
still prunes `PGC_DomainHelp.commands` by a `workflow_id` tag only `create_workflow` step 36c ever
wrote. The system deletes from a list nothing populates. `PGC_DomainHelp.commands` also reaches
Novia — `search_domain_help` returns it verbatim — so the stale array misled its own author.

Shipped: `help` v9 → v10 (seed + upsert). `_embed_test` deleted from `PGC_DomainHelp`.
`docs/workflow-schema.json` gained serv_query's `columns`, missing since Sprint 10.
`échame tarjetas` added to workflow 341's `intent_keywords` as the live alias test.
1000/1000 unit tests pass.

**AC1 is not yet met** — the threshold is binary and verified live on three domains. Dry run
against live rows renders correctly for all four domains; the Slack run is the evidence.

**Still open on this track:** the system panel. It hardcodes `/create-workflow` (retired Sprint 10)
and `/chat` (removal undecided), and omits `/minds-eye` and `/replay`. Deleting `create_workflow`
and its related code is now a backlog item; whether the panel is corrected now or with that
deletion is undecided.

**Live confirmation, 2026-08-23:** the user ran `/help` → `flashcards` and sees `échame tarjetas`
listed under `flashcard_quiz_session`. The alias was added to `intent_keywords` *after* the workflow
was registered and no help entry was written for it — which is the read-time design doing the thing
a stored caption cannot. **AC1 remains open** until `inventory` and `budgets_expenses` are checked
too; its threshold names all three domains.

### Session 3 — 2026-08-23 — Aliases become a thing the user owns

Track A's read-time design turned out to have a second half nobody had named: if `/help` renders
invocation phrases live, then **the phrases themselves are a user-facing surface**, and there was
no way for the user to set one. Three changes, deployed together.

**`manage_routing_aliases`** — a new inline-write Novia tool. One concept at the boundary, two
surfaces underneath: `workflowName` writes `PGC_IntentMap` rows (Pass 1) and keeps
`intent_keywords` in step (Pass 2), as a delta so a divergent keyword survives an edit; `domain`
edits `PGC_DomainHelp.aliases`, which is in that row's `embed_source`, so the domain embedding is
recomputed and the change reaches `classify-intent` and not only `/help`. A phrase already bound
elsewhere is **refused, not shadowed** — that is the `modify budget` collision caught before it is
written rather than after it misroutes. A workflow's own name is never removed.

**`register_workflow` now refuses a domain workflow that names no phrase**, and the gate says so
before approval. `intent_keywords` derives from `intentPhrases` when omitted. A `domain: null`
system workflow legitimately has none, so the rule is not universal.

**The convention bridge explained how steps route and never how a user arrives.** It now states
both surfaces and, more to the point, that the phrases belong to the user — ask, in whatever
language they want to type. `sop_intent_routing` stopped teaching the raw `insert_data` path, which
left Pass 1 and Pass 2 disagreeing every time it was followed.

Also live: `search_domain_help` returns a domain's live `PGC_Workflow` rows, so the tool Novia uses
to resolve a domain can finally see the workflows she built. `docs/workflow-schema.json` gained
`serv_query`'s `columns`, missing since Sprint 10 — the validator was flagging a valid step.

Deployed: `sam deploy` + `upsert-system-context` (3 rows). 997 → **1012** unit tests.

### Session 4 — 2026-08-23 — D1 fixed; run 787 diagnosed; Novia measured against the same question

**Track D / AC4 — the reveal clip.** A `table` inside a reveal container is clipped at **8 rows**
with no vertical scroll, and Slack renders the first row of every table block as a header whatever
the cells declare. Both were measured, not published: the 8 came from run 779, and the probe that
settled it was a chunk built with 10 rows that still showed 8. `buildRevealTables()` now chunks a
long table into blocks of 8, each repeating the real header — run 779's 35 items render as five
blocks, all rows reachable. Two latent defects went with it, both able to fail a whole gate message
and leave a run suspended at a gate nobody saw: the 10,000-character table limit is per **message**,
not per table, and the container's 10-child-block ceiling was enforced on the prose path only. The
hand-copied duplicates of these functions in `callback.test.mjs` were deleted and the real ones
imported. **The two limits compound to roughly 70 rows per reveal** — backlog, not work; nothing
observed comes close. A Slack bug report on both behaviours was filed by the user.

**Run 787 — the reprocessed receipt, and the strongest AC9 evidence so far.** Same receipt as run
779, date changed. **33 of 35 auto-matched, against 779's 2.** The alias machine works.

Two items did not, and they are different stories:

- `PALOMITAS SAL PACK 3` — run 779 **auto-matched** it and wrote no alias. Step 12's
  `new_aliases_resolved` maps `plan.llm_resolved` only, so `auto_matched` items never persist their
  raw receipt string. **The learning loop only learns from the slow paths.**
- `BARRA DE PAN` — alias 44 existed from run 779 and a direct probe returns it at **similarity
  1.0**, but the row that reached the model carried **0.428**. That number belongs to
  `PAN M. 100%INT FAM`, three items earlier: step 8d's `if (!seen[row.id])` keeps the first-seen
  copy and discarded the 1.0 from the item's own query. The model declined correctly on corrupted
  input. **Similarity is a per-query score and the flatten destroys the query it belongs to** —
  step 8b has the identical flaw. Result: inventory 69 *Bread Loaf* duplicates 39 *Baguette*, and
  alias 86 now points at the duplicate, so it is self-reinforcing.

**The same question was put to Novia, twice, and the index change is the only variable.**

| | Session 1172 (before) | Session 1173 (after) |
|---|---|---|
| Tool calls | 69 | **31** |
| Elapsed | 254.9s, killed by wall clock | 209.0s, finished |
| Answer | none | complete |

1172 spent ~45 calls re-slicing `PGC_WorkflowRunStep.output_snapshot->>'summary'` — a 200-character
breadcrumb (100 for an iterator item), so widening the query never widened the value. The context
index named that table as a correction-task source and said nothing about the truncation, and its
documented join to `PGC_SessionEntry` was **wrong**: it said to read `PGC_WorkflowRun.session_id`,
which is null on workflow runs. The link is `PGC_Session.run_id`. Fixed as an **Instruction** change
(`minds_eye_context_index` v2): each source now states what it holds, what it cannot answer, and why
`PGC_SessionEntry` is where a model's actual input lives.

1173 pivoted to `state->'local_state'` at turn 12 and **found the 0.43** — the contradiction that is
the whole diagnosis, and which 1172 never saw. She then attributed it to a stale
`alias_name_embedding` rather than to the dedupe, having already checked twice that the embedding
exists; one `vectorSearch` probe would have falsified it. Her diagnosis moved from **wrong layer**
(1172: "an LLM reasoning failure") to **right layer, wrong component**. She found the step 12
alias-write gap independently and correctly — better than this session managed unaided.

**Two things in her answer not to trust.** She cites a *"0.82 auto threshold"* that exists nowhere
in workflow 358 or the `match_inventory_items` prompt. And she claims extending the alias write to
`auto_matched` "closes both issues" — it closes PALOMITAS only; `BARRA DE PAN` already had its
alias, and the 8b/8d dedupe is untouched by it.

**User's decision: go with Novia's fix and retest later.** The dedupe defect stays open.

### Session 5 — 2026-08-26 — Run 788 checked; Novia's repair loop is open at both ends

**Run 788 wrote nothing.** The step 11 gate was answered *Skip inventory*: the run went
11 → 13 → end. `write_plan`, `alias_write_plan` and `inserted_aliases` are all absent from
`local_state`; only the expense (id 205) was written, at step 6. **Workflow 358 v5 — Novia's
fix — has never executed.**

**The two one-offs are two different defects.**

`BARRA DE PAN` → new item is the 8b/8d dedupe, unchanged and now measured. Alias 44 appears in
three of run 788's `alias_candidate_sets`: **1.0** on its own query (item 20), 0.4283 on item
17's (`PAN M. 100%INT FAM`), 0.4203 on item 21's. Item 17 runs first, `if (!seen[row.id])` keeps
it, and session 1175's assembled system message carries `similarity: 0.42826780146698473`.
**Across 35 items, 10 lost their exact 1.0 this way** — 6 more on the inventory side, where the
flattened score for `Rustic Sliced Bread` (0.5175) belongs to neither of the two bread queries
that surfaced it. Only one failed visibly, because the English-name path rescued the other nine:
the ~3% you see is 29% latent × the name path also failing. It is order-dependent, so it does
not converge with use — a different receipt order loses a different ten. `BARRA DE PAN` sits in
item 17's **fifth and last** top-5 slot by 0.04, so today's bread could displace it and look like
a fix while breaking something else.

`COPO INTE 0% AZUCAR` → llm_resolved was **Instruction**, and is already closed. Step 4 rendered
the same string as *"0% Sugar Integral Flakes"* in run 787 and *"0% Sugar Whole Yogurt"* in 788.
Alias 27 reached the model at 1.0, but the prompt it actually received (session 1175) carried no
similarity bands at all. `match_inventory_items` v3 now states the 1.0 rule.

**A new defect in the v5 fix.** Step 12 maps `plan.auto_matched` unconditionally, but an item is
auto-matched *because* an alias already matched it. `PGD_InventoryAlias` has
`uq_inventoryalias_inventory_alias` unique on `(inventory_id, alias_name)`; step 12k is a plain
`serv_insert`, one multi-row statement, `on_else: cancel`, no ON CONFLICT. The next Apply inserts
34 duplicates and aborts the statement — **after** quantity updates and item inserts have
committed, so re-running that receipt would double-increment every quantity.

**Three replacement expressions are drafted and tested** against run 788's real `local_state`:
8b/8d keep the highest score per row instead of the first seen (exact-1.0 alias rows 25 → 35;
`BARRA DE PAN` reaches the model at 1.0), and step 12 emits an alias only when one is not already
stored (0 rows instead of 34, while a synthetic name-matched item still writes exactly one).
Paste-ready brief and full rationale: **`docs/receipt-matching-analysis.md`**.

**Checking Novia's work turned into the sprint's finding.** Her stale-embedding attribution was
falsified by her own probe: entry 4315, run before she changed anything, returned
`similarity_to_44 = 1` for alias 44 against itself, and `PAN M. 100%INT FAM` at
`0.42826780146698473` — the exact number that reached the model, i.e. her own output printed the
provenance of the 0.428. She read the table for what the embedding *represented* and moved on.
Her memory 333 cites the "fresh" embedding on alias 87 at 0.49/0.48 to `Bread` and
`PAN MOLDE RUSTICO`; her pre-fix probe returned 0.4888/0.4815. **She verified two fixes by
reproducing the pre-fix measurement.**

**Why, and this is the part that does not need a better model.** Across ~40 SQL calls she read
`state->'local_state'->'alias_candidates'` twice and `alias_candidate_sets` never — the key
produced one step earlier, in the same JSON object. Two structural reasons:

1. **`PGC_WorkflowRunStep.output_snapshot` is a 200-character stub** (`run-workflow.mjs:443`; 100
   for iterator items at `:1426`, `:1549`). The per-step record can say a step ran and never what
   it produced, which forces every real diagnosis into `local_state` — a flat bag with no step
   attribution, where a derived key is indistinguishable from a recorded one.
2. **She cannot test a fix against the failing case.** `simulate_workflow` is L0/L1/L2 and
   executes nothing; `run_workflow` needs a new receipt through a gate. The replay harness does
   exactly this, costs nothing, and **is not in her tool list**. Every verification available to
   her is a proxy, and both of hers confirmed.

Then memory closed the loop with an assertion: 328 is titled `CONFIRMED ROOT CAUSES`, and **334
is `procedural`** — a general rule stating `update_data` skips embedding recompute on an
unchanged value. `table.mjs:597` recomputes on **key presence**, not value change, so the rule is
false and was never tested. Being wrong and being finished are currently indistinguishable to
her. Both system items raised to backlog High Priority.

### Session 6 — 2026-08-27 — Novia's repair loop is blind at both ends, and it is measured

**The session started as a review of her diagnosis and ended as a system finding.** Session 1176
was run deliberately without spoon-feeding: the two defects were stated with their evidence, the
fix expressions were withheld. She produced both fixes herself. Then checking her work found why
she had missed the defects in the first place — and it is not her.

**Contract fix shipped (`8c4caa1`, upserted).** `serv_query.output_contract` and
`iterator.output_contract` both described their inputs in detail and their outputs in one
sentence. `serv_query` spends ~350 words on `vectorSearch`'s inputs and never says the returned
rows carry a `similarity` field at all; `iterator` says it "collects results" and never says an
array-returning item_step yields an array of arrays. Cross the two and you get 8b/8d exactly: a
per-query score, collected per item, flattened by row id with first-seen-wins. **Fault domain:
Contract.** Both additions are generic — any workflow that vector-searches inside an iterator
meets this seam, and no simulation level can see it. The exception is stated alongside the rule:
dedup by row identity is *correct* when the flatten exists to cut tokens and nothing downstream
reads the scores. That is what memory 318 records 8b/8d being built to do; the defect is that the
scores were read. Novia reviewed both additions and accepted the substance; her framing fix on the
last `serv_query` sentence and her concrete provenance remedy on `iterator` were taken, her
proposal to delete the exception was not.

**Why she missed it: nothing told her a similarity is query-relative.** She wrote 8b/8d herself
(memory 318, the v2→v3 vector pre-filter), and her own record gives the frame — token reduction,
counted in rows: *"at most 20×8 = 160 inventory rows before dedup… typically 10–30 unique
candidates."* In that frame "which copy survives" is not a question that exists. Her only source
on the score is `minds_eye_tool_schemas`, which says *"every returned row carries a similarity
score"* — a row property, phrased as a row property, on a single-call tool where the
query-relativity never has to be stated. Given the concept in one sentence she derived max-wins
unaided, including the ranking rationale, which was not in the prompt. **Availability gap, not
capability gap.**

**`read_memory` returned none of it.** `minds-eye.mjs:2274` defaults to `limit 10` ordered by
`priority desc`. Nine auto-written *"Completed workflow 'process_receipt' for domain 'inventory'."*
stubs carry **priority 8**; every considered diagnosis — 327, 328, 329, 330, 331, 333, 334 — carries
**priority 5**. The stubs take nine of ten slots. Not one diagnosis memory reached her, and she then
wrote 335 re-deriving ground 328 and 333 already covered. The inversion worth keeping: **the
memories she was denied were mostly wrong** — 327 blames translation, 330/331/333 build the
stale-embedding theory, and 334 is a *procedural* memory asserting `update_data` skips embedding
recompute on an unchanged value, which `table.mjs:597` falsifies (it recomputes on key presence).
1176 may be clean *because* retrieval failed. Raising the limit without deleting 327/330/331/333/334
hands her four false memories including one false system rule.

**v6 carried four changes beyond the two agreed, none of them reported.** 12c's `output_key`
renamed `quantity_update_results` → `updated_rows`; 12h and 12k lost their explicit `on_success`
tokens (behaviourally identical today, but step *order* is now load-bearing); and step 13's notify
template was rewritten, dropping the alias count, category, payment method and grocery flag. v5's
`💾 Aliases written: {{inserted_aliases.length}}` was live and working — run 787's
`local_state.inserted_aliases` holds 2 rows.

**Then the two system defects, both measured, both raised to backlog High Priority.**

1. **The transcript truncates the artifact she is editing.** `MAX_TOOL_OUTPUT_CHARS = 15000`.
   `read_workflow('process_receipt')` is **19,125 characters**; step 13 begins at **18,395** and its
   alias line at **19,049**. The last **4,125 characters are dropped**, and step 13 is the
   second-to-last step. All four of her full-array reads this session were cut identically. Her
   account — *"I composed step 13's message_template from memory rather than copying it verbatim
   from read_workflow"* — is literally true: **the transcript never showed it to her.** The comment
   above the constant is the tell — the cap is never applied to a call's *arguments* because Sprint
   9's largest defect was her losing sight of work she had submitted, but the artifact under edit
   arrives as an *output*. The protection covers what she wrote and not what she is changing.

2. **The approval gate cannot show the fields that carry the change.** `DIFF_FIELDS` is a fixed
   allow-list omitting `message_template`, `output_key`, `input`, `items_key`, `item_step`,
   `fields`, `options`. Step 13 *was* detected as changed, so the gate printed its heading and
   listed nothing beneath it — which is why her observation ("no diff for step 13") was correct
   even though her explanation of it was not. Four unagreed changes were approved without being
   rendered.

**And nothing archives what was replaced.** `PGC_Workflow` holds one row per workflow; `version` is
a counter overwritten in place. There is no version table, and `PGC_WorkflowRun` stores
`workflow_id` with no steps snapshot. v5 survives only in `PGC_SessionEntry` 4370 and in
`docs/receipt-matching-analysis.md`. **She cannot see the whole artifact, the gate cannot show what
she changed, and nothing keeps what was overwritten.** The three compound.

**v7 restored step 13 and its number is wrong.** She used
`{{alias_write_plan.alias_rows.length}}` — what was *submitted*, which after the upsert includes
every already-known alias. The next receipt will read *"35 aliases written"* when one is new,
inverting the AC9 signal precisely when it matters. Her stated reason for rejecting
`alias_write_result` (unset when step 12k is skipped) applies equally to `alias_write_plan`: step 6
routes a non-grocery receipt straight to 13, so 12i never runs either. `match_plan` is unset on
that path too — the notify has been broken there since v5, pre-existing.

### Priority call — 2026-08-27

**The two system defects above come before Track B, before the Mercadona run, and before the v8
message.** Every remaining sprint item routes through Novia editing a workflow, and that loop is
currently blind at both ends. Fixing the receipt while the repair loop cannot show her the artifact
or show the user the diff means the next repair reintroduces the next silent regression.

### Open for next session

1. **Fix the two repair-loop defects first** — backlog High Priority, both dated 2026-08-27.
   `MAX_TOOL_OUTPUT_CHARS` and `DIFF_FIELDS`. **Fault domain: Execution** — both are engine
   defects in system code, so they are fixed in code, not by prompt or artifact.
2. **Then send the v8 message below.** Do not send it before (1): v8 is a workflow edit, and it is
   the first honest test of whether the fixed gate renders what she actually changed.
3. **Then process the Mercadona receipt and Apply.** Still the live test of both v6 fixes and the
   AC9 measurement in one run. Pre-registered protocol unchanged: per-item step-10 input tokens
   against **831**, per-item cost against **$0.0073**, auto-matched count as support.
4. **Then Track B**, with `CAPERUCITA TINTA` as the specimen — inventory 25 is a red wine named
   "Ink Cartridge"; alias 30 is correct and must not change. A rename keyed on a raw alias: exactly
   the Track B verb.
5. **Novia's false memories** — 327, 330, 331, 333 and **334** (procedural, false system rule). Ask
   her to falsify each with the query in hand; delete what she cannot defend. 328 and 329 are
   accurate — keep. Do this *before* any `read_memory` limit change, or the limit change hands her
   the false ones.
6. **The `read_memory` limit-10-by-priority default**, and the workflow-completion hook writing
   priority-8 one-line stubs. Nine of them currently outrank every diagnosis in the system.
7. **The cold read** — a *fresh* session, the two revised contracts plus run 788's `local_state`,
   no diagnosis, and see whether she reaches 8b/8d unaided. 1176 is contaminated for this test.
   It is the only thing that measures whether the contract edit closed the gap.
8. **AC1** — verify `/help` live on `inventory` and `budgets_expenses`; `flashcards` is confirmed.
9. **AC4** — verify the chunked reveal live on the next receipt.
10. Still open from earlier: the system panel in `/help` (names `/create-workflow` and `/chat`,
    omits `/minds-eye` and `/replay`), and `register_workflow` writing `source: 'auto'` for phrases
    the SOP now says to ask the user for.
11. Consider preserving v5 in `docs/` and raising workflow version history as a backlog item —
    a workflow edit is currently irreversible by design.

### The v8 message — paste into `/novia` after the two engine fixes are deployed

```text
Step 13's alias count in v7 reports the wrong number. Check it against the data before
changing anything.

  SELECT r."state"->'local_state'->'alias_write_plan' FROM "PGC_WorkflowRun" r WHERE r."id"=788;
  SELECT s->>'step', s->>'message_template' FROM "PGC_Workflow" w,
    jsonb_array_elements(w.steps) s WHERE w.name='process_receipt' AND s->>'step'='13';

alias_write_plan.alias_rows is what step 12i SUBMITS to 12k. Since step 12 still maps
plan.auto_matched unconditionally, that list contains every alias that already existed —
run 788's plan carried 34 of them and 1 genuinely new. So v7 will report "35 aliases
written" on a receipt where one alias was learned. That is the opposite of the signal I
need: this number is how I tell whether the matching loop is still learning new vocabulary
or has settled onto known items, and an inflated count hides the settling.

serv_upsert returns what distinguishes them. Read its output_contract.

Two other things to resolve while you are in step 13:

1. You rejected alias_write_result because it is unset when 12k is skipped. That is true,
   and it is equally true of alias_write_plan: step 6 routes a non-grocery receipt straight
   to 13, so 12i never runs either. match_plan is unset on that path as well, and has been
   since v5. Decide what step 13 should say on a non-grocery receipt and make every token
   in it resolve on both paths.

2. Tell me what "aliases written" should count when the same raw receipt string appears
   twice on one receipt.

Submit as one propose_workflow_fix. Read the current array with read_workflow and change
only step 13 — the gate now shows me every field you touch, including message_template.
```
