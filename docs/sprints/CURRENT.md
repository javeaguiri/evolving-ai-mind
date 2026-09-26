# Sprint 13 — Editing a list of records

**Status: ACTIVE. Opened 2026-09-22**, when Sprint 12 closed. Sprint 12's outcome and retro are
in `docs/sprints/sprint-12.md` — read its retro before adding anything to this sprint.

**Branch:** `sprint/13-bulk-record-edit`

> **Sprint 12's retro asks this sprint not to grow.** Two sprints running have scoped five and
> seven acceptance criteria and delivered two apiece, with most of the real work unscoped. This
> sprint opens with six criteria, three of them inherited work that is already designed. That is
> the ceiling, not the floor.

> Release readiness is **not** in this sprint. It is a standing workstream in
> `docs/ops-release-readiness.md`, reviewed at this sprint's boundary rather than scoped into it.

---

## Sprint Goal

**Make "change several records and save once" a thing a workflow can do, without inventing a new
way to render a gate.**

There is no good way to edit a list of records today. Every correction is one record at a time
through a gate that reloads between each. `manage_budget` wants it — twelve categories, one
editable amount each — and so does the edit branch of `manage_expenses`.

---

## The decision this sprint rests on: no new `gate_type`

**A "table edit" gate type was proposed and rejected on 2026-09-22.**

`gate_type` governs **rendering only**. The test is whether the thing renders differently from
what already exists, and it does not: a bulk edit is the existing `form` gate with more fields.
The `form` gate's own contract says so (`step-executor.mjs:505-509`):

> *"form — collect any number of typed values in one gate. **Replaces what would otherwise be a new
> gate_type per widget** (select_one, select_many, date_input, …): a widget is a field type, not a
> gate type."*

Two gate types rendering identically would let Novia pick either with nothing downstream
differing — a distinction with no mechanism behind it. The seven existing types
(`list_selection`, `form`, `text_input`, `confirm`, `review_object`, `choice`,
`followup_prompt`) each earn their own rendering.

**Where a change would be legitimate, if this sprint decides it wants one:** a header row, aligned
columns, or the new Block Kit data table block above the inputs are all **rendering**. Those are a
new widget row in the renderer or a new field `input_type` — `callback.mjs:1235` and `1598` both
say so explicitly — and still never a new `gate_type`.

---

## What already exists, and has never been used

The save-all-at-once mechanism is **already built**. Nothing in system code needs to change for
the basic case:

| Piece | Where | What it gives |
|---|---|---|
| `resolveFormFields` | `step-executor.mjs:386-392` | `step.fields` accepts a `{{template}}` resolving out of `local_state` — **the field list is data, not authoring** |
| `collectFormValues` | `form-fields.mjs:58-76` | Returns *every* rendered form field's value, keyed by the name encoded in its `block_id`, on one button click |
| The block guard | `callback.mjs:287, 579-600` | `SLACK_BLOCK_LIMIT = 50` with an input-aware message when a gate exceeds it |

So a `js_transform` emits one field per editable cell, the gate renders them, one click returns
all of them, and a second `js_transform` diffs against the loaded rows and writes only what
changed.

**The ceiling is 50, not 100.** Form gates go out as messages via `chat.postMessage`; Slack caps a
message at 50 blocks. Modals allow 100, but only `text_input` gates use `views.open`. That is
**~45 editable cells** after the message and header blocks, stacked vertically — no column
alignment, no tabbing across, no pasting a range.

**Keep the row-id encoding out of system code.** The workflow's own `js_transform` encodes and
decodes the field name that carries a row id, so it stays workflow-local rather than becoming a
proprietary syntax the harness has to learn.

---

## Scope

