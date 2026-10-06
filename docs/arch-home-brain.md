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

- **A second provider, not a replacement.** Slack keeps working. A run started in either can be
  seen in the app.
- **The app holds no domain vocabulary.** It never knows what "inventory", "A/C" or "budget" means.
  Navigation comes from the domain registry, panels from procedure-layer descriptors, gates from
  `dialog`. A rendering decision that needs to know what a field means belongs in a workflow step.
- **Workflows stay the business logic.** A domain page runs the domain's workflows and renders
  their gates inline; the app adds rendering, never behaviour.
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

| Region / panel | What it shows | Fed by |
|---|---|---|
| **Command bar** | One input, the equivalent of `/mind` | `CLASSIFY_INTENT`, with `callback.provider = 'web'` |
| **Breadcrumbs** | Where the user is: Home › domain › workflow › gate | The app's own route |
| **Navigator** (left) | Home, each domain, Activity, Settings | Domain registry (`PGC_DomainHelp`) and each domain's live workflows from `PGC_Workflow` — the same read `/help` and `search_domain_help` make |
| **Needs you** | Every gate waiting on a person, newest first, answerable in place | Runs at `awaiting_human_gate`, each rebuilt with `buildDialog`. **Includes scheduled runs**, whose `callback` is null — today such a gate suspends with nobody to answer it |
| **Home status** | Device and system state as tiles; a tile may carry actions | A status workflow's output: tile descriptors `{ label, value, unit?, state?, actions? }` built by `js_transform` (§4.8) |
| **Recent activity** | Runs by status and time; opening one shows its steps | `PGC_WorkflowRun`, `PGC_WorkflowRunStep` |
| **Domain page** | The domain's root records as a table, its workflows as actions; a running workflow's gates render inside the page | `list_entity` and the domain's workflows |
| **Novia** (right) | A Novia conversation; her gated actions (`propose_workflow_fix`, `register_workflow`) render as gates in the thread | `MINDS_EYE` / `MINDS_EYE_RESUME`; history from `PGC_SessionEntry` |
| **Ask Novia about this** | From any panel, opens Novia with the current view as context — the run id, the domain, the gate | The panel's own identifiers, passed into the opening prompt |

### 4.4 Gate rendering

Each `gate_type` gets one component. The `dialog` is identical to what Slack receives; only the
rendering differs.

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
 Browser (single-page app)
   │  HTTPS + token                         ▲ push (or poll)
   ▼                                        │
 ┌──────────────────────┐       ┌───────────────────────────┐
 │ WebApiFunction  EXP  │       │ WebCallbackFunction  EXP  │
 │ /api/v1/ui/web/*     │       │ consumes WebResultsQueue  │
 └─────────┬────────────┘       └─────────────▲─────────────┘
           │ SQS (same messages Slack sends)   │ results where provider = 'web'
           ▼                                   │
 ┌─────────────────────────────────────────────┴─────────────┐
 │ ProcFunction  PROC — unchanged business logic             │
 └─────────────────────────────┬─────────────────────────────┘
                               ▼
                   ServFunction  SERV  →  PostgreSQL
```

| Component | Role |
|---|---|
| **Single-page app** | Static files on S3 behind CloudFront. Bundled with esbuild, like the Lambdas |
| **Identity** | A Cognito user pool, one user per household member. API Gateway validates the token; the browser never holds the internal API key |
| **`WebApiFunction`** (EXP) | The app's backend: command, Novia message, gate response, and panel reads. Enqueues the same SQS messages Slack enqueues and calls PROC with the internal key, as `SlackbotFunction` does |
| **`WebResultsQueue` + `WebCallbackFunction`** (EXP) | Outbound results for `provider: 'web'`. `enqueueCallback` selects the queue by `callback.provider` rather than a fixed Slack queue |
| **Push** | Phase 1 polls the inbox (§4.6) while the tab is visible; an API Gateway WebSocket replaces polling when latency matters |

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
provider-neutral **inbox** (`PGC_UiMessage`: provider, thread reference, message type, payload,
created/read times), then enqueues it as today. The app reads the inbox for history and on
reconnect. Slack keeps its own channel history and ignores the inbox.

**Reconnect.** Pending gates come from runs at `awaiting_human_gate`, rebuilt with `buildDialog`,
never from stored renderings — the gate the user sees is always the gate the run is waiting on.

### 4.7 API surface

Spec-first in `openapi.yaml` before implementation. All under `/api/v1/ui/web/`, token-authorized:

| Route | Purpose |
|---|---|
| `POST /command` | Command bar → `CLASSIFY_INTENT` |
| `POST /novia` | Novia message → `MINDS_EYE` / `MINDS_EYE_RESUME` |
| `POST /gate/{runId}` | Gate response → `resume_gate` |
| `GET /inbox` | Inbox messages since a cursor |
| `GET /gates` | Pending gates, rebuilt |
| `GET /domains` | Navigator: domains and their workflows |
| `GET /runs`, `GET /runs/{runId}` | Activity panel |

### 4.8 Home status and the device bridge

No step type reaches an external API today. Device state and control need **one new step type**
that calls an external HTTP API — a new system behaviour, so a new case in `step-executor.mjs` and
a `PGC_StepType` contract, never a hard-coded integration. The first target is a home-automation
hub such as Home Assistant, which already bridges climate, lighting, solar inverters and Matter
devices; the step type stays generic so any API qualifies.

- **Reading:** a status workflow calls the hub, a `js_transform` maps its response to tile
  descriptors, and the Home status panel renders them. What a tile means is decided in the
  workflow.
- **Control:** a tile action starts a workflow; consequential actions pass a `confirm` gate.
- **Credentials:** hub tokens live in SSM like every other secret.

### 4.9 Phasing

| Phase | Delivers | Proves |
|---|---|---|
| **0 — Spike** | `provider: 'web'` end to end for one workflow; a `form` gate rendered as an editable grid | The seam in §3.1 holds; the grid answers the bulk-edit ceiling |
| **1 — Console** | Identity, command bar, Needs you, navigator, domain pages, Novia panel, inbox with polling; the Slack leaks in §3.2 removed | Daily use without Slack |
| **2 — Home status** | The external-API step type, a status workflow, tiles with actions | Device control from the brain |
| **3 — Household** | Several household members; per-member Novia threads; push | A family uses one brain |
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
6. **Proposal deck v1 corrections before it is presented** — slide 21 says external API connections
   are already built (they are not, §4.8); slides 2 and 18 quote the README's monthly cost rather
   than the measured steady state in `architecture.md` §16; slide 14 states schema-per-home
   isolation in the present tense; slide 17 places all `PGC_` tables in the shared layer (§5.3).
