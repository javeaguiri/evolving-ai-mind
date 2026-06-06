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
  // IMPORTANT: response_format is only supported by sonar models via the Perplexity
  // agent endpoint. Non-sonar models (e.g. anthropic/claude-*, openai/gpt-*) routed
  // through the gateway return HTTP 400 when response_format is present. For those
  // models schema enforcement relies entirely on the Ajv correction loop in review-output.mjs.
  const isSonar = typeof model === 'string' && model.includes('sonar');
  const responseFormat = (isSonar && outputSchema)
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

  // Capture token usage before any parsing — needed for truncation detection below.
  const outputTokens = data.usage?.output_tokens ?? 0;

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

  // Extract JSON from the response. Models sometimes wrap output in markdown fences
  // and may prepend reasoning text before the opening fence or append explanations
  // after the closing fence. Extract content between the first ``` pair when present;
  // otherwise use the raw text directly.
  const fenceMatch    = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const openingStrip  = rawText.replace(/^```(?:json)?\s*/i, '').trim();
  const clean         = fenceMatch ? fenceMatch[1].trim() : openingStrip;

  try {
    return JSON.parse(clean);
  } catch (error) {
    const parseErr = new Error(`LLM returned invalid JSON: ${error.message}\nRaw: ${rawText.slice(0, 200)}`);
    parseErr.rawOutput = clean;
    // Truncation detection: output_tokens exactly equals the ceiling — the model was cut
    // off mid-response, not confused. A correction prompt won't help; a resumption will.
    if (maxOutputTokens && outputTokens >= parseInt(maxOutputTokens, 10)) {
      parseErr.isTruncated = true;
    }
    throw parseErr;
  }
}

/**
 * Call Perplexity Agent API with a full messages array for multi-turn chat.
 * Returns raw text — no JSON.parse. Designed for /chat and /explain endpoints.
 *
 * Mapping from OpenAI-style messages array to Agent API fields:
 *   system message → instructions
 *   last user message → input
 *   remaining messages → messages history array
 *
 * @param {string} model     LLM model name
 * @param {Array}  messages  [{role, content}] — system, user, assistant turns
 * @param {string} traceId
 * @returns {Promise<string>} Raw LLM text response
 */
export async function callLlmWithMessages(model, messages, traceId) {
  const llmKey = process.env.LLM_API_KEY;
  if (!llmKey) throw new Error('LLM_API_KEY env var not set');

  const systemMsg    = messages.find(m => m.role === 'system');
  const instructions = systemMsg?.content ?? '';

  const lastUserIdx = messages.findLastIndex(m => m.role === 'user');
  const input       = lastUserIdx !== -1 ? messages[lastUserIdx].content : '';

  const history = messages.filter((m, i) => m.role !== 'system' && i !== lastUserIdx);

  // The Agent API messages field for conversation history is only honoured by
  // sonar models. Non-sonar models (anthropic/*, openai/*) routed through the
  // gateway silently ignore it — the model only receives `input`. For those
  // models, prepend the history as a formatted transcript inside `input` so
  // the conversation context is always visible regardless of model.
  const isSonar = typeof model === 'string' && model.includes('sonar');
  let effectiveInput = input;
  if (!isSonar && history.length > 0) {
    const transcript = history
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    effectiveInput = `Previous conversation:\n\n${transcript}\n\nCurrent question: ${input}`;
  }

  const body = {
    model,
    input:       effectiveInput,
    temperature: 0.2,
    ...(instructions                    ? { instructions }          : {}),
    ...(isSonar && history.length > 0   ? { messages: history }     : {}),
  };

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

  console.info('llm-client: callLlmWithMessages response', {
    model,
    outputLen: data.output?.length,
    usage:     data.usage,
    traceId,
  });

  const messageBlock = data.output?.find(o => o.type === 'message');
  const rawText      = messageBlock?.content?.[0]?.text ?? '';

  if (!rawText) throw new Error('LLM returned empty response');

  return rawText;
}

/**
 * Call LLM with a resumption prompt — used when the previous attempt was truncated
 * at the token ceiling. Regenerates the full response from scratch with a doubled
 * token budget. Unlike the correction loop, no partial output is included — a
 * truncated response cannot serve as a valid base for incremental correction.
 *
 * @param {string} model           LLM model name
 * @param {string} instructions    Original system prompt
 * @param {string} userMessage     Original user message
 * @param {object} outputSchema    JSON schema for output enforcement
 * @param {string} traceId
 * @param {number} maxOutputTokens Original ceiling — doubled for this attempt
 * @returns {Promise<object>}      Parsed JSON response
 */
export async function callLlmWithResumption(model, instructions, userMessage, outputSchema, traceId, maxOutputTokens) {
  const doubledTokens = maxOutputTokens ? Math.min(parseInt(maxOutputTokens, 10) * 2, 8000) : 4000;

  const resumptionMessage = `Your previous response was cut off before the JSON was complete because it hit the output token limit. Regenerate the complete response from the beginning. Return only the complete valid JSON object — no explanation, no preamble, no markdown fences.`;

  console.info('llm-client: sending resumption prompt', { originalCeiling: maxOutputTokens, doubledCeiling: doubledTokens, traceId });

  return callLlm(model, instructions, resumptionMessage, outputSchema, traceId, doubledTokens);
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
  const errorLines = errors.map(e => {
    const location = e.instancePath || (e.table ? `table "${e.table}"` : null);
    let actualValue = null;
    if (e.instancePath && attempt1Output) {
      const parts = e.instancePath.split('/').filter(Boolean);
      let node = attempt1Output;
      for (const part of parts) node = node?.[part];
      if (node !== undefined && node !== null && typeof node !== 'object') actualValue = node;
    }
    const valuePart = actualValue !== null ? ` (got: "${actualValue}")` : '';
    return location ? `- [${location}]${valuePart} ${e.message}` : `- ${e.message}`;
  }).join('\n');
  const outputText = JSON.stringify(attempt1Output, null, 2);

  const correctionMessage = `Your previous response had these specific issues that must be fixed:
${errorLines}

Your previous response was:
${outputText}

Fix ONLY the issues listed above. Return the complete corrected JSON object — no explanation, no preamble, no markdown fences.`;

  console.info('llm-client: sending correction prompt', { errorCount: errors.length, traceId });

  return callLlm(model, instructions, correctionMessage, outputSchema, traceId, maxOutputTokens);
}
