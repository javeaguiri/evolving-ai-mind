# Session Chat & LLM Diagnostics — Requirements and Design
## evolving-mind-ai v3.2 — Phase 3 Feature Spec

---

## 1. Overview

This document specifies the requirements and design for three session context types that allow users to interact conversationally with LLMs in evolving-mind-ai, and to inspect the reasoning behind LLM decisions made during workflow execution.

### 1.1 Session Context Types

| Type | Trigger | Status |
|---|---|---|
| `general_chat` | `/chat <prompt>` | In scope |
| `llm_call_diagnostic` | `/explain <query_id> <prompt>` | In scope |
| `run_diagnostic` | `/explain-run <run_id> <prompt>` | **Deferred** |

### 1.2 Core Mechanism

All session types share the same underlying mechanism described in this thread:
- Every LLM API call is stateless; context is maintained by persisting and replaying the full **messages array**
- The messages array is stored as ordered rows in `PGC_SessionEntry` (one row per turn) and reconstructed on each follow-up call by selecting entries ordered by `sequence_number`
- `reasoning` (Option A) is injected into the LLM output schema for diagnostic sessions and stored on the `assistant` row in `PGC_SessionEntry`

---

## 2. Table Design

### 2.1 PGC_Session

Marks the start of a chat session. One row per session regardless of type.

```sql
CREATE TABLE "PGC_Session" (
  id              SERIAL PRIMARY KEY,
  session_type    VARCHAR(30)   NOT NULL,          -- 'general_chat' | 'llm_call_diagnostic'
  query_id        UUID          NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  slack_thread_ts VARCHAR(50)   NULL,              -- general_chat lookup key (Slack thread_ts)
  workflow_name   VARCHAR(100)  NULL,              -- llm_call_diagnostic: PGC_Workflow.name
  run_id          UUID          NULL,              -- llm_call_diagnostic
  trace_id        VARCHAR(100)  NULL,              -- llm_call_diagnostic; matches Slack trace
  step_id         VARCHAR(50)   NULL,              -- llm_call_diagnostic: workflow step ID
  intent_category VARCHAR(100)  NULL,              -- llm_call_diagnostic
  created_at      TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE INDEX ON "PGC_Session" (slack_thread_ts);
CREATE INDEX ON "PGC_Session" (query_id);
CREATE INDEX ON "PGC_Session" (run_id);
```

**Field notes:**
- `query_id` is the user-facing reference. It appears in the Slack diagnostic notification and is the argument to `/explain`
- `slack_thread_ts` is only populated for `general_chat` sessions; it is the Slack-assigned thread timestamp and serves as the follow-up lookup key
- `trace_id` corresponds to the trace ID already shown in certain Slack message replies, creating a consistent reference across the UI
- `workflow_name` stores `PGC_Workflow.name` (not ID) to remain human-readable without a join
- All `llm_call_diagnostic` fields are NULL for `general_chat` sessions and vice versa

### 2.2 PGC_SessionEntry

One row per turn in the conversation. Reconstructs the messages array by ordering on `sequence_number`.

```sql
CREATE TABLE "PGC_SessionEntry" (
  id              SERIAL PRIMARY KEY,
  session_id      INTEGER       NOT NULL REFERENCES "PGC_Session"(id),
  sequence_number INTEGER       NOT NULL,          -- 1-based; preserves messages array order
  role            VARCHAR(15)   NOT NULL,          -- 'system' | 'user' | 'assistant'
  content         TEXT          NOT NULL,          -- raw message content sent/received
  reasoning       TEXT          NULL,              -- Option A; populated on 'assistant' rows only
  created_at      TIMESTAMP     NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, sequence_number)
);

CREATE INDEX ON "PGC_SessionEntry" (session_id);
```

