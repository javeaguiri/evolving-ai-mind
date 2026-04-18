// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/integration/llm-prompt-schema.test.mjs
//
// Regression test suite — verifies that every PGC_Prompt.output_schema is
// accepted by the Perplexity Agent API without returning HTTP 400.
//
// Calls callLlm() from src/shared/llm-client.mjs directly so the test
// exercises the exact same code path as the Lambda — same model, same
// response_format gating, same request construction. A probe that passes
// here will pass at runtime.
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
//   LLM_AGENT_URL         — Perplexity agent endpoint
//   SERV_API_URL          — SERV base URL to read PGC_Prompt rows

import { describe, it, before, test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Run mode
// ---------------------------------------------------------------------------

const TEST_ALL     = process.env.TEST_ALL === '1' || process.env.TEST_ALL === 'true';
const TEST_PROMPTS = process.env.TEST_PROMPTS
  ? process.env.TEST_PROMPTS.split(',').map(s => s.trim()).filter(Boolean)
  : null;

const shouldRun = TEST_ALL || (TEST_PROMPTS && TEST_PROMPTS.length > 0);

// ---------------------------------------------------------------------------
// Skip path
// ---------------------------------------------------------------------------

if (!shouldRun) {
  test('llm-prompt-schema — skipped (no filter specified)', t => {
    t.diagnostic('Set TEST_ALL=1 to test all prompts, or TEST_PROMPTS=name1,name2 for specific ones.');
    t.diagnostic('Required env vars when running: LLM_API_KEY, LLM_AGENT_URL, SERV_API_URL');
    t.diagnostic('Example (cmd.exe, all prompts):');
    t.diagnostic('  set TEST_ALL=1 && set LLM_API_KEY=pplx-... && set LLM_AGENT_URL=https://api.perplexity.ai/v1/agent && set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node --test tests/integration/llm-prompt-schema.test.mjs');
    t.skip('0/0 prompts tested — set TEST_ALL=1 or TEST_PROMPTS=<names> to run');
  });
} else {
  // -------------------------------------------------------------------------
  // Env var validation
  // -------------------------------------------------------------------------

  const missingVars = ['LLM_API_KEY', 'LLM_AGENT_URL', 'SERV_API_URL']
    .filter(k => !process.env[k]);

  if (missingVars.length > 0) {
    test('llm-prompt-schema — env var check', () => {
      assert.fail(`Missing required env vars: ${missingVars.join(', ')}`);
    });
  } else {
    // -------------------------------------------------------------------------
    // Import callLlm from the shared module — same code path as Lambda
    // -------------------------------------------------------------------------

    // Source guard: verify llm-client.mjs on disk contains the isSonar guard
    // before making any API calls. If this fails, the source file has regressed
    // and the test would give a false green (sonar probes would pass while
    // claude-model Lambda calls would still 400).
    import { readFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import { resolve, dirname } from 'node:path';

    const __filename = fileURLToPath(import.meta.url);
    const __dirname  = dirname(__filename);
    const llmClientSrc = readFileSync(
      resolve(__dirname, '../../src/shared/llm-client.mjs'), 'utf8'
    );
    if (!llmClientSrc.includes('isSonar')) {
      const { test: failTest } = await import('node:test');
      failTest('llm-client.mjs source guard', () => {
        assert.fail(
          'llm-client.mjs is missing the isSonar guard. ' +
          'response_format will be sent to non-sonar models, causing HTTP 400 in Lambda. ' +
          'Restore the guard before running integration tests or deploying.'
        );
      });
      process.exit(1);
    }

    const { callLlm } = await import('../../src/shared/llm-client.mjs');

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Fetch all PGC_Prompt rows from SERV.
     * Returns Map<intent_category, promptRow> — latest version per category.
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
     * Mirrors the same reduce pattern used by step-executor.mjs executeLlmCall().
     * Values that are objects/arrays are JSON-stringified, matching runtime behaviour.
     */
    function substituteProbeInput(promptText, probeInput) {
      if (!probeInput || typeof probeInput !== 'object') return promptText;
      return Object.entries(probeInput).reduce((text, [key, val]) => {
        const placeholder   = `{{${key}}}`;
        const substitution  = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
        return text.split(placeholder).join(substitution);
      }, promptText);
    }

    /**
     * Probe a single prompt by calling callLlm() with:
     *   - prompt_text with {{placeholders}} substituted from probe_input
     *   - the prompt's actual model and output_schema from the DB
     *
     * probe_input provides minimal but realistic input values so the model
     * receives a coherent system prompt and produces real JSON output.
     * This makes both 400s (API rejection) and invalid JSON (schema/prompt
     * mismatch) meaningful signals — not probe artifacts.
     *
     * If probe_input is absent the test falls back to the bare instruction,
     * which may produce ⚠️ invalid JSON warnings but never a false ✅.
     *
     * Returns: { passed: boolean, is400: boolean, error?: string }
     */
    async function probePrompt(row) {
      const { model, prompt_text, output_schema, probe_input, max_output_tokens } = row;
      const instructions = substituteProbeInput(
        prompt_text,
        probe_input
      );
      // userMessage: probe_input typically covers all variables via the system
      // prompt. Pass a short confirmation so the model has something in the
      // user turn — matches the runtime pattern where user_input may be empty.
      const userMessage = probe_input ? JSON.stringify(probe_input) : 'probe';
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

    // -------------------------------------------------------------------------
    // Test suite
    // -------------------------------------------------------------------------

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
            status: is400 ? 'FAIL_400' : passed ? 'pass' : 'error',
            reason: passed ? undefined : error,
          });
        }

        // Emit per-prompt diagnostics
        for (const r of results) {
          const icon      = r.status === 'FAIL_400' ? '❌' : r.status === 'skipped' ? '⏭ ' : r.status === 'error' ? '⚠️ ' : '✅';
          const probeTag  = r.hasProbeInput ? '' : ' [no probe_input — add to seed]';
          const detail    = r.status === 'pass'
            ? `${r.model}${probeTag}`
            : `${r.model}${probeTag} — ${r.reason ?? ''}`;
          t.diagnostic(`${icon}  ${r.intent_category} v${r.version} (${detail})`);
        }

        // 400s are schema-compatibility failures — hard fail
        const failed400 = results.filter(r => r.status === 'FAIL_400');
        if (failed400.length > 0) {
          const names = failed400.map(r => `${r.intent_category} v${r.version} [${r.model}]`).join(', ');
          assert.fail(
            `${failed400.length} prompt(s) returned HTTP 400 (schema rejected by API for this model): ${names}. ` +
            'Fix output_schema in seed_PGC_Prompt.json and re-upsert, or check response_format gating in llm-client.mjs.'
          );
        }

        // Other errors (timeouts, invalid JSON from LLM, etc.) — warn but don't fail
        // These are not schema-compatibility issues.
        const errors = results.filter(r => r.status === 'error');
        if (errors.length > 0) {
          for (const r of errors) {
            t.diagnostic(`⚠️  Non-400 error for ${r.intent_category}: ${r.reason}`);
          }
        }
      });

    });
  }
}
