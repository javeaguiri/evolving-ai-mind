# evolving-mind-ai — Web App Design
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 0.4
Status: **DRAFT for approval — Sprint 14 AC0.** The four platform choices in §1 are **tentative**
(Javear, 2026-10-22: "go tentatively with the suggestions"). No Phase 0 code starts before this
document is approved.
Last updated: 2026-10-31 (v0.4, §4 rewritten on Javear's review — back to `arch-home-brain.md`'s console: navigator, page of panels, Novia on the right; pages hold panels of three kinds (workflow, data, Novia), a widget is a data representation inside a data panel; workflows stepped through as in Slack; reports refreshed by re-running their workflow; 🧠 Help apart from ⚙ Settings; §2.5 session topics, §2.6 workflow output, §5.4 ceilings owned by the renderer)
Previously: 2026-10-30 (v0.3 — ☰ menu, labelled runs, Novia separate; §2.4 run labels)
Previously: 2026-10-25 (v0.2 — pages of widgets, one Ask, ⚙ for the machinery; §2.3 `PGC_Page`)

**Working mock-up:** <https://claude.ai/artifact/CiBwcLPCVTH3YfKt85L1ro> — the wireframes for this
document, clickable. Private until shared from its Share menu.

This document takes `docs/arch-home-brain.md` §4 (product direction, v0.1) to buildable depth for
**Phase 0** and **Phase 1**. The Home Brain document keeps the product direction, the edit policy
(§4.8) and the tenancy model (§5); this one owns how the web app is built.

---

## 1. Platform

| Concern | Design (tentative) |
|---|---|
| **Hosting** | Static single-page app in a private S3 bucket behind **CloudFront** (origin access control). CloudFront has a second origin, the existing REST API, for the path `/api/v1/ui/web/*` — the site and its API share one origin, so the browser makes no cross-origin call and needs no CORS. All of it is declared in `template.yaml` |
| **Reaching PROC** | A new Lambda, **`WebApiFunction`** (EXP), behind `/api/v1/ui/web/{proxy+}`. It is to the web what `SlackbotFunction` is to Slack: reads call PROC over HTTP with the internal API key; actions enqueue the same SQS messages Slack enqueues. **The browser never holds the internal key** |
| **Sign-in** | An **Amazon Cognito user pool** with managed login: authorization code flow with PKCE, a public app client (no secret), self-sign-up off, users created by the administrator. A passkey or TOTP is the second factor. The web routes carry `ApiKeyRequired: false` and a **Cognito authorizer** on API Gateway; the user's identity is the token's `sub`, never a request field |
| **Framework** | **React**, written as `.jsx` and bundled by **esbuild** — the bundler the Lambdas already use. Markdown from `/proc` is rendered by `react-markdown` with `remark-gfm` (tables). Every user-visible string goes through `react-i18next` message catalogs (ICU MessageFormat) from the first component (§13). No component library; the editable grid is built from native inputs |
| **Result delivery** | **Polling** `GET /inbox?after=<cursor>`: a short interval while a run the user started or answered is in flight, a long one when idle, paused while the tab is hidden. A WebSocket is a Phase 1 option taken only if the delay is felt in use |

Final decisions hold: ESM `.mjs` for every Lambda, esbuild, the shared `LambdaExecutionRole`,
Lambdas outside the VPC, SSM `String` parameters. The Cognito pool and client ids reach the app as
build-time configuration; they are not secrets.

### 1.1 Components

```
 Browser — React SPA (static, from CloudFront)
   │  same origin: /api/v1/ui/web/*  (Authorization: Bearer <Cognito access token>)
   ▼
 CloudFront ──► S3 (index.html, app bundle)
   │
   └──► API Gateway  /api/v1/ui/web/{proxy+}   Cognito authorizer, no API key
          │
          ▼
        WebApiFunction  EXP ─── HTTP + internal key ──► ProcFunction  PROC ──► ServFunction ──► PostgreSQL
          │                                                  │
          └── SQS WorkflowQueue (CLASSIFY_INTENT,            └── every message to a person:
              WORKFLOW_STEP resume_gate)                         PGC_UiMessage row (all providers)
                                                                 + SlackResultsQueue (provider 'slack' only)
```

| Code | Location |
|---|---|
| SPA source | `src/ui/web/app/` (`.jsx`), built to `dist/web/` by an esbuild script |
| `WebApiFunction` | `src/ui/web/api/handler.mjs` and one module per resource |
| Shared experience-layer rules | `src/ui/shared/` — the `number` field rule and the `EMPTY_OPTION_VALUE` convention move here from `src/ui/slackbot/form-fields.mjs`, so Slack and the web validate a form identically |
| PROC read endpoints | `src/proc/gates.mjs`, `src/proc/inbox.mjs` |
| Site deploy | `dev_scripts/deploy-web.mjs` — build, `aws s3 sync`, CloudFront invalidation. `sam deploy` does not ship the site |

---

## 2. Data

### 2.1 `PGC_UiMessage` — the inbox

Every message PROC sends a person is written here, for **every** provider. For Slack it is also
enqueued to the results queue as today; for the web the row **is** the delivery.

| Column | Type | Notes |
|---|---|---|
| id | bigserial PK | The inbox cursor |
| provider | text | `slack`, `web` |
| channel | text | Slack channel, or the web user's `sub` |
| thread_id | text | Slack thread ts, or the web thread id the app generated |
| workflow_run_id | integer | Nullable, no FK — runs are purged independently |
| message_type | text | `HUMAN_GATE`, `HUMAN_NOTIFICATION`, `WORKFLOW_ERROR` |
| payload | jsonb | The message exactly as enqueued — markdown text, or `gate_type` + `dialog` |
| created_at | timestamptz | |

`enqueueCallback` (`sqs-callback.mjs`) becomes the single delivery point: write the row through
SERV, then enqueue to `SYSSQSSlackResults` when `callback.provider` is `slack`. A run with no
callback (a scheduled run) writes nothing; its gates still appear in 🔔 Needs you (§3.1), which reads
runs, not the inbox.

### 2.2 Gate identity — `gate_id`

A gate is answered by **run and gate**, never by run alone. Today `resumeGate` accepts any answer
while the run is `awaiting_human_gate`, so a stale answer to gate A is applied to gate B once the
run has moved on. With two providers this stops being rare: a gate answered on the web leaves the
Slack message's buttons live.

- When a `human_gate` frame is pushed, it gets a `gate_id` (a UUID).
- `buildDialog` returns it on the `dialog`; Slack's buttons carry it in their value; the web's
  response carries it in the body.
