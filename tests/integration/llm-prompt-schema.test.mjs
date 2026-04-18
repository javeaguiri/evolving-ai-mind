// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/integration/llm-prompt-schema.test.mjs
//
// Regression test suite — one test per PGC_Prompt entry.
// Calls callLlm() with the prompt's actual model, output_schema, and probe_input.
// probe_input substitutes {{placeholders}} in prompt_text so the model receives
// coherent context, mirroring what step-executor.mjs does at runtime.
//
// Result classification per prompt:
//   ✅  pass     — callLlm() returned valid JSON (no 400, no parse error)
//   ❌  FAIL_400 — API returned HTTP 400 — same failure occurs in Lambda
//   ⚠️  warning  — non-400 error (truncation, model refused) — hard fail only
//                   when probe_input was present (real context, real signal)
//
// NOTE: node --test strips custom CLI args. Use environment variables.
//
// USAGE (cmd.exe):
//   All prompts:
//     set TEST_ALL=1 && set LLM_API_KEY=pplx-... && set LLM_AGENT_URL=https://api.perplexity.ai/v1/agent && set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node --test --test-reporter=spec tests/integration/llm-prompt-schema.test.mjs
//
//   Specific prompts:
//     set TEST_PROMPTS=generate_workflow_steps,fix_workflow_steps && ...
//
//   No env vars → single skipped test, safe in CI:
//     node --test tests/integration/llm-prompt-schema.test.mjs
//
// ENVIRONMENT:
//   TEST_ALL=1            — test every prompt (latest version per intent_category)
//   TEST_PROMPTS=a,b,c    — comma-separated intent_category values
//   LLM_API_KEY           — Perplexity API key
//   LLM_AGENT_URL         — Perplexity agent endpoint
//   SERV_API_URL          — SERV base URL

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { callLlm } from '../../src/shared/llm-client.mjs';

// ---------------------------------------------------------------------------
// Run mode
// ---------------------------------------------------------------------------

const TEST_ALL     = process.env.TEST_ALL === '1' || process.env.TEST_ALL === 'true';
const TEST_PROMPTS = process.env.TEST_PROMPTS
  ? process.env.TEST_PROMPTS.split(',').map(s => s.trim()).filter(Boolean)
  : null;

const shouldRun    = TEST_ALL || (TEST_PROMPTS && TEST_PROMPTS.length > 0);
const envVarsOk    = ['LLM_API_KEY', 'LLM_AGENT_URL', 'SERV_API_URL'].every(k => process.env[k]);

// ---------------------------------------------------------------------------
// Skip path
// ---------------------------------------------------------------------------

if (!shouldRun) {
  test('llm-prompt-schema — skipped (no filter specified)', t => {
    t.diagnostic('Set TEST_ALL=1 or TEST_PROMPTS=name1,name2 to run.');
    t.diagnostic('Required env vars: LLM_API_KEY, LLM_AGENT_URL, SERV_API_URL');
    t.skip('0/0 prompts tested');
  });
}

if (shouldRun && !envVarsOk) {
  test('llm-prompt-schema — missing env vars', () => {
    const missing = ['LLM_API_KEY', 'LLM_AGENT_URL', 'SERV_API_URL'].filter(k => !process.env[k]);
    assert.fail(`Set these env vars before running: ${missing.join(', ')}`);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  // Latest version per intent_category
  const latest = new Map();
  for (const row of data.rows ?? []) {
    if (!latest.has(row.intent_category)) latest.set(row.intent_category, row);
  }
  return latest;
}

function substituteProbeInput(promptText, probeInput) {
  if (!probeInput || typeof probeInput !== 'object') return promptText;
  return Object.entries(probeInput).reduce((text, [key, val]) => {
    const sub = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
    return text.split(`{{${key}}}`).join(sub);
  }, promptText);
}

async function probePrompt(row) {
  const { model, prompt_text, output_schema, probe_input, max_output_tokens } = row;
  const instructions = substituteProbeInput(prompt_text, probe_input);
  const userMessage  = probe_input ? JSON.stringify(probe_input) : 'probe';
  try {
    await callLlm(model, instructions, userMessage, output_schema, 'probe-test', max_output_tokens ?? 2048);
    return { passed: true, is400: false };
  } catch (err) {
    const is400 = err.message.includes('400');
    return { passed: false, is400, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Test suite — one it() per prompt, registered via top-level await
// ---------------------------------------------------------------------------

if (shouldRun && envVarsOk) {
  // Top-level await (ESM) — fetch rows before registering tests so node:test
  // can create one it() per prompt. All tests are visible in the runner output
  // and counted individually in the metrics.
  const promptRows = await fetchPromptRows();

  const targets = TEST_ALL
    ? [...promptRows.values()]
    : TEST_PROMPTS.map(name => {
        const row = promptRows.get(name);
        if (!row) throw new Error(`Prompt not found in PGC_Prompt: "${name}"`);
        return row;
      });

  describe('PGC_Prompt output_schema — Perplexity API compatibility', () => {
    for (const row of targets) {
      const { intent_category, version, model, output_schema, probe_input } = row;
      const label = `${intent_category} v${version} [${model}]`;

      it(label, async t => {
        if (!output_schema) {
          t.skip('no output_schema — skipped');
          return;
        }

        const probeTag = probe_input ? '' : ' [no probe_input — add to seed]';
        t.diagnostic(`Probing${probeTag}`);

        const { passed, is400, error } = await probePrompt(row);

        if (is400) {
          // HTTP 400 — API rejected the request — always a hard failure
          assert.fail(
            `HTTP 400 — same failure occurs in Lambda. ` +
            'Fix output_schema in seed_PGC_Prompt.json and re-upsert, or fix ' +
            'response_format gating in llm-client.mjs.'
          );
        }

        if (!passed && probe_input) {
          // Non-400 error WITH real probe context — genuine prompt/schema problem
          assert.fail(
            `callLlm() failed with real probe_input context — investigate prompt text or output_schema:\n${error}`
          );
        }

        if (!passed && !probe_input) {
          // Non-400 error without probe_input — known artifact, warn only
          t.diagnostic(`⚠️  No probe_input (known artifact): ${error?.slice(0, 200)}`);
        }
        // passed === true → test passes implicitly
      });
    }
  });
}
