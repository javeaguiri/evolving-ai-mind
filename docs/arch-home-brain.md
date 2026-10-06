# evolving-mind-ai — Home Brain
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 0.1
Status: Proposed — not scheduled into any sprint
Last updated: 2026-10-06

Source: `docs/evolving-ai-home-brain-proposal-v1.pptx` (proposal draft v1, not yet presented).

---

## 1. Purpose

The Home Brain is evolving-mind-ai presented as **one assistant for the whole home**: home
control, finances, planning, learning and whatever domains a household creates, behind a single
experience instead of a dozen single-purpose apps.

This document covers two things:

1. **The Home Brain app** (§4) — a dedicated web/app experience layer, a second provider
   alongside Slack. This is the near-term work.
2. **A multi-tenant data model** (§5) — how the service tier could hold many homes. This is a
   direction kept open, not a plan.

---

## 2. Operating model

| Aspect | Position |
|---|---|
| Deployment | **Single user, single household instance.** One SAM stack per household, as today |
| Ownership | A hobby project of Javear's. The code is AGPL-3.0 |
| Product path | **Not firm.** If one exists, it is a separate entity resourced by a partner, licensing the code, with Javear as advisor. Distribution through home building and reform is the scenario in the deck |
| Design stance | Build the app for one household, **with an eye towards** multi-tenancy: keep the habits that leave the door open (§3.3), build none of the tenancy itself |

---

## 3. Starting position

### 3.1 PROC is already UI-agnostic

The experience/procedure partition (`CLAUDE.md`) means a second experience layer consumes what
Slack consumes today:

| Seam | Where | What it gives a new provider |
|---|---|---|
| Gate payload | `buildDialog` (`step-executor.mjs`) | A provider-neutral `dialog` — `typography`, `actions`, form `fields`, list items — never Block Kit |
| Callback routing | `routeCallback` (`callback.mjs`) | `callback: { provider, channel, threadId }` on every run; `provider` is the switch |
| Gate re-render | `buildDialog(step, localState)` | Any suspended gate can be rebuilt from `PGC_WorkflowRun` alone — no stored rendering needed |
| Run state | `PGC_WorkflowRun.status` | `awaiting_human_gate` identifies every gate waiting on a person |

### 3.2 Slack leaks to remove

Small and enumerable. Each becomes a provider-neutral name:

| Leak | Becomes |
|---|---|
| `PGC_Session.slack_thread_ts` | A provider-neutral thread reference plus the provider |
| `slackUser` in `/chat` and `/novia` request bodies | The authenticated user, from the experience layer |
| `SQS_SLACK_RESULTS_URL` in `sqs-callback.mjs` and `proc/handler.mjs` | Results routed by `callback.provider` (§4.6) |
| `explain.mjs` prompt text "rendered in Slack" | "rendered as markdown" |
| `triggered_by: 'slack'` | The provider that triggered the run |

### 3.3 Habits that keep tenancy open

1. **SERV is the only path to data.** Every workflow step reaches storage through `serv-client.mjs`
   with filters, `orderBy`, `vectorSearch` and entity reads; no seeded workflow carries SQL.
2. **Novia's `run_sql` is the one exception** — read-only, through SERV `runSql`. It stays an
   exception.
3. **The browser never holds the internal API key.** The app has a real user identity even with
   one user, and identity comes from the authenticated token, never the request body.

---

## 4. The Home Brain app

### 4.1 Principles

- **A hybrid: the app owns navigation, the backend owns workflow content.** The app is a
  single-page application built on a JavaScript framework, with two modes of working:

  | Mode | What it covers | Who decides the content |
  |---|---|---|
  | **Navigate** | Lists the app fetches and keeps current — Novia sessions, workflows, runs, pending gates, domains — and drill-down into a domain's records, with direct edits where the registry allows them (§4.8) | The app, from JSON returned by REST services |
  | **Execute** | Running a workflow or a Novia conversation | The backend, exactly as for Slack: it pushes markdown text, forms and human gates, and the app displays them |

