// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// dev_scripts/audit-model-ids.mjs
//
// Audits all PGC_Prompt rows for model IDs that are not in the validated
// model list (docs/perplexityLLMs.json) and not known aliases from
// seed_PGC_SystemContext.json (llm_model_aliases).
//
// Usage (from project root):
//   node dev_scripts/audit-model-ids.mjs

import { readFileSync } from 'fs';

const SERV_API_URL    = process.env.SERV_API_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';

if (!SERV_API_URL) {
  console.error('ERROR: SERV_API_URL env var not set');
  process.exit(1);
}

// Load known model IDs from the validated Perplexity model list
const llmList = JSON.parse(readFileSync(
  new URL('../docs/perplexityLLMs.json', import.meta.url), 'utf8'
));
const validModelIds = new Set(llmList.data.map(m => m.id));

// Load aliases from seed
const contextSeed = JSON.parse(readFileSync(
  new URL('../src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json', import.meta.url), 'utf8'
));
const aliasRow    = contextSeed.find(r => r.key === 'llm_model_aliases');
const aliases     = aliasRow?.content ?? {};
const validAliases = new Set(Object.keys(aliases));

async function servPost(path, body) {
  const resp = await fetch(`${SERV_API_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': INTERNAL_API_KEY },
    body:    JSON.stringify(body),
  });
  return resp.json();
}

console.log('\n=== LLM Model ID Audit ===\n');
console.log('Valid aliases:', [...validAliases].map(a => `${a} → ${aliases[a]}`).join(', '));
console.log('Valid model count (Perplexity):', validModelIds.size);
console.log('');

const resp = await servPost('/api/v1/serv/table/getRows', {
  tableName: 'PGC_Prompt',
  orderBy:   { column: 'intent_category', direction: 'asc' },
});

if (!resp.success) {
  console.error('Failed to fetch PGC_Prompt:', resp.error);
  process.exit(1);
}

const rows = resp.rows ?? [];
console.log(`Checking ${rows.length} prompt(s)...\n`);

const issues  = [];
const summary = {};

for (const row of rows) {
  const model = row.model ?? '(null)';
  summary[model] = (summary[model] ?? 0) + 1;

  const isAlias   = validAliases.has(model);
  const isValid   = validModelIds.has(model);
  const isKnown   = isAlias || isValid;
  const isOld     = model === 'anthropic/claude-sonnet-4-5';

  if (!isKnown) {
    issues.push({ intent_category: row.intent_category, version: row.version, model });
  }

  const tag = isAlias ? '[alias]' : isOld ? '[old — consider upgrading to smart]' : '[ok]';
  console.log(`  ${row.intent_category} v${row.version}: ${model} ${tag}`);
}

console.log('\n--- Model usage summary ---');
for (const [model, count] of Object.entries(summary).sort()) {
  console.log(`  ${model}: ${count} prompt(s)`);
}

if (issues.length > 0) {
  console.log('\n⚠️  UNKNOWN MODEL IDs (not in Perplexity list and not an alias):');
  for (const issue of issues) {
    console.log(`  ${issue.intent_category} v${issue.version}: "${issue.model}"`);
  }
  console.log('\nFix: update seed_PGC_Prompt.json and run upsert-prompt.mjs');
  process.exit(1);
} else {
  console.log('\n✅ All prompt model IDs are valid (aliases or known Perplexity models).');
}
