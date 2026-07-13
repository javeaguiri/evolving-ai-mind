# evolving-mind-ai — LLM Replay Harness
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Status: **Design — not yet implemented.** Sprint 8 lead item.

---

## 1. Purpose

Developing `create_workflow` requires invoking it live several times a day. Each invocation
costs real Perplexity spend, and the overwhelming majority of defects it surfaces are in
deterministic code — step routing, template resolution, schema registration, Slack rendering —
that never needed an LLM to find.

The replay harness removes the LLM from the development loop without removing anything else.
A replayed run is a **real run**: real `local_state`, real `js_transform`, real SERV reads and
writes, real human gates in Slack. Only the network call to the LLM is served from a recording.

It has a second purpose of equal value. Because prompt assembly runs for real on every replayed
call, a replay **proves how prompts are constructed** — including how a change to a `js_transform`
or a gate downstream propagates into the next prompt's text. Prompt construction stops being
something to reason about and becomes something to observe.

---

## 2. The seam

`llm-harness.mjs → executeLlmCall()` is the only place in the system that calls an LLM on behalf
of a workflow step. Everything it does before the call is deterministic and free:

```
  load PGC_Prompt by intent_category          ← SERV read
  resolveInput(step.input, localState)        ← template resolution
  load PGC_SystemContext                      ← SERV read
  inject step_type_contracts if referenced    ← SERV read
  resolveModelAlias()                         ← pure
  retrieveMemories()                          ← SERV read
  assembleInstructions()                      ← pure
  resolveTemplate(step.input.user_input)      ← template resolution
─────────────────────────────────────────────────────────────── THE SEAM
  callLlm(model, instructions, userInput, schema, ...)   ← $
───────────────────────────────────────────────────────────────
  validate() via review-output                ← Ajv + semantic + routing
  write PGC_Session + PGC_SessionEntry        ← diagnostics
  write PGC_Memory if save_to_memory          ← memory
```

The harness intercepts **only** at the seam. Everything above it runs unchanged — that is what
makes a replayed run trustworthy evidence about prompt construction rather than a simulation of it.
Everything below it runs unchanged — a replayed response is validated, recorded, and memory-written
exactly as a live one is.

---

## 3. The request fingerprint

A recorded response is addressable by **the content of the request that produced it**, never by
its position in a run.

Keying on `(run_id, step_id)` is unsound: the moment a gate is answered differently, a
`js_transform` changes, or a step is inserted, that key still resolves — and returns a response
generated against a *different prompt*. A silently wrong hit is worse than a miss.

### Components

The fingerprint is recorded per `llm_call` as a set of component hashes, not one opaque digest:

| component | source | drift means |
|---|---|---|
| `prompt` | `PGC_Prompt.prompt_text` + `version` | the instruction text changed |
| `input` | `resolvedInput` (post `resolveInput`) | `local_state` reaching this call changed |
| `user_input` | resolved `step.input.user_input` | the user message changed |
| `model` | resolved model ID (post alias) | a different model would answer |
| `schema` | `PGC_Prompt.output_schema` | the response contract changed |
| `memory` | the injected memory block | different memories were retrieved |

A **hit** requires every component to match. The composite hash is the fast path; the component
breakdown is what a break report shows, so drift is always attributable to a cause rather than to
"something changed".

### Why component-level, not a single hash

Memory retrieval is time-varying: `PGC_Memory` accumulates, so an identical run assembled a week
later can retrieve a different memory block. Under a single opaque hash this invalidates the entire
corpus continuously. Under component hashes, memory-only drift is classified as **soft** — reused
by default and logged — while prompt or input drift is **hard** and breaks. See §8.

### What this gives for free

- **The correction loop.** A retry after validation failure carries the error list in its prompt,
  so it fingerprints differently and gets its own recording. No attempt-counter bookkeeping.
- **Iterators.** An `llm_call` inside an iterator runs N times with a different `local_state` each
  time, so each iteration addresses its own recording. No index bookkeeping.
