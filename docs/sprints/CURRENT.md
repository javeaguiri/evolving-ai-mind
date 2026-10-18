# Sprint 14 — The budget grid, and seeing a gate before it is built

**Status: PROPOSED 2026-10-18, at Sprint 13's close — scope is agreed at "start sprint".**
Read `docs/sprints/sprint-13.md` §Retro first.

**Branch (proposed):** `sprint/14-budget-grid-and-preview`

> Every AC below was carried from Sprint 13 by Javear's decision on 2026-10-18. The retro's point
> stands: the engine gaps already known are scoped as items here, not left to surface.

---

## Sprint Goal

**Make `manage_budget` the reference small-grid edit — one form, grouped, saving only what
changed — and give Novia a way to see a gate before she builds it.**

---

## Scope

| # | Item |
|---|---|
| **1** | **`manage_budget` (`edit_budget`, workflow 357 v7) — four findings from runs 914/915**, sent to Novia as findings, not fixes: (a) every save writes all 21 rows — step 15 builds one per category, changed or not; (b) amounts are `text` fields read with `parseFloat`, so `12,50` saves as 12 silently — the `number` field exists; (c) step 15 hardcodes `currency: 'USD'` on every row in a euro household, and the summary prints `$`; (d) grouping is a `[Income]` label prefix. It is a one-column small grid (~21 rows) — **not** `manage_expenses`' pick-one |
| **2** | **A form field `group` that renders a heading where it changes — Execution.** Form fields are inputs only (`step-executor.mjs` `case 'form'`), so nothing can render a sub-title between them. The standard form is HTML's `<fieldset>`/`<legend>`: a `group` on each field, a header block in `dialogToBlocks` where it changes, and the `human_gate` contract says so. ~3 headings + 21 fields is well under 50 blocks |
| **3** | **`preview_step`, headless — spec first.** Carried from Sprint 13 item 10 (`docs/backlog.md`, "Step preview"): one step against a chosen state through the real `buildDialog` → `dialogToBlocks`, returning a gate's block count and payload size. `openapi.yaml`, a `minds_eye_tool_schemas` row and `docs/arch-minds-eye.md` before code |
| **4** | **Measure Slack's message-size threshold** — Sprint 13 item 11. Outward posts to a test channel Javear names, each with his go-ahead |
| **5** | **The inventory correction workflow** — rename, merge, recategorise, alias-fix; specimens aliases **81**, **60**, **59**, keyed on the raw receipt string. Sprint 13 Track C, unchanged |
| **6** | *Candidate:* a `condition` on `special_buttons`, as `options` already take — the asymmetry behind `manage_expenses`' Delete-on-Add gap. Decide at scoping whether it is needed or whether options suffice |

## Acceptance Criteria

⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved. **Updated when a criterion's
state changes, not at close.**

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | A single gate edits several records and one click saves them all; **only changed rows are written** | [1](#scope) | Binary, from Slack |
| **AC2** | ⬜ | `manage_budget` uses it: amounts are numbers, currency is the household's, and income / non-discretionary / discretionary render under their own headings | [1](#scope), [2](#scope) | Binary, from Slack |
| **AC3** | ⬜ | Novia selects the pattern unprompted when a design calls for it — first cold design on `claude-opus-5-5` | [1](#scope) | Binary, from a cold `/novia` session |
| **AC4** | ⬜ | A gate that would exceed the ceiling fails in a way that names the cause and the remedy — measured before it is registered | [3](#scope), [4](#scope) | Binary |
| **AC6** | ⬜ | One correction workflow performs rename, merge, recategorise and alias-fix; aliases 81, 60 and 59 are corrected through it | [5](#scope) | Binary, from Slack, no raw SQL |

(AC5 was folded into AC2 at Sprint 13's close: `edit_budget` is `manage_budget`.)

## Out of scope

| Item | Why |
|---|---|
| A web experience layer | `docs/arch-home-brain.md` — an unpresented proposal |
| Release readiness | `docs/ops-release-readiness.md`, reviewed at the sprint boundary |
| A rendered (Slack-posting) `preview_step` | Headless first; the inert-button contract must be settled before a preview posts |

## Session Notes
