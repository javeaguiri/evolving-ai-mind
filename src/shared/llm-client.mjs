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

// Hard abort ceiling — must stay safely below the ProcFunction Lambda timeout
// (240s, template.yaml), leaving room for the step to record its failure and notify
// before the Lambda is killed. Gives a clean descriptive error instead of a silent kill.
//
// A timeout is fatal to the run: the SQS message is deleted on receipt
// (sqs-callback.mjs deleteReceivedBatch, added to stop AWS RecursiveLoop mis-firing on
// long step cycles), so there is no redelivery to retry on. A single slow call therefore
// destroys the whole run — which is why the ceiling has to sit well clear of the work,
// not just above it. design_workflow_process, the longest call in create_workflow, runs
// 40–100s depending on design size; run 718 hit the old 115s ceiling on step 21t (the
// consolidation pass, which re-emits an entire process_design).
const LLM_TIMEOUT_MS = 170_000;

// Perplexity gateway requires max_output_tokens for Anthropic models.
// Used as fallback when the caller (PGC_Prompt.max_output_tokens or minds-eye prefs) doesn't specify one.
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * POST a request body to the gateway and return the parsed response envelope.
 *
 * Every caller in this file needs the same four things — the key check, the abort
 * ceiling, the timeout-vs-transport error distinction, and the non-2xx error text —
 * and had its own byte-identical copy of them. One copy means a change to the abort
 * ceiling or the error shape cannot apply to some callers and not others.
 *
 * Response post-processing is deliberately NOT here: callers differ on what the
 * envelope means (parsed JSON, raw text, or the raw item array), and that difference
 * is the whole reason they are separate functions.
 *
 * @param {object} body  The request body, already assembled
 * @returns {Promise<object>} The parsed response envelope
 */
async function postToGateway(body) {
  const llmKey = process.env.LLM_API_KEY;
  if (!llmKey) throw new Error('LLM_API_KEY env var not set');

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

  return response.json();
}

/**
 * Call the gateway with native tool definitions, returning the raw output items.
 *
 * Separate from callLlm rather than a flag on it, because the contracts differ:
 * callLlm promises parsed JSON, and a tool-calling turn may return no message block
 * at all — only a `function_call` — so there is nothing for JSON.parse to read. A
 * function whose return type depends on what the model chose to do is worse than two
 * functions with one contract each.
 *
 * `input` accepts a string OR an array of canonical items, and the array form is the
 * point of this function. Echoing the previous turn's `output` items back — carrying
 * the server-assigned `call_id` — gives each item its own cache boundary, so turn N
 * reads turn N-1's whole prefix at cache-read rates instead of rewriting it. A
 * hand-rendered transcript string is one opaque block and gets no such credit:
 * measured on the live gateway, the same append scored read 4,698 as a string against
 * read 16,539 as items. Nothing about that is inferable from the request shape, which
 * is why it is written down here.
 *
 * @param {string}       model            Gateway model id
 * @param {string}       instructions     System prompt
 * @param {string|Array} input            A prompt string, or canonical items to carry forward
 * @param {Array}        [tools]          Tool definitions: { type: 'function', name, description, parameters }
 * @param {string}       traceId          For logging
 * @param {number}       [maxOutputTokens]
 * @returns {Promise<{output: Array, usage: object, text: string}>}
 *   `output` is echoed straight back as the next turn's `input`; `usage` carries the
 *   cache counters; `text` is every message block's text joined, empty on a pure tool call.
 */
export async function callLlmWithTools(model, instructions, input, tools, traceId, maxOutputTokens) {
  const body = {
    model,
    input,
    instructions,
    max_output_tokens: parseInt(maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, 10),
    ...(tools?.length ? { tools } : {}),
  };

  const data   = await postToGateway(body);
  const output = data.output ?? [];
  const usage  = data.usage ?? {};

  const text = output
    .filter(o => o.type === 'message')
    .map(o => o.content?.map(c => c.text ?? '').join('') ?? '')
    .join('')
    .trim();

  // cache_read vs cache_creation is the signal the whole item-array design turns on,
  // so it is logged explicitly rather than left inside the usage blob.
  const details = usage.input_tokens_details ?? {};
  console.info('llm-client: callLlmWithTools response', {
    model,
    itemTypes:     output.map(o => o.type),
    inputTokens:   usage.input_tokens,
    cacheCreation: details.cache_creation_input_tokens,
    cacheRead:     details.cache_read_input_tokens,
    cost:          usage.cost?.total_cost,
    traceId,
  });

  if (output.length === 0) throw new Error('LLM returned no output items');

  return { output, usage, text };
}

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
  const body = {
    model,
    input:        userMessage,
    instructions,
    max_output_tokens: parseInt(maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, 10),
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

  const data = await postToGateway(body);

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

  // Extract JSON from the response. Models sometimes wrap output in markdown fences.
  // Only strip fences when the raw output ITSELF starts with ``` — if the output is
  // already a JSON object, any ``` inside it belong to embedded code blocks in string
  // values and must not be extracted (they would yield "javascript..." which fails parse).
  const trimmedRaw = rawText.trim();
  const fenceMatch = trimmedRaw.startsWith('```')
    ? trimmedRaw.match(/^```(?:json)?\s*([\s\S]*?)```/i)
    : null;
  const clean = fenceMatch ? fenceMatch[1].trim() : trimmedRaw;

  try {
    return JSON.parse(clean);
  } catch (firstError) {
    // LLM prepended prose before the JSON object — find the first { and retry.
    const jsonStart = clean.indexOf('{');
    if (jsonStart > 0) {
      try { return JSON.parse(clean.slice(jsonStart)); } catch { /* fall through */ }
    }
    const parseErr = new Error(`LLM returned invalid JSON: ${firstError.message}\nRaw: ${rawText.slice(0, 200)}`);
    parseErr.isParseError = true;
    parseErr.rawOutput    = rawText;
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
  // Concatenate every system-role message rather than taking only the first —
  // callers (e.g. explain.mjs) may layer their own meta-instructions on top of
  // stored context (e.g. the original llm_call's full prompt_text) that is
  // also recorded with role: 'system'. Dropping anything past the first
  // silently discards that context instead of just narrowing the persona.
  const systemMessages = messages.filter(m => m.role === 'system');
  const instructions   = systemMessages.map(m => m.content).join('\n\n');

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
    input:             effectiveInput,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    ...(instructions                    ? { instructions }          : {}),
    ...(isSonar && history.length > 0   ? { messages: history }     : {}),
  };

  const data = await postToGateway(body);

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
    let message = e.message;
    const path = e.instancePath || '';
    if (path.endsWith('output_shape') || path.endsWith('/output_shape')) {
      message += ' — output_shape must be a JSON Schema object describing the prompt\'s output fields; use {} if the output has no specific shape';
    } else if (e.keyword === 'required' && e.params?.missingProperty === 'output_shape') {
      message += ' — output_shape must be a JSON Schema object describing the prompt\'s output fields; use {} if the output has no specific shape';
    }
    return location ? `- [${location}]${valuePart} ${message}` : `- ${message}`;
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
