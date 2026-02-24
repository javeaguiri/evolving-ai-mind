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
