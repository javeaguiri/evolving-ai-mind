# Sprint 15 — Encryption at rest, then Novia tests her own work

**Status: ACTIVE — started 2026-11-02 (Javear).** Re-scoped at start from the proposal of 2026-10-31:
the move to the Anthropic API is deferred — it was chosen to fix the 1h TTL for a human-in-the-loop
test cycle, and if Novia runs the whole cycle herself the 5-minute TTL may be enough (AC5 decides).
Encryption at rest comes first. Read `docs/sprints/sprint-14.md` §Retro first.

**Branch:** `sprint/15-encrypt-novia-self-test`

---

## Sprint Goal

**The prod database is encrypted on disk, and Novia runs, reads and answers a workflow she started —
so a build → test → fix cycle finishes without Javear in the loop.**

---

## Scope

| # | Item |
|---|---|
| **1** | **Encryption at rest for PostgreSQL** — Sprint 14 scope item 6 / AC6, carried; `docs/arch-security.md` F7. Snapshot → encrypted copy → restore, **AWS-managed key `aws/rds`** (decided Javear, 2026-11-02). Not a template toggle: `EvoMindDB` has a custom `DBInstanceIdentifier`, so `StorageEncrypted: true` in `template.yaml` asks CloudFormation for a replacement it cannot perform under that name — and after a restore-and-rename keeps `SYSRDSEvoMind`, the next deploy would still read the property change as a replacement. The plan brings the restored instance back under the stack without one (e.g. `DeletionPolicy: Retain`, remove from stack, resource import with `StorageEncrypted: true`), keeps the endpoint, and is cut in a quiet window so no writes are lost. **Written and agreed before any AWS action** |
| **2** | **A test-data policy for prod** — from the backlog; decided by Javear before Novia self-tests anything that writes |
| **3** | **`read_workflow_run`** — from the backlog: the run's status, current step, waiting gate with its `gate_id`, per-step outputs, bounded with provenance |
| **4** | **`answer_gate`** — Sprint 14 scope item 9, carried. Built on the provider-neutral `POST /gates/{runId}/responses` with `gate_id`, which this sprint builds in PROC first (`arch-web-app.md` §3.1); refused for a run she did not start and for any gate guarding her own gated write |
| **5** | **Wake her when her run reaches a gate** — from the backlog: a run she started that suspends, completes or fails enqueues `MINDS_EYE_RESUME` for her session; with a bound on self-test rounds per session |

## Acceptance Criteria

⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved. **Updated when a criterion's
state changes, not at close.**

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | The prod database is encrypted at rest: `StorageEncrypted: true` on the live instance, `template.yaml` matches the live instance, every table's row count unchanged across the cut, and the Lambdas reach it with no SSM change or with the change made through a version-pinned deploy (Sprint 14 AC6) | [1](#scope) | Binary, verified live |
| **AC2** | ⬜ | A written test-data policy for prod, approved by Javear | [2](#scope) | Approved |
| **AC3** | ⬜ | Novia answers a gate in a run she started and the run resumes through `POST /gates/{runId}/responses`; a run she did not start, or a gate guarding her own gated write, is refused (Sprint 14 AC9) | [3](#scope), [4](#scope) | Binary, live |
| **AC4** | ⬜ | She builds or fixes a workflow, runs it, is woken at its gate, reads it with `read_workflow_run`, answers, and reports the outcome — with no message from Javear between start and report | [3](#scope), [4](#scope), [5](#scope) | Binary, live |
| **AC5** | ⬜ | Her cache reads across a self-test cycle are measured from the proc logs; the result decides whether the Anthropic API move returns | [3](#scope)–[5](#scope) | Measured, reported |
| ~~**AC1 (proposed)**~~ | ~~⬜~~ — **deferred at sprint start (Javear, 2026-11-02)**: the 1h TTL was for a human-paced test cycle; AC5 measures whether a self-paced one needs it | ~~Novia's calls go to the Anthropic API; a round started more than 5 minutes after the last reads its prefix back from cache~~ | — | — |
| ~~**AC2 (proposed)**~~ | ~~⬜~~ — **deferred with it** | ~~Her cost per session falls against the Oct 24 baseline, from the Usage and Cost API~~ | — | — |

## Out of scope

| Item | Why |
|---|---|
| Novia calls Anthropic directly | Deferred at sprint start (Javear, 2026-11-02) — AC5 decides whether it returns |
| The web app's Phase 0 build | A later sprint, from `docs/arch-web-app.md` §10 (approved v0.5) — Sprint 14 AC1–AC4 |
| IAM database authentication (backlog F3 / S3) | Sequenced after this sprint's instance replacement |
| Moving workflow `llm_call`s off Perplexity | Novia is nearly all LLM spend |

## Session Notes
