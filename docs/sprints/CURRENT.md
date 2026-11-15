# Sprint 16 — The web app's backend seam

**Status: STARTED 2026-11-15.** The first half of `docs/arch-web-app.md` §10 Phase 0, split at
scoping (Javear, 2026-11-15): the backend first, proven by curl; the front end is Sprint 17. The
prior sprint's retro is `docs/sprints/sprint-15x.md`.

**Branch:** `sprint/16-web-seam`

**Design:** `docs/arch-web-app.md` (approved v0.5), §10 Phase 0, PROC, Contract and Slack rows.
Already built: `gate_id` and `POST /proc/gates/{runId}/responses` (Sprint 15).

---

## Sprint Goal

**`/proc` drives a second provider.** A workflow started for `provider: 'web'` runs to completion
with every message in the web inbox and none in Slack; its gates are listed and answered over
HTTP; the household's pages and the data they read are served read-only. Everything the Sprint 17
front end needs exists behind a tested, specified API.

---

## Scope

| # | Item |
|---|---|
| **1** | 🟡 **The inbox:** `PGC_UiMessage`, written by `enqueueCallback` for `provider: 'web'`; `GET /proc/inbox` |
| **2** | 🟡 **Run labels (§2.4)**, `GET /proc/runs`, and starting a named workflow |
| **3** | ⬜ **Pages:** `PGC_Page` with the seeded Home — panel kinds `workflow`, `records`, `summary`, `novia` (`arch-web-app.md` v0.6: a records panel's view is the viewer's switch); `upsert-page.mjs` for the household's pages from a household file (never system seeds); `GET /proc/pages` |
| **4** | ⬜ **Reads:** `GET /proc/gates`, `GET /proc/outputs` (§2.6), and the read-only `records` read behind `GET /sources/{source}/rows` |
| **5** | ⬜ **Contract:** `row`, `column` and `group` on the `human_gate` contract (`PGC_StepType`) |
| **6** | ⬜ **Slack:** `gate_id` on buttons, and the ephemeral "already answered" |
| **7** | 🟡 **Principal and object checks (§11):** PROC takes the principal from its caller, never from a request body field; every id-taking resource above is checked against it |

## Acceptance Criteria

⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved. **Updated when a criterion's
state changes, not at close.**

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | 🟡 | A named workflow started for `provider: 'web'` runs to completion with every message in `GET /proc/inbox`, and none in Slack; the run appears in `GET /proc/runs` under its label | [1](#scope), [2](#scope) | Shown live — Javear starts the run (workflow-testing convention); Wren supplies the command and reads the evidence |
| **AC2** | ⬜ | A gate waiting in a web-started run is listed by `GET /proc/gates` and answered through `POST /proc/gates/{runId}/responses`; a gate already answered elsewhere is refused `409 gate_moved`. `GET /proc/gates` also lists a gate from a Slack-started run | [4](#scope), [6](#scope) | Shown live, one form gate and one other gate type |
| **AC3** | ⬜ | In Slack, a button carries `gate_id`, and a click on a gate already answered gets the ephemeral "already answered" instead of a resume | [6](#scope) | Shown live, or unit tests if no double answer can be staged without a write to a real run (post-deploy checks are read-only) |
| **AC4** | ⬜ | `GET /proc/pages` returns the seeded Home and the household's pages from `upsert-page.mjs`; no household page is in a system seed. `GET /proc/outputs` and `GET /sources/{source}/rows` return what a Home panel names, read-only | [3](#scope), [4](#scope) | Shown by curl |
| **AC5** | ⬜ | The `human_gate` contract carries `row`, `column` and `group`; L0 accepts a gridded form and rejects a malformed one | [5](#scope) | Unit tests, and `simulate` on a gridded form. The live vehicle, `manage_budget`, moves to Sprint 17 |
| **AC6** | 🟡 | No id-taking endpoint trusts an id without checking it against the principal; the principal never comes from a body field | [7](#scope) | Review against §11, and a refusal test per endpoint |
| **AC7** | 🟡 | Each new endpoint is in `openapi.yaml` before it is built, and its spec matches its code (sprint-15x retro) | all | Review at close |

## Progress

- **Items 1 and 7 — code and tests (2026-11-15), not yet deployed.** `PGC_UiMessage` template and
  registry seeds; `enqueueCallback` writes the inbox for `slack` and `web` (the web's only
  delivery); `GET /proc/inbox` (`inbox.mjs`); the principal from `x-principal-user` with the
  household role from `HOUSEHOLD_PRINCIPALS` (`principal.mjs`). Spec first (`75344f2`). To go live:
  the SSM parameter `/evolving-mind-ai/household-principals`, `sam deploy`, then the table through
  `POST /serv/schema/createTable` and `upsert-schema-registry.mjs --check`.
- **Item 2 — code and tests (2026-11-15), not yet deployed.** `PGC_WorkflowRun.label`,
  `PGC_Workflow.display`, `'web'` in `chk_triggered_by` (templates and registry seed);
  `labelUpdate` in `run-workflow.mjs` writes the label with the step that first fills
  `display.run_label`; `GET`/`POST /proc/runs` (`runs.mjs`); Novia writes `display` through
  `register_workflow` and `propose_workflow_fix` (Javear: in item 2, so AC1 can show a label).
  Spec first. A web callback carries no `threadId` — the run is its thread.
- **Deploy at the end of the sprint (Javear).** Order: the SSM parameter (Javear) → `createTable`
  `PGC_UiMessage` → `addColumn` `PGC_WorkflowRun.label`, `PGC_Workflow.display` →
  `modifyConstraint` `chk_triggered_by` → `upsert-schema-registry.mjs --check` →
  `sam deploy --no-confirm-changeset` → `upsert-system-context.mjs` (tool schemas v18).
  The schema first: once deployed, every Slack message writes the inbox.
- **Design v0.6 (2026-11-15, Javear):** a records panel names its source, not a widget; grid, list
  and document are views the viewer switches between. Mock-up republished at the same link.

## Retro lessons applied

- **Spec against code** (15x): AC7, checked per endpoint as it lands, not only at close.
- **Check every sibling** (15x): a gate answered over HTTP must be refused when stale for every
  gate family the endpoint reaches. Novia's gates are answered on the web only in Phase 1 (Novia's
  region), so this sprint names that boundary rather than leaving it implied.
- **Name a fallback vehicle** (15x): AC3 and AC5 name theirs.

## Out of scope

| Item | Why |
|---|---|
| Infrastructure (S3, CloudFront, Cognito, `WebApiFunction`, `deploy-web.mjs`, the CSP) | Sprint 17 |
| The shell, panels and widgets, every gate type rendered on the web | Sprint 17 |
| `manage_budget` as the first web workflow | Sprint 17 — needs the grid rendering |
| Token storage (§12 open question 1) | Decided at the start of Sprint 17, with the infrastructure |
| Phase 1: the page editor, `form` widget, editable tables, Novia's region, Help, Activity, the command bar | §10 Phase 1 |
| WebSocket | Polling first, until it's felt (§10) |
| Tenancy | Deferred until the second household commits (`arch-home-brain.md`) |