- `resumeGate` refuses an answer whose `gate_id` differs from the top frame's, as it refuses one
  for a run no longer awaiting. A Slack button posted before this change carries no `gate_id` and
  is accepted as today.

This is an Execution change in `run-workflow.mjs`, `step-executor.mjs`, `callback.mjs` and
`interactive.mjs`.

### 2.3 `PGC_Page` — the household's pages

One row per page version, as `PGC_Workflow` keeps its versions. An evolving artifact (§4.2): written
by the user from *+ Add panel* or by Novia's gated `propose_page_change`, seeded only with a
generic, empty Home.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| page_key | text | Stable identity across versions; the `{pageId}` in `/p/{pageId}` |
| version | integer | Unique with `page_key`; the latest is drawn |
| title | jsonb | A string or a language map (§13) |
| order | integer | Position in the navigator's *Pages*; Home is `0` |
| panels | jsonb | Ordered `[{ id, kind, width, title?, config }]`; `kind` is `workflow`, `data` or `novia` (§4.2). A data panel's `config` names its `source` and `widget` and carries that widget type's options |
| created_by | text | `seed`, `user`, `novia` |
| created_at | timestamptz | |

A panel's `config` is validated on write against its kind's schema and, for a data panel, its widget
type's — as L0 validates a step against its `PGC_StepType` contract; an unknown kind, widget or key
is refused, not stored.

### 2.4 Run labels

A run is listed by what it was about — *Mercadona · 17 Oct* — not by its id or start time (§4.3).

- **Declared by the workflow**, as `display.run_label` (§6.3): a template in the engine's `{{…}}`
  syntax over the run's `local_state`. An evolving artifact — Novia writes it when she builds or
  fixes a workflow; a system workflow declares none.
- **Resolved by the engine.** After each step, `run-workflow.mjs` resolves the template with
  `template-resolver.mjs`; once every token resolves, the result is written to
  `PGC_WorkflowRun.label` and not resolved again. The engine substitutes and never formats: a value
  meant for people (a date, an amount) is prepared by the workflow, in a `js_transform`, as all
  formatted content is.
- **Fallback.** A run with no label yet, or whose workflow declares none, is shown as the workflow's
  `display.label` and its start date, formatted by the app in the user's locale.

This is an Execution change in `run-workflow.mjs` and a column on `PGC_WorkflowRun`
(`arch-data.md` §4.3.8).

### 2.5 Session topics

A Novia panel (§4.2) lists the sessions on one topic, so a session carries one:
`PGC_Session.topic`, text, nullable.

- **Set from the panel.** *New* in a Novia panel starts a session with the panel's `topic`.
- **Set by Novia.** For a session begun elsewhere — her region, Slack — she names the topic with
  `set_session_topic`, a tool that changes only the label and so is not gated. A session with no
  topic is listed in her region by its first message.

Phase 1; a column on `PGC_Session` (`arch-data.md` §4.3.8) and a Novia tool.

### 2.6 A workflow's latest output

A `report` widget (§4.2) shows the output of a workflow's latest **completed** run: the payload of
that run's last `HUMAN_NOTIFICATION` in `PGC_UiMessage`, whichever provider ran it, with the run's
label and completion time. Nothing new is stored — the inbox already holds every message — so the
report outlives the run, and ↻ Refresh is an ordinary new run (§4.3). Inbox retention (§12) must keep
the latest completed run's messages for every workflow a report names.

---

## 3. API surface

All under `/api/v1/ui/web/`, JSON, `Authorization: Bearer`. Spec-first in `docs/openapi.yaml`
before implementation. Errors are `{ error: { code, message, fields? } }`.

### 3.1 Phase 0

| Method and path | Request | Response | Behind it |
|---|---|---|---|
| `GET /gates` | — | `200 { gates: [{ runId, gateId, workflowName, gate_type, dialog, provider, waitingSince }] }`, oldest first | `GET /proc/gates`: runs at `awaiting_human_gate` (explicit `columns`), each top frame rebuilt with `buildDialog`. Every provider, scheduled runs included |
| `GET /gates/{runId}` | — | `200` one gate as above, or `404 gate_not_waiting` | Same read, one run |
| `POST /gates/{runId}/responses` | `{ gateId, action, formValues?, inputValue?, listGroup?, selectedValue? }` | `202 { runId }`; `409 gate_moved` when `gateId` is not the waiting gate; `422 invalid_fields` with `fields` when a `number` field fails the shared rule — the run is not resumed | Validates, then enqueues `WORKFLOW_STEP resume_gate` with the run's own callback — the answer never re-points a run at another provider |
| `GET /inbox` | `?after=<id>&run=<id>&limit=` | `200 { messages: [...], cursor }` | `GET /proc/inbox`: the user's web messages, plus every message of runs the user answered from the web |
| `POST /runs` | `{ workflow }` | `202 { runId }`; `404 workflow_not_found` | Starts the named workflow — no intent classification — with `callback: { provider: 'web', channel: <sub>, threadId: <runId>, locale }`. The run (§4.3) is its thread |
| `GET /runs` | `?workflow=&domain=&status=&limit=&before=` | `200 { runs: [{ runId, workflowName, label, status, startedAt }], cursor }`, newest first | `GET /proc/runs`: `PGC_WorkflowRun` with explicit `columns`; `label` per §2.4. Feeds workflow panels and the run list in 🔔 |
| `GET /pages` | — | `200 { pages: [{ pageKey, version, title, order, panels }] }`, latest version of each, `title` resolved to the caller's locale | `GET /proc/pages`. Phase 0 returns Home only |
| `GET /workflows` | — | `200 { domains: [{ domain, label, workflows: [{ name, label, description }] }] }` | The navigator's *Domains* and each domain page's workflow panel in Phase 0 — the `workflows` part of §3.2's `GET /domains` |
| `GET /me` | — | `200 { name, email, locale, timezone }` | The token's claims; `locale` and `timezone` from the user's profile, defaulting to the household's (§13) |

`WORKFLOW_ERROR` reaches the browser summarised by `WebApiFunction`, as `callback.mjs` summarises it
for Slack; the summary function is shared, not copied.

### 3.2 Phase 1

**Navigation is data.** `GET /domains` returns what the navigator and a domain page draw, already resolved to the caller's locale (as a `dialog` is):

```json
{ "domains": [
  { "domain": "budgets_expenses", "label": "Budgets and expenses", "icon": "wallet", "order": 20,
    "workflows": [
      { "name": "manage_budget", "label": "Edit the budget", "description": "One month's amounts in a grid" }
    ] } ] }
```

