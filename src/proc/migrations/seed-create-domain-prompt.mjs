// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/migrations/seed-create-domain-prompt.mjs
//
// One-time migration — inserts the create_domain prompt into PGC_Prompt.
// Safe to run multiple times — ON CONFLICT DO NOTHING on (intent_category, version).
//
// Usage:
//   node src/proc/migrations/seed-create-domain-prompt.mjs
//
// Requires PGC_DATABASE_URL in environment — load from .env.local:
//   node --env-file=.env.local src/proc/migrations/seed-create-domain-prompt.mjs

import pg from 'pg';

const { Client } = pg;

const PROMPT_TEXT = `You are a PostgreSQL schema designer for a system called evolving-mind-ai.

The user wants to create a new data domain called "{{domainName}}".

Return ONLY a valid JSON object — no markdown, no explanation, no backticks.
The JSON must match this exact shape:

{
  "domain": "<domain name, lowercase>",
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
      "foreignKeys": [],
      "constraints": [],
      "triggers": [
        { "name": "trg_<tablename_lower>_updated_at", "timing": "BEFORE UPDATE", "function": "set_updated_at()" }
      ]
    }
  ],
  "domainHelp": {
    "domain": "<domain name, lowercase>",
    "aliases": ["<alias1>", "<alias2>"],
    "description": "<one sentence describing the domain>",
    "commands": [
      { "command": "/create-domain <domain>", "description": "Create the domain" },
      { "command": "list <domain>",           "description": "List all records" }
    ]
  }
}

Rules:
- Table names must start with PGD_ followed by PascalCase (e.g. PGD_Recipes)
- Column types must be one of: serial, bigserial, text, varchar, integer, bigint, smallint, boolean, numeric, decimal, real, jsonb, timestamptz, timestamp, date, uuid
- Every table must have id (serial, primaryKey), created_at, and updated_at columns
- Every table must have the set_updated_at() trigger
- Foreign keys between tables in the same domain are encouraged where logical
- Generate 2-4 tables appropriate for the domain
- Return ONLY the JSON object, nothing else`;

async function run() {
  const connectionString = process.env.PGC_DATABASE_URL;
  if (!connectionString) {
    console.error('PGC_DATABASE_URL is not set — load .env.local first');
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
        1,
        null,
      ]
    );

    if (result.rows.length > 0) {
      console.log(`✅ Prompt inserted — id: ${result.rows[0].id}`);
    } else {
      console.log('ℹ️  Prompt already exists (ON CONFLICT DO NOTHING) — no changes made');
    }

  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
