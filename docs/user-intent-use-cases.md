# evolving-mind-ai — Intent Classification Use Case Matrix
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

Version: 1.0  
Status: Draft — Session 17  
Scope: All `/m` command variations handled by `classify-intent.mjs`

---

## Routing Decision Tree

```
Input contains PGC_* or PGD_* table name prefix?
  YES → Direct table path (Groups 3–4)
        Verb present?
          NO  → crud_ambiguous error
          YES → verb + required fields/id present?
                  YES → serv/table/* directly
                  NO  → crud_ambiguous error
  NO  → Workflow path (Groups 1–2)
        Pass 1: PGC_IntentMap regex match → workflow or heavy_lift
        Pass 2: domain alias → keyword scan → workflow
        Tier 2: sonar LLM → workflow or heavy_lift
        Tier 3: heavy_lift routing (no LLM)
```

**Key rule:** `id=N` and `field=value` pairs in domain input (no PGC_/PGD_ prefix) do NOT
route to serv/table directly. They route to the domain workflow. The workflow steps own
entity retrieval, confirmation gates, and child data assembly.

---

## Column Definitions

| Column | Meaning |
|---|---|
| **ID** | Unique use case identifier |
| **User Input** | Exact `/m` pattern. `<…>` = variable content |
| **Pass** | Which classification pass resolves it |
| **Confidence** | Value in classification result `confidence` field |
| **`action_type`** | Value in classification result |
| **`workflow_name`** | Set when `action_type === 'workflow'` |
| **`search_term`** | Extracted search string, or null |
| **Downstream** | What the SQS path calls, or what HTTP caller should call next |
| **Slack response** | What the user sees |

---

## Group 1 — Domain CRUD Operations (workflow path)

All four CRUD verbs per domain route to registered workflows via the Step Processor.
`input.search` is populated for retrieval workflows when a search term is present.
`id=N` and `field=value` pairs are passed inside `input.userInput` for the workflow
steps to extract — the classifier does not parse them.

| ID | User Input | Pass | Confidence | `action_type` | `workflow_name` | `search_term` | Downstream | Slack response |
|---|---|---|---|---|---|---|---|---|
| 1.1 | `/m add recipe <natural language content>` | Pass 1 | `exact` | `workflow` | `add_recipes` | null | `POST /proc/run-workflow` | LLM parses input → `review_object` gate → structured recipe with ingredients and tags |
| 1.2 | `/m list recipes` | Pass 1 | `exact` | `workflow` | `list_recipes` | null | `POST /proc/run-workflow` | Formatted list of recipe names with ids |
| 1.3 | `/m get recipes sweet potato chili` | Pass 1 | `exact` | `workflow` | `get_recipes` | `"sweet potato chili"` | `POST /proc/run-workflow` | Full recipe record with ingredients and tags |
| 1.4 | `/m get recipes id=1` | Pass 1 | `exact` | `workflow` | `get_recipes` | null | `POST /proc/run-workflow` | Full recipe record with ingredients and tags (workflow step filters by id) |
| 1.5 | `/m update recipes id=42 difficulty=hard` | Pass 1 | `exact` | `workflow` | `update_recipes` | null | `POST /proc/run-workflow` | Confirmation gate → "Updated recipes record (id: 42)" |
| 1.6 | `/m delete recipes id=42` | Pass 1 | `exact` | `workflow` | `delete_recipes` | null | `POST /proc/run-workflow` | Confirmation gate → "Deleted recipes record (id: 42)" |
| 1.7 | `/m show recipes pasta carbonara` | Pass 2 | `keyword_match` | `workflow` | `get_recipes` | `"pasta carbonara"` | `POST /proc/run-workflow` | Full recipe record with ingredients and tags |
| 1.8 | `/m list my recipes` | Pass 2 | `keyword_match` | `workflow` | `list_recipes` | null | `POST /proc/run-workflow` | Formatted list of recipe names with ids |
| 1.9 | `/m find my recipes name="sweet potato"` | Pass 2 | `keyword_match` | `workflow` | `get_recipes` | `"sweet potato"` | `POST /proc/run-workflow` | Full recipe record(s) matching name |
| 1.10 | `/m show all recipes` | Pass 2 | `keyword_match` | `workflow` | `list_recipes` | null | `POST /proc/run-workflow` | Formatted list of recipe names with ids |

