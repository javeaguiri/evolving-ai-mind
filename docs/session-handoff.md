# evolving-mind-ai — Session Handoff
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->
<!-- Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). -->
<!-- See LICENSE file in the project root for full license terms. -->

---

## How To Use This Document

Paste the prompt below as your first message in the new chat thread,
then attach or paste every file listed in the File Manifest.
Do not start asking questions or requesting code until Claude confirms
it has read all files and the architecture document.

---

## Prompt — Paste This First

```
We are continuing development of evolving-mind-ai v3.2 — a self-evolving
cognitive automation system built on AWS Lambda, SQS, PostgreSQL (RDS),
and a Slack bot.

Before doing anything else, please read docs/architecture.md carefully.
It contains every architectural decision made so far, their rationale,
and the list of things we explicitly decided NOT to do. Do not suggest
alternatives to any decision marked as final in that document.

After reading architecture.md, read all source files listed below.
Then confirm you have read everything and summarise:
  1. What has been built and is working
  2. What the next task is
  3. Any questions you have before starting

Do not write any code until I confirm your summary is correct.

Key facts:
- Copyright header on every .mjs file:
    // Copyright (c) 2026 Javea Guiri. All rights reserved.
    // Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
    // See LICENSE file in the project root for full license terms.
- Windows dev environment — PowerShell backtick ` for line continuation
- Git Bash available for Unix commands
- Stack name: evomind-infrastructure, region us-east-2
- API base: https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod
- Log tailing: aws logs tail /aws/lambda/<function-name> --follow
```

---

## File Manifest — Attach All Of These

### Documentation (read first)
```
docs/architecture.md               ← START HERE — all decisions and rationale
docs/openapi.yaml                  ← API spec
```

### Infrastructure
```
template.yaml                      ← SAM template — all Lambda + SQS + RDS resources
```

### Shared
```
src/shared/ping-utils.mjs          ← parseEvent, respond, ok, err helpers
```

### UI / Slackbot layer
```
src/ui/slackbot/handler.mjs        ← route dispatcher
src/ui/slackbot/ping.mjs           ← ping-api handler
src/ui/slackbot/ping-sqs.mjs       ← ping-sqs handler (ACK via chat.postMessage)
src/ui/slackbot/ping-llm.mjs       ← ping-llm handler
src/ui/slackbot/ping-e2e.mjs       ← ping-e2e handler
src/ui/slackbot/callback.mjs       ← SQS SlackResults consumer
```

### PROC layer
```
src/proc/handler.mjs               ← route dispatcher
src/proc/ping-llm.mjs              ← Perplexity fortune cookie
src/proc/step-orchestrator.mjs     ← SQS WorkflowQueue consumer
```

### SERV layer
```
src/serv/handler.mjs               ← route dispatcher + bootstrap call
src/serv/init-brain.mjs            ← PGC bootstrap, buildCreateTableSQL, seed helpers
src/serv/schema.mjs                ← SERV-Schema CRUD endpoints
src/serv/ping-db.mjs               ← PostgreSQL health check
```

### PGC bootstrap templates (imported as ES module static imports)
```
src/serv/templates/pgc/PGC_Schema.json
src/serv/templates/pgc/PGC_TableMap.json
src/serv/templates/pgc/PGC_EntitySchema.json
src/serv/templates/pgc/PGC_DomainHelp.json
src/serv/templates/pgc/seeds/seed_PGC_Schema.json
src/serv/templates/pgc/seeds/seed_PGC_TableMap.json
```

### PGD domain mockups (runtime data shape — not code files)
```
src/serv/templates/pgd/domains/recipes/PGD_Recipes.json
src/serv/templates/pgd/domains/recipes/PGD_Ingredients.json
src/serv/templates/pgd/domains/recipes/PGD_RecipeSteps.json
src/serv/templates/pgd/domains/recipes/PGC_EntitySchema_Recipe.json
src/serv/templates/pgd/domains/recipes/PGC_TableMap_Recipes.json
```

---

## Current State Summary — For Your Reference

### What is working (verified with curl + CloudWatch logs)

| Test | Status |
|---|---|
| `/ping-api` — Slack → SlackbotFunction | ✅ |
| `/ping-llm` — Slack → ProcFunction → Perplexity | ✅ |
| `/ping-sqs` — Slack → SQS → Orchestrator → SQS → Slack thread | ✅ |
| `ping-db` — curl → ServFunction → RDS PGC + PGD | ✅ |
| `/ping-e2e` — Slack → SQS → Orchestrator → ServFunction → RDS → Slack thread | ✅ |
| `init-brain bootstrap` — 4 PGC tables created + seeded on cold start | ✅ |
| `SERV-Schema createTable` | ✅ |
| `SERV-Schema listTables` | ✅ |
| `SERV-Schema getTable` | ✅ |
| `SERV-Schema updateTable` | ✅ |
| `SERV-Schema deleteTable` | ✅ |

### Git tags
```
v3.2-scaffolding-complete   all 5 pings passing
v3.2-ping-complete          ping-sqs threading + ping-e2e
v3.2-serv-schema-complete   SERV-Schema CRUD + init-brain bootstrap
```

### Next task
Implement PROC/Schema — `/create-domain` Slack command that:
1. ACKs via `chat.postMessage` (same pattern as ping-sqs/ping-e2e)
2. Enqueues `CREATE_DOMAIN` to SQS WorkflowQueue
3. ProcStepOrchestrator routes `CREATE_DOMAIN`
4. Calls LLM to generate domain JSON (tables, entity schema, domain help)
5. Calls ServFunction directly (Lambda invoke) to execute createTable for each table
6. Posts result to Slack thread via SQS SlackResults

But before coding, two tech debt items should be resolved first:
- Callback abstraction (remove Slack coupling from SERV request bodies)
- PGC workflow table JSON templates (PGC_Workflow, PGC_WorkflowRun,
  PGC_WorkflowRunStep, PGC_Prompt, PGC_IntentMap, PGC_WorkflowRunLock)

### Files that will need to change for next task
```
src/ui/slackbot/handler.mjs          add create-domain route
src/ui/slackbot/create-domain.mjs    NEW — ACK + enqueue CREATE_DOMAIN
src/proc/step-orchestrator.mjs       add CREATE_DOMAIN case
src/proc/create-domain.mjs           NEW — LLM call + SERV-Schema invokes
src/ui/slackbot/callback.mjs         add CREATE_DOMAIN_RESULT case
template.yaml                        SERV_FUNCTION_NAME already on Orchestrator
                                     check SLACK_BOT_TOKEN on Orchestrator for LLM
src/serv/init-brain.mjs              add 6 new PGC workflow tables to bootstrap
src/serv/templates/pgc/              6 new JSON template files
```
