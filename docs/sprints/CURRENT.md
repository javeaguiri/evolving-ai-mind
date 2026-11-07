# Sprint 15x — What Novia's self-testing costs

**Status: ACTIVE.** Started 2026-11-05 (Javear). An extension of Sprint 15 rather than a reopening
(Wren's call at Javear's request, 2026-11-05): Sprint 15 is merged and its record closed, and main
must match prod. Its retro is session 1293's analysis below. Sprint 16 (web app Phase 0) follows.

**Branch:** `sprint/15x-novia-cost` · **Deployed 2026-11-07 at `26a4850`** (scope 10–16), with `minds_eye_tool_schemas` v17, `minds_eye_system_prompt` v41, `sop_test_cycle` v4 and `sop_schema_change` v3 upserted. First deployed 2026-11-05 at `c81dd0b`. **Next:** Session A, run by Javear from Slack, as AC3's vehicle: split inventory into staples, emergency stock and recipe items, then build a grocery list that excludes stock (the recipe consumption follows in a later session)

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
| **1** | 🟡 **built 2026-11-05, deployed at c81dd0b:** `renderToolOutput` / `renderCallItems` in `toInputItems`. Earlier requests' results and call arguments over `EARLIER_REQUEST_STUB_CHARS` render as stubs, and `read_session_entry` gains `part: "arguments"` (`minds_eye_tool_schemas` v12). Policy: stub both (Javear, 2026-11-05). Replaces the unbuilt turn-limit compression in `arch-minds-eye.md` §6.1. **Compact the transcript at a new request.** When Javear types a new message, results from earlier requests are rendered as a one-line stub that names the tool, the size and the session entry holding them (`read_session_entry` recalls them). His messages and her replies stay. Design for approval before code: when it triggers, what is kept, how it stays byte-identical across rounds so the cache holds |
| **2** | 🟡 **built 2026-11-05, deployed at c81dd0b:** `collapseStepLines` (3+ consecutive steps of one type and status become one line with the count; a line with an error, retry or notify message is never folded in) in run events and the `read_workflow_run` outline; `boundGateDialog` (a list over 20 shows 10 plus a pointer to `read_workflow_run`). Session 1293's 22 stored events: 210K → 83K characters (40%). **Run events say less.** `describeRunEvent`'s `steps_since` collapses an iterator's passes into one line per step (count and status), and a gate dialog's large lists are bounded, with the count and how to read them whole (`read_workflow_run`) |
| **3** | 🟡 **built 2026-11-05, deployed at c81dd0b:** `truncateVectorColumns` is shared by `getRows` and every table write; entity writes use `stripVectors`, as entity reads do. **Writes do not return vector columns in full.** `insertRow`, `updateRows` and upsert in `table.mjs`, and the writes in `entity.mjs`, apply the truncation `getRows` already does (5 characters + `...`) |
| **4** | 🟡 **built 2026-11-05, deployed at c81dd0b:** `propose_workflow_fix { fromSandbox: true, baseVersion }`. `resolveProposedSteps` reads the sandbox's `PGC_Workflow` copy, so the pre-gate refusal, the gate diff and the write all see the tested steps. Refused when the live version has moved, there's no sandbox, the copy is unchanged, or a patch is sent as well (`minds_eye_tool_schemas` v14, `sop_test_cycle` says to commit before `end_test`). **Commit a tested copy as tested.** After a sandbox test passes, she commits the sandbox's `PGC_Workflow` copy without re-sending the patch, and the commit gate shows the diff from the live version. Design before code |
| **5** | 🟡 **built 2026-11-05, deployed at c81dd0b:** gate answers weren't recorded anywhere (run 964's gate rows have null output). `resumeGate` now writes each answer as sent beside the gate's row (`buildGateAnswerRecord`: `step_key <step>:answer:<gate_id>`, `output_snapshot.answer`). `answer_gate { asSourceRun: true }` sends the source run's answer for the same gate and visit (`pickSourceAnswer`), and is refused for runs answered before this change. `minds_eye_tool_schemas` v15, `sop_test_cycle`; outlines show `answered`. **Answer a replay's gate as the source run did.** `answer_gate` can take the source run's recorded response for the same gate, so she doesn't have to dig up and re-paste the 4K-character receipt. Design before code (where the source response is recorded) |
| **6** | 🟡 **built 2026-11-05, deployed at c81dd0b:** `path` on `read_workflow_run` (`minds_eye_tool_schemas` v13) resolves into each named step's output value with `resolvePath`: dot, `[n]`, `[*]`, `.length`. **`read_workflow_run` reads a path within a step's output**, as `read_session_entry` reads a page, so one field doesn't take six `run_sql` calls |
| **7** | 🟡 **built 2026-11-05, deployed at c81dd0b:** `outputTokens` and `reasoningTokens` are logged from `usage.output_tokens` / `output_tokens_details`. The gateway's field names are to be confirmed in the first live log (AC8). **Log output tokens** (and reasoning tokens if the gateway reports them) on every `callLlmWithTools` call, so the output line can be split |
| **8** | 🟡 **built 2026-11-05, deployed (v3 upserted):** `sop_test_cycle` v3. The plan works through an `llm_call`'s reshaped input for one item of test data, and at a break she reads the changed input (`read_workflow_run { steps, path }`) before resolving it. **Guidance:** `sop_test_cycle`. At an `LLM_BREAK`, read the changed input before choosing `call_live`. When a code step reshapes what an `llm_call` receives, reason through that input before the first test run (Instruction domain, `PGC_SystemContext`) |
| ~~**9**~~ | ~~**A sandbox "as of run N".**~~ **Dropped (Javear, 2026-11-05):** it fixes no known defect. In session 1293 the `created_at` cutoff left run 964's updates to existing rows in place, and both tests still gave correct results. Building it would mean recording every row's prior values to correct test data that wasn't wrong. Not moved to the backlog |
| **10** | 🟡 **built 2026-11-07:** `callLlmWithTools` raises `isTruncated` when `output_tokens` reaches `max_output_tokens`, so the loop's existing re-ask and `TRUNCATION_NOTICE` fire. **Report a response cut off at the output ceiling as truncation.** Found in session 1307: three `simulate_workflow` calls hit the 10,240 ceiling with their patch cut to 234 characters and were answered "arguments were not valid JSON — resend". She sent the same call again twice and blamed her own JSON. About $1.09 |
| **11** | 🟡 **built 2026-11-07:** `toInputItems` holds a turn's outputs until its last call (grouped by the entry's `turn`), and a respond entry now records its `turn`. **Rebuild a parallel turn in the loop's order** (calls, then outputs). Found in session 1307: call 28's round resume read 28,870 of 54,030 tokens back |
| **12** | 🟡 **built 2026-11-07:** `schemaOperations` / `schemaOperationsRefusal` / `applySchemaOperations`; `minds_eye_tool_schemas` v16. **One approval for a schema sequence.** `propose_schema_fix { operations }` takes an ordered list under one gate, refuses a list that can't run before posting it, runs the operations in order and stops at the first failure (`applied` / `failed` / `not_run`). Session 1307 needed four approvals for two columns and their CHECKs |
| **13** | 🟡 **built 2026-11-07:** `minds_eye_system_prompt` v39 (pacing: every stop waits on the user, and how to stop less), `sop_schema_change` v2 (one approval for the sequence; a CHECK passes NULL, so it can go in the same call as its column). **Stop less (guidance, Instruction domain)** |
| **14** | 🟡 **built 2026-11-07:** `respond { questions }` (`normaliseQuestions`, `composeAnswersPrompt`), `noviaQuestionBlocks` in `callback.mjs`, `collectNoviaAnswers` in `form-fields.mjs`, *Send answers* in `interactive.mjs`; `minds_eye_tool_schemas` v16, `openapi.yaml`. **Answer her questions in place.** Each question gets its own answer box in her message, and the answers come back paired with their questions. Javear could only answer a list by copying the whole message or a screenshot into a modal that covered it |
| **15** | 🟡 **built 2026-11-07:** `withTestPlan`, `testPlanRefusal`, `withTestRequest(result, test, testPlan)`; `testPlan` on `propose_workflow_fix` / `register_workflow` (`minds_eye_tool_schemas` v17); `sop_test_cycle` v4, `minds_eye_system_prompt` v41. **One click approves the change and its test plan.** The plan rides on the approval gate. In session 1308, *Apply and test* was followed by a second stop to approve a plan she wrote afterwards. The change still goes live first (Javear, 2026-11-07) |
| **16** | 🟡 **built 2026-11-07:** `validateColumnDefault`; `addColumn` writes `column.default` (its OpenAPI `ColumnDefinition` already offered it, and the code ignored it); `modifyColumn` takes `default` / `dropDefault`; both keep `PGC_Schema.columns` in step. `propose_schema_fix` gate lines show it; `sop_schema_change` v3. **Column defaults on existing tables** (Execution domain: standard `SET DEFAULT` the harness didn't accept). Found in session 1308: making `item_type` required needed a default no tool could set |

## Acceptance Criteria

⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved. **Updated when a criterion's
state changes, not at close.**

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ✅ met 2026-11-05: session 1293's 128 entries re-rendered at its 93 call points by main's and this branch's `toInputItems`. Transcript 30.4M → 8.5M characters (**27.9%**), peak 636K → 198K. With the ~20K-token instructions-and-tools prefix counted, about 41% | Session 1293's stored entries, rendered at each of its 85 call points by the new `toInputItems`, total less than half the input characters they total today (an offline counterfactual, run as a script against the live rows) | [1](#scope), [2](#scope), [3](#scope) | ≤ 50% |
| **AC2** | ✅ met 2026-11-07: unit tests, and live in session 1308. Every round resume read its whole prefix back across parallel turns (entries 2–7, 22–23): 59,032 of 59,034 tokens after the commit gate, and 27,242 of 27,244 and 29,163 of 29,165 after test-run wakes. In 1307 the same situation re-wrote 25K tokens | Compaction keeps the cache: within a request, every round after the first reads its whole prefix back (unit test that renders byte-identically across rounds; live `cacheRead` from the proc logs) | [1](#scope), [11](#scope) | Binary — unit test and live |
| **AC3** | ✅ met 2026-11-07: session 1307 (8 requests, sandbox test run 974). 81 calls, $4.04, $0.050 a call against 1293's $0.076. Peak context **92,775** tokens against 287K. Output was the largest charge ($1.75), not reads ($0.77) | A live Novia session of at least three requests that includes a sandbox test, measured from the proc logs: cost per call and peak context against session 1293 | [1](#scope)–[8](#scope) | Peak context ≤ 120K; reported |
| **AC4** | ✅ met 2026-11-05: `serv-write-vectors.test.mjs` (10 tests) runs the real routes for insert, batch insert, update, upsert and the three entity writes; 1334 → 1344 tests | No write returns a full vector (unit tests on `insertRow`, `updateRows`, upsert, entity writes) | [3](#scope) | Unit tests pass |
| **AC5** | ✅ met 2026-11-07: unit tests (`minds-eye-commit-tested-copy.test.mjs`, 5 tests). Live in session 1307, entry 97: `propose_workflow_fix { fromSandbox: true, baseVersion: 12 }` with no patch committed `review_inventory` v13 (`mode: from_sandbox`, validation passed) | A tested sandbox copy is committed without the patch being sent again, and the committed steps equal the tested steps | [4](#scope) | Binary — unit test and live |
| **AC6** | 🟡 unit tests met 2026-11-05 (`gate-answer-record.test.mjs`, 8 tests); live needs a replay of a run answered after deploy | A replay's gate is answered with the source run's response, with no form values in the call | [5](#scope) | Binary — live |
| **AC7** | ✅ met 2026-11-05: 4 unit tests in `minds-eye-run-event-bounds.test.mjs` (a field, `.length`, `[*]`, an unresolved path → null). The result is bounded by `capOutput` like every read | `read_workflow_run` returns one path of a step's output, bounded with provenance | [6](#scope) | Unit tests pass |
| **AC8** | ✅ met 2026-11-07: `outputTokens` and `reasoningTokens` appear on all 81 of session 1307's calls (the gateway uses `usage.output_tokens` and `output_tokens_details.reasoning_tokens`) | Output tokens are in the proc log for every Novia call | [7](#scope) | Seen in the logs |
| **AC9** | ✅ met 2026-11-07: session 1308, run 977's `LLM_BREAK` at step 10 (hard drift on input). Before resolving it she read the step that reshapes the input (`read_workflow_run` 8e) and the prompt, saw every item was already matched by exact alias, and supplied the empty response at no LLM cost | `sop_test_cycle` carries the break-inspection rule, and in AC3's session Novia reads the changed input before resolving any break | [8](#scope) | Shown in AC3's session |
| ~~**AC10**~~ | ~~⬜~~ dropped with scope 9 | ~~`start_test` with a run as its cutoff yields the tables as they stood before that run~~ | ~~[9](#scope)~~ | — |
| **AC11** | 🟡 unit tests met 2026-11-07 (`minds-eye-schema-operations.test.mjs`, 11 tests); live pending | A schema change of several operations goes through one approval, in order, and stops at the first failure | [12](#scope) | Binary — unit tests and live |
| **AC12** | ⬜ | In the next live session with a schema change or a multi-point question, Novia sends the sequence in one `propose_schema_fix` and asks her questions in one respond's `questions` | [13](#scope) | Shown in a live session |
| **AC13** | ✅ met 2026-11-07: session 1308. Her respond asked two questions with choices (entry 19); *Send answers* returned them as entry 20, each paired with its question | Javear answers each of Novia's questions in its own box in Slack, her message stays visible, and she receives each answer with its question | [14](#scope) | Binary — live in Slack |
| **AC14** | 🟡 unit tests met 2026-11-07 (`minds-eye-test-plan-gate.test.mjs`, 13 tests); live pending | Her next workflow change carries its test plan on the gate, and *Apply and test* leads straight to the test with no further approval | [15](#scope) | Binary — live |
| **AC15** | 🟡 unit tests met 2026-11-07 (`serv-schema-defaults.test.mjs`, 28 tests, the real routes against a stubbed `pg.Client`); live pending | `item_type` gets the default `'regular'` and becomes NOT NULL in one `propose_schema_fix` approval (also AC11's live case), with the registry showing both | [16](#scope), [12](#scope) | Binary — live |

## Out of scope

| Item | Why |
|---|---|
| Simulating against a recorded run's state; previewing an `llm_call`'s input | Withdrawn (above): the replay's `LLM_BREAK` already shows that input |
| The 5-minute cache TTL | The gateway ignores a 1-hour TTL (measured 2026-10-24); unchanged |
| `process_receipt` itself | v16 is live and was tested in session 1293 |