**Notes:**
- 1.4: `id=1` is passed as `userInput` to the workflow. The `get_recipes` workflow step needs to detect `id=N` and build an id-based filter rather than a LIKE filter. This is a **workflow design issue** — the current `get_recipes` step only handles LIKE-by-name. Tracked separately.
- 1.7–1.10: Pass 2 resolves domain via `PGC_DomainHelp.aliases`, then matches `intent_keywords` in `PGC_Workflow`. Disambiguation: `get_recipes` wins over `list_recipes` when non-domain tokens follow the verb (search term present).
- These examples use `recipes`. The same patterns apply to all registered domains.

---

## Group 2 — System Workflow Commands (heavy_lift path)

These bypass domain logic entirely and route to dedicated SQS entry points or system workflows.

| ID | User Input | Pass | Confidence | `action_type` | `workflow_name` | `search_term` | Downstream | Slack response |
|---|---|---|---|---|---|---|---|---|
| 2.1 | `/m build me a domain` | Pass 1 | `exact` | `heavy_lift` | null | null | `SQS CREATE_DOMAIN` | Domain design LLM flow → confirmation gates → tables created |
| 2.2 | `/m create a workflow` | Pass 1 | `exact` | `heavy_lift` | null | null | `SQS CREATE_WORKFLOW` | Workflow design LLM flow → simulation → registered |
| 2.3 | `/m help` | Pass 1 | `exact` | `workflow` | `help` | null | `POST /proc/run-workflow` | Interactive domain list with buttons |
| 2.4 | `/m help recipes` | Pass 1 | `exact` | `workflow` | `help` | null | `POST /proc/run-workflow` | Recipe commands reference card |
| 2.5 | `/m I want to track my golf scores` | Tier 2 | `llm_classified` | `heavy_lift` | null | null | `SQS CREATE_DOMAIN` | Domain design LLM flow |
| 2.6 | `/m something completely novel` | Tier 2 | `llm_classified` | `heavy_lift` | null | null | `WORKFLOW_NOTIFY` | "I understood this but have no workflow for it yet. Use /create-workflow to build one." |

**Notes:**
- 2.1 and 2.2: `/create-domain` and `/create-workflow` are dedicated Slack slash commands that bypass `/m` entirely. These use cases cover users who reach the same intent via free text through `/m`.
- 2.5: Tier 2 sonar recognises domain-creation intent from natural language and returns `heavy_lift`. Tier 3 routes to `CREATE_DOMAIN`.

---

## Group 3 — Direct PGD Table Operations (serv/table path)

Triggered when input contains a `PGD_*` prefixed table name. No Step Processor. No WorkflowRun.
Returns a fully-formed `ad_hoc_step` in the classification result — the HTTP caller
executes it directly against `serv/table/*`.

