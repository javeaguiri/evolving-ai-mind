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
| **3** | **The real gap: what to do past the ceiling.** The contract's only remedy today is *filter that query down, or bound it with an explicit limit, and let the user narrow the list first* — it never mentions **paging**, and `nav_state` appears nowhere in any seed. `review_inventory` 359 v8 proved a workflow-local pager (buttons that hide at the ends, selection surviving page turns), so the pattern works and is simply undocumented |
| **4** | Apply it to `manage_budget` |
| **5** | Decide whether the >40-cell case pages, narrows, or refuses — and make the refusal say which |
| **6** | **`edit_budget` (357 v6), moved from Sprint 12 Track E.** Novia converts its edit flow to the bulk-edit pattern, **then** it is retested end to end from Slack — once, against the design that will survive. Carried from Sprint 9 and Sprint 11 |
| **7** | **The inventory correction workflow, moved whole from Sprint 12 Track C — see the section below.** Three of its four verbs are record edits over the same two tables, so it is the bulk-edit pattern's third consumer and its hardest test |
| **8** | **`manage_expenses`, carried from Sprint 12 Track F.** Designed and evaluated, not built. **Two corrections must be sent before the build** — the `payment_method` vocabulary mismatch and the hard delete both destroy data during the troubleshooting session itself |

## Out of scope

| Item | Why |
|---|---|
| A `table_edit` gate type | Decided against above |
| The data table block for the read side | A rendering change worth having, but it is a separate decision from making bulk edit work at all |
| A web experience layer | The only option that delivers real spreadsheet editing, and the only one that needs its own authentication. Design it when ~45 vertical cells has been used enough to say whether it is painful or merely inelegant |
| Release readiness | `docs/ops-release-readiness.md` |

---

## Acceptance Criteria

**Status as of 2026-09-22.** ⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved.
**This table is updated when a criterion's state changes, not at close** — it is how the sprint's
position is read at a glance.

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | A single gate edits several records and one click saves them all; only changed rows are written | [1](#scope) | Binary, from Slack |
| **AC2** | ⬜ | `manage_budget` uses it | [4](#scope) | Binary, from Slack |
| **AC3** | ⬜ | Novia selects the pattern unprompted when a design calls for it | [2](#scope), [3](#scope) | Binary, from a cold `/novia` session |
| **AC4** | ⬜ | A gate that would exceed the ceiling fails in a way that names the cause and the remedy | [3](#scope), [5](#scope) | Binary |
| **AC5** | ⬜ | `edit_budget` uses the pattern and runs end to end from Slack | [6](#scope) | Binary, from Slack |
| **AC6** | ⬜ | One correction workflow performs rename, merge, recategorise and alias-fix; aliases **81**, **60** and **59** are corrected through it | [7](#scope), [Track C](#track-c-moved-from-sprint-12--the-inventory-correction-workflow) | Binary, from Slack, no raw SQL |
| **AC7** | ⬜ | `manage_expenses` is built by Novia and runs end to end — add, delete and edit — with the two data-destroying corrections applied and the delete semantics decided | [8](#scope) | Binary, from Slack |

---

## Track C (moved from Sprint 12) — the inventory correction workflow

**Carried from Sprint 11 AC2, unstarted.** Four verbs over the same two tables, designed as **one**
workflow rather than four:

1. **Rename** an item — `PGD_Inventory` 25 is a red wine recorded as "Ink Cartridge"
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

## Carried from Sprint 12

`manage_expenses` (Sprint 12 AC7, unbuilt) carries forward. **Track D is closed, not carried** —
its premise inverted and its alias work now rides with Track C. **Tracks C and E are scope items 7
and 6 above, not carry-forward.** `manage_expenses` has a reason to wait —
its edit branch is the second consumer of this sprint's pattern, and building it first means
building it twice.