| # | Item |
|---|---|
| **1** | The bulk-edit pattern as a reference workflow: load rows → `js_transform` builds `fields` → `form` gate → `js_transform` diffs → iterator writes only changed rows |
| **2** | ~~The `human_gate` contract gains the dynamic-`fields` example~~ **ALREADY DONE — verified live 2026-09-22.** The contract already states that `fields` takes a `{{template}}`, frames it as *one field PER RECORD the workflow just read*, says *reach for it whenever the number of things to edit is known only at runtime*, and gives the ceiling **with the multiplication rule**: *"~40 rows at one field each but only ~13 at three"* |
| **3** | **The real gap: what to do past the ceiling.** ✅ **CONTRACT LANDED 2026-09-26** — `gate_type` now opens with a seven-question decision tree (first yes wins, question 7 answering *then it is not a gate — use notify*), and `fields` carries the four routes past the ceiling (narrow, page, pick one, refuse) plus the paging mechanism drawn from `review_inventory` 359 v8. The row description stops describing the types a second time and states only what all gates share. ⬜ **The L1 half is outstanding** — see scope item 9 |
| **4** | Apply it to `manage_budget` |
| **5** | Decide whether the >40-cell case pages, narrows, or refuses — and make the refusal say which |
| **6** | **`edit_budget` (357 v6), moved from Sprint 12 Track E.** Novia converts its edit flow to the bulk-edit pattern, **then** it is retested end to end from Slack — once, against the design that will survive. Carried from Sprint 9 and Sprint 11 |
| **7** | **The inventory correction workflow, moved whole from Sprint 12 Track C — see the section below.** Three of its four verbs are record edits over the same two tables, so it is the bulk-edit pattern's third consumer and its hardest test |
| **8** | **`manage_expenses`, carried from Sprint 12 Track F.** Designed and evaluated, not built. **Two corrections must be sent before the build** — the `payment_method` vocabulary mismatch and the hard delete both destroy data during the troubleshooting session itself |
| **9** | **`gate_too_many_fields` cannot see the case it exists for.** It guards `Array.isArray(s.fields)`, so a `"{{template}}"` fields reference is skipped — and that is the only shape whose length is a row count. `gate_option_set_unbounded` already solved the identical problem one field apart (walk back to every writer of the key, refuse an unbounded `serv_*`, warn where the length is unknowable); reuse it against `MAX_GATE_FIELDS`. Its current remedy text also prescribes one-record-at-a-time editing, which is the design this sprint replaces. **Held until Novia's feedback** — her behaviour against the new contract says whether the text alone suffices |

## Out of scope

| Item | Why |
|---|---|
| A `table_edit` gate type | Decided against above |
| The data table block for the read side | A rendering change worth having, but it is a separate decision from making bulk edit work at all |
| A web experience layer | The only option that delivers real spreadsheet editing, and the only one that needs its own authentication. Design it when ~45 vertical cells has been used enough to say whether it is painful or merely inelegant |
| Release readiness | `docs/ops-release-readiness.md` |

---

## Acceptance Criteria

