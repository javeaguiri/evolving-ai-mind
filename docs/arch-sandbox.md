# evolving-mind-ai — Test Sandbox
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Status: **Proposed — Sprint 15 AC2, for Javear's approval.**

---

## 1. Policy

1. **A test never touches household data.** Every run Novia starts as a test runs in the sandbox:
   its reads and writes of `PGD_*` tables go to copies.
2. **Test data is hers to shape.** She creates, edits and deletes rows in the sandbox freely —
   no gate, no approval per write. The approved test plan says what she will create.
3. **Real data stays gated.** Her writes outside the sandbox are gated exactly as today.
4. **One sandbox, one test cycle.** She creates it when a test cycle starts and drops it when she
   reports. Creating a sandbox drops any earlier one.
5. **The record of the test is real.** The run, its steps, its session and diagnostics are written
   to the real `PGC_*` tables, so the test can be read and explained afterwards.
6. **A test run never reaches Slack.** It runs with `callback.provider: 'novia'` (Sprint 15
   scope 6).
7. **Not testable in the sandbox:** creating tables or views (`serv_schema`). A test run refuses
   the step with an error naming it; the plan lists it as not covered.

## 2. What the sandbox holds

A Postgres schema, `sandbox_<n>`, in the one database PGC and PGD share. It holds a copy of:

| Copied | Why |
|---|---|
| Every `PGD_*` table, with its rows, indexes, constraints and FKs | The workflow's data. FKs are recreated between the copies so `CASCADE` deletes behave as they do for real |
| Every `PGD_*` view, recreated over the copied tables | A view binds to the tables it was created over; the real view would read real data |
| `PGC_Memory` | A test run's memory writes stay out of household memory, and its reads see real memory plus its own |
| `PGC_Workflow` | The uncommitted test copy of a workflow (§5) replaces the real row here and only here |

Everything else — `PGC_WorkflowRun`, `PGC_WorkflowRunStep`, `PGC_Session*`, the schema registry,
prompts, system context — is not copied and resolves to the real table.

The whole PGD layer is copied, not just the tables one workflow touches: it is small, and a full
copy needs no analysis of which tables a workflow reaches or what their FKs pull in.

Each copied table with a `serial` column gets its own sequence, set to the table's current maximum,
so test inserts never consume real ids.

## 3. How a test run reaches it

**Postgres `search_path`.** SERV names every table unqualified, so a connection opened with
`SET search_path TO sandbox_<n>, public` reads and writes the copies, and finds every table
not copied in `public`. No query changes.

```
PGC_WorkflowRun.sandbox = 'sandbox_<n>'       ← set when Novia starts a test run
        │
run-workflow.mjs runs the run inside withSandbox(run.sandbox, …)
        │
serv-client.mjs  ──  every SERV call made in that context carries  x-sandbox: sandbox_<n>
        │
SERV  ──  validates the name (pattern + the schema exists),
          then SET search_path on every connection that request opens
```

- **The context is set once per run**, by `run-workflow.mjs`, with Node's `AsyncLocalStorage`.
  Step code, the LLM harness and the memory writer make their SERV calls unchanged.
- **The name is validated before it reaches SQL.** `sandbox_` followed by digits only, and present
  in `pg_namespace`; anything else is a 400.
- **A real run is never affected.** Only requests carrying the header change `search_path`;
  the household can keep using every workflow while a test runs.

## 4. Lifecycle

| Operation | Who | What |
|---|---|---|
| `POST /serv/sandbox/create` | Novia's `start_test` tool | Drops any existing `sandbox_*` schema, creates `sandbox_<n>`, copies §2, returns its name |
| Test data | Her `insert_data` / `update_data` / `delete_data` / `query_table` / `run_sql` with `sandbox: true` | Ungated inside the sandbox; she reads it to verify outcomes |
| Test runs | Her `run_workflow` with `test: true` | `sandbox` set on the run, provider `novia` |
| `POST /serv/sandbox/drop` | Her `end_test` tool, when she reports | Drops the schema; the run records stay |

**On a defect** she finishes every path it does not block, reports, drops the sandbox, and goes
through the normal fix cycle (simulate → Javear's permission → commit). A fresh test cycle creates
a fresh sandbox — copied again, so it holds the committed fix and current household data.

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
| Header validation and `search_path` on every connection | `src/serv/` — one helper used where SERV opens a connection |
| `create` / `drop` | A new SERV route, spec-first in `openapi.yaml` |
| `serv_schema` refused in a sandbox run | `src/proc/step-executor.mjs` |
| `start_test`, `end_test`, `sandbox: true`, `test: true` | `src/proc/minds-eye.mjs` + `minds_eye_tool_schemas` |
