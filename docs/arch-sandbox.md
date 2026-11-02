# evolving-mind-ai — Test Sandbox
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Status: **Approved (Javear, 2026-11-02) — SERV half built.** `src/serv/sandbox.mjs`, `src/serv/sandbox-context.mjs`.

---

## 1. Policy

1. **A test never writes household data.** Every run Novia starts as a test runs in the sandbox.
   Its writes to `PGD_*` tables go to copies; a write to a table that was not copied is refused.
2. **Test data is hers to shape.** She chooses which tables are copied and which of their rows,
   and creates, edits and deletes sandbox rows freely — no gate, no approval per write. The
   approved test plan says what she will copy and create.
3. **Real data stays gated.** Her writes outside the sandbox are gated exactly as today.
4. **One sandbox, one test cycle.** She creates it when a test cycle starts, resets it to its
   starting data to retest, and drops it when she reports. Creating a sandbox drops any earlier one.
5. **The record of the test is real.** The run, its steps, its session and diagnostics are written
   to the real `PGC_*` tables, so the test can be read and explained afterwards.
6. **A test run never reaches Slack.** It runs with `callback.provider: 'novia'` (Sprint 15
   scope 6).
7. **Not testable in the sandbox:** creating tables or views (`serv_schema`). A test run refuses
   the step with an error naming it; the plan lists it as not covered.

## 2. What the sandbox holds

A Postgres schema, `sandbox_<n>`, in the one database PGC and PGD share.

| Copied | How chosen | Rows |
|---|---|---|
| The `PGD_*` tables the test needs | Named by Novia, from the workflow's steps and her plan; SERV adds the FK parents of every named table | Per table: `all`, `none`, or SERV filters (the `getRows` filter form) |
| `PGD_*` views over a copied table | Automatic — every view that depends on a copied table is recreated over the copy | — |
| `PGC_Memory` | Always | All — a test run reads real memory plus its own, and its writes stay in the sandbox |
| `PGC_Workflow` | Always | All — the uncommitted test copy of a workflow (§5) replaces the real row here and only here |

- **FKs** are recreated between the copies, so `CASCADE` deletes behave as they do for real. A
  parent she did not name is copied with all its rows. The FKs are added `NOT VALID`: a filtered
  copy is accepted as it stands, and every write made in the sandbox is checked.
- **Triggers** are recreated on the copies — `LIKE … INCLUDING ALL` does not copy them, and
  without the `updated_at` triggers a test would see different rows from the ones the household
  sees.
- **Each `serial` column** gets its own sequence, set to the real table's current maximum, so test
  inserts never consume real ids.
- **Tables not copied** — other `PGD_*` tables, and every other `PGC_*` table — resolve to the
  real ones. A test run may read them; it may not write the `PGD_*` ones.

## 3. How a test run reaches it

**Postgres `search_path`.** SERV names every table unqualified, so a connection opened with
`SET search_path TO sandbox_<n>, public` reads and writes the copies, and finds every table not
copied in `public`. No query changes.

```
PGC_WorkflowRun.sandbox = 'sandbox_<n>'       ← set when Novia starts a test run
        │
run-workflow.mjs runs the run inside withSandbox(run.sandbox, …)
        │
serv-client.mjs  ──  every SERV call made in that context carries  x-sandbox: sandbox_<n>
        │
SERV  ──  validates the name (pattern + the schema exists),
          SET search_path on every connection that request opens,
          refuses a PGD write to a table the sandbox does not hold
```

- **The context is set once per run**, by `run-workflow.mjs`, with Node's `AsyncLocalStorage`.
  Step code, the LLM harness and the memory writer make their SERV calls unchanged.
- **The name is validated before it reaches SQL.** `sandbox_` followed by digits only, and present
  in `pg_namespace`; anything else is a 400.
- **A missed table is an error, not a leak.** The refusal names the table, so she adds it to the
  sandbox and reruns.
- **A real run is never affected.** Only requests carrying the header change `search_path`; the
  household can keep using every workflow while a test runs.

## 4. Novia's tools

| Tool | What it does |
|---|---|
| `start_test({ tables: [{ name, rows }] })` | `POST /serv/sandbox/create`: drops any existing sandbox, copies §2, stores the spec in the sandbox, and returns its name and what was copied — named tables, added FK parents, recreated views, row counts |
| `reset_test()` | Recreates the sandbox from its stored spec: back to its starting data, test-created rows gone |
| `end_test()` | `POST /serv/sandbox/drop`: drops the schema; the run records stay |
| `insert_data` / `update_data` / `delete_data` with `sandbox: true` | Shapes test data — ungated, sandbox only |
| `query_table` / `run_sql` with `sandbox: true` | Reads sandbox data to set up and verify outcomes |
| `run_workflow` with `test: true` | Starts a run with `sandbox` set and provider `novia`; refused when no sandbox exists |

To widen a sandbox mid-cycle she calls `start_test` again with the larger spec.

**On a defect** she finishes every path it does not block, reports, ends the test, and goes through
the normal fix cycle (simulate → Javear's permission → commit). A fresh test cycle starts a fresh
sandbox, copied from current household data with the committed fix in `PGC_Workflow`.

## 5. The uncommitted test copy

When only a workflow change can cut a loop, she writes a test copy of the workflow into the
sandbox's `PGC_Workflow`, **in place of the real row, with the same `id`**. The run's
`workflow_id` points at the real row, so the run record is valid; `run-workflow.mjs` loads steps
inside the sandbox context, so the run executes the test copy. The test copy passes L1/L2
simulation before it is written. The plan shows its diff from the real workflow; it disappears
with the sandbox.

## 6. What is built

| Piece | Where |
|---|---|
| `PGC_WorkflowRun.sandbox` (text, null) | Template + `seed_PGC_Schema.json`, deployed with `addColumn`; `arch-data.md` |
| `withSandbox` and the `x-sandbox` header | `src/shared/serv-client.mjs` |
| Running a run inside its sandbox | `src/proc/run-workflow.mjs` |
| Header validation, `search_path` on every connection, the write refusal | `src/serv/` — one helper used where SERV opens a connection |
| `create` (copy, FK parents, views, sequences, spec) / `drop` | A new SERV route, spec-first in `openapi.yaml` |
| `serv_schema` refused in a sandbox run | `src/proc/step-executor.mjs` |
| `start_test`, `reset_test`, `end_test`, `sandbox: true`, `test: true` | `src/proc/minds-eye.mjs` + `minds_eye_tool_schemas` |
