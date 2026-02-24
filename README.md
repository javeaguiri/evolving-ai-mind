\# evolving-ai-mind



A public \*\*second brain\*\* where I explore how AI, life, and deliberate practice shape a better version of myself.  

This repo tracks ideas, experiments, and tooling that help me think clearer, decide better, and move forward with intention.



---



\## Purpose



\- Capture insights, notes, and experiments in one place.

\- Use AI to augment thinking, planning, and reflection.

\- Track progress over time across life, work, and learning.

\- Keep everything open for transparency and future reference (not for collaboration).



---



\## High-level Structure



# 📁 Directory Structure

evolving-mind-ai/
├── api/
│ ├── process/ # PROC-: Core business logic layer
│ │ ├── interpret.js # PROC-Interpret: AI instruction interpretation → routes natural language to workflows
│ │ ├── run-workflow.js # PROC-Workflow: Executes workflow orchestration → coordinates multi-step brain operations
│ │ ├── sync-brain.js # PROC-Sync: Syncs brain state across systems → ensures consistency across SPD/SPC tables
│ │ ├── ping.js # PROC-Ping: Tests Vercel→api/process/ping→LLM connections → returns health status JSON
│ │ └── index.js # PROC-Router: Routes all /api/process/ endpoints → single Express handler for all process ops
│ │
│ ├── service/ # SERV-: Database operations layer (SPD/SPC tables)
│ │ ├── table.js # SERV-Table: Executes data CRUD on SPD and SPC tables → create/read/update/delete operations
│ │ ├── entity.js # SERV-Entity: Executes multi-table entity operations → complex joins across SPD/SPC for entities
│ │ ├── schema.js # SERV-Schema: Executes structural changes → create table, add column, alter schema
│ │ ├── query.js # SERV-Query: Executes brain queries → complex SELECTs with JOINs across brain tables
│ │ └── index.js # SERV-Router: Routes all /api/service/ endpoints → single Express handler for all service ops
│ │
│ ├── slackbot/ # SLACK-: Vercel serverless Slack bot (Bolt.js)
│ │ ├── ping.js # SLACK-Ping: /ping [1-10] → tests Vercel→LLM with configurable pings in Slack thread
│ │ ├── second-brain.js # SLACK-SecondBrain: /second-brain → dynamic router + help menu for all second-brain features
│ │ ├── commands.js # SLACK-Commands: Dynamic registry → auto-generates help text from feature metadata
│ │ └── index.js # SLACK-Router: Bolt ExpressReceiver → routes /slackbot/ to all Slack handlers for Vercel
│ │
│ └── shared/ # SHARED-: Cross-cutting concerns (auth, logging, config)
│ ├── graph-client.js # SHARED-Graph: GraphQL client → standardized queries/mutations to brain backend
│ ├── auth.js # SHARED-Auth: Authentication middleware → JWT validation, API key checks
│ ├── config.js # SHARED-Config: Centralized configuration → env vars, feature flags, endpoints
│ └── logger.js # SHARED-Logger: Structured logging → JSON logs with request tracing
│
├── vercel.json # VERCEL-Routes: Configures /slackbot/* → api/slackbot/index.js + /api/* passthrough
├── package.json # NPM-Deps: @slack/bolt, axios, express → all runtime dependencies
└── README.md # SETUP-Guide: Deployment + Slack app configuration instructions