`label`, `description`, `icon`, `order` and visibility come from the `display` metadata of
`PGC_DomainHelp` and `PGC_Workflow` (§6.3). Listed: the domain's workflows with `display.menu` not
`false`; system workflows (`domain: null`) never. Sorted by `order`, then by `label` with
`Intl.Collator` in the user's locale. `?labels=all` returns the full language maps instead — for an
editor of labels, never for drawing.

**Pages and panel data.** `PUT /pages/{pageKey}` writes a new version from *+ Add panel* (`409`
when the base version moved, `422` naming the panel whose config fails its schema);
`DELETE /pages/{pageKey}` (never Home). A data panel reads
`GET /sources/{source}/rows?filter=&order_by=&columns=&limit=` — the same PROC `records` read as a
domain page, through the registry's edit policy and `display` metadata, so a panel sees nothing a
domain page could not. A `report` widget reads `GET /outputs/{workflow}` — `200 { runId, label,
completedAt, payload }` from §2.6, or `404 no_output` before the first completed run. A Novia panel
reads `GET /novia/sessions?topic=`.

Adds `arch-home-brain.md` §4.7's remaining resources — `GET /domains`, `/domains/{domain}/schema`,
`/domains/{domain}/records[/{id}]`, `GET /runs/{runId}` (one run's steps, for Activity), the Novia
session resources, and the edit resources under the §4.8 edit policy — with the grid's batch save and the
document's entity save (§6.4).

---

## 4. Pages and navigation

**Two modes, as `arch-home-brain.md` §4.1 sets them.** In **Navigate** the app looks into the data
layers and lets the user change data more directly than Slack can — laid out by the app from REST
JSON and the registry. In **Execute** a workflow or a Novia conversation is stepped through as it is
in Slack: the backend pushes markdown and gates, and the app displays them. A page holds both, in
separate panels — never a workflow's questions spread across a page.

### 4.1 The shell

```
Desktop
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ◉ Home brain   Home                    [ Run a workflow…            ]     🔔 1    🧠    ⚙ │
├───────────────┬─────────────────────────────────────────────────────────┬────────────────┤
│ PAGES         │ ┌ Spending by category ───────── ⓘ ┐ ┌ Budget ────────── ⓘ ┐ │ NOVIA        ‹ │
│  ▸ Home       │ │ ▇▇▇▇▇▇ Groceries                 │ │ [ Edit the budget ] │ │ Shopping list  │
│  ▸ Money      │ │ ▇▇▇▇ Transport                   │ │ ▸ October · 4 edits │ │ Stock alerts   │
│  + New page   │ │ ▇▇ Eating out    (click a bar)   │ │ ▸ September         │ │ + New          │
│ DOMAINS       │ └──────────────────────────────────┘ └─────────────────────┘ │ ────────────── │
│  ▸ Inventory  │ ┌ Grocery list ───────────────── ↻ Refresh ─ ⓘ ┐             │ You: why is …  │
│  ▸ Budget     │ │ Milk ×2 · Bread · Olive oil                    │             │ Novia: …       │
│  ▸ Expenses   │ │ Updated 17 Oct, from Manage inventory          │             │                │
│ ACTIVITY      │ └────────────────────────────────────────────────┘             │ [ message… ]   │
│  ▸ Runs       │                                                                │                │
│  ▸ Schedules  │                                                                │                │
│  ▸ Memory     │                                                                │                │
└───────────────┴─────────────────────────────────────────────────────────┴────────────────┘

Phone
┌────────────────────────┐
│ ☰  Home    🔔 1  🧠  ⚙ │
├────────────────────────┤
│ Spending by category   │
│ ▇▇▇▇▇▇ ▇▇▇▇ ▇▇         │
│ Budget                 │
│ [ Edit the budget ]    │
│ ▸ October · 4 edits    │
│ Grocery list        ↻  │
├────────────────────────┤
│ Pages  Domains  Novia  │
└────────────────────────┘
```

Page, domain and panel names above are illustrative; all of them are data.

| Control | Contents |
|---|---|
| **Navigator** (left) | **Pages** — Home, then the household's own pages in their `order`, then *+ New page*. **Domains** — every domain from the registry, each opening its domain page (§4.4). **Activity** — Runs, Schedules, Memory. Pinned on a desktop and collapsible to icons; on a phone, the *Pages* and *Domains* tabs |
| **Command bar** | Phase 1. Free text that starts a workflow — the web's `/mind`, sent as `CLASSIFY_INTENT`; the run opens in the run drawer (§4.3). It never reaches Novia, who has her own region |
| **🔔 Needs you** | The count of questions waiting on a person, across every run and provider, shown only when there are some. Opens the list; each item opens the question **inside its run** (§4.3) |
| **🧠 Help** | What the brain can do and how pages are built (§4.6) |
| **⚙ Settings** | The user's own settings (§4.7) |
| **Page body** | The page's panels in a responsive grid; each panel declares a width (`1/3`, `1/2`, `2/3`, `full`); a phone stacks them in order, full width |
| **Novia** (right) | Her sessions and the open conversation (§4.5). Collapsible to a strip on a desktop; the *Novia* tab on a phone |

### 4.2 Pages, panels and widgets

Two levels. **A page holds panels; a panel holds what its kind allows.** The user never assembles
widgets into panels: adding a panel is one choice — what it is about — and then, for data, how to
show it.

| Term | What it is | Code or data |
|---|---|---|
| **Page** | A title and an ordered list of panels | Data — a `PGC_Page` row (§2.3), an evolving artifact |
| **Panel** | The frame on a page: title, width, ⓘ, *Ask Novia about this*, and one **kind** | The kinds are system code; which panels a page has, configured how, is data |
| **Widget** | A representation of data inside a panel — a table, form, list, chart, metric or report | A widget type is system code — a React component and its config schema — the rule `step-executor.mjs` follows for step types |

**Panel kinds.**

| Kind | About | Shows | Config | Phase |
|---|---|---|---|---|
| **Workflow** | One workflow, or every workflow of a domain | A *Start* button per workflow (its `display.label`); its runs by **run label** (§2.4), newest first; the active run stepped through in place (§4.3). With `show_output`, the latest output as a `report` widget above the runs | `workflow` or `domain`, `limit`, `show_output` | 0 (on domain pages), 1 (on household pages) |
| **Data** | A table or view of a domain, or a workflow's latest output | Exactly one widget | `source`, `widget`, the widget's options | 1 |
| **Novia** | A topic | Her sessions on that topic (§2.5), newest first; opening one continues it in the panel; *New* starts a session on the topic | `topic` | 1 |

**Widget types.**

| Widget | Source | Shows | Options |
|---|---|---|---|
| `table` | Table or view | A grid, editable where the edit policy allows; an optional totals row (§6) | `columns`, `filter`, `order_by`, `limit` |
| `form` | Entity or table | One record as a form, child collections inline beneath it (§6.2's document); a record picker above | `picker_column` |
| `list` | Table or view | Compact rows — *Olive oil · 1 left*; a row opens its record | `title_column`, `detail_columns`, `filter`, `limit` |
| `chart` | Table or view | Bars, a line or a pie; click-through (below) | `kind`, `category_column`, `value_columns`, `filter` |
| `metric` | Table or view | One number, optionally against a second — *€312 of €400* | `value_column`, `compare_column` |
| `report` | A workflow's latest output (§2.6) | The markdown that workflow produced, with when and from which run; **↻ Refresh** runs the workflow again (§4.3) | `workflow` |

**A widget reads data, never computes it.** A table, view or entity source is read through the
registry; *running low* is a view over inventory with its reorder rule, *budget vs spent* a view
joining budgets to the month's expenses (§6.2). The widget filters, sorts, limits and formats
through the registry's `display` metadata (§6.3) and holds no domain arithmetic and no domain words
of its own: every label is the registry's, the workflow's, or the page author's. **A report's source
is always a workflow**, because formatted content is composed in `/proc` — the app never writes a
report. A panel whose source no longer exists draws a *source missing* frame naming it, rather than
disappearing.

**Click-through.** A chart's bar, slice or point opens a drawer with a `table` widget over the same
source, filtered to the clicked category (and series, when there are several value columns): the
rows behind the mark. A row in a `table` or `list` opens its record in a `form` widget. Both come
from the widget's own config, with no domain knowledge; a specialised drill (a year into its
months) is a widget option, added as system code when a page needs it.

**Adding a panel.** *Edit page* → **+ Add panel** → what it is about: a domain's table or view, a
workflow, a domain's workflows, or a Novia topic. For data, the widget next — only the widgets that
fit the source are offered (a `chart` needs a numeric column, a `form` an entity or table) — then
its options, a preview, and *Add*. Panels are reordered with up and down controls and sized by
width; drag-and-drop layout comes later. Or **Novia**: *"put the supplies running low on my home
page"* becomes a gated `propose_page_change`, shown as a preview of the page before it is written.
Either way the page row is versioned like a workflow.

**Seeded.** Home ships as a seed with no panels; nothing domain-specific is seeded (`CLAUDE.md`,
system artifacts stay generic). An empty Home says *"Your home page is empty — open a domain from
the menu, or add a panel."* (Phase 0: *open a domain from the menu*.)

### 4.3 Workflows — stepped through as in Slack

| Surface | Design |
|---|---|
| **The run** | What Slack shows as a thread: the run's messages and questions in order, each question answered in place, the next step's output appearing below it. The backend sends what it sends Slack (§5); only the rendering differs, without Slack's limits (§5.4) |
| **Where a run is shown** | In the workflow panel that started it, which widens to `full` while the run is active; **⤢** opens it as the run page, `/runs/{runId}`. A run started anywhere else — from Slack, the command bar, Novia, a schedule, a report's Refresh — opens in the **run drawer** over the page, from 🔔 or from its label in a list |
| **History** | A workflow panel lists its runs by label (§2.4); opening a finished run shows its thread, read-only. *Ask Novia about this* carries the run id |
| **Empty** | *"You don't have any {workflow} runs yet — they will be shown here."* with *Start* |
| **Refreshing a report** | ↻ starts the report's workflow (`POST /runs`). A run that stops at a question opens in the run drawer; when it completes, the report redraws from the new output, under *Updated {date}, from {run label}* |

A question is only ever shown inside its run. 🔔 is a way to reach it, not a second place it lives.

### 4.4 Domain pages

Each domain has a page, `/d/{domain}`, drawn from the registry rather than stored — a household
cannot break one by editing it. First a workflow panel over the domain's workflows (`display.menu`
not `false`), then a data panel for each table and registered view, with the widget its
`display.view` names (`table` when none). This is where anything not yet on a household page is
found. **Phase 0 draws the workflow panel only**; Phase 1 adds the data panels and *Copy to a new
page*, which turns the domain page into a household page the user can rearrange.

