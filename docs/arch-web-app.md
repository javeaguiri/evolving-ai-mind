# evolving-mind-ai — Web App Design
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 0.1
Status: **DRAFT for approval — Sprint 14 AC0.** The four platform choices in §1 are **tentative**
(Javear, 2026-10-22: "go tentatively with the suggestions"). No Phase 0 code starts before this
document is approved.
Last updated: 2026-10-25 (§4 rewritten — the household's own pages of widgets as the navigation, one Ask for workflows and Novia, ⚙ for the machinery, the system explained from data; §2.3 `PGC_Page`)

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
callback (a scheduled run) writes nothing; its gates still appear in Needs you (§3.1), which reads
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
by the user from the widget menu or by Novia's gated `propose_page_change`, seeded only with a
generic Home.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| page_key | text | Stable identity across versions; the `{pageId}` in `/p/{pageId}` |
| version | integer | Unique with `page_key`; the latest is drawn |
| title | jsonb | A string or a language map (§13) |
| order | integer | Position in the page tabs; Home is `0` |
| widgets | jsonb | Ordered `[{ id, type, width, title?, config }]`; `type` is a widget type of §4.2, `config` its schema |
| created_by | text | `seed`, `user`, `novia` |
| created_at | timestamptz | |

A widget's `config` is validated against its type's schema on write, as L0 validates a step against
its `PGC_StepType` contract; an unknown type or key is refused, not stored.

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
| `GET /inbox` | `?after=<id>&thread=<id>&limit=` | `200 { messages: [...], cursor }` | `GET /proc/inbox`: the user's web messages, plus every message of runs the user answered from the web |
| `POST /commands` | `{ text, threadId }` | `202 { threadId }` | `CLASSIFY_INTENT` with `callback: { provider: 'web', channel: <sub>, threadId, locale }`. `threadId` is the conversation of §4.4 |
| `GET /pages` | — | `200 { pages: [{ pageKey, version, title, order, widgets }] }`, latest version of each, `title` resolved to the caller's locale | `GET /proc/pages`. Phase 0 returns the seeded Home only |
| `GET /me` | — | `200 { name, email, locale, timezone }` | The token's claims; `locale` and `timezone` from the user's profile, defaulting to the household's (§13) |

`WORKFLOW_ERROR` reaches the browser summarised by `WebApiFunction`, as `callback.mjs` summarises it
for Slack; the summary function is shared, not copied.

### 3.2 Phase 1

**Navigation is data.** `GET /domains` returns what the navigator and a domain page's action list
draw, already resolved to the caller's locale (as a `dialog` is):

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

**Pages and widget data.** `PUT /pages/{pageKey}` writes a new version from the widget menu (`409`
when the base version moved, `422` naming the widget whose config fails its schema);
`DELETE /pages/{pageKey}` (never Home). A data widget reads
`GET /sources/{source}/rows?filter=&order_by=&columns=&limit=` — the same PROC `records` read as
All data, through the registry's edit policy and `display` metadata, so a widget sees nothing a
domain page could not.

Adds `arch-home-brain.md` §4.7's remaining resources — `GET /domains`, `/domains/{domain}/schema`,
`/domains/{domain}/records[/{id}]`, `GET /runs[/{runId}]`, the Novia session resources,
`POST /runs`, and the edit resources under the §4.8 edit policy — with the grid's batch save and the
document's entity save (§6.4).

---

## 4. Pages and navigation

**The user's own pages are the navigation.** A person opens the site to see their household — what
is running low, how the month's spending stands — not the system's machinery. So the main menu is
a row of pages the household makes, each a set of **widgets**; one **Ask** box reaches the brain
from anywhere; and the machinery (all data, runs, workflows, memory) sits one level down, reachable
but out of the way. The app is still a single-page app in the technical sense (§1); what this
section decides is what the user sees.

### 4.1 The shell

```
Desktop                                                       Phone
┌────────────────────────────────────────────────────────┐   ┌──────────────────────┐
│ ◉ Home brain   Home · Stocks · +    [ Ask… ]   ⚙   ◯  │   │ ◉ Home        ⚙   ◯ │
├────────────────────────────────────────────────────────┤   ├──────────────────────┤
│ ┌ Needs you (1) ─────────┐ ┌ Running low ───────── ⓘ ┐ │   │ Needs you (1)        │
│ │ Budget · Edit amounts  │ │ Olive oil      1 left    │ │   │ Running low          │
│ │ waiting 3 min [ Open ] │ │ Coffee beans   2 left    │ │   │ Budget vs spent      │
│ └────────────────────────┘ └──────────────────────────┘ │   │  (one column)        │
│ ┌ Budget vs spent · October ─────────────────────── ⓘ ┐ │   ├──────────────────────┤
│ │ Groceries  ████████░░  €312 / €400                 │ │   │ Home  Stocks  Ask  ⋯ │
│ └────────────────────────────────────────────────────┘ │   └──────────────────────┘
└────────────────────────────────────────────────────────┘
```

| Region | Contents |
|---|---|
| **Page tabs** | The household's pages in their `order`, then **+** (new page). Home is the first page and cannot be deleted. On a phone: a bottom bar with the first pages, *Ask*, and *⋯* for the rest |
| **Ask** | One box. Opens the conversation drawer (§4.4) on any page, without leaving it |
| **⚙** | The machinery (§4.5) |
| **◯** | The signed-in user: language, sign out |
| **Page body** | The page's widgets in a responsive grid: each widget declares a width (`1/3`, `1/2`, `full`); a phone stacks them in order, full width |

### 4.2 Pages and widgets

A **page** is an evolving artifact: a row holding its title and an ordered list of widgets, each
with its configuration. A **widget type** is system code — a React component and its config
schema, the rule `step-executor.mjs` follows for step types: a new kind of widget is a code change;
which widgets a page shows, over which data, is data.

| Widget type | Shows | Configuration | Phase |
|---|---|---|---|
| `needs_you` | Waiting gates, oldest first, each opening the gate | — | 0 |
| `conversations` | Recent conversations, each opening the drawer | `limit` | 0 |
| `table` | A table or view as a grid, editable where the edit policy allows (§6) | `source`, `filter`, `columns`, `order_by`, `limit` | 1 |
| `list` | Rows as compact cards — *Olive oil · 1 left* | `source`, `filter`, `title_column`, `detail_columns`, `limit` | 1 |
| `metric` | One number, optionally against a second — *€312 of €400* | `source`, `value_column`, `compare_column`, `format` | 1 |
| `chart` | Bars or a line over a source's rows | `source`, `kind`, `category_column`, `value_columns` | 1 |
| `actions` | Buttons that start workflows — *Edit the budget*, *Add a receipt* | `workflows` | 1 |
| `activity` | Recent runs, a domain's or all | `domain`, `limit` | 1 |
| `note` | Text the household writes | `markdown` | 1 |

**A widget reads data, never computes it.** `source` names a registered table or **view**; *running
low* is a view over inventory with its reorder rule, *budget vs spent* a view joining budgets to the
month's expenses (§6.2). The widget filters, sorts, limits and formats through the registry's
`display` metadata (§6.3) — it holds no domain arithmetic and no domain words of its own: every
label is the registry's or the page author's. A widget whose source no longer exists draws a
*source missing* frame naming it, rather than disappearing.

**Who makes pages.** The user, from a widget menu — **+** on a page opens the catalog, a widget is
configured in a short form (source, then the type's options), and widgets are reordered with up and
down controls; drag-and-drop layout comes later. Or **Novia**: *"put the supplies running low on my
home page"* becomes a gated `propose_page_change`, shown as a preview of the page before it is
written. Either way the page row is versioned like a workflow.

**Seeded.** Home ships as a seed with `needs_you` and `conversations`; nothing domain-specific is
seeded (`CLAUDE.md`, system artifacts stay generic). Phase 0 draws Home from that seed, so the page
model is in place from the first build and Phase 1 only adds widget types.

### 4.3 Explaining the system

A new user meets words the brain uses for itself. Three devices, each from data rather than hand
copy.

| Device | What it does |
|---|---|
| **One vocabulary** | Six words, used the same everywhere — in the app, in Novia's replies, in errors. *Domain*: a kind of thing you keep track of. *Workflow*: a routine the brain runs for you. *Question*: the brain needs your answer before it carries on (a gate). *Run*: one time a workflow ran. *Memory*: what the brain has learned. *Novia*: the brain's builder — she makes and fixes workflows, pages and domains. The definitions are catalog keys (§13); a term's first use on a screen carries a dotted underline |
| **ⓘ on every widget and term** | Opens on hover **and** on tap — a phone has no hover. A term shows its definition. A widget shows where its data comes from, from its config and the registry: *"Items from Inventory below their reorder level · view `running_low` · added by Novia, 24 Oct · Ask to change this"* |
| **How your brain works** | A page under ⚙, generated from the household's registry, never written by hand: each domain with its tables, the workflows that act on it, what is scheduled, what it remembers, what is waiting. It describes *this* brain, so it stays true as the brain evolves |

### 4.4 Ask — one conversation, whoever answers

The user asks; the brain decides who answers. A request a workflow covers starts that workflow; the
rest goes to Novia. **Threads** and **Novia** are no longer menu items: a conversation is what was
a thread, and Novia is one of the voices in it.

| Behaviour | Design |
|---|---|
| **Drawer** | Opens over the page from the right (a full-screen sheet on a phone), so the page stays in view. Deep-linkable as `?ask=<conversationId>` on any route. A list of past conversations at its head; each is the command, then every message and question of its runs in order, answerable in place |
| **Routing** | `POST /commands` → `CLASSIFY_INTENT`, exactly as `/mind`. **Phase 1:** where routing finds no workflow — today it answers *"I could not complete that request"* — a web command hands off to Novia (`MINDS_EYE`) in the same conversation instead, and a conversation she is in continues with her. Slack's `/mind` and `/novia` are unchanged |
| **Who answered** | Each reply names its source — *Edit the budget* (a workflow) or *Novia* — with ⓘ |
| **Ask about this** | From any widget, record or question: opens the drawer with Novia and the item's identifiers (widget config, run id, record) in the opening message |
| **Phase 0** | The drawer with workflow routing only; a request nothing matches gets today's notice |

### 4.5 ⚙ — the machinery

| Route | Page | Phase |
|---|---|---|
| `/system/how-it-works` | How your brain works (§4.3) | 1 |
| `/system/data`, `/system/data/{domain}` | **All data** — every domain, from the registry, with its records in the §6 views; the place for anything not yet on a page | 1 |
| `/system/activity`, `/system/activity/{runId}` | Runs, and one run's steps | 1 |
| `/system/workflows` | Workflows by domain, each runnable | 1 |
| `/system/memory` | What the brain remembers, by domain | 1 |
| `/system/settings` | Language, timezone, household currency | 1 |

### 4.6 Routes

Client-side; every page has a deep link.

| Route | Page | Phase |
|---|---|---|
| (Cognito managed login) | Sign-in, then back to the page asked for | 0 |
| `/` | The first page — Home | 0 |
| `/p/{pageId}` | A household page | 1 |
| `/gates/{runId}` | **Question** — the workflow's name and the gate, full width; Back returns to the page it came from | 0 |
| `?ask=<conversationId>` | The conversation drawer, over any route | 0 |
| `/system/…` | The machinery (§4.5) | 1 |

The mock-up draws Phase 0's Home and question, the drawer, a Phase 1 Home and second page, the
widget menu, the ⓘ popovers and How your brain works; Phase 1 surfaces are labelled.

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

---

## 6. Domain views — records outside any workflow (Phase 1)

All data (§4.5) and the `table` widget (§4.2) read and write records through the REST resources (§3.2) — `WebApiFunction` →
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

A specialised need — a portfolio chart, a calendar — is a **new view type**, chosen by the registry.
Computed values (market value = quantity × price) come from a database view registered like a
table and shown read-only, never from arithmetic in the app.

### 6.3 Display metadata — in the registry

A `display` object, on the table (`PGC_Schema`) and on the entity (`PGC_EntitySchema`). Every key
is optional; absent keys fall back to the defaults above. It is an evolving artifact: Novia proposes
it with a domain's tables, the domain-confirming gate shows it, and it is changed like any other
registry fact.

| Key | Level | Meaning |
|---|---|---|
| `view` | Table, entity | `grid`, `document`, `list`, or a specialised view type |
| `label` | Domain, table, entity, workflow | What a person reads instead of the identifier — a string or a language map (§13) |
| `description` | Domain, workflow | One line under the label in menus — a string or a language map |
| `icon` | Domain, workflow | A name from the app's own icon set; an unknown name draws the default |
| `order`, `menu` | Domain, workflow | Position in All data, the workflow list and an `actions` widget's picker; `menu: false` keeps a workflow out of them |
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
| **Slack-started run, gate answered on the web** | The response is enqueued with the run's own callback (Slack). The next gate and the results post to the Slack thread as always, and through the inbox they also appear in Needs you and the conversation on the web. The Slack message's buttons stay live; a click there is refused by `gate_id` (§2.2) and `interactive.mjs` answers *"Already answered elsewhere."* ephemerally |
| **Web-started run** | No Slack message exists, so it can only be answered on the web |
| **Phase 1** | A `GATE_RESOLVED` callback updates the Slack message to show it was answered on the web, so the stale buttons disappear rather than refuse |

---

## 9. States

| State | What the user sees |
|---|---|
| **Loading** | Skeleton widgets on the page and rows in the drawer; a gate shows its frame and a spinner in the button row |
| **Empty** | Needs you: *Nothing is waiting for you.* Conversations: the Ask box is the call to action. A data widget with no rows: its own title and *Nothing here yet*. A new page: the widget menu, open |
| **Run working** | A *Working…* line at the foot of the conversation after a command or an answer, until the next message arrives |
| **Answer sent** | The gate collapses to a one-line record — *You chose Save · 3 changes* — and its inputs are disabled; the next gate or message follows below |
| **Gate moved (`409`)** | *This was answered elsewhere.* The gate reloads from `GET /gates/{runId}` |
| **Invalid fields (`422`)** | The offending cells outlined, each with its message; nothing is sent to the run |
| **Workflow error** | The summarised error in the conversation, with *Ask Novia about this* carrying the run id |
| **Source missing** | A widget whose `source` is gone draws a frame naming it and offers *Ask Novia about this*; the rest of the page draws normally |
| **Offline / API failure** | A banner, *Can't reach the home brain — retrying*; polling backs off; typed values are kept |
| **Signed out** | The token is refreshed silently; when that fails, the user returns to sign-in and then to the same page |

---

## 10. Phases

| | Phase 0 — prove the seam | Phase 1 — the console |
|---|---|---|
| **Infrastructure** | S3 + CloudFront, Cognito pool and one user, `WebApiFunction`, the web routes, `deploy-web.mjs` | WebSocket only if polling is felt |
| **PROC** | `PGC_UiMessage` and `enqueueCallback` writing it; `gate_id`; `PGC_Page` with the seeded Home; `GET /proc/gates`, `GET /proc/inbox`, `GET /proc/pages` | Navigate reads (§3.2), the edit policy and `PGC_RecordEdit`, the `arch-home-brain.md` §3.2 Slack leaks removed |
| **Contract** | `row`, `column`, `group` on the `human_gate` contract | — |
| **Pages** | Sign-in, Home from the seeded `PGC_Page` (`needs_you`, `conversations`), Question, the Ask drawer with workflow routing; every gate type of §5.2 | Household pages and the widget menu, the Phase 1 widget types of §4.2, Ask's hand-off to Novia, ⚙ (How your brain works, All data, Activity, Workflows, Memory, Settings), ⓘ on widgets and terms, *Ask about this*, Novia's `propose_page_change` |
| **Slack** | `gate_id` on buttons; the ephemeral "already answered" | `GATE_RESOLVED` message update |
| **Domain views** | — | Grid and document views, cell editors, `display` metadata (§6); SERV batch and entity writes with version checks (§6.4) |
| **First workflow** | `manage_budget` (357): month pick, then one grid grouped by budget type, after Novia's four corrections | — |

Phase 0 builds every gate type because Needs you shows every waiting gate, whichever provider
started its run.

---

## 11. Security

The threat model is `docs/arch-security.md`; these are the site's own controls.

| Control | Design |
|---|---|
| **No internal key in the browser** | The browser holds only Cognito tokens; `WebApiFunction` holds the internal key |
| **Identity** | The user is the token's `sub`, verified by the API Gateway authorizer. `WebApiFunction` passes it to PROC as the principal (`arch-security.md` S5); no request body field names a user |
| **Markdown** | `/proc` markdown is LLM-written and may carry injected content. It is rendered **without raw HTML** and **without remote images** — an image URL can carry data out the moment it renders. Links open in a new tab with `rel="noopener noreferrer"` |
| **Content Security Policy** | Sent by CloudFront: scripts and styles from the site's own origin only, `connect-src` the site's origin and the Cognito domain, `img-src` the site's origin and `data:`, `frame-ancestors 'none'` |
| **Object-level checks** | Every resource taking an id — a gate, a conversation, a page, later a record — is checked against the principal in PROC, never trusted from the URL |
| **Dependencies** | Lockfile committed; `npm audit` in `deploy-web.mjs` stops a deploy with a high-severity finding |
| **No CSRF surface** | Requests authenticate with a bearer header, not a cookie |

---

## 12. Open questions

1. **Token storage.** Tentative: access token in memory, refresh token in `localStorage`, with a
   strict Content Security Policy from CloudFront. The alternative is a cookie session held by
   `WebApiFunction`, which keeps every token out of script reach at the cost of validating the JWT
   in the function rather than in API Gateway.
2. **Inbox retention** (`arch-home-brain.md` §6.5) — how long `PGC_UiMessage` keeps a row.
3. **Custom domain** — the CloudFront default domain serves Phase 0; a household domain needs an
   ACM certificate in `us-east-1` and a DNS record.
4. **Gate-size validation** (`arch-home-brain.md` §6.3) — the L1 field-count check enforces Slack's
   ceiling; a workflow meant for the web grid can exceed it. Whether the check reads the run's
   provider or stays at the lowest ceiling is decided before `manage_budget` grows past it.

---

## 13. Languages

The analysis is `arch-home-brain.md` §7. Phase 0 ships English only; these rules keep a second
language a matter of adding catalogs and language maps, not rewriting the app.

| Rule | Detail |
|---|---|
| **Catalogs from day one** | No user-visible literal in a component. Every string is a catalog key; English is the only catalog in Phase 0. Plurals and parameters in ICU MessageFormat. App words in `src/ui/web/app/locales/<locale>.json`; system-message keys from the shared `src/ui/shared/messages/<locale>.json`. Files, not a database table — `arch-home-brain.md` §7.3 |
| **Locale and timezone on the principal** | `GET /me` returns them; every `POST /commands` and gate response sends `locale` on the callback, so a run started on the web carries its user's language into `local_state` |
| **Formatting through `Intl`** | Numbers, dates, currency and sorting (`Intl.NumberFormat`, `DateTimeFormat`, `Collator`) with the user's locale and timezone — never `toLocaleString()` without a locale, never a literal symbol. Number entry accepts the locale's decimal separator (the shared rule already accepts a comma) |
| **The `dialog` stays plain strings** | PROC resolves language maps before a gate is sent (`arch-home-brain.md` §7.2), so §5's components never see one |
| **System messages by key** | A notification or error carrying `messageKey` and `params` is rendered from the catalog; its `message` text is the fallback |
| **Fixed words** | Ask, the ⚙ entries (How your brain works, All data, Activity, Workflows, Memory, Settings), the six vocabulary terms and their definitions (§4.3) — app words, catalog keys like any other. Page titles are the household's, stored as language maps |
| **Data-driven menus** | All data, the workflow list and the `actions` picker come from `GET /domains` (§3.2) with `label` already in the user's language; the app draws them and never translates a name itself |
| **Registry labels** | `display.label` and column labels may be language maps. PROC picks the user's locale, then the household's, then the first entry, then a humanised identifier (`budgets_expenses` → *Budgets expenses*); the fallback is marked in the response (`labelFallback: true`) so missing translations can be listed |
| **Layout** | `lang` set on the document from the locale; CSS logical properties (`margin-inline`, `padding-inline-start`) so a right-to-left language is not ruled out; no text baked into images |
| **User content** | Shown as entered, never machine-translated without being asked |
