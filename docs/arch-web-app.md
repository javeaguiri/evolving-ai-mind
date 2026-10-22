# evolving-mind-ai — Web App Design
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

Version: 0.1
Status: **DRAFT for approval — Sprint 14 AC0.** The four platform choices in §1 are **tentative**
(Javear, 2026-10-22: "go tentatively with the suggestions"). No Phase 0 code starts before this
document is approved.
Last updated: 2026-10-22

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
| **Framework** | **React**, written as `.jsx` and bundled by **esbuild** — the bundler the Lambdas already use. Markdown from `/proc` is rendered by `react-markdown` with `remark-gfm` (tables). No component library; the editable grid is built from native inputs |
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
| `POST /commands` | `{ text, threadId }` | `202 { threadId }` | `CLASSIFY_INTENT` with `callback: { provider: 'web', channel: <sub>, threadId }` |
| `GET /me` | — | `200 { name, email }` | The token's claims |

`WORKFLOW_ERROR` reaches the browser summarised by `WebApiFunction`, as `callback.mjs` summarises it
for Slack; the summary function is shared, not copied.

### 3.2 Phase 1

Adds `arch-home-brain.md` §4.7's remaining resources — `GET /domains`, `/domains/{domain}/schema`,
`/domains/{domain}/records[/{id}]`, `GET /runs[/{runId}]`, the Novia session resources,
`POST /runs`, and the edit resources under the §4.8 edit policy.

---

## 4. Pages and navigation

Routes are client-side; every page has a deep link. The layout is one codebase: a three-region
console from tablet width up, a single column with a bottom tab bar on a phone.

| Route | Page | Phase |
|---|---|---|
| (Cognito managed login) | Sign-in, then back to the page asked for | 0 |
| `/` | **Home** — command bar; *Needs you* (waiting gates, a count on the tab); recent threads | 0 |
| `/gates/{runId}` | **Gate** — the workflow name and the gate, full width; Back returns to Home | 0 |
| `/threads/{threadId}` | **Thread** — one command's conversation: the command, then every message and gate of its runs in order, answerable in place | 0 |
| `/domains`, `/domains/{domain}` | Navigator; domain page with records and its workflows as actions | 1 |
| `/runs`, `/runs/{runId}` | Activity; a run's steps | 1 |
| `/novia`, `/novia/{sessionId}` | Novia sessions; a conversation, her gated actions as gates | 1 |

```
Desktop                                              Phone
┌───────────────────────────────────────────────┐   ┌──────────────────────┐
│ ◉ Home brain   [ Ask the home brain…      ] ◯ │   │ [ Ask the home brain…]│
├──────────┬────────────────────────────────────┤   ├──────────────────────┤
│ Home   2 │ Needs you (2)                      │   │ Needs you (2)        │
│ Threads  │ ┌────────────────────────────────┐ │   │ ┌──────────────────┐ │
│ ─ Ph. 1 ─│ │ manage_budget · Edit amounts   │ │   │ │ manage_budget …  │ │
│ Domains  │ │ waiting 3 min   [ Open ]       │ │   │ │ [ Open ]         │ │
│ Activity │ └────────────────────────────────┘ │   │ └──────────────────┘ │
│ Novia    │ Recent threads                     │   │ Recent threads       │
│          │  "manage budget"  · completed      │   ├──────────────────────┤
│          │                                    │   │ Home  Threads  More  │
└──────────┴────────────────────────────────────┘   └──────────────────────┘
```

The mock-up draws every Phase 0 page and the Phase 1 regions as greyed placeholders.

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

## 6. A gate answered on the other provider

| Case | Behaviour |
|---|---|
| **Slack-started run, gate answered on the web** | The response is enqueued with the run's own callback (Slack). The next gate and the results post to the Slack thread as always, and through the inbox they also appear in Needs you and the thread on the web. The Slack message's buttons stay live; a click there is refused by `gate_id` (§2.2) and `interactive.mjs` answers *"Already answered elsewhere."* ephemerally |
| **Web-started run** | No Slack message exists, so it can only be answered on the web |
| **Phase 1** | A `GATE_RESOLVED` callback updates the Slack message to show it was answered on the web, so the stale buttons disappear rather than refuse |

---

## 7. States

| State | What the user sees |
|---|---|
| **Loading** | Skeleton rows in Needs you and threads; a gate shows its frame and a spinner in the button row |
| **Empty** | Needs you: *Nothing is waiting for you.* Threads: the command bar is the call to action |
| **Run working** | A *Working…* line at the foot of the thread after a command or an answer, until the next message arrives |
| **Answer sent** | The gate collapses to a one-line record — *You chose Save · 3 changes* — and its inputs are disabled; the next gate or message follows below |
| **Gate moved (`409`)** | *This was answered elsewhere.* The gate reloads from `GET /gates/{runId}` |
| **Invalid fields (`422`)** | The offending cells outlined, each with its message; nothing is sent to the run |
| **Workflow error** | The summarised error in the thread, with the run id for Novia |
| **Offline / API failure** | A banner, *Can't reach the home brain — retrying*; polling backs off; typed values are kept |
| **Signed out** | The token is refreshed silently; when that fails, the user returns to sign-in and then to the same page |

---

## 8. Phases

| | Phase 0 — prove the seam | Phase 1 — the console |
|---|---|---|
| **Infrastructure** | S3 + CloudFront, Cognito pool and one user, `WebApiFunction`, the web routes, `deploy-web.mjs` | WebSocket only if polling is felt |
| **PROC** | `PGC_UiMessage` and `enqueueCallback` writing it; `gate_id`; `GET /proc/gates`, `GET /proc/inbox` | Navigate reads (§3.2), the edit policy and `PGC_RecordEdit`, the `arch-home-brain.md` §3.2 Slack leaks removed |
| **Contract** | `row`, `column`, `group` on the `human_gate` contract | — |
| **Pages** | Sign-in, Home, Gate, Thread; every gate type of §5.2 | Navigator and domain pages, Activity, Novia panel, *Ask Novia about this* |
| **Slack** | `gate_id` on buttons; the ephemeral "already answered" | `GATE_RESOLVED` message update |
| **First workflow** | `manage_budget` (357): month pick, then one grid grouped by budget type, after Novia's four corrections | — |

Phase 0 builds every gate type because Needs you shows every waiting gate, whichever provider
started its run.

---

## 9. Security

The threat model is `docs/arch-security.md`; these are the site's own controls.

| Control | Design |
|---|---|
| **No internal key in the browser** | The browser holds only Cognito tokens; `WebApiFunction` holds the internal key |
| **Identity** | The user is the token's `sub`, verified by the API Gateway authorizer. `WebApiFunction` passes it to PROC as the principal (`arch-security.md` S5); no request body field names a user |
| **Markdown** | `/proc` markdown is LLM-written and may carry injected content. It is rendered **without raw HTML** and **without remote images** — an image URL can carry data out the moment it renders. Links open in a new tab with `rel="noopener noreferrer"` |
| **Content Security Policy** | Sent by CloudFront: scripts and styles from the site's own origin only, `connect-src` the site's origin and the Cognito domain, `img-src` the site's origin and `data:`, `frame-ancestors 'none'` |
| **Object-level checks** | Every resource taking an id — a gate, a thread, later a record — is checked against the principal in PROC, never trusted from the URL |
| **Dependencies** | Lockfile committed; `npm audit` in `deploy-web.mjs` stops a deploy with a high-severity finding |
| **No CSRF surface** | Requests authenticate with a bearer header, not a cookie |

---

## 10. Open questions

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