- **Path divergence.** Answering a gate differently changes `local_state`, which changes
  `resolvedInput`, which misses. Divergence that never reaches a prompt is — by definition —
  irrelevant to the LLM, and correctly ignored.

---

## 4. Break policy — one mechanism, three modes

Replay and record are not two mechanisms. They are two values of a break policy on the same seam.

| `llm_break_policy` | at each `llm_call` | LLM cost |
|---|---|---|
| `never` | call the LLM | full |
| `on_miss` | serve fingerprint hits; **break** on hard drift or miss | zero on hit |
| `always` | **break** at every call; never call the LLM | zero |

`never` is today's behaviour and the default for any run with no replay config.
`on_miss` is *replay*. `always` is *record*.

The policy is stored on the run and **may be changed at a break** — a run started as `on_miss` can
be switched to `always` from the break point onward ("record the rest").

A run with `always` and **no** source run is how a corpus is bootstrapped for a workflow that has
never been run: every response is hand-written. This is also how synthetic fixtures are built.

---

## 5. The break

A break reuses the existing suspension machinery — the same stack-frame push, persist, and
SQS-resume cycle that `human_gate` uses. It is not a parallel engine.

```
executeLlmCall reaches the seam
  → policy says break
  → stash { instructions, userInput, fingerprint, candidate } on a break frame
  → run.status = 'awaiting_llm_break'
  → persist stack, enqueue HUMAN_NOTIFICATION to Slack (pointer only)
  → Lambda returns

developer reads the break over HTTP, supplies a resolution

  → resume endpoint writes { resolution, response } onto the break frame
  → WORKFLOW_STEP / resume_llm  — carries workflowRunId only, no payload
  → re-enter executeLlmCall with the forced response read from the frame
  → assembly re-runs (free) and is VERIFIED against the stashed fingerprint
  → validate → session write → memory write → next step
```

### Resolutions

| resolution | effect |
|---|---|
| `use_recorded` | accept the candidate recording despite drift |
| `call_live` | call the LLM for this one step, then continue under the run's policy |
| `supplied` | use a response supplied in the request body |
| `abort` | cancel the run |

`use_recorded` is the resolution that makes prompt iteration cheap. When a prompt is edited in a
way that should not change the answer, accepting the recording keeps the entire downstream suffix
free.

### The break notification is the interface

A break is a message to a **developer**, not to a user. What a developer needs is not a description
of what happened but the commands to act on it. A notification that reports a break and leaves the
route shape, the auth header, and the resolution vocabulary to be rediscovered has handed over a
chore instead of a decision.

The notification therefore carries a literal, copy-pasteable command for every resolution:

```
🛑  Run 812 — BROKE at step 21, awaiting resume

    workflow     create_workflow
    step         21 · design_workflow_process
    replaying    run 719
    reason       DRIFT — input, prompt   (memory drift ignored: soft)
    policy       on_miss

    Read the break — assembled prompt, component diff, local_state diff:
      curl -s -H "x-api-key: $INTERNAL_API_KEY" "https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/proc/replay/812"

    Resume with the recorded response — free, keeps the whole suffix free:
      curl -s -X POST -H "x-api-key: $INTERNAL_API_KEY" -H 'content-type: application/json' -d '{"resolution":"use_recorded"}' "https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/proc/replay/812/resume"

    Resume by calling the LLM for this step only — costs one call:
      curl -s -X POST -H "x-api-key: $INTERNAL_API_KEY" -H 'content-type: application/json' -d '{"resolution":"call_live"}' "https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/proc/replay/812/resume"

    Resume with a response you write — free:
      curl -s -X POST -H "x-api-key: $INTERNAL_API_KEY" -H 'content-type: application/json' -d @resume.json "https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/proc/replay/812/resume"
      resume.json:  { "resolution": "supplied", "response": { ... } }

    Record every remaining step:  add  "breakPolicy": "always"  to any resume body.
    Abandon:                      -d '{"resolution":"abort"}'
```

Rules the message obeys:

- **URLs are literal.** No `$BASE`, no placeholder host — the command is runnable as printed.
- **The API key is never rendered.** `$INTERNAL_API_KEY` is referenced as an environment variable so
  no key material is ever written to a Slack channel, a log, or a transcript.
- **`812` is the replay run, `719` is the source run.** Both appear, so the distinction never has to
  be inferred. Every path parameter in the API is the **replay** run (§9).
- **The prompt is not in the message.** It is far past Slack's 3000-char block limit, and the system's
  convention is that messages are pointers, not payloads. The `GET` returns it.

### At a break, the prompt is on the frame — not in `PGC_SessionEntry`

The diagnostics session is written **after** a response is obtained. At suspend time no response
exists, so no `PGC_Session` row has been written for this call yet. The assembled prompt lives on
the break frame in `PGC_WorkflowRun.stack`, and `GET /proc/replay/{runId}` serves it from there.

The `PGC_Session` row is written on resume, once a response — recorded, live, or supplied — has been
obtained and validated, exactly as in a live run.

### The supplied response is not privileged

Whatever response is supplied — recorded, live, or hand-written — flows through `review-output`
(Ajv + semantic + routing) and the `PGC_Session` diagnostics write exactly as a live response does.
A hand-written response that would have failed validation **fails the run**. Bypassing validation
would test the harness against inputs the harness never actually accepts.

### Re-assembly is verified, not assumed

On `resume_llm` the step re-executes from the top, so assembly runs a second time. It is expected
to be identical — `local_state` is frozen while the run is suspended — but memory retrieval could
in principle differ. The re-assembled fingerprint is compared against the one stashed on the break
frame. A mismatch is surfaced as an anomaly; it is never silently accepted.

---

## 6. Runs are never replayed in place

A replay **always creates a new `PGC_WorkflowRun`.**

- The source run's `PGC_WorkflowRun`, `PGC_WorkflowRunStep`, and `PGC_Session` rows are the
  corpus being read. Re-executing in place would overwrite the evidence being replayed and
  collide with the `PGC_WorkflowRunStep` idempotency log.
- A replayed run performs real SERV writes. It must be independently visible in the audit log.
- Multiple replays can fan out from one source — the same run, replayed three times, answering a
  gate differently each time.

### The new run copies the input, not the recordings

From the source run the new run copies `workflow_id` and `input` — nothing else. Recordings are
**looked up by fingerprint**, not duplicated into the new run.

Each `llm_call` in the new run writes its own `PGC_Session` + `PGC_SessionEntry` rows, carrying the
prompt **as assembled in this run** and the response **actually used**, plus provenance. The new
run's log is therefore complete and self-contained, which means:

- a replay of a replay works with no special case
- `/explain` on the new run shows the real assembled prompt for every step
- prompts can be diffed run-to-run even for steps that replayed silently

Copying the source run's session entries into the new run would create a second copy of one truth.
It is not done.

---

## 7. Schema changes

### `PGC_WorkflowRun` — new columns

| column | type | purpose |
|---|---|---|
| `replay_source_run_id` | `integer` nullable | the run whose corpus and input this run replays |
| `llm_break_policy` | `text` nullable | `never` \| `on_miss` \| `always`; null ⇒ `never` |

New `status` value: **`awaiting_llm_break`**. Distinct from `awaiting_human_gate` so that a run
paused for a developer is never confused with a run paused for a user — by `/shutdown`, by gate
tooling, or by a human reading the table.

### `PGC_Session` — new columns

`PGC_Session` is already one row per `llm_call`, with `run_id`, `step_id`, and `intent_category`.
It is the natural home for the fingerprint. (`PGC_SessionEntry` is one row per *message* and is not.)

| column | type | purpose |
|---|---|---|
| `request_fingerprint` | `jsonb` | the component hashes of §3 |
| `fingerprint_hash` | `text`, indexed | composite of the components — the lookup key |
| `response_source` | `text` | `live` \| `replayed` \| `recorded` |
| `replayed_from_session_id` | `integer` nullable | provenance — which recording was served |

