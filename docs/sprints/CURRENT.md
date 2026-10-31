# Sprint 15 — Novia: her cost, and testing her own work

**Status: PROPOSED 2026-10-31 — awaiting "start sprint".** Decided by Javear 2026-10-30: her cost is
affecting his ability to use her. Read `docs/sprints/sprint-14.md` §Retro first.

**Branch:** `sprint/15-novia-direct` (created at "start sprint")

---

## Sprint Goal

**Novia costs less per session and tests her own builds and fixes without Javear in the loop:** her
calls go to the Anthropic API directly, with a 1-hour cache, and she can run, read and answer a
workflow she started.

---

## Scope

| # | Item |
|---|---|
| **1** | **Novia calls Anthropic directly** — `docs/backlog.md`, top priority. `callLlmWithTools` only, through `@anthropic-ai/sdk`; workflow `llm_call`s, sonar and embeddings stay on Perplexity. `toInputItems` and the item replay rewritten for Messages content blocks, keeping the byte-identical rebuild tests; `ttl: "1h"` on the cached prefix; the API key in SSM like the others. Carries Sprint 14 AC7 (c) |
| **2** | **`answer_gate`** — Sprint 14 scope item 9, carried. Built on the provider-neutral `POST /gates/{runId}/responses` with `gate_id`, which this sprint therefore builds in PROC first (`arch-web-app.md` §3.1); refused for a run she did not start and for any gate guarding her own gated write |
| **3** | **`read_workflow_run`** — from the backlog: the run's status, current step, waiting gate with its `gate_id`, per-step outputs, bounded with provenance |
| **4** | **Wake her when her run reaches a gate** — from the backlog: a run she started that suspends, completes or fails enqueues `MINDS_EYE_RESUME` for her session; with a bound on self-test rounds per session |
| **5** | **A test-data policy for prod** — from the backlog; decided before she self-tests anything that writes |

## Acceptance Criteria

⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved. **Updated when a criterion's
state changes, not at close.**

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | Novia's calls go to the Anthropic API; a round started more than 5 minutes after the last reads its prefix back from cache (Sprint 14 AC7) | [1](#scope) | Binary, from the proc logs on a live session |
| **AC2** | ⬜ | Her cost per session falls against the Oct 24 baseline, from the Usage and Cost API | [1](#scope) | Measured, compared |
| **AC3** | ⬜ | Novia answers a gate in a run she started and the run resumes through `POST /gates/{runId}/responses`; a run she did not start, or a gate guarding her own gated write, is refused (Sprint 14 AC9) | [2](#scope) | Binary, live |
| **AC4** | ⬜ | She builds or fixes a workflow, runs it, is woken at its gate, reads it with `read_workflow_run`, answers, and reports the outcome — with no message from Javear between start and report | [3](#scope), [4](#scope), [5](#scope) | Binary, live |

## Out of scope

| Item | Why |
|---|---|
| The web app's Phase 0 build | The sprint after this one, from `docs/arch-web-app.md` §10 (approved v0.5) — Sprint 14 AC1–AC4 |
| Encryption at rest (Sprint 14 AC6) | Placed when a sprint has room for a quiet cut |
| Moving workflow `llm_call`s off Perplexity | Novia is nearly all LLM spend |

## Session Notes
