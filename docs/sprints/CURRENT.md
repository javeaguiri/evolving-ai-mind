# Sprint 17 — The web app's front end

**Status: ACTIVE — started 2026-11-15.** Scope and ACs agreed with Javear at "start sprint". The second half of `docs/arch-web-app.md` (v0.6) §10 Phase 0; Sprint 16 built the
backend seam it sits on. The prior sprint's retro is `docs/sprints/sprint-16.md`.

**Branch:** `sprint/17-web-front` — merged to main at close, as every sprint is.

---

## Sprint Goal

**The household signs in to a web page and uses the brain there.** Home, Money and Inventory draw
from `PGC_Page`; a workflow started on the page is stepped through in place, every gate type
answered in the browser; `edit_budget` edits a month in one grid.

---

## Decided at scoping

| Question | Decision |
|---|---|
| **Token storage** | Access token in memory, refresh token in `localStorage`, behind the CloudFront CSP; the Cognito authorizer on API Gateway validates the token (`arch-web-app.md` v0.7 §1) |
| **Inbox retention** | None this sprint — `PGC_UiMessage` is unbounded until the web is in use (§12.1 stays open) |
| **`GET /me`'s locale and timezone** | A new `GET /proc/me` returns the principal's roles with the household's locale and timezone, from SSM String `household-locale` and `household-timezone`, until a profile exists (Phase 1) |
| **Domain labels** | `PGC_DomainHelp.display` (`label`) is built now, so the *Domains* menu shows the household's names; a domain without one shows its humanised identifier, flagged `labelFallback` |

## Scope

| # | Item |
|---|---|
| **1** | 🟡 **Infrastructure:** S3 + CloudFront, a Cognito pool with one user, `WebApiFunction` and the web routes, `deploy-web.mjs`, the CSP and the §11 controls. `household-principals` gains the Cognito `sub` alongside the curl id (SSM v2, pin bumped in prod). 🟡 IN PROGRESS — the S3/CloudFront/Cognito grants to the deploy role deployed alone 2026-11-15 (`sam deploy`, no errors in the logs); `summariseWorkflowError` shared from `src/ui/shared/workflow-error.mjs` for the web handler |
| **2** | ✅ DONE **The two §3.1 reads Sprint 16 did not build:** `GET /workflows` (the *Domains* menu and domain pages' workflow panel, from `display` `label`/`menu` of `PGC_Workflow` and `PGC_DomainHelp` — the `PGC_DomainHelp.display` column joins Phase 0) and `GET /me` (`GET /proc/me`: roles, and locale and timezone from new SSM `household-locale`/`household-timezone`). Spec ✅ DONE; code ✅ DONE (`workflows.mjs`, `me.mjs`, the `PGC_DomainHelp.display` template and registry seed, 12 tests). Domain labels written by `dev_scripts/upsert-domain-display.mjs` from the seed (`system` hidden) and `household/domains.json`; Novia's domain tooling noted in the backlog. Schema deployed 2026-11-15 (`addColumn` from the template, catalog read back, registry 18/18 ok) and labels written (rerun: no changes). SSM `household-locale` v1 (`en`), `household-timezone` v1 (`Europe/Madrid`); `sam deploy` 2026-11-15; smoke read-only: `/proc/me` household role, `en`, `Europe/Madrid`; `/proc/workflows` four domains with the household's labels, `system` hidden; a stranger 403; no PROC errors |
| **3** | ⬜ **The shell:** sign-in; 🏠, the *Pages* and *Domains* menus, 🔔, ⚙; Settings › Profile; English catalogs from day one (§13) |
| **4** | ⬜ **Panels:** workflow panels (*Start*, runs by label, a run stepped through in place); records panels with the view switch (`grid` read-only, `list`); summary panels (`chart`, `metric`, `report`); click-through and report Refresh; domain pages' workflow panel; the run page and run drawer |
| **5** | ⬜ **Every gate type of §5.2** rendered and answered on the web, the grid from `row`/`column`/`group` |
| **6** | ⬜ **First workflow:** `edit_budget` (357; the design names it `manage_budget`) — month pick, then one grid grouped by budget type, after Novia's four corrections |

## Acceptance Criteria

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | Javear signs in, and Home, Money and Inventory render from `PGC_Page`, read-only, with the view switch on records panels | 1, 2, 3, 4 | Shown live |
| **AC2** | ⬜ | Every §5.2 gate type renders and is answered in the browser; a gate answered elsewhere shows *This was answered elsewhere* (`409`) | 4, 5 | One live run per gate type, or a named fallback vehicle |
| **AC3** | ⬜ | `edit_budget` edits a month's budgets in one grid grouped by type, one Save | 5, 6 | Shown live |
| **AC4** | 🟡 | No internal key reaches the browser; the CSP and the Cognito authorizer hold | 1 | Review against §11, and tests |
| **AC5** | 🟡 | Each new endpoint is in `openapi.yaml` before it is built, as its own commit, and its spec matches its code | all | Review as each lands |

## Retro lessons to apply (sprint-16)

- **An upsert proves its rerun:** "no changes" on a second run is tested before the first live
  write — `deploy-web.mjs` and any new upsert included.
- **A writable field joins the reads that verify it,** in the same change.
- **Read a new test's output,** not only its count — no unit test touches the network.

## Out of scope

| Item | Why |
|---|---|
| Phase 1: the page editor, the `form` widget and editable grids on pages, Novia's region and panels, Help, Activity, the command bar | §10 Phase 1 |
| `GATE_RESOLVED` — retiring Slack's stale buttons when a gate is answered on the web | §8, Phase 1 |
| WebSocket | Polling first, until it's felt (§10) |
| Tenancy | Deferred until the second household commits (`arch-home-brain.md`) |
| Inbox retention | Decided at scoping: none until the web is in use (`arch-web-app.md` §12.1) |
