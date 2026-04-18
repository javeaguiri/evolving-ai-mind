// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/integration/llm-prompt-schema.test.mjs
//
// Regression test suite — verifies that every PGC_Prompt.output_schema is
// accepted by the Perplexity Agent API without returning HTTP 400.
//
// Calls callLlm() from src/shared/llm-client.mjs with each prompt's actual
// model, output_schema, and probe_input from the DB. probe_input provides
// minimal realistic substitution values so {{placeholders}} in prompt_text
// are resolved before the call — the same way step-executor.mjs does it at
// runtime. The model receives a coherent system prompt and produces real JSON
// output, making both 400s (API rejection) and invalid JSON (schema/prompt
// mismatch) meaningful signals rather than probe artifacts.
//
// NOTE: node --test strips custom CLI args from process.argv.
// Use environment variables to activate.
//
// USAGE (cmd.exe):
//
//   All prompts:
//     set TEST_ALL=1 && set LLM_API_KEY=pplx-... && set LLM_AGENT_URL=https://api.perplexity.ai/v1/agent && set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node --test tests/integration/llm-prompt-schema.test.mjs
//
//   Specific prompts:
//     set TEST_PROMPTS=generate_workflow_steps,analyze_and_design_workflow && set LLM_API_KEY=pplx-... && set LLM_AGENT_URL=https://api.perplexity.ai/v1/agent && set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node --test tests/integration/llm-prompt-schema.test.mjs
//
//   No env vars → single skipped test, 0 failures, safe in CI:
//     node --test tests/integration/llm-prompt-schema.test.mjs
//
// ENVIRONMENT:
//   TEST_ALL=1            — test every prompt (latest version per intent_category)
//   TEST_PROMPTS=a,b,c    — test specific intent_category values only
//   LLM_API_KEY           — Perplexity API key
//   LLM_AGENT_URL         — Perplexity agent endpoint (https://api.perplexity.ai/v1/agent)
//   SERV_API_URL          — SERV base URL to read PGC_Prompt rows

// ---------------------------------------------------------------------------
// All static imports must be at the top level in ESM
// ---------------------------------------------------------------------------

