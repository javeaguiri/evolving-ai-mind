

🧠 evolving-mind-ai
Self-Evolving, Low-Cost Cognitive Automation System
evolving-mind-ai is an intelligent low-cost automation brain that creates, manages, and evolves its own process flows and data schemas. It harnesses LLM-powered reasoning to generate new workflows and database structures dynamically, while routine tasks run entirely through low-cost AWS Lambda + PostgreSQL operations.

⚙️ Design Principles
Principle	Description
Intelligent & Adaptive	Uses LLM only to create new task/process flows and SQL schemas when novelty is detected.
Low-Cost Operation	Everyday tasks run through AWS Lambda serverless functions + PostgreSQL free tier.
Autonomous Schema Evolution	The system evolves PGC (config schemas) and PGD (domain data tables) automatically.
Composability	Modular services—PROC, SERV, API—are stateless and functionally replaceable.
GitHub Readability	Fully visualized architecture, directory outline, and YAML/operator clarity.
Target Cost: ~$0.03–$0.05 per month
Stack: Slack → AWS Lambda → PostgreSQL → LLM (OpenAI / Anthropic-compatible layer)

🏗️ System Architecture
text
graph TD;
  Slack[Slack Bot UI] --> PROC[Rules Engine (PROC)];
  PROC --> SERV[Service Layer (AWS Lambda)];
  SERV --> API[API Gateway + PostgreSQL Service Endpoints];
  API --> PGC[(PostgreSQL Schema Config - PGC)];
  API --> PGD[(PostgreSQL Domain Tables - PGD)];
  PROC --> LLM[LLM Layer (Flow & Schema Synthesizer)];

  LLM --> PROC;
Flow Summary
Slack input triggers low-cost Lambda endpoint.

Rules Engine routes intents using pre-defined function routes or schema-driven logic.

Service layer executes SQL operations through PostgreSQL adapters (new Function()–based runners).

LLM layer steps in only when new workflows or entity types are needed.

🧰 Core Components
1. Slack Bot (UI Layer)
Natural interface for creating & executing flows.

Example Slash Commands

text
/create-domain project-management
/create-task-flow "weekly goal planning"
/list-domains
/run-flow project-management:weekly-goal-planning
Each interaction maps to a PROC orchestration, which runs in Lambda and calls into the PostgreSQL-backed service layer.

2. Rules Engine (PROC Layer)
Routes messages, creates temporary execution plans, and reuses prebuilt task flows.

javascript
const ROUTES = {
  "create-domain": llmGenerateSchema(),          // LLM creates new PGC entry + tables
  "create-task-flow": llmGenerateTaskFlow(),     // LLM defines procedural SQL flow
  "run-flow": executeProcessFlow(),              // Executes defined task logic
  "list-domains": pgcListDomains()               // Reads PGC and formats via prettyPrint()
};
Workflows execute via new Function() to enable dynamic orchestration.

All persistent state (schemas, flows, logs) lives in PostgreSQL.

AWS SQS supports async handoffs and decoupled event orchestration.

3. Service Layer (SERV)
Stateless Lambda endpoints that implement core CRUD and orchestration services.

Endpoint	Purpose
POST /api/schema	Create or update entries in PGC-Schema tables
POST /api/domain	Insert domain data into PGD tables
GET /api/process	Retrieve process definitions for execution
POST /api/process/run	Execute stored process flows
POST /api/pretty	Format and summarize process output (LLM optional)
GET /api/health	System health and status check
Example AWS Lambda Handler

javascript
export const handler = async (event) => {
  const { path, body } = event;
  if (path === "/api/process/run") {
    return runProcessFlow(body);
  }
  if (path === "/api/schema") {
    return updatePGCSchema(body);
  }
  return { statusCode: 404, body: "Not found" };
};
4. PostgreSQL Backbone
A unified data store for configuration + operational domains.

PGC (PostgreSQL Config Tables)

Table	Description
PGC_Schema	Defines entity configurations, relationships, indexes.
PGC_Process	Stores workflow metadata and SQL flow definitions.
PGD (PostgreSQL Domain Tables)

Table	Description
PGD_<Domain>	Dynamically created tables for user-specific domains.
PGD_Events	Logs runtime events and flow executions.
5. YAML Configuration (Declarative)
Declarative configs define schema evolution rules and CRUD metadata for code generation—not domain data.