No new table. The replay corpus is a read over the diagnostics log the system already writes for
every `llm_call` of every run.

### Backfill

Existing `PGC_Session` rows have no fingerprint. A backfill script recomputes the composite hash
from the stored `PGC_SessionEntry` system/user messages, making every historical run — including
the seven `create_workflow` runs already measured — immediately replayable.

---

## 7a. Where replay state lives

| state | grain | home | read/written when |
|---|---|---|---|
| `replay_source_run_id` | run | `PGC_WorkflowRun` | set at run creation; read to scope every corpus lookup |
| `llm_break_policy` | run | `PGC_WorkflowRun` | set at run creation; **mutable at a break** |
| break payload — assembled prompt, fingerprint, candidate | frame | `PGC_WorkflowRun.stack` | written at suspend; read at `resume_llm` |
| resolution + supplied response | frame | `PGC_WorkflowRun.stack` | written by the resume endpoint; read at `resume_llm` |
| `request_fingerprint`, `response_source`, `replayed_from_session_id` | call | `PGC_Session` | written after each `llm_call` |

The two run-grain pointers answer different questions and are not duplicates of each other:
`PGC_WorkflowRun.replay_source_run_id` says **where to look** (config, read before the call);
`PGC_Session.replayed_from_session_id` says **what was found** (provenance, written after it).

### The policy is read from the run row on every step

`run-workflow.mjs` already calls `loadRun()` at the top of every `execute_top` — it must, to read
`status` and `stack`. `llm_break_policy` and `replay_source_run_id` ride along in that existing
SELECT at no additional cost, and `step-executor.mjs` already passes the whole run row into
`executeLlmCall({ step, localState, run, traceId })`. The policy is therefore **already in scope at
the seam** with no signature change anywhere in the call chain.

`LOAD_RUN_COLUMNS` in `run-workflow.mjs` is an explicit column whitelist. The two new columns must
be added to it, or they arrive as `undefined` — failing closed to `never` and silently billing a
run that was supposed to replay. This is worth its own unit test.

### Not cached in the Lambda

One step is one invocation, and the Step Processor holds no in-process state between invocations
(Section 6.5). Warm containers are shared across **concurrent runs** (`BatchSize: 10`), so a
module-level cache would leak replay mode from a replayed run into a live user's run, and would
evaporate whenever a container recycled mid-run.

### Not carried in the SQS message

Four producers enqueue `WORKFLOW_STEP` — `run-workflow.mjs` re-enqueueing `execute_top`,
`interactive.mjs` on a gate click, `classify-intent.mjs` on the initial hop, and the replay resume
endpoint. Carrying the policy in the message would require all four to propagate it, including
`interactive.mjs`, which is Experience tier and must not know what replay mode is.

The policy is also **mutable mid-run** — a break can switch a run to `record` from that point
onward. A value copied into a message already in flight is stale by construction.

Durable run config lives in the run row and is read fresh on every step. Only one-shot per-message
payloads travel in SQS. This is the same split the system already makes for `status`.

---

## 8. Drift classification

| drifting component | class | default at a break |
|---|---|---|
| `input` | hard | break — `local_state` reaching the call changed |
| `prompt` | hard | break — offer `use_recorded` with a text diff |
| `user_input` | hard | break |
| `model` | hard | break |
| `schema` | hard | break — the recorded response may no longer validate |
| `memory` | soft | reuse, log, do not break |
| *no recording at all* | miss | break — nothing to offer but `call_live` / `supplied` |

A break report carries, for the developer to decide with:

- the **assembled prompt** for this call, in full
- a **component diff** against the candidate recording — which components drifted, and a text diff
  of each
- a **`local_state` diff** against the source run at the same step

The `local_state` diff is **diagnostic only**. It is never consulted to decide whether to break —
the fingerprint decides. `local_state` divergence that does not reach a prompt has no LLM
consequence and is correctly ignored by the control path.

---

## 9. Services