import { describe, it, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { callLlm } from '../../src/shared/llm-client.mjs';

// ---------------------------------------------------------------------------
// Run mode — env vars only (node --test strips process.argv)
// ---------------------------------------------------------------------------

const TEST_ALL     = process.env.TEST_ALL === '1' || process.env.TEST_ALL === 'true';
const TEST_PROMPTS = process.env.TEST_PROMPTS
  ? process.env.TEST_PROMPTS.split(',').map(s => s.trim()).filter(Boolean)
  : null;

const shouldRun = TEST_ALL || (TEST_PROMPTS && TEST_PROMPTS.length > 0);

// ---------------------------------------------------------------------------
// Skip path — no env vars set
// ---------------------------------------------------------------------------

if (!shouldRun) {
  test('llm-prompt-schema — skipped (no filter specified)', t => {
    t.diagnostic('Set TEST_ALL=1 to test all prompts, or TEST_PROMPTS=name1,name2 for specific ones.');
    t.diagnostic('Required env vars when running: LLM_API_KEY, LLM_AGENT_URL, SERV_API_URL');
    t.diagnostic('Example (cmd.exe, all prompts):');
    t.diagnostic('  set TEST_ALL=1 && set LLM_API_KEY=pplx-... && set LLM_AGENT_URL=https://api.perplexity.ai/v1/agent && set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node --test tests/integration/llm-prompt-schema.test.mjs');
    t.skip('0/0 prompts tested — set TEST_ALL=1 or TEST_PROMPTS=<names> to run');
  });
}

// ---------------------------------------------------------------------------
// Env var validation — runs only when shouldRun
// ---------------------------------------------------------------------------

if (shouldRun) {
  const missingVars = ['LLM_API_KEY', 'LLM_AGENT_URL', 'SERV_API_URL']
    .filter(k => !process.env[k]);

  if (missingVars.length > 0) {
    test('llm-prompt-schema — missing env vars', () => {
      assert.fail(`Set these env vars before running: ${missingVars.join(', ')}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all PGC_Prompt rows from SERV.
 * Returns Map<intent_category, promptRow> — latest version per category.
 * Rows ordered desc by version so first occurrence per category is latest.
 */
async function fetchPromptRows() {
  const resp = await fetch(`${process.env.SERV_API_URL}/api/v1/serv/table/getRows`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      tableName: 'PGC_Prompt',
      orderBy:   { column: 'version', direction: 'desc' },
    }),
  });
  if (!resp.ok) throw new Error(`SERV getRows failed: HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.success) throw new Error(`SERV getRows error: ${data.error}`);

  const latest = new Map();
  for (const row of data.rows ?? []) {
    if (!latest.has(row.intent_category)) {
      latest.set(row.intent_category, row);
    }
  }
  return latest;
}

/**
 * Substitute {{placeholder}} tokens in prompt_text using probe_input values.
 * Mirrors the reduce pattern in step-executor.mjs executeLlmCall() exactly.
 * Object/array values are JSON-stringified, matching runtime behaviour.
 */
function substituteProbeInput(promptText, probeInput) {
  if (!probeInput || typeof probeInput !== 'object') return promptText;
  return Object.entries(probeInput).reduce((text, [key, val]) => {
    const placeholder  = `{{${key}}}`;
    const substitution = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
    return text.split(placeholder).join(substitution);
  }, promptText);
}

/**
 * Probe a single prompt via callLlm() using the prompt's actual model,
 * output_schema, and probe_input from the DB.
 *
 * probe_input substitutes {{placeholders}} in prompt_text so the model
 * receives a coherent system prompt and produces real JSON output.
 * Without probe_input the model receives unresolved placeholders and
 * typically produces reasoning text — useful only for 400 detection.
 *
 * callLlm() applies the same response_format gating (isSonar check) as
 * the deployed Lambda. A 400 here means the same 400 occurs at runtime.
 *
 * Returns: { passed: boolean, is400: boolean, error?: string }
 */
async function probePrompt(row) {
  const { model, prompt_text, output_schema, probe_input, max_output_tokens } = row;
  const instructions = substituteProbeInput(prompt_text, probe_input);
  // user turn: pass probe_input as a JSON string so the model has something
  // concrete to work with — mirrors the runtime pattern where user_input
  // may be a small resolved string or empty.
  const userMessage  = probe_input ? JSON.stringify(probe_input) : 'probe';
  try {
    await callLlm(
      model,
      instructions,
      userMessage,
      output_schema,
      'probe-test',
      max_output_tokens ?? 512,
    );
    return { passed: true, is400: false };
  } catch (err) {
    const is400 = err.message.includes('400');
    return { passed: false, is400, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Test suite — only registered when shouldRun and env vars are present
// ---------------------------------------------------------------------------

if (shouldRun && !['LLM_API_KEY', 'LLM_AGENT_URL', 'SERV_API_URL'].some(k => !process.env[k])) {
  let promptRows = new Map();

  describe('PGC_Prompt output_schema — Perplexity API compatibility', () => {

    before(async () => {
      promptRows = await fetchPromptRows();
    });

    it('all target prompts complete callLlm() without HTTP 400', async t => {
      const targets = TEST_ALL
        ? [...promptRows.values()]
        : TEST_PROMPTS.map(name => {
            const row = promptRows.get(name);
            if (!row) throw new Error(`Prompt not found in PGC_Prompt: "${name}"`);
            return row;
          });

      if (targets.length === 0) {
        t.skip('No matching prompts found in PGC_Prompt');
        return;
      }

      t.diagnostic(`Probing ${targets.length} prompt(s) via callLlm() — substituted probe_input`);

      const results = [];

      for (const row of targets) {
        const { intent_category, version, model, output_schema, probe_input } = row;

        if (!output_schema) {
          results.push({ intent_category, version, model, status: 'skipped', reason: 'no output_schema' });
          continue;
        }

        const { passed, is400, error } = await probePrompt(row);
        results.push({
          intent_category,
          version,
          model,
          hasProbeInput: !!probe_input,
          status:  is400 ? 'FAIL_400' : passed ? 'pass' : 'error',
          reason:  passed ? undefined : error,
        });
      }

      // Per-prompt diagnostics — visible with --test-reporter=spec
      for (const r of results) {
        const icon     = r.status === 'FAIL_400' ? '❌' : r.status === 'skipped' ? '⏭ ' : r.status === 'error' ? '⚠️ ' : '✅';
        const probeTag = r.hasProbeInput ? '' : ' [no probe_input — add to seed]';
        const detail   = r.status === 'pass'
          ? `${r.model}${probeTag}`
          : `${r.model}${probeTag} — ${r.reason ?? ''}`;
        t.diagnostic(`${icon}  ${r.intent_category} v${r.version} (${detail})`);
      }

      // HTTP 400 = API rejected the request — same failure occurs in Lambda — hard fail
      const failed400 = results.filter(r => r.status === 'FAIL_400');
      if (failed400.length > 0) {
        const names = failed400
          .map(r => `${r.intent_category} v${r.version} [${r.model}]`)
          .join(', ');
        assert.fail(
          `${failed400.length} prompt(s) returned HTTP 400 — same failure occurs in Lambda: ${names}. ` +
          'Fix output_schema in seed_PGC_Prompt.json and re-upsert, or fix response_format ' +
          'gating in llm-client.mjs.'
        );
      }

      // Non-400 errors (invalid JSON, timeouts) — warn, do not fail
      // With probe_input these should now be rare — investigate if they appear
      const errors = results.filter(r => r.status === 'error');
      for (const r of errors) {
        t.diagnostic(`⚠️  Non-400 error for ${r.intent_category}: ${r.reason}`);
      }
    });

  });
}
