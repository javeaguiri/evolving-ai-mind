# evolving-mind-ai — Code Review Checklist
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

Version: 1.0  
Last updated: 2026-03-24 (session 9)

---

## How to use this checklist

Run through these checks on every PR or pairing session. A "violation" does
not automatically block merge — it requires a recorded justification and
explicit approval from both reviewer and author. Violations that become
patterns should be raised as tech debt register items.

---

## 1. Tier Boundary Violations

### 1a. Experience layer (src/ui/) must not import from PROC or SERV
- No `import` from `src/proc/` in any file under `src/ui/`
- No `import` from `src/serv/` in any file under `src/ui/`
- Cross-tier calls go through API Gateway HTTP fetch only
- `@aws-sdk/client-sqs` and `@slack/web-api` are the only non-shared imports allowed

### 1b. Process layer (src/proc/) must not import from SERV or EXP
- No `import` from `src/serv/` in any file under `src/proc/`
- No `import` from `src/ui/` in any file under `src/proc/`
- SERV calls go through `serv-client.mjs` (HTTP fetch to API Gateway)
- LLM calls go through `llm-client.mjs`
- SQS enqueues go through `sqs-callback.mjs`

### 1c. Service layer (src/serv/) must not call upward
- No `import` from `src/proc/` or `src/ui/`
- No SQS, no LLM calls, no Slack SDK
- `pg` client is the only external dependency allowed

### 1d. No AWS SDK in PROC endpoint modules
- `@aws-sdk/*` imports are allowed only in `src/shared/sqs-callback.mjs` and `src/ui/`
- `handler.mjs` in PROC may reference the SQS event shape but must not import the SDK
- Endpoint modules (classify-intent.mjs, run-workflow.mjs, etc.) must use `fetch()` for all external calls

---

## 2. Duplication / Single Responsibility

### 2a. No duplicate HTTP fetch wrappers
- All SERV calls go through `getRows()`, `insertRow()`, `updateRows()`, `servPost()` in `src/shared/serv-client.mjs`
- No inline `fetch(SERV_API_URL + '/...')` in endpoint modules
- If a needed SERV operation doesn't have a helper, add it to `serv-client.mjs`

### 2b. No duplicate LLM call logic
- All LLM calls go through `callLlm()` or `callLlmWithCorrection()` in `src/shared/llm-client.mjs`
- No inline `fetch(LLM_URL)` in endpoint modules

### 2c. No re-implementation of shared utilities
- `parseEvent`, `ok`, `err`, `buildReqFromSqs` — always from `src/shared/lambda-utils.mjs`
- `enqueueCallback`, `enqueueWorkflow` — always from `src/shared/sqs-callback.mjs`
- `resolveTemplate` — always from `src/proc/template-resolver.mjs` (PROC-internal)
- If a pattern appears in two PROC endpoint modules, consider extracting to shared

### 2d. No business logic in handler.mjs files
- `handler.mjs` files in each Lambda are dispatch only — parse, route, delegate
- Business logic belongs in endpoint modules or shared utilities
- Exception: trivial inline handlers for `PING_SQS`, `PING_E2E` type messages are acceptable

---

## 3. SQS Usage in Process Layer

### 3a. All SQS enqueues in PROC go through shared/sqs-callback.mjs
- `enqueueCallback(payload, callback)` for results to the Experience tier
- `enqueueWorkflow(message)` for messages to WorkflowQueue
- No direct `SQSClient` or `SendMessageCommand` in PROC endpoint modules

### 3b. `callback` is always read as `req.callback ?? req.body?.callback ?? null`
- Never `req.body.callback` alone — this breaks on SQS delivery
- Check every new PROC endpoint that reads callback

### 3c. SQS message types are documented
- Every new SQS message type (Category 1 or Category 2) is added to the tables
  in architecture.md Section 3.2 before the code is merged
- The distinction between fire-and-forget (no workflowRunId) and workflow execution
  (always has workflowRunId) must be preserved

---

## 4. Import Hygiene

### 4a. All imports at the top of the file
- No dynamic `import()` inside functions unless there is a documented reason
  (e.g. lazy-loading a large module to avoid cold start cost)
- Conditional imports are a violation — use a shared module instead

### 4b. No circular imports
- `shared/` modules must not import from each other in a cycle
- PROC endpoint modules must not import each other (use direct call within same tier instead)

### 4c. Copyright header on every .mjs file (lines 1–3, exact text)
```
// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
```

---

## 5. Brain Architecture Separation

### 5a. Left brain / Right brain boundary
- Left brain (workflow execution): `run-workflow.mjs`, `step-executor.mjs`, `template-resolver.mjs`
  — deterministic execution of stored step definitions, no LLM calls
- Right brain (LLM reasoning): `review-output.mjs`, `llm-client.mjs`, `classify-intent-tiers.mjs` (Tier 2/3)
  — all LLM calls, all output validation, all correction loops
- Left brain must not call the LLM directly — route through a right-brain module
- Right brain output must not be trusted raw — always passes through `review-output.mjs` validation
  before entering workflow state

### 5b. Workflow definitions vs Step Processor
- Workflow business logic lives in `PGC_Workflow.steps` (JSON), not in code
- `step-executor.mjs` handles step types generically — no workflow-specific `if` branches
  (e.g. no `if (workflowName === 'create_domain')` in the executor)
- New workflow behaviours are added by updating the workflow JSON definition,
  not by adding cases to the Step Processor
- Exception: new step types require a new case in `step-executor.mjs` — this is correct

### 5c. LLM output validation
- Every `llm_call` step result must pass through `review-output.mjs` before
  being written to `local_state` or used in any downstream step
- Raw LLM output must never be passed directly to DDL (createTable) or SQS payloads
- The `output_schema` for each prompt lives in `PGC_Prompt.output_schema` —
  validation schemas are not hardcoded in PROC modules

---

## 6. Spec First

### 6a. openapi.yaml updated before implementation
- Any new API endpoint must have a complete path entry in `openapi.yaml` before
  implementation code is written
- Any change to request/response shape of an existing endpoint must update `openapi.yaml` first

### 6b. Architecture doc updated for structural decisions
- New SQS message types → Section 3.2 tables
- New step types → Section 9 step type table + Section 6.2 step type catalogue
- New gate types → Section 6.6 gate type catalogue + Section 9 gate type table
- New PGC tables → Section 4.3 + Section 4.3.6 count table
- New tech debt items → Section 7

---

## Violation approval process

When a reviewer identifies a violation:
1. Raise it explicitly in the review (PR comment or pairing note)
2. Author provides written justification
3. Both parties record approval in the PR or session notes
4. If the violation reveals a missing pattern (e.g. no helper exists for a needed SERV call),
   create a tech debt register entry alongside the approval

---
