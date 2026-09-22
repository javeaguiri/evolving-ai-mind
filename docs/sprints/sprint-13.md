# Sprint 13 — Editing a list of records

**Status: SCOPED 2026-09-22. Not started.** Sprint 12 is still open; at its close this file
becomes the active sprint document (`git mv docs/sprints/sprint-13.md docs/sprints/CURRENT.md`)
and Sprint 12's `CURRENT.md` becomes `sprint-12.md`.

**Branch (when it starts):** `sprint/13-bulk-record-edit`

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
| **5** | Decide whether the >45-cell case pages, narrows, or refuses — and make the refusal say which |

## Out of scope

| Item | Why |
|---|---|
| A `table_edit` gate type | Decided against above |
| The data table block for the read side | A rendering change worth having, but it is a separate decision from making bulk edit work at all |
| A web experience layer | The only option that delivers real spreadsheet editing, and the only one that needs its own authentication. Design it when ~45 vertical cells has been used enough to say whether it is painful or merely inelegant |
| Release readiness | `docs/ops-release-readiness.md` |

---

## Acceptance Criteria

| # | Criterion | Threshold |
|---|---|---|
| **AC1** | A single gate edits several records and one click saves them all; only changed rows are written | Binary, from Slack |
| **AC2** | `manage_budget` uses it | Binary, from Slack |
| **AC3** | Novia selects the pattern unprompted when a design calls for it | Binary, from a cold `/novia` session |
| **AC4** | A gate that would exceed 50 blocks fails in a way that names the cause and the remedy | Binary |

---

## Carried from Sprint 12

Decided at Sprint 12's close, not here: `manage_expenses` (Sprint 12 AC7, unbuilt), the three
Track D decisions, and Track E's `edit_budget` retest. `manage_expenses` has a reason to wait —
its edit branch is the second consumer of this sprint's pattern, and building it first means
building it twice.
