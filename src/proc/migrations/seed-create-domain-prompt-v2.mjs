// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/migrations/seed-create-domain-prompt-v2.mjs
//
// Updates the create_domain prompt to version 2:
//   - Uses {{userInput}} instead of {{domainName}}
//   - LLM infers a clean snake_case domain name from user description
//   - Explicit FK shape example to prevent string format errors
//   - Constraint type must be lowercase
//
// Usage:
//   set PGC_DATABASE_URL=postgresql://... && node src/proc/migrations/seed-create-domain-prompt-v2.mjs
//
// Safe to run multiple times — ON CONFLICT DO NOTHING on (intent_category, version).

import pg from 'pg';

const { Client } = pg;

const PROMPT_TEXT = `You are a PostgreSQL schema designer for a system called evolving-mind-ai.

The user wants to create a new data domain. Their description is: "{{userInput}}"

From this description, infer a short, lowercase, snake_case domain name (e.g. "stock_portfolio", "recipes", "fitness").
Use that inferred name as the "domain" field in your response.

Return ONLY a valid JSON object — no markdown, no explanation, no backticks.
The JSON must match this exact shape:

{
  "domain": "<inferred short snake_case domain name>",
  "tables": [
    {
      "tableName": "<PGD_TableName>",
      "target": "pgd",
      "description": "<what this table stores>",
      "columns": [
        { "name": "id",         "type": "serial",      "primaryKey": true },
        { "name": "created_at", "type": "timestamptz", "nullable": false, "default": "now()" },
        { "name": "updated_at", "type": "timestamptz", "nullable": false, "default": "now()" }
      ],
      "foreignKeys": [
        {
          "name": "fk_<child_table>_<parent_table>",
          "column": "<foreign_key_column>",
          "references": { "table": "<PGD_ParentTable>", "column": "id" },
          "onDelete": "CASCADE"
        }
      ],
      "constraints": [
        { "type": "unique", "name": "uq_<table>_<columns>", "columns": ["<column>"] }
      ],
      "triggers": [
        { "name": "trg_<tablename_lower>_updated_at", "timing": "BEFORE UPDATE", "function": "set_updated_at()" }
      ]
    }
  ],
  "domainHelp": {
    "domain": "<same inferred snake_case domain name>",
    "aliases": ["<alias1>", "<alias2>"],
    "description": "<one sentence describing the domain>",
    "commands": [
      { "command": "/create-domain <description>", "description": "Create the domain" },
      { "command": "list <domain>", "description": "List all records" }
    ]
  }
}

Rules:
- "domain" field must be a short, lowercase, snake_case name inferred from the user description
- Table names must start with PGD_ followed by PascalCase (e.g. PGD_Recipes, PGD_StockPrices)
- Column types must be one of: serial, bigserial, text, varchar, integer, bigint, smallint, boolean, numeric, decimal, real, jsonb, timestamptz, timestamp, date, uuid
- Every table must have id (serial, primaryKey), created_at, and updated_at columns
- Every table must have the set_updated_at() trigger
- Foreign keys MUST use the nested object format: "references": { "table": "PGD_TableName", "column": "id" }
- Foreign key "name" field is required — use format: fk_<childtable_lower>_<parenttable_lower>
- Constraint "type" must be lowercase: "unique" or "check" (never "UNIQUE")
- Constraint "name" field is required
- Generate 2-4 tables appropriate for the domain
- Return ONLY the JSON object, nothing else`;

async function run() {
  const connectionString = process.env.PGC_DATABASE_URL;
  if (!connectionString) {
    console.error('PGC_DATABASE_URL is not set');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    console.log('Connected to PGC database');

    const result = await client.query(
      `INSERT INTO "PGC_Prompt"
         (intent_category, prompt_text, model, version, was_successful)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        'create_domain',
        PROMPT_TEXT,
        'anthropic/claude-sonnet-4-5',
        2,
        null,
      ]
    );

    if (result.rows.length > 0) {
      console.log(`✅ Prompt v2 inserted — id: ${result.rows[0].id}`);
    } else {
      console.log('ℹ️  Prompt v2 already exists — no changes made');
    }

  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