| ID | User Input | Pass | Confidence | `action_type` | `ad_hoc_step.type` | Downstream | Slack response |
|---|---|---|---|---|---|---|---|
| 3.1 | `/m list PGD_Recipes` | Pass 1 (table prefix) | `crud` | `crud` | `serv_query` | `POST /serv/table/getRows` | Raw row list from PGD_Recipes |
| 3.2 | `/m list PGD_Recipes name=Pasta` | Pass 1 (table prefix) | `crud` | `crud` | `serv_query` | `POST /serv/table/getRows` (filters: name LIKE Pasta) | Filtered raw row list |
| 3.3 | `/m add PGD_Recipes name=Pasta servings=4` | Pass 1 (table prefix) | `crud` | `crud` | `serv_insert` | `POST /serv/table/insertRow` | "Added to PGD_Recipes (name=Pasta, servings=4) — id: N" |
| 3.4 | `/m update PGD_Recipes id=42 servings=6` | Pass 1 (table prefix) | `crud` | `crud` | `serv_update` | `POST /serv/table/updateRows` | "Updated 1 PGD_Recipes record." |
| 3.5 | `/m delete PGD_Recipes id=42` | Pass 1 (table prefix) | `crud` | `crud` | `serv_delete` | `POST /serv/table/deleteRows` | "Deleted 1 PGD_Recipes record." |
| 3.6 | `/m PGD_Recipes` *(no verb)* | Pass 1 (table prefix) | `crud_ambiguous` | `crud_ambiguous` | — | `enqueueCallback` error | "Please include a verb. Examples: /m list PGD_Recipes, /m add PGD_Recipes name=X" |
| 3.7 | `/m PGD_Recipes name=Pasta` *(no verb)* | Pass 1 (table prefix) | `crud_ambiguous` | `crud_ambiguous` | — | `enqueueCallback` error | Same as 3.6 — verb required; intent (list vs insert) is ambiguous |
| 3.8 | `/m add PGD_Recipes` *(no fields)* | Pass 1 (table prefix) | `crud_ambiguous` | `crud_ambiguous` | — | `enqueueCallback` error | "To insert a row into PGD_Recipes I need field values. Available columns: name, description…" |
| 3.9 | `/m update PGD_Recipes id=42` *(no fields)* | Pass 1 (table prefix) | `crud_ambiguous` | `crud_ambiguous` | — | `enqueueCallback` error | "To update a row I need at least one field=value pair." |
| 3.10 | `/m update PGD_Recipes difficulty=hard` *(no id)* | Pass 1 (table prefix) | `crud_ambiguous` | `crud_ambiguous` | — | `enqueueCallback` error | "To update a row in PGD_Recipes I need id=N." |
| 3.11 | `/m delete PGD_Recipes` *(no id)* | Pass 1 (table prefix) | `crud_ambiguous` | `crud_ambiguous` | — | `enqueueCallback` error | "To delete a row from PGD_Recipes I need id=N." |

---

## Group 4 — Direct PGC System Table Operations (serv/table path)

Same routing as Group 3 but targeting system config tables. `PGC_TableMap` enforces
`allow_delete: false` on all system tables — delete attempts are rejected by SERV, not the classifier.
`allow_update: true` on all system tables — updates are permitted with id + fields.

| ID | User Input | Pass | Confidence | `action_type` | `ad_hoc_step.type` | Downstream | Slack response |
|---|---|---|---|---|---|---|---|
| 4.1 | `/m list PGC_Workflow` | Pass 1 (table prefix) | `crud` | `crud` | `serv_query` | `POST /serv/table/getRows` | All workflow definition rows |
| 4.2 | `/m list PGC_Workflow name=get_recipes` | Pass 1 (table prefix) | `crud` | `crud` | `serv_query` | `POST /serv/table/getRows` (filters: name=get_recipes) | Matching workflow row |
| 4.3 | `/m update PGC_Workflow id=301 quality_score=9` | Pass 1 (table prefix) | `crud` | `crud` | `serv_update` | `POST /serv/table/updateRows` | "Updated 1 PGC_Workflow record." |
| 4.4 | `/m list PGC_Prompt intent_category=classify_intent_tier2` | Pass 1 (table prefix) | `crud` | `crud` | `serv_query` | `POST /serv/table/getRows` | Prompt row(s) for that category |
| 4.5 | `/m list PGC_DomainHelp` | Pass 1 (table prefix) | `crud` | `crud` | `serv_query` | `POST /serv/table/getRows` | All domain help rows |
| 4.6 | `/m list PGC_IntentMap` | Pass 1 (table prefix) | `crud` | `crud` | `serv_query` | `POST /serv/table/getRows` | All intent map rows |
| 4.7 | `/m delete PGC_Workflow id=301` | Pass 1 (table prefix) | `crud` | `crud` | `serv_delete` | `POST /serv/table/deleteRows` → SERV rejects (allow_delete: false) | SERV 403: "Delete not permitted on PGC_Workflow" |
| 4.8 | `/m PGC_Workflow id=301` *(no verb)* | Pass 1 (table prefix) | `crud_ambiguous` | `crud_ambiguous` | — | `enqueueCallback` error | "Please include a verb. Examples: /m list PGC_Workflow, /m update PGC_Workflow id=N field=value" |
| 4.9 | `/m update PGC_Workflow id=301` *(no fields)* | Pass 1 (table prefix) | `crud_ambiguous` | `crud_ambiguous` | — | `enqueueCallback` error | "To update a row I need at least one field=value pair." |

