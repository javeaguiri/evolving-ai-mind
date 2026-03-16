We are building evolving-mind-ai v3.2 — a self-evolving, low-cost cognitive
automation system built on AWS Lambda, SQS, PostgreSQL (RDS), and a Slack bot.

CRITICAL: Read docs/architecture.md before doing anything else in every
conversation. It contains every architectural decision, their rationale, and
things we explicitly decided NOT to do. Never suggest alternatives to decisions
marked as final in that document.

GENERAL RULES:
- Never suggest changing: ESM format, esbuild bundler, shared LambdaExecutionRole,
  Lambda-outside-VPC architecture, SSM String parameters. These are final.
- Always wait for all relevant files to be shared before writing any code.
- Always propose changes and wait for confirmation before writing code on
  complex tasks.
- Iterate with minimal diffs — change only what is necessary.
- Never rewrite a file completely unless explicitly asked.
- Always check existing patterns in the codebase before introducing new ones.
- Before placing any new file, consult the directory structure and partitioning
  rules in architecture.md Section 3.

COPYRIGHT:
Every .mjs file must have this exact header on lines 1-3:
// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.

ENVIRONMENT:
- Windows development — use cmd.exe for curl, not PowerShell
- AWS stack: evomind-infrastructure, region us-east-2
- API base: https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod
- Log tailing: aws logs tail /aws/lambda/<name> --follow --region us-east-2
- Log history: aws logs tail /aws/lambda/<name> --since 30m --region us-east-2
- Deploy: sam build && sam deploy
- Local scripts: set VAR=value && node script.mjs  (--env-file has CRLF issues on Windows)
- .samignore excludes postman/ — removed from repo due to em-dash filename issue

DATABASE:
- PGC database — system config tables (PGC_* tables)
- PGD database — user domain tables (PGD_* tables)
- Table names are mixed case and MUST be quoted in SQL: "PGC_Schema"
- ssl: { rejectUnauthorized: false } on all pg connections — never change this
- PGC_WorkflowRun and PGC_Workflow bootstrap templates are STALE — new safety
  columns in architecture.md Section 4.4 not yet reflected in JSON templates
- PGC_DATABASE_URL: set PGC_DATABASE_URL=postgresql://... && node script.mjs

THREE-TIER ARCHITECTURE (architecture.md Sections 2 and 3):
- Experience tier: SlackbotFunction, SlackCallbackListenerFunction
- Process tier: ProcFunction
  - Dual-trigger: API Gateway (HTTP) + SQS WorkflowQueue (async)
  - handler.mjs detects event type and routes to endpoint modules
  - Endpoint modules are transport-agnostic — NO AWS SDK, NO Slack SDK
  - req.source = 'http' | 'sqs' — only difference is response path:
      http → return ok(result) directly to API Gateway
      sqs  → enqueueCallback(req.callback, result) via sqs-callback.mjs
  - sqs-callback.mjs is the ONLY place @aws-sdk/client-sqs lives in ProcFunction
  - All external calls via fetch() — SERV_API_URL, LLM_AGENT_URL
- Service tier: ServFunction — DB CRUD/DDL only, no business logic

CURRENT STATE (last tag: v3.2-create-domain-live-llm):
- Four Lambda functions deployed (ProcStepOrchestrator still exists — to be removed)
- All 5 pings passing
- SERV-Schema CRUD complete
- SERV-Table getRows + insertRow complete (PGC_TableMap gated)
- 10 PGC system tables bootstrapped and seeded
- /create-domain working end-to-end with live LLM (Perplexity Agent API,
  anthropic/claude-sonnet-4-5, prompt version 2)
- PGD domains created: recipes, stock_portfolio
- PGC_WorkflowRun + PGC_Workflow bootstrap templates stale (new safety columns)

LAMBDA FUNCTIONS:
- evolving-mind-ai-slackbot              (SlackbotFunction)
- evolving-mind-ai-proc                  (ProcFunction) — HTTP only today, SQS to be added
- evolving-mind-ai-serv                  (ServFunction)
- evolving-mind-ai-slack-callback-listener (SlackCallbackListenerFunction)
- SYSLMBOrchestrator                     (ProcStepOrchestrator) — TO BE DELETED

KEY FILES (current locations):
- src/ui/slackbot/handler.mjs            Slackbot entry point
- src/ui/slackbot/create-domain.mjs      Slack /create-domain command
- src/ui/slackbot/callback.mjs           SQS CallbackResults consumer
- src/proc/handler.mjs                   ProcFunction entry (HTTP only today)
- src/proc/step-orchestrator.mjs         TO BE DELETED — logic moves to proc endpoints
- src/serv/handler.mjs                   ServFunction entry
- src/serv/schema.mjs                    SERV-Schema DDL
- src/serv/table.mjs                     SERV-Table DML
- src/serv/init-brain.mjs               Bootstrap
- src/shared/ping-utils.mjs              TO BE RENAMED lambda-utils.mjs

NEXT TASK — Phase 1: Refactoring (must complete before any new features)

Goal: align codebase with three-tier architecture. Eliminate ProcStepOrchestrator.
Make ProcFunction handle both HTTP and SQS. Make all proc endpoints transport-agnostic.

Steps in order:
1. Update PGC_Workflow + PGC_WorkflowRun JSON templates with new safety columns
   (architecture.md Section 4.4) and drop/recreate PGC tables
2. Add SERV_API_URL, LLM_AGENT_URL, LLM_CHAT_URL to SSM + template.yaml
3. Create src/shared/sqs-callback.mjs — exports enqueueCallback()
   ONLY place @aws-sdk/client-sqs lives in ProcFunction
4. Create src/shared/lambda-utils.mjs — copy of ping-utils.mjs (rename)
5. Add processSqsBatch() to src/proc/handler.mjs
   — no AWS SDK, plain event.Records iteration
   — builds normalised req from SQS message via buildReqFromSqs()
   — dispatches to same endpoint modules as HTTP path
6. Add SQS WorkflowQueue trigger to ProcFunction in template.yaml
7. Remove ProcStepOrchestrator from template.yaml
8. Move handleCreateDomain + callLlm into src/proc/create-domain.mjs
   — transport-agnostic, no AWS SDK
   — req.source === 'sqs' → enqueueCallback(), req.source === 'http' → return ok()
9. Replace invokeServ Lambda invoke with fetch(process.env.SERV_API_URL + path)
10. Delete src/proc/step-orchestrator.mjs
11. Update all imports from ping-utils.mjs → lambda-utils.mjs (~10 files)
12. Rename workflowId → traceId in all SQS payloads and UI messages
13. Move PGC_Prompt, PGC_Workflow, PGC_IntentMap seeds into init-brain.mjs
14. Move FK + constraint normalisation into schema.mjs createTable
15. Add response_format json_schema back to callLlm Agent API call

Please confirm you have read docs/architecture.md and all uploaded files.
Summarise: what has been built, what is working, and what the next task is.
Do not write any code until I confirm your summary is correct.