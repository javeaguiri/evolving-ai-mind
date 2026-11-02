# Sprint 15 — Encryption at rest, then Novia tests her own work

**Status: ACTIVE — started 2026-11-02 (Javear).** Re-scoped at start from the proposal of 2026-10-31:
the move to the Anthropic API is deferred — it was chosen to fix the 1h TTL for a human-in-the-loop
test cycle, and if Novia runs the whole cycle herself the 5-minute TTL may be enough (AC5 decides).
Encryption at rest comes first. Read `docs/sprints/sprint-14.md` §Retro first.

**Branch:** `sprint/15-encrypt-novia-self-test`

---

## Sprint Goal

**The prod database is encrypted on disk, and Novia tests a workflow she built or fixed against a
plan Javear approved — in a sandbox, so household data is never touched — running, reading and
answering it herself until she reports.**

---

## Scope

| # | Item |
|---|---|
| **1** | **Encryption at rest for PostgreSQL** — Sprint 14 scope item 6 / AC6, carried; `docs/arch-security.md` F7. Snapshot → encrypted copy → restore, **AWS-managed key `aws/rds`** (decided Javear, 2026-11-02). Not a template toggle: `EvoMindDB` has a custom `DBInstanceIdentifier`, so `StorageEncrypted: true` in `template.yaml` asks CloudFormation for a replacement it cannot perform under that name — and after a restore-and-rename keeps `SYSRDSEvoMind`, the next deploy would still read the property change as a replacement. The plan brings the restored instance back under the stack without one (e.g. `DeletionPolicy: Retain`, remove from stack, resource import with `StorageEncrypted: true`), keeps the endpoint, and is cut in a quiet window so no writes are lost. **Written and agreed before any AWS action** — ✅ DONE 2026-11-02 — [`docs/ops-encryption-at-rest.md`](../ops-encryption-at-rest.md), all four phases |
| **2** | **A test-data policy for prod — a sandbox schema** (decided Javear, 2026-11-02: option A of the backlog's three). Design [`arch-sandbox.md`](../arch-sandbox.md): a `sandbox_<n>` schema holding copies of the tables a test needs (named by her, FK parents and dependent views added by SERV, rows `all`/`none`/filtered) plus `PGC_Memory` and `PGC_Workflow`; a test run reaches it through `search_path`, and a PGD write to a table not copied is refused. Tools `start_test` / `reset_test` / `end_test`. The run, its steps and session stay real — the record of the test. No two-stage commit: a Postgres transaction lives on one connection and a run spans many invocations and gate waits. Approved Javear, 2026-11-02 (only the tables and views needed; test memories in the sandbox) — **build** next |
| **3** | **`read_workflow_run`** — from the backlog: the run's status, current step, waiting gate with its `gate_id`, per-step outputs, bounded with provenance |
| **4** | **`answer_gate`** — Sprint 14 scope item 9, carried. Built on the provider-neutral `POST /gates/{runId}/responses` with `gate_id`, which this sprint builds in PROC first (`arch-web-app.md` §3.1); refused for a run she did not start and for any gate guarding her own gated write |
| **5** | **Wake her when her run reaches a gate** — from the backlog: a run she started that suspends, completes or fails enqueues `MINDS_EYE_RESUME` for her session; with a bound on self-test rounds per session |
| **6** | **Her test runs' gates never reach Slack** (Javear, 2026-11-02) — a test run carries `callback.provider: 'novia'`; PROC routes on the provider as `arch-web-app.md` §3 does, so nothing is enqueued to Slack and she sees the gate through 5 and 3 — the provider-neutral dialog with templates resolved, as Javear would see it before Block Kit. Slack-only layout is the renderer's, not hers |
| **7** | **The test cycle** (Javear, 2026-11-02), in her guidance, not code: (a) after a commit she offers **Submit only** or **Submit and test**; (b) on test, she checks the data each path needs and writes a **plan** — paths covered (each once, from the simulation trace), data used and created, test-only changes, what is *not* covered — which Javear approves before she starts; (c) loops are cut by **shaping data first** (e.g. cards one correct answer from done); where only a workflow change will do, she tests an **uncommitted copy** and the plan shows its diff from the real one; (d) on a defect she continues every path it does not block, then resets the sandbox, runs one normal fix cycle (simulate → Javear's permission → commit) and offers a fresh test cycle |
| **8** | **`PGC_SessionEntry.json` template role check omits `tool`** — from the backlog (2026-08-30); one line, no migration — ✅ DONE 2026-11-02 (live database already admitted `tool`) |
| **9** | **A turn whose tool arguments will not parse is never persisted** — from the backlog (2026-08-30); `minds-eye.mjs` writes the `PGC_SessionEntry` row so the rebuilt transcript matches the in-round one — ✅ DONE 2026-11-02, unit-tested; not yet deployed |
| **10** | **The replay harness as her tool** — from the backlog (2026-08-26); last in the sprint. After a fix she replays the failing run at no LLM cost; replays go through the sandbox (2) and her provider (6). Endpoints exist; the gap is the tool case and its `minds_eye_tool_schemas` entry |

## Acceptance Criteria

⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved. **Updated when a criterion's
state changes, not at close.**

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ✅ met 2026-11-02 — encrypted (`aws/rds`), row counts identical, live check passed, drift `IN_SYNC`, no unencrypted instance, snapshot or backup left ([`ops-encryption-at-rest.md`](../ops-encryption-at-rest.md)) | The prod database is encrypted at rest: `StorageEncrypted: true` on the live instance, `template.yaml` matches the live instance (drift `IN_SYNC`), every table's row count unchanged across the cut, the Lambdas reach it with no SSM change or with the change made through a version-pinned deploy, and **no unencrypted copy remains** — the old instance, its automated backups and the pre-encrypt snapshot deleted (Phase 4; added Javear, 2026-11-02) (Sprint 14 AC6) | [1](#scope) | Binary, verified live |
| **AC2** | ✅ met 2026-11-02 — [`arch-sandbox.md`](../arch-sandbox.md) approved by Javear | A written test-data policy for prod, approved by Javear | [2](#scope) | Approved |
| **AC3** | ⬜ | Novia answers a gate in a run she started and the run resumes through `POST /gates/{runId}/responses`; a run she did not start, or a gate guarding her own gated write, is refused (Sprint 14 AC9) | [3](#scope), [4](#scope) | Binary, live |
| **AC4** | ⬜ | She fixes a workflow, offers Submit only / Submit and test, writes a test plan Javear approves, runs it in the sandbox, is woken at its gates, reads them with `read_workflow_run`, answers, resets the sandbox and reports — with no message from Javear between plan approval and report (reworded Javear, 2026-11-02; was "between start and report") | [3](#scope)–[7](#scope) | Binary, live — vehicle: `manage_budget` new-month defect |
| **AC5** | ⬜ | Her cache reads across a self-test cycle are measured from the proc logs; the result decides whether the Anthropic API move returns | [3](#scope)–[5](#scope) | Measured, reported |
| **AC6** | ⬜ | A test run's writes land only in the sandbox: every real `PGD_*` table it touches has identical row counts and content before and after; reset leaves no sandbox table behind | [2](#scope) | Binary, live |
| **AC7** | ⬜ | No gate or notification from a run with provider `novia` reaches Slack; she reads the gate's resolved dialog | [6](#scope) | Binary, live |
| **AC8** | ⬜ | Her guidance carries the test cycle: the two submit options, the plan and its contents, data-first loop cutting with an uncommitted test copy as the fallback, and continue → reset → one fix cycle → fresh test on a defect | [7](#scope) | Shown in AC4's run |
| **AC9** | ✅ met 2026-11-02 — template fixed; parse-error entry persisted, 3 unit tests (1185 → 1188) | The template's role check includes `tool`, matching the registry and live database; an unparseable tool call is persisted and appears in the rebuilt transcript (unit test) | [8](#scope), [9](#scope) | Unit tests pass |
| **AC10** | ⬜ | After a fix she replays the failing run in the sandbox through her own tool, and reads its outcome | [10](#scope) | Binary, live |
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

### Session 1 (2026-11-02)

Sprint started, re-scoped (Anthropic direct deferred to AC5). Encryption runbook written and approved
(`docs/ops-encryption-at-rest.md`); AC1 now also requires no unencrypted copy remaining. **Phase 0**
deployed — bastion grants verified (snapshot and automated-backup reads work; 9 automated snapshots,
no manual ones, all unencrypted). **Phase 1.1** — `Retain` on `EvoMindDB`, no RDS change. **Phase 1.2**
— `EvoMindDB` and the `RDSEndpoint` output removed; CloudFormation `DELETE_SKIPPED`, instance
`available` with deletion protection, SERV reads through the Lambda. Live engine is 16.13 against
the template's former `"16.6"`. **Next:** Phase 2 in a quiet window Javear picks; Phase 3 restores the
`EvoMindDB` block from git history with `StorageEncrypted: true` and `EngineVersion: "16"`.

**Phase 2 (same session):** writes frozen; 30-table baseline; snapshot 5m, encrypted copy 3.5m,
restore 8.5m (CA, retention and windows carried over — no modify). Abort point passed: all 30 row
counts identical, encrypted, parameter group in sync, `vector` present. Swap ~2 min; the SSM URL
reaches the new instance (verified by server address before unfreezing). Unfrozen; old
`sysrdsevomind-unenc` frozen and stopped — **RDS restarts it on 2026-11-09, so Phase 4 by 2026-11-08**.
SERV reads through the Lambda. Runbook corrected with what the cut showed (restore CA flag, rename
waiter, unfreeze needs a read-write session first). The `aws/rds` key's id was printed once by a
refused direct `kms:DescribeKey` — an identifier, not key material; no direct KMS call again.

**Phase 3 (same session):** Javear's live check passed (`/ping` e2e, a read, a write). Imported from
the deployed template plus the block (`CAPABILITY_NAMED_IAM` needed too); one change, `Import`, no
replacement. Restoring `RDSEndpoint` showed a non-replacing `Modify` of `EvoMindDB` — `sam build`
metadata and the `!GetAtt` form of `VPCSecurityGroups`, same value — previewed before executing, no
pending change after. Single-resource drift needed `DetectStackResourceDrift` (granted, own deploy):
**`IN_SYNC`, no differences.**

**Novia test candidate (Javear, 2026-11-02):** `manage_budget` did not create the new month's budget
correctly. Left as found — a live defect for AC4, where Novia diagnoses and fixes it herself.

**Phase 4 (same session, Javear: "do phase 4 now… okay delete snapshots"):** `sysrdsevomind-unenc`
deleted with its automated backups; pre-encrypt snapshot deleted; two unencrypted CloudFormation
snapshots from 2026-03-05 setup day (instances long gone) found by an account-wide sweep and
deleted; the old automated snapshots cleared ~2 min after the instance. **Sweep: 0 unencrypted
instances, snapshots, backups.** Write grants removed (own deploy); bastion keeps 7 read-only
actions (5 CloudFormation drift/describe, 2 RDS snapshot/backup describes). A write probe ran
before IAM propagated and created encrypted snapshot `grant-probe` — **Javear to delete it in the
console** (the bastion can no longer). Kept: `sysrdsevomind-encrypted-20261102` (baseline, a month).
F7 closed in `arch-security.md`; README and `architecture.md` §2 say PostgreSQL 16, encrypted.

### Session 2 (2026-11-02) — re-scoped with Javear

Commit trailers across history rewritten to `Co-Authored-By: Christopher Wren` (all branches and
tags, force-pushed by Javear); 183 doc hash references repointed (`1931531`). Javear's self-test
review added scope 6–10 and AC6–AC10: her test runs' gates stay out of Slack (provider `novia`),
the test cycle (Submit only / Submit and test, an approved plan, data-first loop cutting with an
uncommitted test copy, continue → reset → one fix cycle → fresh test), and three backlog items
(template role check, unparseable tool call persisted, replay as her tool). **Test-data policy:
option A, a sandbox schema** — no two-stage commit is possible across a run. Transcript eviction
stays in the backlog, waiting for its trigger.

### Next session — write the sandbox policy, then the toolkit

Read this file, then `docs/arch-web-app.md` §3 (`PGC_UiMessage` provider routing, §3.1
`POST /gates/{runId}/responses`, `gate_id`) and `docs/arch-minds-eye.md` (tool catalog).
1. **AC2 write-up for approval** — the sandbox: which tables are copied (those the workflow under
   test reads or writes, from its steps), when (test start), how SERV routes a test run's
   `PGD_*` names to `test.*`, what stays real (`PGC_*`), reset, and the uncommitted test copy.
   Propose, don't build.
2. **Quick wins** — 8 and 9 (unit tests first).
3. **Prep before code** — `PGC_StepType` / `minds_eye_tool_schemas` text for `read_workflow_run`,
   `answer_gate`, and the test-cycle guidance (7).
4. Build order: 3 `read_workflow_run` → 6 provider `novia` → 4 `answer_gate` + endpoint
   (`openapi.yaml` spec-first) → 5 the wake → 2 the sandbox → 7 → 10 replay.
AC4's live vehicle: the `manage_budget` new-month defect, left as found.