- **Workflow execution is unchanged.** Workflows, gates and Novia behave as they do for Slack. The
  backend sends the app what it sends Slack's renderer — markdown and the provider-neutral
  `dialog` — never Block Kit and never HTML. The app's job in this mode is the one `callback.mjs`
  does for Slack: turn markdown and `dialog` into the screen.
- **The partition rule holds as written.** `/proc` formats workflow content — `formatted_markdown`,
  report text, gate messages — so neither experience layer interprets raw workflow data. The only
  raw data the app lays out itself is in Navigate mode: lists and records, presented from the
  registry's own metadata.
- **The app holds no domain vocabulary.** It never knows what "inventory", "A/C" or "budget" means.
  Navigation comes from the domain registry, record layout from `PGC_Schema`, workflow content
  from the backend.
- **A second provider, not a replacement.** Slack keeps working. A run started in either can be
  seen in the app.
- **One page, many panels.** A console: navigation on the left, a panel grid in the centre, Novia
  on the right. On a phone the three become tabs.

### 4.2 Layout

Desktop:

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ◉ Home brain    Home › Inventory › Review          [ Ask the home brain… ]  🔔 3 │
├──────────────┬──────────────────────────────────────────────┬──────────────────┤
│ HOME         │ Needs you (3)                                │ Novia            │
│  ▸ Dashboard │ ┌──────────────────────────────────────────┐ │ ──────────────── │
│              │ │ Confirm merge of 2 items        2 min ago │ │ You: why is the  │
│ DOMAINS      │ │ [ Approve ]  [ Cancel ]                   │ │ shopping list    │
│  ▸ Inventory │ └──────────────────────────────────────────┘ │ naming the wrong │
│  ▸ Recipes   │                                              │ bread?           │
│  ▸ Budget    │ Home status                                  │                  │
│  ▸ Expenses  │ ┌──────────┐ ┌──────────┐ ┌──────────┐       │ Novia: alias 81  │
│  ▸ Flashcards│ │ tile     │ │ tile     │ │ tile     │       │ points at item   │
│              │ │ value    │ │ value    │ │ value    │       │ 17 …             │
│ ACTIVITY     │ └──────────┘ └──────────┘ └──────────┘       │                  │
│  ▸ Runs      │                                              │ [ proposed fix ] │
│  ▸ Schedules │ Recent activity                              │                  │
│              │  run · completed · 09:12                     │ ──────────────── │
│ SETTINGS     │  run · awaiting you · 08:40                  │ [ message…     ] │
└──────────────┴──────────────────────────────────────────────┴──────────────────┘
```

Phone — the same three regions as tabs, the command bar pinned to the top:

```
┌────────────────────────┐
│ [ Ask the home brain…] │
├────────────────────────┤
│ Needs you (3)          │
│ ┌────────────────────┐ │
│ │ Confirm merge …    │ │
│ │ [Approve] [Cancel] │ │
│ └────────────────────┘ │
│ Home status            │
│ ┌────────┐┌────────┐   │
│ │ tile   ││ tile   │   │
│ └────────┘└────────┘   │
├────────────────────────┤
│  Home   Domains  Novia │
└────────────────────────┘
```

Domain names and tiles above are illustrative. Both are data.

### 4.3 Regions and panels

Resources are in §4.7. **Mode** is from §4.1: *Navigate* is laid out by the app from REST JSON,
*Execute* is workflow content pushed by the backend.

| Region / panel | Mode | What it shows | Fed by |
|---|---|---|---|
| **Command bar** | Execute | One input, the equivalent of `/mind`; replies arrive as pushed content | `POST /commands` |
| **Breadcrumbs** | Navigate | Where the user is: Home › domain › record, or Home › run › gate | The client's own router |
| **Navigator** (left) | Navigate | Home, each domain, Activity, Settings | `GET /domains` — the domain registry (`PGC_DomainHelp`) and each domain's live workflows from `PGC_Workflow`, the same read `/help` and `search_domain_help` make |
| **Needs you** | Navigate → Execute | The list of gates waiting on a person, newest first; opening one shows the gate as pushed content, answerable in place | `GET /gates` — runs at `awaiting_human_gate`, each rebuilt with `buildDialog`. **Includes scheduled runs**, whose `callback` is null — today such a gate suspends with nobody to answer it |
| **Home status** | Execute | Device and system state; pinned output of a status workflow (§4.9) | The latest inbox message of the named status workflow |
| **Recent activity** | Navigate | Runs by status and time; drill into a run's steps | `GET /runs`, `GET /runs/{runId}` |
| **Domain page** | Navigate | Drill-down into a domain: its records as a sortable, filterable table, a record and its child records, and the domain's workflows as actions. Fields the edit policy allows are editable in place; add and delete appear where the table allows them (§4.8) | `GET /domains/{domain}/schema`, `GET /domains/{domain}/records`, `GET /domains/{domain}/records/{id}` |
| **Workflow output** | Execute | A started workflow's markdown, forms and gates, in a panel beside the page that started it | Pushed inbox messages for the run |
| **Novia** (right) | Navigate → Execute | The session list, kept current; opening one shows the conversation, with her gated actions (`propose_workflow_fix`, `register_workflow`) as gates | `GET /novia/sessions`; history from `PGC_SessionEntry`; new turns pushed |
| **Ask Novia about this** | Execute | From any panel, opens Novia with the current view as context — the run id, the domain, the record, the gate | The panel's own identifiers, passed into the opening message |

### 4.4 Gate rendering

Each `gate_type` gets one client component. The `dialog` the backend pushes is the one Slack's
renderer receives, with its content already decided and formatted by `/proc`; the app only
displays it. Markdown in a `dialog` or a notification is shown by a markdown component.

| `gate_type` | Web rendering |
|---|---|
| `list_selection` | A sortable table; row click or row action replaces typing an id |
| `form` | Typed inputs; with a grid hint (below), an **editable grid** with a single Save |
| `text_input` | Inline text area |
| `confirm` | Message and buttons |
| `review_object` | Read-only object or table view with actions |
| `choice` | Button group |
| `followup_prompt` | Inline prompt in the conversation |

**The form grid.** A bulk edit (Sprint 13's pattern) is a `form` gate whose `fields` hold one field
per editable cell. The web renders it as a grid when the fields carry a **generic layout hint**: a
row key and a column label per field. The hint is rendering vocabulary, not domain vocabulary, and
belongs on the `human_gate` `PGC_StepType` contract so Novia emits it. Slack ignores the hint and
stacks the fields as it does today. The row-id encoding in the field `name` stays workflow-local,
as Sprint 13 requires.

**Ceilings are per provider.** A message caps a Slack form at 50 blocks; the web has no comparable
ceiling. The pager pattern stays for sets too large for any screen.

### 4.5 Components

```
 Browser — single-page app (JS framework)
   │  Navigate: REST over HTTPS, JSON            ▲ Execute: pushed markdown,
   │  Execute: start, answer, send               │ forms and gates
   ▼                                             │
 ┌──────────────────────────────────┐
 │ WebApiFunction  EXP              │  /api/v1/ui/web/*  +  WebSocket
 └───────┬──────────────────┬───────┘
         │ SQS              │ HTTP + internal key
         │ (writes: the     │ (reads)
         │  same messages   │
         │  Slack sends)    │
         ▼                  ▼
 ┌─────────────────────────────────────────────────────────┐
 │ ProcFunction  PROC — unchanged business logic           │
 │ results for provider 'web' → inbox row → pushed         │
 └───────────────────────────┬─────────────────────────────┘
                             ▼
                 ServFunction  SERV  →  PostgreSQL
```

| Component | Role |
|---|---|
| **Single-page app** | A JavaScript framework app — React is the recommendation — bundled with esbuild, the bundler the Lambdas already use. Static files on S3 behind CloudFront. Client-side routing gives the breadcrumbs and deep links |
| **Identity** | A Cognito user pool, one user per household member. API Gateway validates the bearer token; the browser never holds the internal API key |
| **`WebApiFunction`** (EXP) | The app's REST service layer. Navigate reads call PROC with the internal key, as `SlackbotFunction` does; Execute actions enqueue the same SQS messages Slack enqueues |
| **PROC read endpoints** | The reads the REST resources need — domains, schema, records, gates, runs, sessions. PROC calls SERV; the experience tier never calls SERV directly |
| **Results for the web** | `enqueueCallback` routes by `callback.provider`: Slack's results go to the Slack results queue for Block Kit rendering; the web's are written to the inbox (§4.6) and pushed |
| **Push** | An API Gateway WebSocket carries each new inbox message — markdown, form or gate — to the open app, and list changes (a new session, a run finishing) so Navigate lists stay current. `GET /inbox` since a cursor catches up after a disconnect and is Phase 0's only mechanism |

All final decisions hold: ESM, esbuild, shared `LambdaExecutionRole`, Lambdas outside the VPC, SSM
`String` parameters.

### 4.6 Message flows

**Inbound.** The app sends the messages Slack already sends, with `callback.provider = 'web'` and
`threadId` set to the app's own thread reference:

| User action | Message |
|---|---|
| Command bar | `CLASSIFY_INTENT` |
| Novia message | `MINDS_EYE` / `MINDS_EYE_RESUME` |
| Gate response | `WORKFLOW_STEP resume_gate`, with the run's `stepExecutionId` so a second answer from another provider is a no-op |
| Start a domain workflow | `POST /proc/run-workflow` |

**Outbound.** PROC records every message it sends a person — gate, notification, error — in a
provider-neutral **inbox** (`PGC_UiMessage`: provider, thread reference, message type, JSON
payload, created/read times). For Slack it then enqueues the message as today; for the web the
inbox row is the delivery. The app reads the inbox for history, for new messages and on reconnect.
Slack keeps its own channel history and ignores the inbox.

**Reconnect.** Pending gates come from runs at `awaiting_human_gate`, rebuilt with `buildDialog`,
never from stored renderings — the gate the user sees is always the gate the run is waiting on.

### 4.7 API surface

REST resources, JSON in and out, spec-first in `openapi.yaml` before implementation. All under
`/api/v1/ui/web/`, bearer-token authorized.

**Navigate** — the app lays out what these return:

| Method and resource | Purpose | Behind it |
|---|---|---|
| `GET /domains` | Domains and their workflows | Domain registry, `PGC_Workflow` |
| `GET /domains/{domain}/schema` | Columns, types, labels, enums — what the app needs to lay out records | `PGC_Schema` |
| `GET /domains/{domain}/records` | Records with filter, sort and page parameters in the SERV filter vocabulary | SERV `getRows` |
| `GET /domains/{domain}/records/{id}` | One record with its child records | SERV entity reads via `PGC_EntitySchema` |
| `GET /gates` | Gates waiting on a person | Runs at `awaiting_human_gate` |
| `GET /runs`, `GET /runs/{runId}` | Activity and a run's steps | `PGC_WorkflowRun`, `PGC_WorkflowRunStep` |
| `GET /novia/sessions`, `GET /novia/sessions/{id}/messages` | Sessions, and a conversation's history | `PGC_Session`, `PGC_SessionEntry` |
| `GET /inbox` | Pushed messages since a cursor, for catch-up | `PGC_UiMessage` |

**Execute** — each returns `202 Accepted` with the run or session it touched; what follows is
pushed:

| Method and resource | Purpose | Behind it |
|---|---|---|
| `POST /commands` | Free-text intent | `CLASSIFY_INTENT` |
| `POST /runs` | Start a named workflow with input | Run entry, as `POST /proc/run-workflow` |
| `POST /gates/{runId}/responses` | Answer a gate | `resume_gate` |
| `POST /novia/sessions`, `POST /novia/sessions/{id}/messages` | Open a session; send a message | `MINDS_EYE` / `MINDS_EYE_RESUME` |

**Edit** — direct record edits under the edit policy (§4.8); synchronous, returning the record as
written:

| Method and resource | Purpose | Behind it |
|---|---|---|
| `PATCH /domains/{domain}/records/{id}` | Change editable fields; `If-Match` carries the version read | Policy check, then SERV `updateRows` |
| `POST /domains/{domain}/records` | Add a record, where the table allows it | Policy check, then SERV `insertRow` |
| `DELETE /domains/{domain}/records/{id}` | Delete a record, where the table allows it; `If-Match` as for `PATCH` | Policy check, then SERV `deleteRows` |

### 4.8 Direct edits and the edit policy

A record changes by one of two paths:

| Path | Who uses it | Governed by |
|---|---|---|
| **Workflow** | Every workflow step that writes, whether started from Slack, the app, a schedule or Novia | The workflow's own design — its gates, validation and run record |
| **Direct** | The app's Edit resources (§4.7), from a domain page | The **edit policy** in the registry |

**The edit policy governs the direct path only.** Workflows are never restricted by it. A field
that is read-only to direct edits is one that only workflows change — a flashcard's review
schedule, written by the quiz — not one that nothing changes. A field can be open to both paths:
inventory quantity is edited directly from the app and also decremented by a meal-planning
workflow.

**Shape.** The policy is declared in `PGC_Schema`, which makes it an evolving artifact:

| Level | Declares | Where |
|---|---|---|
| **Field** | `editable` or `read_only` for direct edits | Each column definition in `PGC_Schema.columns` |
| **Table** | Whether direct add and direct delete are allowed | The table's `PGC_Schema` row |

Illustrations: flashcard front and back are editable while session results are read-only; a
portfolio's holdings are editable, with add and delete allowed; a session table allows neither.

**Default: `read_only`.** A field is editable only when declared so. Columns the system maintains —
the primary key, timestamps, embedding columns, foreign keys a workflow resolves — are never
editable directly. `design_table` proposes a policy when a domain is created; the user or Novia
changes it afterwards like any other registry fact. Application-wide domains carry the policy in
their seeded definition; tenant-specific domains carry their own.

**Enforcement is server-side.** `GET /domains/{domain}/schema` returns the policy so the app offers
edit controls only where it allows them, but the app is never the guard. The PROC endpoint behind
the Edit resources checks every field in the request against the policy and refuses the request
whole if any field is not editable. That endpoint is the only route for a direct edit — the
experience tier never calls SERV — so the check has one home, and workflows, which call SERV
directly, never meet it.

**What a direct edit inherits from SERV.** The database constraints, and embedding upkeep:
`updateRows` re-computes an embedding when one of its `embed_source` columns changes, so editing a
field that feeds an embedding keeps similarity search correct.

**Concurrent changes.** Every record read carries a version — an `ETag` from the row's
`updated_at`, which a per-table trigger maintains on domain tables. A table without `updated_at`
accepts no direct edits. A direct edit sends it back in `If-Match`; if a workflow or another edit changed the record
since, the edit is refused with `409 Conflict` and the app re-reads. A direct edit therefore never
silently overwrites a workflow's write, or the reverse.

**Audit.** Each direct edit writes one row — who, when, domain, record, and each field's old and new
value — to `PGC_RecordEdit`. A workflow's changes are already traceable through its run record;
this gives the direct path the same, so "why does this record read 4?" is answerable by the user or
by Novia.

**Changing a read-only field.** A domain page lists the domain's workflows as actions; that list is
how a user reaches the workflow that changes a field they cannot edit directly.

**Who may edit.** The policy applies to every household member alike until Phase 3, where the field
and table declarations gain an optional list of roles.

### 4.9 Home status and the device bridge

No step type reaches an external API today. Device state and control need **one new step type**
that calls an external HTTP API — a new system behaviour, so a new case in `step-executor.mjs` and
a `PGC_StepType` contract, never a hard-coded integration. The first target is a home-automation
hub such as Home Assistant, which already bridges climate, lighting, solar inverters and Matter
devices; the step type stays generic so any API qualifies.

- **Reading:** a status workflow calls the hub and formats its response, and the Home status
  panel pins that workflow's latest output. What each reading means is decided in the workflow.
- **Control:** a tile action starts a workflow; consequential actions pass a `confirm` gate.
- **Credentials:** hub tokens live in SSM like every other secret.

### 4.10 Phasing

| Phase | Delivers | Proves |
|---|---|---|
| **0 — Spike** | The framework app shell; `GET /gates`, `POST /gates/{runId}/responses` and `GET /inbox`; `provider: 'web'` end to end for one workflow; a `form` gate shown as an editable grid | The seam in §3.1 holds for a second provider; the grid answers the bulk-edit ceiling |
| **1 — Console** | Identity, the §4.7 resources, the edit policy and `PGC_RecordEdit` (§4.8), the WebSocket push, command bar, Needs you, navigator, domain drill-down, Novia panel; the Slack leaks in §3.2 removed | Daily use without Slack |
| **2 — Home status** | The external-API step type, a status workflow, tiles with actions | Device control from the brain |
| **3 — Household** | Several household members; per-member Novia threads; per-role edit policy (§4.8) | A family uses one brain |
| **Later** | Document, image and voice input; spoken output; always-on voice through an assistant device | The deck's "future work: the product experience" |

---

## 5. Multi-tenant data model (direction, not plan)

### 5.1 Flexible records

Domain data is stored as **records with JSON fields** instead of a physical table per domain. The
change lives **entirely in the service tier**: PROC, workflows, gates and Novia's designs keep
calling the same SERV contract and cannot tell a JSON-backed domain from a table-backed one.

Domains are registered with a **scope**:

| Scope | Examples | Owner |
|---|---|---|
| **Application-wide** | Pre-seeded domains — recipes, inventory, budget and expenses | Seeded with the system; every home gets the definition, each home its own records |
| **Tenant-specific** | One-off domains a household creates | That household alone |

### 5.2 What SERV takes on

| Concern | Today | With flexible records |
|---|---|---|
| **Integrity** | PostgreSQL enforces NOT NULL, CHECK enums, types, defaults, foreign keys and uniqueness; the registry mirrors the database | **SERV enforces** every constraint from `PGC_Schema` on write. Uniqueness is the hard case: code-level checks race, so each unique constraint becomes a unique expression index on the records table |
| **Typed comparison** | Column types | Filters and `orderBy` cast JSON values by the registered type |
| **Embeddings** | `vector` columns; similarity search is a sequential scan | Embeddings stored in the record's JSON and cast to `vector` at query time — the cast and `cosine_distance` are `IMMUTABLE`, so a partial HNSW expression index per domain and field is available when scale warrants it. `embed_source` inference is unchanged |
| **Entity joins** | Physical foreign keys via `PGC_EntitySchema` | Joins on JSON fields, with relationships enforced by SERV |
| **Novia's `run_sql`** | SQL against physical `PGD_` tables | SERV generates a typed view per domain over the records, so her SQL and debugging keep a relational face |

### 5.3 The `PGC_` half

Flexible records cover `PGD_` data. Many `PGC_` rows are also per home: workflows and intent
patterns Novia builds, memory, sessions and runs. The same **scope** applies to them — seeded rows
are application-wide, evolved rows belong to a tenant.

---

## 6. Open questions

1. **Scope of flexible records** — do application-wide domains also live as flexible records, or
   remain physical tables with only tenant one-offs in JSON?
2. **Cross-provider gates** — when a Slack-started run is answered in the app, how does the Slack
   message show it was answered elsewhere?
3. **Gate-size validation** — the L1 field-count check enforces Slack's ceiling. Does it stay at
   the lowest common provider ceiling while Slack remains a provider?
4. **Grid hint shape** — the exact field properties for row key and column label on the
   `human_gate` contract.
5. **Inbox retention** — how long `PGC_UiMessage` keeps delivered messages.
6. **Display metadata in the registry** — domain drill-down lays out raw records from
   `PGC_Schema`. Which display facts (label, format, currency, reveal threshold) the registry must
   carry for that, beyond types and enums.
7. **Framework** — React is the recommendation; the choice is open until Phase 0.
8. **Proposal deck v1 corrections before it is presented** — slide 21 says external API connections
   are already built (they are not, §4.9); slides 2 and 18 quote the README's monthly cost rather
   than the measured steady state in `architecture.md` §16; slide 14 states schema-per-home
   isolation in the present tense; slide 17 places all `PGC_` tables in the shared layer (§5.3).