**Field notes:**
- `role` mirrors the LLM API convention exactly: `system`, `user`, `assistant`
- `content` for `assistant` rows is the raw LLM response (workflow JSON, chat reply, etc.)
- `reasoning` is NULL unless diagnostics are enabled for the workflow that produced this entry; it is never included in the reconstructed messages array sent back to the LLM
- For `general_chat`, the system prompt is stored as `sequence_number = 1`, `role = 'system'`
- For `llm_call_diagnostic`, the filled-in prompt is stored as `sequence_number = 1`, `role = 'user'`; the assistant response as `sequence_number = 2`, `role = 'assistant'`
- Follow-up turns from `/explain` or `/chat` thread replies append incrementing sequence numbers

### 2.3 Messages Array Reconstruction

```sql
SELECT role, content
FROM "PGC_SessionEntry"
WHERE session_id = $1
ORDER BY sequence_number ASC;
```

The result maps directly to the LLM API `messages` array:
```json
[
  { "role": "system",    "content": "..." },
  { "role": "user",      "content": "..." },
  { "role": "assistant", "content": "..." },
  { "role": "user",      "content": "follow-up question" }
]
```

`reasoning` is excluded from this reconstruction — it is diagnostic metadata, not conversation context.

---

## 3. Diagnostic Configuration

### 3.1 PGC_SystemContext Entry

Diagnostics are configured via a well-known `PGC_SystemContext` entry. The system reads this at runtime; no code changes are required to enable or disable diagnostics for a workflow.

**Key:** `diagnostics_config`

**Value (jsonb):**
```json
{
  "enabled_workflows": [
    "create_workflow",
    "create_domain"
  ]
}
```

- `enabled_workflows` is a list of `PGC_Workflow.name` values
- Empty array `[]` disables diagnostics globally without removing the entry
- When a workflow name is not in this list, no `PGC_Session` rows are written by `llm_call` steps and no Slack notification is sent

### 3.2 Runtime Lookup

`step-executor.mjs` reads `diagnostics_config` once per workflow execution (cached on the run context object) and passes a `diagnosticsEnabled: boolean` flag into each `llm_call` step handler. No per-step configuration is required.

---

## 4. LLM Output Schema — Reasoning Field

When diagnostics are enabled, the `reasoning` field is injected into the Ajv output schema for the `llm_call` step and into the prompt instruction:

### 4.1 Schema Addition (merged into existing step output schema)

```json
{
  "properties": {
    "reasoning": {
      "type": "string",
      "description": "A concise explanation of the key decisions made in producing this response. Include why specific structures, fields, or approaches were chosen over alternatives."
    }
  },
  "required": ["reasoning"]
}
```

### 4.2 Prompt Instruction (appended when diagnostics enabled)

```
Include a "reasoning" field in your JSON response that concisely explains the key decisions made in producing this output — why specific structures, field names, or approaches were chosen over alternatives.
```

This instruction is appended to the filled-in prompt before it is sent to the LLM, so the stored `content` in PGC_SessionEntry always reflects what was actually sent.

---

## 5. llm_call Step Modifications

When `diagnosticsEnabled` is true for the current workflow, the `llm_call` step handler performs three additional actions after the LLM responds:

### 5.1 Session Write Sequence

```
1. Generate query_id (UUID)
2. INSERT PGC_Session row (session_type = 'llm_call_diagnostic', query_id, run_id, trace_id, step_id, workflow_name, intent_category)
3. INSERT PGC_SessionEntry row (sequence_number = 1, role = 'user', content = filled-in prompt)
4. INSERT PGC_SessionEntry row (sequence_number = 2, role = 'assistant', content = raw LLM response, reasoning = response.reasoning)
5. POST Slack diagnostic notification (see Section 5.2)
```

All three database writes are non-blocking relative to the SQS execution loop — the step result is already in hand before writes begin. A write failure should log but not fail the step.

### 5.2 Slack Diagnostic Notification

Posted to the workflow's Slack channel (not as a thread reply) when diagnostics are enabled. Block Kit structure:

