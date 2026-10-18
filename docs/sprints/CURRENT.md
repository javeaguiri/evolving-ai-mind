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

**Prove that a second experience layer works end to end: a web site that shows a waiting gate,
takes the answer, and resumes the run — with a `form` gate rendered as a real editable grid.**

This is the Home Brain design's Phase 0 (§4.10). It proves the seam in §3.1 holds for a second
provider, and that a grid answers the bulk-edit ceiling Slack cannot.

---

## Scope

| # | Item |
|---|---|
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

1. **Hosting** for the site, and how it reaches PROC without exposing the internal API key.
2. **Sign-in mechanism** for one user.
3. **Framework** — React is the design's recommendation (§6.7).
4. **How results reach the site** — polling `GET /inbox` for Phase 0, or the WebSocket push §4.6 plans for Phase 1.

## Out of scope

| Item | Why |
|---|---|
| Multi-tenancy, several household members | Waits for the partner's commitment (Javear, 2026-10-18) |
| Phase 1's full console — navigator, command bar, Novia panel, direct edits | Phase 0 proves the seam first |
| Removing the Slack leaks in `arch-home-brain.md` §3.2 | Phase 1, except where Phase 0 needs one gone |

## Session Notes
