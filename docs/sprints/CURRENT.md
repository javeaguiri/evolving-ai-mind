# Sprint 16 — The web app, Phase 0: prove the seam

**Status: PROPOSED 2026-11-07 (Wren), not started.** Scope, ACs and branch to be agreed with Javear
at "start sprint". The prior sprint's retro is `docs/sprints/sprint-15x.md`.

**Branch (proposed):** `sprint/16-web-phase0` — not created.

**Design:** `docs/arch-web-app.md` (approved v0.5), §10 Phase 0. Already built: `gate_id` and
`POST /proc/gates/{runId}/responses` (Sprint 15).

---

## Sprint Goal

**The household can sign in to a web page, see Home, Money and Inventory read-only, start a named
workflow and answer every type of gate it raises, and the run's messages arrive the same as in
Slack.** It proves that `/proc` drives a second experience layer from the same UI-agnostic
instructions.

---

## Scope (from §10 Phase 0)

| # | Item |
|---|---|
| **1** | ⬜ **Infrastructure:** S3 + CloudFront, a Cognito pool with one user, `WebApiFunction`, the web routes, and `deploy-web.mjs`. The Content Security Policy and the controls in §11 |
| **2** | ⬜ **The inbox:** `PGC_UiMessage`, written by `enqueueCallback` for `provider: 'web'`; `GET /proc/inbox` |
| **3** | ⬜ **Run labels (§2.4)**, `GET /proc/runs`, and starting a named workflow |
| **4** | ⬜ **Pages:** `PGC_Page` with the seeded Home; `upsert-page.mjs` for the household's pages from a household file (never system seeds); `GET /proc/pages` |
| **5** | ⬜ **Reads:** `GET /proc/gates`, `GET /proc/outputs` (§2.6), and the read-only `records` read behind `GET /sources/{source}/rows` |
| **6** | ⬜ **Contract:** `row`, `column` and `group` on the `human_gate` contract (`PGC_StepType`) |
| **7** | ⬜ **The shell:** sign-in; 🏠, the *Pages* and *Domains* menus, 🔔, ⚙; Settings › Profile; English catalogs from day one (§13) |
| **8** | ⬜ **Panels and widgets:** workflow panels (*Start*, runs by label, a run stepped through in place); data panels with `table` (read-only), `list`, `chart`, `metric` and `report`, click-through and report Refresh; domain pages; the run page and run drawer |
| **9** | ⬜ **Every gate type of §5.2**, because 🔔 reaches every waiting gate whichever provider started its run |
| **10** | ⬜ **Slack:** `gate_id` on buttons, and the ephemeral "already answered" |
| **11** | ⬜ **First workflow:** `manage_budget` (357): month pick, then one grid grouped by budget type, after Novia's four corrections |

## Acceptance Criteria (proposed)

⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved. **Updated when a criterion's
state changes, not at close.**

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | Javear signs in, and Home, Money and Inventory render from `PGC_Page` rows, read-only | [1](#scope), [4](#scope), [7](#scope), [8](#scope) | Shown live |
| **AC2** | ⬜ | A workflow started on the web runs to completion with every message in the web inbox, and none in Slack | [2](#scope), [3](#scope) | Shown live |
| **AC3** | ⬜ | Every §5.2 gate type renders and is answered on the web. A gate already answered elsewhere is refused (`409 gate_moved`) | [5](#scope), [9](#scope), [10](#scope) | One live run per gate type, or a named fallback vehicle (sprint-15x retro) |
| **AC4** | ⬜ | `manage_budget` edits a month's budgets in one grid grouped by type | [6](#scope), [11](#scope) | Shown live |
| **AC5** | ⬜ | No internal key reaches the browser, and every id-taking resource is checked against the principal | [1](#scope), [5](#scope) | Review against §11, and tests |
| **AC6** | ⬜ | Each new endpoint is in `openapi.yaml` before it is built, and its spec matches its code (sprint-15x retro) | all | Review at close |

## Out of scope

| Item | Why |
|---|---|
| Phase 1: the page editor, the `form` widget and editable tables, Novia's region and panels, Help, Activity, the command bar | §10 Phase 1 |
| WebSocket | Polling first, until it's felt (§10) |
| Tenancy | Deferred until the second household commits (`arch-home-brain.md`) |
| A custom domain | The CloudFront default serves Phase 0 (§12.3) |