### 4.5 Novia

Novia has the right-hand region, and only she answers there.

| Behaviour | Design |
|---|---|
| **Region** | Her sessions at its head, newest first, each named by its topic (§2.5); opening one shows the conversation. Deep-linkable as `?novia=<sessionId>` on any route |
| **Novia panels** | A panel on a page holds one topic's sessions (§4.2), for a subject the household returns to |
| **Messages** | `MINDS_EYE` / `MINDS_EYE_RESUME`, as `/novia` in Slack; her gated actions render with the gate components of §5 |
| **Ask Novia about this** | From any panel, record, run or question: opens her region with the item's identifiers (panel config, run id, record) in the opening message |
| **Starting a workflow** | She may start one for the user; it is then a run like any other, in the run drawer and its workflow's history |
| **Phase** | 1 |

### 4.6 🧠 Help — what the brain can do

A drawer over the page. Where it describes the brain it is generated from the household's registry,
never written by hand, so it stays true as the brain evolves; where it describes the app it is
catalog text (§13).

| Section | Holds |
|---|---|
| **What your brain can do** | Each domain with its tables and views, the workflows that act on it, what is scheduled, what it remembers |
| **Building your pages** | Adding a panel, the three kinds, choosing a widget, click-through, refreshing a report, asking Novia to build a page |
| **Words** | Nine words, used the same everywhere — in the app, in Novia's replies, in errors. *Domain*: a kind of thing you keep track of. *Workflow*: a routine the brain runs for you. *Run*: one time a workflow ran. *Question*: the brain needs your answer before it carries on (a gate). *Memory*: what the brain has learned. *Novia*: the brain's builder — she makes and fixes workflows, pages and domains. *Page*: a screen of panels you arrange. *Panel*: one box on a page. *Widget*: how a panel shows its data. A term's first use on a screen carries a dotted underline |

**ⓘ on every panel and term** opens on hover **and** on tap — a phone has no hover. A term shows its
definition. A panel shows where its data comes from, from its config and the registry: *"Items from
Inventory below their reorder level · view `running_low` · added by Novia, 24 Oct · Ask Novia to
change this"*.

### 4.7 ⚙ Settings — the user's own

Each entry is a form; none is a page of data.