### PROC endpoints

```
POST /proc/replay                  start a replay or record run  → returns the NEW runId
GET  /proc/replay/{runId}          status; full break report when broken
POST /proc/replay/{runId}/resume   supply a resolution and continue
```

**`{runId}` is always the new replay run — never the source run.**

The source run is named exactly once in the entire API: as `sourceRunId` in the `POST /proc/replay`
body. After that it is never addressed again by a caller. It is a **corpus being read**, not a
process — it has no state to inspect and nothing to resume. Everything that can be inspected or
resumed belongs to the new run.

| | run addressed |
|---|---|
| `POST /proc/replay` body `sourceRunId` | **source** (old) — the corpus |
| `POST /proc/replay` response `runId` | **replay** (new) |
| `GET /proc/replay/{runId}` | **replay** (new) |
| `POST /proc/replay/{runId}/resume` | **replay** (new) |
| Slack break notification | shows **both**, labelled |

**`POST /proc/replay`**

```json
{
  "sourceRunId": 719,
  "breakPolicy": "on_miss",
  "callback":    { "provider": "slack", "channel": "...", "threadId": "..." }
}
```

`sourceRunId` is optional. Omitted, the caller supplies `workflow` + `input` directly and starts a
fresh run — with `breakPolicy: "always"` that is pure record mode against a workflow that has no
recorded run. Supplied, `workflow_id` and `input` are copied from the source run.

Returns the new `runId`. The endpoint is a thin constructor over the existing run-creation path —
it is not a second execution engine.

**`POST /proc/replay/{runId}/resume`**

```json
{
  "resolution":  "use_recorded",
  "response":    { },
  "breakPolicy": "always"
}
```

`response` is required only for `supplied`. `breakPolicy` is optional and changes the run's policy
from this point onward.

The endpoint writes the resolution and any supplied response **onto the break frame** in
`PGC_WorkflowRun.stack`, then enqueues a `resume_llm` message carrying only `workflowRunId`. A
hand-supplied response for a step such as `design_workflow_process` can approach SQS's 256KB
message limit; the frame is `jsonb` and has no such ceiling. SQS messages stay pointers, never
payloads.

Resolution is over **HTTP, not Slack**. An LLM response for a step like `design_workflow_process`
is far larger than a Slack modal input accepts. Slack receives a break *notification* carrying the
run ID and session ID; the response is supplied over HTTP.

Real `human_gate` steps in a replayed run are unaffected — they render in Slack and are answered in
Slack, exactly as in a live run. That is the point: a replay is a real run with a recorded LLM.

### Starting a replay — any workflow, system or evolving

**There is no per-workflow case.** The seam is `executeLlmCall`, which every `llm_call` step of every
workflow passes through. `create_domain`, `create_workflow`, `edit_budget`, a generated CRUD
workflow — all replay identically.

This holds because all three existing entry paths converge on the same two operations:

| entry | what it does before the run |
|---|---|
| `create-domain.mjs` | resolves `input = { userInput }` → insert `PGC_WorkflowRun` → enqueue `execute_top` |
| `create-workflow.mjs` | resolves `input = { userInput, domain }` via `matchDomainAlias` → insert `PGC_WorkflowRun` → enqueue `execute_top` |
| `classify-intent.mjs` `handoff()` | resolves `input = workflowInput` → insert `PGC_WorkflowRun` → enqueue `execute_top` |

Their only pre-run work is **computing what goes into `input`** — and that answer is already persisted
in the source run's `PGC_WorkflowRun.input`. `POST /proc/replay` therefore clones `workflow_id` +
`input` and enqueues `execute_top`: **a fourth entry point of identical shape.** Bypassing the entry
module is not merely safe, it is correct — its only job was to compute a value the corpus already has.

A consequence worth stating: a replay does **not** re-run `matchDomainAlias` or intent classification.
Replay begins at the run, not at the intent. Intent routing is separately cheap to exercise and is not
what this harness is for.

### What is outside the seam