```json
{
  "text": "🔍 LLM Diagnostic | query_id available for /explain",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*🔍 LLM Call Diagnostic*"
      }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Query ID:*\n`<query_id>`" },
        { "type": "mrkdwn", "text": "*Step ID:*\n`<step_id>`" },
        { "type": "mrkdwn", "text": "*Run ID:*\n`<run_id>`" },
        { "type": "mrkdwn", "text": "*Trace ID:*\n`<trace_id>`" },
        { "type": "mrkdwn", "text": "*Workflow:*\n`<workflow_name>`" },
        { "type": "mrkdwn", "text": "*Intent:*\n`<intent_category>`" }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "To explain this result: `/explain <query_id> <your question>`"
      }
    }
  ]
}
```

---

## 6. New Slack Commands

### 6.1 `/chat <prompt>`

**Purpose:** Start a general-purpose LLM conversation not tied to any workflow.

**Flow:**
```
1. Parse prompt string from command text
2. INSERT PGC_Session (session_type = 'general_chat')
3. INSERT PGC_SessionEntry (seq=1, role='system', content=<general_chat_system_prompt>)
4. INSERT PGC_SessionEntry (seq=2, role='user', content=<prompt>)
5. Call LLM with messages array [system, user]
6. INSERT PGC_SessionEntry (seq=3, role='assistant', content=<response>)
7. Post Slack response in new thread; store thread_ts on PGC_Session row
8. Response includes instructions for continuing in thread
```

**Thread Continuation:**

When the user replies in the same Slack thread, the callback handler:
1. Looks up PGC_Session by `slack_thread_ts`
2. Reconstructs messages array from PGC_SessionEntry rows
3. Appends new user message
4. Calls LLM
5. Appends assistant response
6. Replies in same Slack thread

**System prompt** for general_chat is stored in `PGC_SystemContext` under key `general_chat_system_prompt`. Default value:
```
You are a helpful assistant integrated into evolving-mind-ai, a personal cognitive automation system. Answer clearly and concisely.
```

### 6.2 `/explain <query_id> <prompt>`

**Purpose:** Start a diagnostic conversation anchored to a specific `llm_call` step output.

**Flow:**
```
1. Parse query_id (UUID) and prompt string from command text
2. Look up PGC_Session by query_id; 404 → Slack error reply
3. Reconstruct messages array from existing PGC_SessionEntry rows (seq 1 = user prompt, seq 2 = assistant response)
4. Append new user message (seq 3)
5. Call LLM with full messages array
6. INSERT PGC_SessionEntry (seq=3, role='user', content=<prompt>)
7. INSERT PGC_SessionEntry (seq=4, role='assistant', content=<response>)
8. Post Slack response in new thread; store thread_ts on PGC_Session if not already set
9. Subsequent thread replies continue the session using thread_ts lookup (same as general_chat)
```

**Notes:**
- The existing two SessionEntry rows from the `llm_call` step (the filled-in prompt and the LLM response with reasoning) provide the initial context. The user's `/explain` question becomes `seq 3`.
- `reasoning` from `seq 2` is not injected into the messages array but may be surfaced in the initial Slack reply as a collapsed section: *"Here is the reasoning the LLM provided for this output: ..."*

### 6.3 `/explain-run <run_id> <prompt>` — DEFERRED

Schema slot reserved. Will aggregate step outputs across an entire run and seed the session with that context. Table design above supports this via `run_id` on `PGC_Session`.

---

## 7. Intent Preprocessor Changes

Two new intent categories are required:

| Intent Category | Trigger Pattern | Handler |
|---|---|---|
| `general_chat` | `/chat` command | New `chat` processor |
| `explain_query` | `/explain` command | New `explain` processor |
| `explain_run` | `/explain-run` command | Deferred |

Thread reply routing (for session continuation) is handled by the callback endpoint, not the intent preprocessor. The callback handler checks for `slack_thread_ts` match in `PGC_Session` before falling through to normal intent processing.

---

## 8. API Endpoints

Following the 3-tier framework, one new processor endpoint is required:

| Method | Path | Tier | Description |
|---|---|---|---|
| POST | `/chat` | proc | Handle `/chat` command and thread continuations |
| POST | `/explain` | proc | Handle `/explain` command and thread continuations |

Both endpoints follow the same pattern: load or create session → reconstruct messages array → call LLM → write entries → post to Slack.

No new `exp` endpoints are required — Slack commands route through the existing `/slack/command` exp endpoint and are dispatched by the intent preprocessor.

---

## 9. PGC_Schema Updates

Both new tables must be registered in `PGC_Schema` following the existing pattern. This keeps the schema service aware of all system tables.

```json
[
  {
    "table_name": "PGC_Session",
    "column_name": "id",            "data_type": "integer",   "is_system": true
  },
  {
    "table_name": "PGC_Session",
    "column_name": "session_type",  "data_type": "varchar",   "is_system": true
  },
  {
    "table_name": "PGC_Session",
    "column_name": "query_id",      "data_type": "uuid",      "is_system": true
  },
  {
    "table_name": "PGC_Session",
    "column_name": "slack_thread_ts","data_type": "varchar",  "is_system": true
  },
  {
    "table_name": "PGC_Session",
    "column_name": "workflow_name", "data_type": "varchar",   "is_system": true
  },
  {
    "table_name": "PGC_Session",
    "column_name": "run_id",        "data_type": "uuid",      "is_system": true
  },
  {
    "table_name": "PGC_Session",
    "column_name": "trace_id",      "data_type": "varchar",   "is_system": true
  },
  {
    "table_name": "PGC_Session",
    "column_name": "step_id",       "data_type": "varchar",   "is_system": true
  },
  {
    "table_name": "PGC_Session",
    "column_name": "intent_category","data_type": "varchar",  "is_system": true
  },
  {
    "table_name": "PGC_Session",
    "column_name": "created_at",    "data_type": "timestamp", "is_system": true
  },
  {
    "table_name": "PGC_SessionEntry",
    "column_name": "id",            "data_type": "integer",   "is_system": true
  },
  {
    "table_name": "PGC_SessionEntry",
    "column_name": "session_id",    "data_type": "integer",   "is_system": true
  },
  {
    "table_name": "PGC_SessionEntry",
    "column_name": "sequence_number","data_type": "integer",  "is_system": true
  },
  {
    "table_name": "PGC_SessionEntry",
    "column_name": "role",          "data_type": "varchar",   "is_system": true
  },
  {
    "table_name": "PGC_SessionEntry",
    "column_name": "content",       "data_type": "text",      "is_system": true
  },
  {
    "table_name": "PGC_SessionEntry",
    "column_name": "reasoning",     "data_type": "text",      "is_system": true
  },
  {
    "table_name": "PGC_SessionEntry",
    "column_name": "created_at",    "data_type": "timestamp", "is_system": true
  }
]
```

---

## 10. Deferred: Chat History in llm_call Steps

As noted in the requirements, a future enhancement would allow `llm_call` steps within a workflow to pass a `chatHistory` parameter (a prior messages array collected from earlier steps in the same run). This would enable multi-step workflows where later LLM calls are aware of earlier ones without re-sending full context. This is architecturally compatible with the design above — `PGC_SessionEntry` rows from earlier steps could be reconstructed and injected as prior turns. Deferred to a later session.

---

## 11. Implementation Sequence

Recommended build order:

1. **DB migration** — create `PGC_Session` and `PGC_SessionEntry` tables; register in `PGC_Schema`
2. **PGC_SystemContext seed** — add `diagnostics_config` and `general_chat_system_prompt` entries
3. **llm_call step** — add diagnostics flag check, session writes, Slack notification
4. **`/chat` command** — new proc handler; thread continuation via callback
5. **`/explain` command** — new proc handler; surfaces reasoning in initial reply; thread continuation
6. **openapi.yaml** — add `/chat` and `/explain` proc endpoints before implementation