| Entry | Holds | Phase |
|---|---|---|
| **Profile** | Name, email (from the sign-in), sign out | 0 |
| **Security** | Password, multi-factor sign-in, signed-in devices — Cognito's own (§1) | 1 |
| **Language** | The user's language (§13) | 1 |
| **Dates & numbers** | Date format, timezone, number and currency format; the household currency | 1 |
| **Appearance** | Wallpaper, light or dark | 1 |

### 4.8 Routes

Client-side; every page has a deep link.

| Route | Page | Phase |
|---|---|---|
| (Cognito managed login) | Sign-in, then back to the page asked for | 0 |
| `/` | Home | 0 |
| `/p/{pageId}` | A household page | 1 |
| `/d/{domain}` | A domain page (§4.4) | 0 |
| `/runs/{runId}` | A run page (§4.3) | 0 |
| `/activity/runs`, `/activity/schedules`, `/activity/memory` | Every run by its label, filterable by domain and status; the schedules; what the brain remembers, by domain | 1 |
| `/settings/{entry}` | Settings (§4.7) | 0 (Profile), 1 |
| `?run=<runId>` | The run drawer, over any route | 0 |
| `?novia=<sessionId>` | Novia's region, open on a session | 1 |
| `?help=<section>` | The Help drawer | 1 |

---

## 5. Gate rendering

The app renders the `dialog` `buildDialog` produces — the same payload `dialogToBlocks` turns into
Block Kit. **No domain vocabulary, no Slack ceilings**: a gate is as long as its fields.

### 5.1 Dialog fields → components

| `dialog` field | Web component |
|---|---|
| `typography` | Markdown (GFM tables included) |
| `description_list` | A list of the options with their descriptions |
| `list` | A table, one column per key across the items, `parentHeading` above; `secondaryAction` is a button on the row |
| `input` | A labelled control by `input_type` (§5.3); with grid hints, a grid cell (§5.2) |
| `textbox` | A text area (`multiline`) or a text box |
| `review_object` | A two-column key/value table; an array value as a nested table |
| `reveal` | A disclosure (`<details>`) — closed, labelled `button_label` |
| `actions` | A button row; `primary` and `danger` styles carried; a button with `modal` opens a dialog with a text area, its text sent as `inputValue` |

### 5.2 Gate types

| `gate_type` | Web rendering | Response sent |
|---|---|---|
| `form` | Typed inputs in a column; **an editable grid** when the fields carry grid hints. One button row at the foot | `{ action, formValues: { <name>: <value>, … } }` — every field, as Slack sends |
| `list_selection` | A table; the row's action button replaces typing an ID | `{ action: <item_action.action>, inputValue: <item id>, listGroup: <responseData.table or ''> }` |
| `choice` | One radio per option with its description, then Continue | `{ action: <option value> }` |
| `confirm` | Message and buttons | `{ action }` |
| `text_input` | Text area, then the gate's buttons | `{ action, inputValue }` |
| `review_object` | Key/value table, then buttons | `{ action }` |
| `followup_prompt` | Message; *Ask a follow-up* is Phase 1 (it opens a Novia or `/chat` turn) | — |

**The grid.** A field may carry three optional, generic layout properties on the `human_gate`
`PGC_StepType` contract:

| Property | Meaning |
|---|---|
| `row` | The row this field belongs to — any string, unique per row |
| `column` | The column label this field sits under |
| `group` | A heading for a run of rows (Sprint 13's form-field `group`, folded in) |

**Where the hint is written.** In the workflow — on the fields of its `human_gate` step, usually by
the `js_transform` that builds a templated `fields` array (for `manage_budget`, step 12 adds
`row: <category id>`, `column: 'Amount'`, `group: <budget type label>` to each field it already
builds). It is optional: a form without it renders as a stacked form on both providers and works
unchanged. It describes the **structure** of the form — these fields are cells of one table — not a
provider: no workflow ever says "on the web". Slack cannot draw a grid, so it ignores `row` and
`column`; it uses `group` as a header. The contract text goes on the `human_gate` `PGC_StepType` so
Novia emits the hint when she builds a bulk edit. Domain views (§6) need nothing in any workflow —
their layout comes from the registry.

When **every** input field carries `row` and `column`, the web lays the form out as a grid: rows
in first-appearance order, columns in first-appearance order, the field `label` of a row's first
field as its row header, `group` as a heading row. A missing cell is blank. Slack ignores `row` and
`column`, renders `group` as a header between fields, and stacks the inputs as today. The encoding
of a record id inside a field `name` stays workflow-local.

The grid marks a changed cell, counts changes beside Save, and keeps keyboard movement between
cells (Tab, Enter down, arrow keys). It never computes totals: a figure that depends on the values
is the workflow's, in the message.

### 5.3 Inputs

| `input_type` | Component |
|---|---|
| `text`, `textarea` | Text box, text area |
| `number` | A text box with numeric keyboard; validated by the shared rule (decimal comma accepted, `decimal: false` for whole numbers, `min`/`max`) on blur and again by `WebApiFunction` |
| `select`, `multi_select`, `radio`, `checkbox` | Native select, multi-select list, radio group, checkbox group; `''` is "none" |
| `date`, `time`, `datetime` | Native date, time, date-time inputs |

`optional: false` is enforced before sending; `resumeGate`'s own check stays the authority.

### 5.4 Ceilings belong to the renderer

A workflow gives a gate its whole set, once, and never pages for a provider. Each renderer draws the
set within its own limits — the rule §1.5 of `architecture.md` states for the Slack block ceiling.

| Gate content | Web | Slack |
|---|---|---|
| A long `list`, `list_selection`, `review_object` or markdown | The whole set; a table scrolls, sorts and filters in the browser | **Slack pages the gate itself**: one slice per message with *‹ Prev* / *Next ›*. A page click redraws the slice from the run's waiting gate, rebuilt by `buildDialog` through `GET /proc/gates/{runId}` (§3.1); the answer is the one an unpaged gate sends |
| A `form` with grid hints (§5.2) past Slack's ceiling | The whole grid, one Save | **Pick one row**: the row headers as a list; picking opens a modal with that row's fields (a modal holds 100 blocks and takes `number` inputs); its Save answers the gate with that row's fields only |
| A `form` without grid hints past Slack's ceiling | The whole form | Not drawable — L1 refuses it, as today, because nothing in the form says where to split it |

**What a workflow may receive.** An answer to a gridded form may carry a subset of its rows; a row
absent from `formValues` is unchanged, and so is a row whose values equal the fields' defaults. The
workflow writes only the rows that changed — what Sprint 14's grid needs anyway — and the rule is
contract text on the `human_gate` `PGC_StepType`, where Novia reads it.

**Workflows that page today** keep working: their pager is ordinary steps. Novia removes it as she
next works on each one.

This is an Execution change in `callback.mjs` and `interactive.mjs` (the Slack pager and the
pick-one modal), contract text on `human_gate`, and a Validation change in `simulation-engine.mjs`:
L1's gate-size check stops applying to lists and gridded forms and stays for a form without grid
hints.

---

## 6. Domain views — records outside any workflow (Phase 1)

Domain pages (§4.4) and data panels (§4.2) read and write records through the REST resources (§3.2) — `WebApiFunction` →
PROC `records` → SERV — and **never through a workflow**. React decides the widgets. It decides
them from the registry, **never from a domain name**: a new rendering behaviour is a new view type
in the app (system code), and which domain uses it is registry data — the rule `step-executor.mjs`
follows for step types.

### 6.1 Cell editors — from column type

| Registry fact (`PGC_Schema`) | Editor |
|---|---|
| `date`, `timestamptz` | Date picker |
| `numeric`, `integer`, `real` | Number box — the shared rule, decimal comma accepted |
| A `check` constraint of the form `col IN (…)` | Dropdown of those values |
| An entry in `foreign_keys` | Dropdown showing the referenced table's label column (`pickLabelColumn`), saving the id |
| `boolean` | Checkbox |
| `varchar`, `text` | Text box; text area for `text` |
| `id`, `created_at`, `updated_at`, `*_embedding`, the soft-delete column | Not shown |

`nullable: false` makes a cell required. A foreign key declared `ON DELETE SET NULL` on a NOT NULL
column (`PGD_Expenses.category_id` today) is a registry contradiction the renderer reports rather
than guesses around.

### 6.2 Views

| View | For | Shape | Default for |
|---|---|---|---|
| **Grid** | A flat table — expenses, a stock portfolio, inventory, budgets | A spreadsheet: edit in place, add and delete rows, sort, filter, an optional totals row; changed cells marked; **one Save** sends every changed row | A table with no children |
| **Document** | One entity — a recipe | The root record as a form; each child collection inline beneath it, as a sub-grid (ingredients) or an ordered list (steps, by `step_number`); **one Save** writes the whole entity | An entity in `PGC_EntitySchema` with joined children |
| **List** | Browsing a large table read-mostly | Cards or rows, opening a record | — |

Grid is the `table` widget, Document the `form` widget, List the `list` widget (§4.2). A specialised
need — a portfolio chart, a calendar — is a **new widget type**, chosen by the registry.
Computed values (market value = quantity × price) come from a database view registered like a
table and shown read-only, never from arithmetic in the app.

### 6.3 Display metadata — in the registry

A `display` object, on the table (`PGC_Schema`) and on the entity (`PGC_EntitySchema`). Every key
is optional; absent keys fall back to the defaults above. It is an evolving artifact: Novia proposes
it with a domain's tables, the domain-confirming gate shows it, and it is changed like any other
registry fact.

| Key | Level | Meaning |
|---|---|---|
| `view` | Table, entity | The widget a domain page draws for it: `table`, `form`, `list`, or a specialised widget type |
| `label` | Domain, table, entity, workflow | What a person reads instead of the identifier — a string or a language map (§13) |
| `description` | Domain, workflow | One line under the label in menus — a string or a language map |
| `icon` | Domain, workflow | A name from the app's own icon set; an unknown name draws the default |
| `order`, `menu` | Domain, workflow | Position in the navigator's *Domains* and in workflow panels; `menu: false` keeps a workflow out of them |
| `run_label` | Workflow | How one run is named in lists — a `{{…}}` template over the run's `local_state` (§2.4) |
| `columns` | Table | Order, and per column: `label` (string or language map), `hidden`, `width` |
| `format` | Column | `currency` with `currency_column` (the row's own currency column) or a fixed code; `percent`; `date` |
| `total` | Column | `sum` — a totals row on a grid |
| `soft_delete` | Table | The column a delete sets (`deleted_at`); rows with it set are hidden |
| `order_by` | Table, child collection | Default sort; a child list ordered by it can be reordered by dragging |
| `default_filter` | Table | The filter a grid opens on — e.g. the current month |

The edit policy (`arch-home-brain.md` §4.8) sits beside it: `editable` per column, add and delete
per table.

### 6.4 Saving — and what SERV needs first

| Save | Request | SERV today | SERV needs |
|---|---|---|---|
| **Grid** | `PATCH /domains/{d}/records` — `[{ id, version, changes }]` plus new rows and deletions | `upsertRows` is one transaction; `updateRows` is not; no version check anywhere | A batch write in **one transaction**, each changed row conditioned on its version (`updated_at`), `409` naming the rows that moved |
| **Document** | `PUT /domains/{d}/entities/{name}/{id}` — the whole entity with the root's version | `createEntity`, `updateEntity`, `upsertEntity` write the **root table only** — children are not written, there is no transaction, and embeddings are not maintained | An entity write that diffs each child collection (insert, update, delete), runs root and children in **one transaction**, conditions on the root's version, and re-embeds through `resolveEmbedding` as `table.mjs` does |

These are SERV system changes (Execution), built in Phase 1 before the views that need them.

---

## 7. What the web shares with Slack

**Below the experience layer everything is shared and unchanged; each provider writes its own
renderer.** Nothing is copied.

| Piece | Shared or per provider |
|---|---|
| Workflows, `buildDialog`, `run-workflow`, Novia (`minds-eye.mjs`) | **Shared.** Workflows never learn which provider serves them. Phase 1 removes the `arch-home-brain.md` §3.2 leaks |
| The `dialog` contract | **Shared** — a JSON Schema in `docs/openapi.yaml` both renderers are tested against |
| Experience-layer rules — the `number` rule, `EMPTY_OPTION_VALUE`, the error summariser | **Shared** from `src/ui/shared/` |
| The renderer | **Per provider** — `callback.mjs` emits Block Kit, React components render the web. A copied renderer drifts |
| Domain views (§6) | **Web only** — Slack keeps `list_entity` and the CRUD workflows |

The web renders more from the same contract — a grid, no block ceiling, a row click instead of a
typed id. When it needs a fact Slack has no use for, the fact is added to the contract as structure
(`row`, `column`) that Slack ignores; a workflow never branches on its provider.

**Novia on the web** sends the same `MINDS_EYE` / `MINDS_EYE_RESUME` messages; her gated actions
render with the gate components of §5; her text is markdown. *Ask Novia about this* passes the
current record, run or domain id into the opening message. New work for her: proposing a domain's
`display` metadata and edit policy with its tables.

**Later:** a gate that shows a registry view of records (review a batch before import) would reuse
the Grid component — a genuinely new rendering, so a new `gate_type`, with pick-one as Slack's
fallback.

### 7.1 How a gate reaches either provider

The workflow states the form's structure once. `buildDialog` carries it into the provider-neutral
`dialog`, each renderer draws what its medium allows, and both send the answer back in the same
shape.

```
 PROC (provider-neutral)                                   EXP (one renderer per provider)

 workflow js_transform builds fields[]:
   { name:'amt_17', type:'number', label:'Groceries',
     default:400, row:'17', column:'Amount', group:'Monthly' }
        │
        ▼
 human_gate step ─► buildDialog()  (step-executor.mjs)
        │            copies each field into dialog.fields[],
        │            row / column / group included
        ▼
   dialog { fields:[ { type:'input', name:'amt_17', input_type:'number',
                       label:'Groceries', initial:400,
                       row:'17', column:'Amount', group:'Monthly' }, … ] }
        │
        ├── provider 'slack' ──► callback.mjs dialogToBlocks()
        │                         row/column ignored; group → a header block;
        │                         inputs stacked, within Slack's block ceiling
        │
        └── provider 'web' ────► <Form>: every input carries row + column
                                  → <Grid>: rows by row, columns by column,
                                  group as a heading row; no block ceiling

 Both answer the same way:
   { action:'save', formValues:{ amt_17:'420', amt_18:'95', … } }
        ▼
   resume_gate (SQS) ─► run-workflow ─► the next step reads formValues, provider unknown
```

| Layer | Owns | Never |
|---|---|---|
| **Workflow** (`js_transform`) | Which fields exist — name, label, default — and the hints `row`, `column`, `group` | Names a provider |
| **`buildDialog`** (PROC) | The step → the neutral `dialog`, every field property the contract defines carried through | Knows Block Kit or React |
| **Renderer** (EXP) | Drawing the `dialog` with what the medium allows | Interprets what a field or value means |

`buildDialog` copies a fixed set of field properties, so a hint reaches a renderer only once it is
in that set. Adding `row`, `column` and `group` there, on the `human_gate` `PGC_StepType` contract,
and as a `group` header in `dialogToBlocks`, is scope item 2's PROC and Slack half; the `<Grid>`
is its web half.

### 7.2 Code layout

Slack **pushes** — the system posts into it. A browser **pulls** — it asks for what is new. So the
two providers are not mirror images: the web has no outbound Lambda, and its renderer runs in the
browser.

```
src/ui/
├── slackbot/                          Slack
│   ├── handler.mjs, mind.mjs, …       IN   Slack → SlackbotFunction (slash commands)
│   ├── interactive.mjs                IN   a button click → resume_gate SQS
│   ├── callback.mjs                   OUT  SlackResultsQueue → dialogToBlocks → Slack API
│   └── form-fields.mjs                form values ↔ Block Kit block_ids
│
├── web/                               Web
│   ├── api/                           WebApiFunction (Lambda)
│   │   ├── handler.mjs                IN   browser → /api/v1/ui/web/*, Cognito token
│   │   ├── gates.mjs                  IN   POST /gates/{runId}/responses → resume_gate SQS
│   │   └── inbox.mjs                  OUT  GET /inbox → PGC_UiMessage, through PROC
│   └── app/                           React SPA — runs in the browser, shipped from S3
│       ├── Gate.jsx, Form.jsx         dialog → components: the web's dialogToBlocks
│       └── Grid.jsx                   the editable grid
│
└── shared/                            both providers
    └── form-rules.mjs                 the number rule, EMPTY_OPTION_VALUE
```

| Slack | Web | Why they differ |
|---|---|---|
| `handler.mjs` + `interactive.mjs` | `web/api/` | Same job — authenticate, enqueue the same SQS messages. Slack's proof is a request signature, the web's a Cognito token |
| `callback.mjs`, a Lambda that pushes | No Lambda: PROC writes a `PGC_UiMessage` row and the browser polls `GET /inbox` | A browser cannot be posted into without a WebSocket (§1, Phase 1 option) |
| `dialogToBlocks`, inside that Lambda | React components, in the browser | Rendering moves to the client |
| `form-fields.mjs` | Read from the inputs by name | Block Kit carries a field's name in its `block_id`; an HTML input has a `name` |

`src/ui/shared/` holds the rules both must apply identically — what a valid `number` is, how "none"
travels — so a value typed in Slack and on the web means the same thing. `PGC_UiMessage` is written
for every message, Slack's included; that is how a Slack-started run also appears on the site
(§8).

---

## 8. A gate answered on the other provider

| Case | Behaviour |
|---|---|
| **Slack-started run, gate answered on the web** | The response is enqueued with the run's own callback (Slack). The next gate and the results post to the Slack thread as always, and through the inbox they also appear in 🔔 and in the run on the web. The Slack message's buttons stay live; a click there is refused by `gate_id` (§2.2) and `interactive.mjs` answers *"Already answered elsewhere."* ephemerally |
| **Web-started run** | No Slack message exists, so it can only be answered on the web |
| **Phase 1** | A `GATE_RESOLVED` callback updates the Slack message to show it was answered on the web, so the stale buttons disappear rather than refuse |

---

## 9. States

| State | What the user sees |
|---|---|
| **Loading** | Skeleton panels on the page and rows in a run; a gate shows its frame and a spinner in the button row |
| **Empty** | 🔔: *Nothing is waiting for you.* A workflow with no runs: *"You don't have any {workflow} runs yet — they will be shown here."* with *Start*. A data panel with no rows: its own title and *Nothing here yet*. A report before its first run: *Not run yet* with ↻. Home with no panels: §4.2. A new page: *+ Add panel*, open |
| **Run working** | A *Working…* line at the foot of the run after *Start*, ↻ or an answer, until the next message arrives |
| **Answer sent** | The gate collapses to a one-line record — *You chose Save · 3 changes* — and its inputs are disabled; the next gate or message follows below |
| **Gate moved (`409`)** | *This was answered elsewhere.* The gate reloads from `GET /gates/{runId}` |
| **Invalid fields (`422`)** | The offending cells outlined, each with its message; nothing is sent to the run |
| **Workflow error** | The summarised error in the run, with *Ask Novia about this* carrying the run id |
| **Source missing** | A panel whose `source` is gone draws a frame naming it and offers *Ask Novia about this*; the rest of the page draws normally |
| **Offline / API failure** | A banner, *Can't reach the home brain — retrying*; polling backs off; typed values are kept |
| **Signed out** | The token is refreshed silently; when that fails, the user returns to sign-in and then to the same page |

---

## 10. Phases

| | Phase 0 — prove the seam | Phase 1 — the console |
|---|---|---|
| **Infrastructure** | S3 + CloudFront, Cognito pool and one user, `WebApiFunction`, the web routes, `deploy-web.mjs` | WebSocket only if polling is felt |
| **PROC** | `PGC_UiMessage` and `enqueueCallback` writing it; `gate_id`; run labels (§2.4); `PGC_Page` with the seeded Home; `GET /proc/gates`, `GET /proc/inbox`, `GET /proc/pages`, `GET /proc/runs`, starting a named workflow | Navigate reads (§3.2), `GET /proc/outputs` (§2.6), session topics (§2.5), the edit policy and `PGC_RecordEdit`, the `arch-home-brain.md` §3.2 Slack leaks removed |
| **Contract** | `row`, `column`, `group` on the `human_gate` contract | A gridded form's answer may carry a subset of rows (§5.4) |
| **Pages** | Sign-in; the shell — navigator (Pages, Domains), 🔔, ⚙; Home from the seeded `PGC_Page`; domain pages with their workflow panel — *Start*, runs by label, the run stepped through in place; the run page and run drawer; Settings › Profile; every gate type of §5.2 | Household pages and *+ Add panel*; data panels with every widget type, click-through and report Refresh; workflow panels on household pages; Novia's region and Novia panels; 🧠 Help; Activity; the command bar; the rest of Settings; ⓘ on panels and terms; *Ask Novia about this*; Novia's `propose_page_change` |
| **Slack** | `gate_id` on buttons; the ephemeral "already answered" | `GATE_RESOLVED` message update; the Slack pager and pick-one modal (§5.4), with L1's gate-size check narrowed |
| **Domain views** | — | Grid and document views, cell editors, `display` metadata (§6); SERV batch and entity writes with version checks (§6.4) |
| **First workflow** | `manage_budget` (357): month pick, then one grid grouped by budget type, after Novia's four corrections | — |

Phase 0 builds every gate type because 🔔 reaches every waiting gate, whichever provider started
its run.

---

## 11. Security

The threat model is `docs/arch-security.md`; these are the site's own controls.

| Control | Design |
|---|---|
| **No internal key in the browser** | The browser holds only Cognito tokens; `WebApiFunction` holds the internal key |
| **Identity** | The user is the token's `sub`, verified by the API Gateway authorizer. `WebApiFunction` passes it to PROC as the principal (`arch-security.md` S5); no request body field names a user |
| **Markdown** | `/proc` markdown is LLM-written and may carry injected content. It is rendered **without raw HTML** and **without remote images** — an image URL can carry data out the moment it renders. Links open in a new tab with `rel="noopener noreferrer"` |
| **Content Security Policy** | Sent by CloudFront: scripts and styles from the site's own origin only, `connect-src` the site's origin and the Cognito domain, `img-src` the site's origin and `data:`, `frame-ancestors 'none'` |
| **Object-level checks** | Every resource taking an id — a gate, a run, a page, an output, a Novia session, later a record — is checked against the principal in PROC, never trusted from the URL |
| **Dependencies** | Lockfile committed; `npm audit` in `deploy-web.mjs` stops a deploy with a high-severity finding |
| **No CSRF surface** | Requests authenticate with a bearer header, not a cookie |

---

## 12. Open questions

1. **Token storage.** Tentative: access token in memory, refresh token in `localStorage`, with a
   strict Content Security Policy from CloudFront. The alternative is a cookie session held by
   `WebApiFunction`, which keeps every token out of script reach at the cost of validating the JWT
   in the function rather than in API Gateway.
2. **Inbox retention** (`arch-home-brain.md` §6.5) — how long `PGC_UiMessage` keeps a row; the
   latest completed run of every workflow a report names is kept regardless (§2.6).
3. **Custom domain** — the CloudFront default domain serves Phase 0; a household domain needs an
   ACM certificate in `us-east-1` and a DNS record.
4. **Navigation layout** — v0.4 (§4) awaits Javear's review.

---

## 13. Languages

The analysis is `arch-home-brain.md` §7. Phase 0 ships English only; these rules keep a second
language a matter of adding catalogs and language maps, not rewriting the app.

| Rule | Detail |
|---|---|
| **Catalogs from day one** | No user-visible literal in a component. Every string is a catalog key; English is the only catalog in Phase 0. Plurals and parameters in ICU MessageFormat. App words in `src/ui/web/app/locales/<locale>.json`; system-message keys from the shared `src/ui/shared/messages/<locale>.json`. Files, not a database table — `arch-home-brain.md` §7.3 |
| **Locale and timezone on the principal** | `GET /me` returns them; every `POST /runs` and gate response sends `locale` on the callback, so a run started on the web carries its user's language into `local_state` |
| **Formatting through `Intl`** | Numbers, dates, currency and sorting (`Intl.NumberFormat`, `DateTimeFormat`, `Collator`) with the user's locale and timezone — never `toLocaleString()` without a locale, never a literal symbol. Number entry accepts the locale's decimal separator (the shared rule already accepts a comma) |
| **The `dialog` stays plain strings** | PROC resolves language maps before a gate is sent (`arch-home-brain.md` §7.2), so §5's components never see one |
| **System messages by key** | A notification or error carrying `messageKey` and `params` is rendered from the catalog; its `message` text is the fallback |
| **Fixed words** | The navigator's groups (Pages, Domains, Activity) and Activity's entries (Runs, Schedules, Memory), the Help sections, the Settings entries (Profile, Security, Language, Dates & numbers, Appearance), the panel kinds and widget names, Novia, Start, Refresh, the nine vocabulary terms and their definitions (§4.6) — app words, catalog keys like any other. Page titles are the household's, stored as language maps |
| **Data-driven menus** | The navigator's Domains, domain pages and workflow panels come from `GET /domains` (§3.2) with `label` already in the user's language; the app draws them and never translates a name itself |
| **Registry labels** | `display.label` and column labels may be language maps. PROC picks the user's locale, then the household's, then the first entry, then a humanised identifier (`budgets_expenses` → *Budgets expenses*); the fallback is marked in the response (`labelFallback: true`) so missing translations can be listed |
| **Layout** | `lang` set on the document from the locale; CSS logical properties (`margin-inline`, `padding-inline-start`) so a right-to-left language is not ruled out; no text baked into images |
| **User content** | Shown as entered, never machine-translated without being asked |
