// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/llm-client.mjs
// Shared LLM caller for all Lambda tiers.
//
// Intra-tier import — modules call this directly, no HTTP fetch.
// Transport-agnostic — no AWS SDK, no Slack SDK.
//
// Currently targets Perplexity Agent API.
// Model is passed per-call from PGC_Prompt.model — not hardcoded here.

// Hard abort ceiling — must be safely below ProcFunction Lambda timeout (60s).
// Gives a clean descriptive error instead of a silent Lambda kill on large outputs
// like generate_crud_workflows which can take ~28s.
const LLM_TIMEOUT_MS = 115_000;

/**
 * Call Perplexity Agent API and return parsed JSON.
 * Strips markdown fences defensively before JSON.parse.
 *
 * @param {string} model         LLM model name from PGC_Prompt.model
 * @param {string} instructions  System prompt — {{userInput}} already substituted by caller
 * @param {string} userMessage   User-facing input message
 * @param {object} outputSchema  PGC_Prompt.output_schema — enforced at model level if provided
 * @param {string} traceId       For logging
 * @returns {Promise<object>}    Parsed JSON response
 */
export async function callLlm(model, instructions, userMessage, outputSchema, traceId, maxOutputTokens) {
  const llmKey = process.env.LLM_API_KEY;
  if (!llmKey) throw new Error('LLM_API_KEY env var not set');

  const body = {
    model,
    input:        userMessage,
    instructions,
    temperature:  0.2,
    ...(maxOutputTokens ? { max_output_tokens: parseInt(maxOutputTokens, 10) } : {}),
  };

  // response_format enforces the schema at the model level — reduces field-name
  // hallucination without relying solely on the Ajv correction loop for structure.
  // markdown-fence stripping is kept as a defensive fallback.
  const responseFormat = outputSchema
    ? { type: 'json_schema', json_schema: { name: 'output', schema: outputSchema, strict: false } }
    : undefined;
  if (responseFormat) body.response_format = responseFormat;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(process.env.LLM_AGENT_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${llmKey}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') {
      throw new Error(`LLM call timed out after ${LLM_TIMEOUT_MS / 1000}s`);
    }
    throw fetchErr;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent API error ${response.status}: ${text}`);
  }

  const data = await response.json();

  console.info('llm-client: response received', {
    model,
    outputLen: data.output?.length,
    usage:     data.usage,
    traceId,
  });

  // Extract text from output array — find the message block
  const messageBlock = data.output?.find(o => o.type === 'message');
  const rawText      = messageBlock?.content?.[0]?.text ?? '';

  if (!rawText) throw new Error('LLM returned empty response');

  // Strip markdown fences defensively, then parse JSON
  const clean = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(clean);
  } catch (error) {
    throw new Error(`LLM returned invalid JSON: ${error.message}\nRaw: ${rawText.slice(0, 200)}`);
  }
}

/**
 * Call LLM with a correction prompt — used on attempt 2 of the validation loop.
 * Injects Ajv/semantic errors into the prompt so the model knows exactly what to fix.
 *
 * @param {string} model         LLM model name
 * @param {string} instructions  Original system prompt
 * @param {string} userMessage   Original user message
 * @param {object} outputSchema  JSON schema for output enforcement
 * @param {Array}  errors        Validation errors from attempt 1
 * @param {object} attempt1Output The invalid output from attempt 1
 * @param {string} traceId
 * @returns {Promise<object>}    Parsed JSON response
 */
export async function callLlmWithCorrection(model, instructions, userMessage, outputSchema, errors, attempt1Output, traceId, maxOutputTokens) {
  const errorText  = JSON.stringify(errors, null, 2);
  const outputText = JSON.stringify(attempt1Output, null, 2);

  const correctionMessage = `Your previous response had these validation errors:
${errorText}

Your previous response was:
${outputText}

Return the corrected JSON only. Do not change any fields that were not flagged.`;

  console.info('llm-client: sending correction prompt', { errorCount: errors.length, traceId });

  return callLlm(model, instructions, correctionMessage, outputSchema, traceId, maxOutputTokens);
}
