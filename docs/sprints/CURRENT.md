# Sprint 15x — What Novia's self-testing costs

**Status: ACTIVE.** Started 2026-11-05 (Javear). An extension of Sprint 15 rather than a reopening
(Wren's call at Javear's request, 2026-11-05): Sprint 15 is merged and its record closed, and main
must match prod. Its retro is session 1293's analysis below. Sprint 16 (web app Phase 0) follows.

**Branch:** `sprint/15x-novia-cost`

---

## Why — session 1293 (2026-11-03)

Seven requests in one session about `process_receipt`: diagnose run 964, fix it (v14, in two
rounds), clean up the data, give feedback on the test tools, v15, v16. Novia's 85 calls cost
**$6.45** (proc logs). Cache reads were 97% of input, and one call missed (a 5½-minute pause by
Javear). **What drove the cost was the size of the transcript, not cache misses:**

| | Cost | Driver |
|---|---|---|
| Cache reads | $2.68 | 13.4M tokens. The transcript grew from 20K to **287K** and was re-read on every call |
| Cache writes | $1.84 | 368K tokens of new tool results and replies, at 25× the read price |
| Output | $1.93 | About 96K tokens: patches, replies, reasoning. Output tokens are not logged, so no finer split |

- **Each request carries every earlier one.** The v16 change re-read 235K tokens of run-964
  diagnosis and replay output on every call it made. With each request starting from a ~20K base,
  reads would have been about **$0.66 instead of $2.68**.
- **Tool results by size:** `answer_gate` 191K characters over 15 calls, because a run event lists
  every iterator pass and the gate's whole dialog (51 receipt items). `simulate_workflow` 86K and
  `propose_workflow_fix` 78K, because the whole patch was sent three times (simulate, sandbox,
  commit). `query_table` 57K, `read_workflow_run` 47K, `run_sql` 33K (11 calls digging values out
  of one step's output). `update_data`/`insert_data` 40K, because every row came back with its
  2,560-number `name_embedding`.
- **Round 1's bug** (the LLM given candidates found for items already matched) was visible at
  the replay's `LLM_BREAK` on step 10, whose input had changed. Novia tried one `run_sql` to
  inspect it, it failed, and she chose `call_live`. Novia had proposed a "simulate against a
  recorded run's state" tool and an `llm_call` input preview; both are **withdrawn** (Wren,
  2026-11-05) because the break already shows that input. What was missing was the habit of
  inspecting it, which belongs in her guidance (scope 8).

## Sprint Goal

**A Novia session costs what its current request needs: earlier requests stop being re-read in
full, tool results return what was asked for and say what they withheld, and a tested change is
committed as tested.**

---

## Scope

| # | Item |
|---|---|
| **1** | **Compact the transcript at a new request.** When Javear types a new message, results from earlier requests are rendered as a one-line stub that names the tool, the size and the session entry holding them (`read_session_entry` recalls them). His messages and her replies stay. Design for approval before code: when it triggers, what is kept, how it stays byte-identical across rounds so the cache holds |
| **2** | **Run events say less.** `describeRunEvent`'s `steps_since` collapses an iterator's passes into one line per step (count and status), and a gate dialog's large lists are bounded, with the count and how to read them whole (`read_workflow_run`) |
| **3** | 🟡 **built 2026-11-05, not deployed:** `truncateVectorColumns` is shared by `getRows` and every table write; entity writes use `stripVectors`, as entity reads do. **Writes do not return vector columns in full.** `insertRow`, `updateRows` and upsert in `table.mjs`, and the writes in `entity.mjs`, apply the truncation `getRows` already does (5 characters + `...`) |
| **4** | **Commit a tested copy as tested.** After a sandbox test passes, she commits the sandbox's `PGC_Workflow` copy without re-sending the patch, and the commit gate shows the diff from the live version. Design before code |
| **5** | **Answer a replay's gate as the source run did.** `answer_gate` can take the source run's recorded response for the same gate, so she doesn't have to dig up and re-paste the 4K-character receipt. Design before code (where the source response is recorded) |
| **6** | **`read_workflow_run` reads a path within a step's output**, as `read_session_entry` reads a page, so one field doesn't take six `run_sql` calls |
| **7** | 🟡 **built 2026-11-05, not deployed:** `outputTokens` and `reasoningTokens` are logged from `usage.output_tokens` / `output_tokens_details`. The gateway's field names are to be confirmed in the first live log (AC8). **Log output tokens** (and reasoning tokens if the gateway reports them) on every `callLlmWithTools` call, so the output line can be split |
| **8** | **Guidance:** `sop_test_cycle`. At an `LLM_BREAK`, read the changed input before choosing `call_live`. When a code step reshapes what an `llm_call` receives, reason through that input before the first test run (Instruction domain, `PGC_SystemContext`) |
| **9** | **A sandbox "as of run N".** `start_test` copies a table as it stood before a run, undoing that run's updates to existing rows as well as its inserts, instead of relying on a guessed `created_at` cutoff. Design before code; it depends on whether a run's writes keep their prior values |

## Acceptance Criteria

⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved. **Updated when a criterion's
state changes, not at close.**

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | Session 1293's stored entries, rendered at each of its 85 call points by the new `toInputItems`, total less than half the input characters they total today (an offline counterfactual, run as a script against the live rows) | [1](#scope), [2](#scope), [3](#scope) | ≤ 50% |
| **AC2** | ⬜ | Compaction keeps the cache: within a request, every round after the first reads its whole prefix back (unit test that renders byte-identically across rounds; live `cacheRead` from the proc logs) | [1](#scope) | Binary — unit test and live |
| **AC3** | ⬜ | A live Novia session of at least three requests that includes a sandbox test, measured from the proc logs: cost per call and peak context against session 1293 | [1](#scope)–[8](#scope) | Peak context ≤ 120K; reported |
| **AC4** | ✅ met 2026-11-05: `serv-write-vectors.test.mjs` (10 tests) runs the real routes for insert, batch insert, update, upsert and the three entity writes; 1334 → 1344 tests | No write returns a full vector (unit tests on `insertRow`, `updateRows`, upsert, entity writes) | [3](#scope) | Unit tests pass |
| **AC5** | ⬜ | A tested sandbox copy is committed without the patch being sent again, and the committed steps equal the tested steps | [4](#scope) | Binary — unit test and live |
| **AC6** | ⬜ | A replay's gate is answered with the source run's response, with no form values in the call | [5](#scope) | Binary — live |
| **AC7** | ⬜ | `read_workflow_run` returns one path of a step's output, bounded with provenance | [6](#scope) | Unit tests pass |
| **AC8** | ⬜ | Output tokens are in the proc log for every Novia call | [7](#scope) | Seen in the logs |
| **AC9** | ⬜ | `sop_test_cycle` carries the break-inspection rule, and in AC3's session Novia reads the changed input before resolving any break | [8](#scope) | Shown in AC3's session |
| **AC10** | ⬜ | `start_test` with a run as its cutoff yields the tables as they stood before that run (verified against run 964's own writes) | [9](#scope) | Binary — live |

## Out of scope

| Item | Why |
|---|---|
| Simulating against a recorded run's state; previewing an `llm_call`'s input | Withdrawn (above): the replay's `LLM_BREAK` already shows that input |
| The 5-minute cache TTL | The gateway ignores a 1-hour TTL (measured 2026-10-24); unchanged |
| `process_receipt` itself | v16 is live and was tested in session 1293 |
