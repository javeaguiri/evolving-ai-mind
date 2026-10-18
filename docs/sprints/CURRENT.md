# Sprint 14 — A web front end, Phase 0

**Status: PROPOSED 2026-10-18 — scope is confirmed at "start sprint".**
Read `docs/sprints/sprint-13.md` §Retro and `docs/arch-home-brain.md` (§3, §4.4, §4.6, §4.7, §4.10) first.

**Branch:** `sprint/14-web-phase-0`

> **Decided 2026-10-18 by Javear.** Slack is not cutting it as the main interface — editing a
> spreadsheet of data is what proved it — and it stays a good accessory. The front end is a
> **web site** (responsive, one codebase for phone and desktop). The goal is **general
> acceptability, not multi-tenancy**: tenancy waits until the construction-company partner has
> firmly committed. Build for one household, keep the habits in `arch-home-brain.md` §3.3.

---

## Sprint Goal

**Design the web app in detail, then prove a second experience layer works end to end: a web site that shows a waiting gate,
takes the answer, and resumes the run — with a `form` gate rendered as a real editable grid.**

This is the Home Brain design's Phase 0 (§4.10). It proves the seam in §3.1 holds for a second
provider, and that a grid answers the bulk-edit ceiling Slack cannot.

---

## Scope

| # | Item |
|---|---|
| **0** | **A detailed design of the web app — first, and approved before any build (Javear, 2026-10-18).** `docs/arch-home-brain.md` is a v0.1 proposal: layout, regions, flows and phasing at sketch depth. The detailed design takes it to buildable for Phase 0 and Phase 1, as `docs/arch-web-app.md` (the Home Brain doc keeps the product direction and the tenancy model). It settles: **hosting** and how the site reaches PROC without the internal API key; **sign-in** for one user; **framework**; **result delivery** (polling vs push); **pages and navigation** at phone and desktop width; **every gate type's web rendering** from the provider-neutral `dialog`, including the editable grid (§6.4's grid hint); the **API surface** in `openapi.yaml` terms; **error, empty and loading states**; how a **Slack-started run answered on the web** shows it (§6.2); and **what Phase 0 builds versus what Phase 1 adds**. Wireframes are part of it |
| **1** | **The web provider, end to end — Phase 0.** Spec first in `docs/openapi.yaml`: `GET /gates`, `POST /gates/{runId}/responses`, `GET /inbox` (§4.7). `provider: 'web'` routed by `callback.provider` (§4.6). A site shell that lists waiting gates and answers them. Results reach the site rather than Slack for a web-started run |
| **2** | **A `form` gate as an editable grid** — the shape Slack could not render. Open question §6.4 (the grid hint: row key and column label on the `human_gate` contract) is settled here, and Sprint 13's field `group` heading folds into it |
| **3** | **`manage_budget` (= `edit_budget`, 357 v7) as the Phase 0 workflow** — one column, ~21 rows, the grid's natural first consumer. Its four Sprint 13 findings go to Novia as findings: every save writes all 21 rows; amounts are `text`; `currency: 'USD'` hardcoded in a euro household; grouping by label prefix |
| **4** | **Sign-in for one user.** The site is public-facing, so it needs a real identity even with one user: the browser never holds the internal API key, and identity comes from the token, never the request body (§3.3). Mechanism decided at "start sprint" |
| **5** | **Release readiness R1–R3, moved forward (Javear, 2026-10-18)** — `docs/ops-release-readiness.md`, on `ops/<slug>` branches alongside this sprint. **R1 first**: a web site should not be built against prod, and today there is no other environment |

## Acceptance Criteria

⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved. **Updated when a criterion's
state changes, not at close.**

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC0** | ⬜ | `docs/arch-web-app.md` covers every point in scope item 0, with wireframes, and Javear approves it before Phase 0 code starts | [0](#scope) | Approval |
| **AC1** | ⬜ | A run started from the web site suspends at a gate, the gate appears on the site, and answering it there resumes the run to completion — no Slack involved | [1](#scope) | Binary, live |
| **AC2** | ⬜ | `manage_budget` edits all its amounts in one editable grid on the site, grouped by budget type, and one save writes **only the changed rows**, as numbers, in the household's currency | [2](#scope), [3](#scope) | Binary, live |
| **AC3** | ⬜ | The site requires sign-in, and no request from the browser carries the internal API key | [4](#scope) | Binary |
| **AC4** | ⬜ | Slack still works unchanged for a run started from Slack | [1](#scope) | Binary, from Slack |
| **AC5** | ⬜ | R1 lands: `template.yaml` takes an environment name, and a second stack would not collide with prod or read prod's parameters | [5](#scope) | Demonstrated on one real change |

## Carried from Sprint 13, not scoped here

| Item | Where it goes |
|---|---|
| Sprint 13 AC3 — Novia selects the pattern unprompted, on Opus 5.5 | Observed when she next designs cold; not a sprint target |
| Sprint 13 AC4 — oversized-gate failure, `preview_step`, measuring Slack's size limit | `docs/backlog.md` (Step preview). The Slack ceiling stops being the binding limit once the grid is on the web |
| Sprint 13 AC6 — the inventory correction workflow, aliases 81 / 60 / 59 | Deferred; next sprint that has room |

## Open at "start sprint"

The four open questions — hosting, sign-in, framework, result delivery — are answered **in the
design** (scope item 0), not at scoping. What "start sprint" settles is only whether this scope
and these ACs are right.

## Out of scope

| Item | Why |
|---|---|
| Multi-tenancy, several household members | Waits for the partner's commitment (Javear, 2026-10-18) |
| Phase 1's full console — navigator, command bar, Novia panel, direct edits | Phase 0 proves the seam first |
| Removing the Slack leaks in `arch-home-brain.md` §3.2 | Phase 1, except where Phase 0 needs one gone |

## Session Notes