text
# config/pgc-config.yaml
pgc:
  - name: SchemaDefinition
    fields:
      - { name: entity_name, type: text }
      - { name: field_definitions, type: jsonb }

  - name: ProcessDefinition
    fields:
      - { name: process_name, type: text }
      - { name: sql_script, type: text }
      - { name: version, type: integer }
💡 Example LLM Flow Generation
When a user sends /create-domain health-tracking, the LLM automatically:

Proposes a schema for PGD_health_tracking

Generates DDL (CREATE TABLE …) persisted to PGC_Schema

Registers metadata in PGC_Process

Responds via Slack with a summary:

text
🧬 Domain "health-tracking" created  
Tables: health_metrics, activities  
You can now run `/create-task-flow "daily summary"` to generate a workflow
💰 Cost Model
text
25 daily ops: PostgreSQL query calls via Lambda (0 tokens)
5 LLM ops/day: 22.5K tokens/week → 55K/month → ~$0.03
AWS Lambda (Free tier)
PostgreSQL (Free tier)
Slack API (Free tier)
🚀 Phase Plan
Phase 1 — AWS & PostgreSQL Foundation
Build Lambda + PostgreSQL integration

Deploy /api/schema and /api/process endpoints

Test new Function() orchestration model

Phase 2 — Core Logic & CRUD Services
Finalize PGC/PGD table models

Implement Lambda endpoints and Slack routing

Add unit/integration testing

Phase 3 — LLM Schema/Flow Generation
Enable Slash /create-domain + /create-task-flow

Automate SQL generation and persistence

Phase 4 — Polish & Expansion
Add GitHub Actions pipeline

Pretty output formatting with LLM fallback

Visualization metrics dashboard

# 📁 Directory Structure

```
evolving-mind-ai/
├── api/
│   ├── process/                          # PROC-*: Core business logic layer
│   │   ├── interpret.js                  # PROC-Interpret: AI instruction interpretation
│   │   ├── run-workflow.js               # PROC-Workflow: Workflow orchestration  
│   │   ├── sync-brain.js                 # PROC-Sync: Brain state synchronization
│   │   ├── ping.js                       # PROC-Ping: Vercel→LLM health check
│   │   └── index.js                      # PROC-Router: /api/process/ endpoints
│   │
│   ├── service/                          # SERV-*: SPD/SPC database operations
│   │   ├── table.js                      # SERV-Table: CRUD operations
│   │   ├── entity.js                     # SERV-Entity: Multi-table operations
│   │   ├── schema.js                     # SERV-Schema: DDL operations
│   │   ├── query.js                      # SERV-Query: Complex SELECTs/JOINs
│   │   └── index.js                      # SERV-Router: /api/service/ endpoints
│   │
│   ├── slackbot/                         # SLACK-*: Vercel Slack bot (Bolt.js)
│   │   ├── ping.js                       # SLACK-Ping: /ping [1-10] threaded test
│   │   ├── second-brain.js               # SLACK-SecondBrain: Dynamic router/help
│   │   ├── commands.js                   # SLACK-Commands: Dynamic registry
│   │   └── index.js                      # SLACK-Router: Bolt ExpressReceiver
│   │
│   └── shared/                           # SHARED-*: Cross-cutting concerns
│       ├── graph-client.js               # SHARED-Graph: GraphQL client
│       ├── auth.js                       # SHARED-Auth: JWT/API key validation
│       ├── config.js                     # SHARED-Config: Env vars/flags
│       └── logger.js                     # SHARED-Logger: Structured JSON logs
│
├── vercel.json                           # VERCEL-Routes: /slackbot/* routing
├── package.json                          # NPM-Deps: @slack/bolt + runtime deps
└── README.md                             # SETUP-Guide: Deployment instructions
```
✅ Success Metrics
 <100K tokens/month

 95% operations handled via Lambda (no LLM)

 PostgreSQL schema evolution functional

 Slash commands /create-domain and /create-task-flow operational

 GitHub Actions build + status shield visible

Status: Phase 1 in progress — building AWS-PostgreSQL-Lambda integration.
Repo Presentation: Designed for GitHub with full Markdown styling, Mermaid diagrams, and YAML clarity for developers.