---

## Group 5 — Error and Unknown Paths

These reach `handoff()` and are dispatched as `WORKFLOW_NOTIFY` messages with instructive errors.
No workflow runs. No table operations.

| ID | User Input | Pass | Confidence | `action_type` | Notes | Slack response |
|---|---|---|---|---|---|---|
| 5.1 | `/m stocks` *(domain not registered)* | Pass 2 miss → Tier 2 | `llm_classified` | `heavy_lift` or `unknown` | Tier 2 cannot classify unknown domain | "I understood this but have no workflow for it yet." |
| 5.2 | `/m` *(empty)* | — | — | — | Caught in `handle()` before `classify()` | 400: "userInput is required" |

---

## Classification Result Shape — Canonical Reference

Every path through `classify()` returns this shape. `null` fields are always present.

```js
{
  intent_category: string,       // e.g. "get_recipes", "create_domain", "list_PGD_Recipes"
  action_type:     string,       // 'workflow' | 'heavy_lift' | 'crud' | 'crud_ambiguous'
  confidence:      string,       // 'exact' | 'keyword_match' | 'crud' | 'llm_classified' | 'heavy_lift'
  workflow_name:   string|null,  // set iff action_type === 'workflow'
  domain:          string|null,  // set for crud and crud_ambiguous paths only
  ad_hoc_step:     object|null,  // set iff action_type === 'crud' (Groups 3 and 4)
  search_term:     string|null,  // set by Pass 1/Pass 2 for retrieval workflows
}
```

**`ad_hoc_step` shape for direct table operations (Groups 3 and 4):**

```js
// serv_query
{ type: 'serv_query',  input: { tableName, filters: [...] } }

// serv_insert
{ type: 'serv_insert', input: { tableName, row: { field: value, ... } } }

// serv_update
{ type: 'serv_update', input: { tableName, filters: [{ column:'id', op:'eq', value:N }], updates: { field: value } } }

// serv_delete
{ type: 'serv_delete', input: { tableName, filters: [{ column:'id', op:'eq', value:N }] } }
```

---

## Implementation Priority

Per session 17 plan:

| Phase | Groups | Status |
|---|---|---|
| Phase A — Domain CRUD workflows (step 3 in plan) | Group 1 (1.1–1.6) | Implement first |
| Phase B — Direct table operations | Groups 3–4 | After Phase A verified |
| Phase C — System commands | Group 2 | After Phase B verified |
| Phase D — Error paths | Group 5 | Covered by Phase A–C error branches |

Unit tests for Phase A cover use cases 1.1–1.6 against HTTP `/proc/classify-intent`
with SERV stubbed, verifying the classification result shape before any SQS or
workflow execution is involved.

---

## Open Issues

| ID | Issue | Affects |
|---|---|---|
| OI-1 | `get_recipes` workflow step 1 only handles LIKE-by-name filter. Use case 1.4 (`get recipes id=1`) passes `userInput` with `id=1` to the workflow but the step cannot filter by id. Workflow design fix needed — add id detection to step 1 filter logic, or add a branch step. | Group 1, UC 1.4 |
| OI-2 | `list_recipes` LIKE filter on search term — when Pass 2 routes `"list recipes name=sweet potato"` to `list_recipes` workflow, the `search_term` extracted is `"name=sweet potato"`. The workflow step needs to parse structured filters from `input.search` or `input.userInput`. Alternatively `list_recipes` should not use `search_term` — it lists all, and `get_recipes` handles filtered retrieval. | Group 1, UC 1.8–1.10 |
| OI-3 | Pass 1 table-prefix detection is not yet implemented. Currently `PGD_Recipes` in input would fall to Pass 2 domain alias scan and not match (no alias for `PGD_Recipes`), then fall to Tier 2. Needs a pre-check before Pass 1 regex. | Groups 3–4 |
