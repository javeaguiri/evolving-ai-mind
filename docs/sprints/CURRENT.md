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