| not replayable | why | matters? |
|---|---|---|
| `classify-intent.mjs` Tier 2/3 sonar calls | fire *before* a `PGC_WorkflowRun` exists; do not route through `llm-harness` | no — priced as negligible (§16.4) |
| Novia (`minds-eye.mjs`) | runs its own agentic loop with its own LLM calls, not `executeLlmCall` | no — out of scope; revisit if Novia spend grows |

Every `llm_call` step of every workflow **is** at the seam — which is where the entire measured bill
lives (42 `llm_call` steps across 7 `create_workflow` runs).

### Slack

```
/replay                      list recent runs — id, workflow, status, llm_call count, replayable?
/replay <runId>              replay that run          (breakPolicy: on_miss)
/replay <runId> record       replay, breaking at every llm_call   (breakPolicy: always)
```

`/replay` with no argument answers the question that actually blocks a developer: *which run do I
replay?* It lists recent runs with the one fact that decides it — whether the run has a complete
fingerprinted corpus, and therefore whether replaying it costs nothing or breaks immediately.

`/replay <runId>` needs no workflow name. The run row already knows its `workflow_id`, so the same
command replays a `create_workflow` run, a `create_domain` run, or a generated domain workflow.

### Recording a workflow that has never run

There is no source run to clone, so `workflow` and `input` are supplied directly. This is the HTTP
path — it does not fit a slash command, and it should not try to.

```
curl -s -X POST -H "x-api-key: $INTERNAL_API_KEY" -H 'content-type: application/json' \
  -d '{"workflow":"create_workflow","input":{"userInput":"<description>","domain":null},"breakPolicy":"always"}' \
  "https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/proc/replay"
```

Every `llm_call` breaks; each response is hand-written. The result is a corpus for a workflow that has
never been invoked live — which is also how synthetic fixtures are built for the regression use in §10.

Break notifications post to the run's thread as `HUMAN_NOTIFICATION` — run ID, step, drift summary,
and the session ID to pull the prompt from. They are pointers, not payloads.

### Dev script

`dev_scripts/replay.mjs` wraps the loop that is actually run daily:

```
start run → poll → on break, write assembled prompt + drift report to a local file
          → wait for a response file → POST the resolution → continue
```

It is a wrapper over the three HTTP endpoints and contains no logic of its own.

---

## 10. Replay as a regression test

Because assembly runs for real and every call records its assembled prompt, a replay with a
complete corpus and **zero hard drift** is an end-to-end assertion that the system still constructs
every prompt in a run exactly as it did before — with real `local_state`, real transforms, and no
mocking. It costs nothing to run.

This makes the harness the tool for the failure class Sprint 7 identified: of ~15 defects fixed on
2026-07-12, eleven were in deterministic code, found by paying an LLM to run the pipeline because
running the pipeline live was the only way to exercise it.

A change to a `js_transform`, a step type, a gate renderer, or the schema registry can now be
verified against every recorded run in the corpus, for free, before any live invocation.

---

## 11. Consequences of no stubbing

SERV and SQS are **not** stubbed. A replayed run performs real writes: a replayed `create_workflow`
inserts a real `PGC_Workflow` row; a replayed `create_domain` executes real DDL.

This is deliberate — stubbing SERV would remove the layer where a large share of the defects
actually live. The consequence is that replay needs a cleanup story: `delete_workflow` and
`delete_domain` already exist, so this is expected to be a dev-script concern rather than an
architectural one.

---

## 12. Open decisions

1. **Corpus scope.** Look recordings up within the source run only, or content-addressed across all
   runs? Global lookup yields more hits (an identical prompt is an identical prompt); source-scoped
   lookup is more predictable. Proposed: source run first, then global, configurable.
2. **Memory drift default.** Soft (reuse and log) as specified above, or a policy flag?
3. **Corpus retention.** `PGC_Session` grows with every `llm_call` of every run. Replay makes it an
   asset rather than a log, which changes the retention question.
4. **Cleanup of replayed writes** — dev script, or a run-scoped teardown?