**Status as of 2026-09-26.** ⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved.
**This table is updated when a criterion's state changes, not at close** — it is how the sprint's
position is read at a glance.

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | A single gate edits several records and one click saves them all; only changed rows are written | [1](#scope) | Binary, from Slack |
| **AC2** | ⬜ | `manage_budget` uses it | [4](#scope) | Binary, from Slack |
| **AC3** | 🟡 | Novia selects the pattern unprompted when a design calls for it | [2](#scope), [3](#scope) | Binary, from a cold `/novia` session |
| **AC4** | 🟡 | A gate that would exceed the ceiling fails in a way that names the cause and the remedy | [3](#scope), [5](#scope), [9](#scope) | Binary |
| **AC5** | ⬜ | `edit_budget` uses the pattern and runs end to end from Slack | [6](#scope) | Binary, from Slack |
| **AC6** | ⬜ | One correction workflow performs rename, merge, recategorise and alias-fix; aliases **81**, **60** and **59** are corrected through it | [7](#scope), [Track C](#track-c-moved-from-sprint-12--the-inventory-correction-workflow) | Binary, from Slack, no raw SQL |
| **AC7** | ⬜ | `manage_expenses` is built by Novia and runs end to end — add, delete and edit — with the two data-destroying corrections applied and the delete semantics decided | [8](#scope) | Binary, from Slack |

---

## Track C (moved from Sprint 12) — the inventory correction workflow

**Carried from Sprint 11 AC2, unstarted.** Four verbs over the same two tables, designed as **one**
workflow rather than four:

1. **Rename** an item. **The original specimen is already corrected** — `PGD_Inventory` 25 reads
   *"Cheap Wine (tinto de verano)"* as of 2026-09-13, not *"Ink Cartridge"*, and item 69 is gone.
   **Confirm whether those went through `review_inventory` from Slack**: AC6 requires no raw SQL,
   so if they did, two verbs are already evidenced and need only writing down. If they did not,
   a fresh specimen is needed
2. **Merge** a duplicate into another item, moving quantities and aliases with it — inventory 69
   *Bread Loaf* duplicates 39 *Baguette*, and alias 86 points at the duplicate, so it is
   self-reinforcing
3. **Recategorise** an item, and **aggregate** two `PGD_InventoryCategory` rows meaning the same
   thing
4. **Fix an alias** — repoint or delete one resolving to the wrong product. **Three live
   specimens, moved here from Track D 2026-09-22** — these are the test data, not invented cases:
   **81** `PAN MOLD INT ALTEZ` → 17 *Rustic Sliced Bread*, which should be 36 *Whole Wheat
   Sandwich Bread* (aliases 41 and 89 already resolve there correctly, which is what proves 81
   wrong by the system's own standard); **60** `PANU BOL MIN SELEX` → 17; **59**
   `ARANDANOS DESH ALT` (*deshidratados*, dried) → 6 *Blueberries 300g*, which is fresh

**This is containment, not cleanup.** An alias hit is precisely the path that avoids human review,
so a wrong alias applies itself silently on every future shop.

**Where it has already reached the user — read live 2026-09-22.** Item 17 *Rustic Sliced Bread*
stands at **2 bags**, item 36 *Whole Wheat Sandwich Bread* at **1**; both are category 15 with
`consumption_rate_per_day` 0.2. Every shop carrying that bread as `PAN MOLD INT ALTEZ` increments
the wrong one, and `review_inventory` computes the shopping list from those quantities — **so the
shopping list has been naming the wrong bread.** Small enough to go unnoticed, which is why it went
unnoticed rather than why it was not happening. It also compounds: alias 81 now matches at
**0.9978**, so it wins every future comparison and arrives at the gate labelled HIGH.

**Non-negotiable:** aliases are keyed on the **raw receipt string**, never the English rendering.
Keying the wine's correction on "Ink Cartridge" would make a real ink purchase increment the wine.

**Built by Novia**, and now through the patch loop. This is the sprint's second data point on
whether she handles maintenance work as well as greenfield.

**Acceptance:** AC6 below.

---

## What Sprint 12 left, and where it went

**Nothing is carried loose.** Every inherited item is a scope row above with an AC against it:
Track C → item 7 / AC6, Track E's `edit_budget` → item 6 / AC5, Track F's `manage_expenses` →
item 8 / AC7. **Track D is closed, not carried** — its premise inverted and its alias work now
rides with Track C. **Release readiness is not carried either** — it is a standing workstream at
`docs/ops-release-readiness.md`, reviewed at this sprint's boundary.

**`manage_expenses` is sequenced last for a reason**: its edit branch is a consumer of this
sprint's pattern, so building it before the pattern exists means building it twice. Its two
corrections must still be sent to Novia before any build starts.

**Standing observations — record when they happen, do not schedule:** AC9 (per-receipt cost falls
with use, protocol pre-registered in `sprint-10.md`), AC13 (the friend), workflow 358's v6/v7 fixes
which have still never executed, and **pooled candidate attribution** — whose trigger is *wrong
merges persisting after aliases 81, 60 and 59 are corrected*.

---

## Session Notes

### Session 1 — 2026-09-22 — Sprint 12 closed, Sprint 13 opened

**No code. Nothing deployed, nothing upserted** — main still reflects what is running in prod.

**Sprint 12 closed and merged** (`4307657`). 19 sessions, 1044 → **1177** tests. Two ACs met, two
withdrawn because the work was wrong rather than late, two moved here, one carried. Outcome and
retro in `docs/sprints/sprint-12.md` — **read its retro before adding anything to this sprint.**

**This sprint was scoped from a research question, not a backlog row.** *Can Slack do a
spreadsheet-style edit, and if not, can we build our own widget?* Answer: **no to both.** Block Kit
is the entire vocabulary available to an app — no custom HTML, JS or iframe; the only escape is a
button opening an external page. The **data table block** (20 May 2026) is a real grid at 201 rows
× 20 columns but takes only `raw_text` / `raw_number` / `rich_text`, holds **no inputs, selects,
buttons or checkboxes**, and is unsupported in modals. **Canvases** hold editable markdown tables
but round-trip as unschema'd markdown with no submit event bound to a record set.

**The finding that set the scope: the mechanism already exists and has never been used.** A bulk
edit is the `form` gate with a templated `fields` array — `resolveFormFields`
(`step-executor.mjs:386-392`) takes `step.fields` as a `{{template}}`, `collectFormValues`
(`form-fields.mjs:58-76`) returns every field on one click. And the live `human_gate` contract
**already** tells Novia to reach for it, frames it per record, and states the ceiling with the
fields-by-rows multiplication. **Scope item 2 was written before that was checked and is struck
through.** The one real gap is item 3: the contract's only remedy past the ceiling is *filter or
narrow* — it never says **page**, and `nav_state` appears in no seed, though `review_inventory`
359 v8 proved the pattern works.

**Three decisions taken, all on the record:** no `table_edit` gate type (now an invariant in
`architecture.md` §1.5); release readiness leaves the sprint container for
`docs/ops-release-readiness.md`; and `template.yaml` cannot stand up a second environment — R1,
which blocks R2. **Aurora was reopened as an option** after being written into four places as
decided by the analyst rather than the decider.

**Process change, from the user:** the AC table is a live status board — status column, a link to
the delivering scope item, updated when state changes rather than at close. On the lifecycle and
the enforcement list in `CLAUDE.md`, and merged to main separately (`083f942`) so the retro is
visible there.

**Next session starts here:** draft the paging remedy for the `human_gate` `PGC_StepType` contract
(scope item 3 → AC4), since it is the only real gap and it is what makes a Novia session test
something complete. Then the two `manage_expenses` corrections. **Before AC6, confirm whether
`PGD_Inventory` 25's rename and 69's merge went through `review_inventory` from Slack** — both are
already done in the data, and AC6 requires no raw SQL.

### Session 2 — 2026-09-26 — the gate-type decision tree, and paging

**Seed + upsert only. No code, nothing deployed** — `PGC_StepType.human_gate` upserted, live row
verified byte-equal to the seed. 1177 tests pass.

**The session's real finding was structural, and it came from a challenge to the plan.** The paging
text was first drafted as an appendix to the `fields` description. Asked where a gate-type *decision
tree* actually lives, the answer turned out to be: **nowhere clean.** The `human_gate` row described
its seven types **twice** — once in the row `description`, once in `gate_type` — neither pass shaped
as a decision, with the constraints in a third place.

**`PGC_StepType` is the tree, by design.** `workflow_convention_bridge` carries no gate-type
guidance deliberately and delegates twice: *"Which gate types write, and what value they write, is
declared on the human_gate row in PGC_StepType"*, and in its index, *"PGC_StepType — step fields,
gate types, routing options — query_table"*. Novia reads this row. So the row had to become the
tree rather than gain an appendix.

**Landed:** `gate_type` opens with seven ordered questions on what the gate must DO, first yes wins,
each naming what it writes — and question 7 answers *then it is not a gate at all: use a notify
step, which does not suspend*. The row `description` stops re-describing the types and states only
what all gates share, including that **local_state survives the suspension**, which is what makes a
re-entered gate possible. `fields` gains the four routes past the ceiling — narrow, page, pick one,
refuse, *"silence is not a fifth route"* — and the paging mechanism as engine facts: a **derived**
page size (ceiling ÷ fields per row), a unique-column tie-break, first/last-page flags as truthy
strings because `condition` routes on truthiness, `condition` on Previous/Next, one fold step
reading `action_key`, and a back edge to the slice step. All read out of `review_inventory` 359 v8,
which proved it live.

**The one clause 359 does not cover** is the editable page: 359's pager carries a *selection*, a bulk
edit carries *typed values*. A page turn that neither saves nor re-applies them lets the form's own
untouched-field-submits-its-default rule **revert the user's pending edits** from the stored row.

**`create_workflow` is out of scope as dead path — confirmed, not assumed.** `design_workflow_dialogs`
v19 has three live defects (its "Common Gate Patterns" table omits `form`, `list_selection` and
`followup_prompt`; the table, `{{human_gate_dialog_rules}}` and the closing line are each duplicated
verbatim; and an orphaned JS fragment is spliced onto a mid-prompt terminator). All real, all
unfixed: workflow 2 last ran **2026-07-25** and `fix_workflow` 316 last ran 2026-09-10 and failed.
Novia took both over, so no user is affected and there is no warrant.

**One suspicion raised and disproved in-session.** `PGC_SystemContext.step_type_contracts` holds a
second copy of the whole `human_gate` contract, **10 fields stale** — no `fields`, no `on_cancel`, no
`item_action`. It is **shadowed, not live**: `llm-harness.mjs:274` re-fetches fresh from
`PGC_StepType` and `assembleInstructions` spreads `resolvedInput` last. Verified against the real
assembled prompt in session **1118**, which carries `fields`, `on_cancel` and `action_key`. Dead
weight; a backlog row at most.

**Next session starts here:** Novia's feedback against the new contract — does she reach for the
pattern unprompted (AC3), and does she page when a set will not fit? **Scope item 9 is deliberately
held** until that answer, because her behaviour says whether the contract text alone suffices or the
L1 check has to say it too.

**Incidental, for AC6:** `review_inventory` 359 v8 already carries merge (steps 14–15f, including
alias re-pointing) and edit/delete (8–11f). Two of Track C's four verbs may already be built, which
reframes item 7 from *write it* to *test and extend it*. Run history not yet checked — a lead, not
the confirmation this sprint asks for.
