// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/llm-client-tools.test.mjs
//
// Covers callLlmWithTools in src/shared/llm-client.mjs — the native-tool-calling seam.
// The load-bearing assertion is that an item-array `input` reaches the gateway
// unchanged: echoing the previous turn's output items is what earns incremental
// cache reads, and any normalisation on the way out would silently forfeit them.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { callLlmWithTools } from '../../src/shared/llm-client.mjs';

const realFetch = globalThis.fetch;
const realKey   = process.env.LLM_API_KEY;
const realUrl   = process.env.LLM_AGENT_URL;

/** Captures the request body and replies with a canned envelope. */
let sent;
function stubGateway(envelope) {
  sent = null;
  globalThis.fetch = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, json: async () => envelope };
  };
}

const messageEnvelope = {
  output: [{ type: 'message', content: [{ text: 'the answer' }] }],
  usage:  { input_tokens: 10, input_tokens_details: { cache_read_input_tokens: 5 } },
};

const toolCallEnvelope = {
  output: [{ type: 'function_call', call_id: 'toolu_01', name: 'lookup_order', arguments: '{"order_id":"ORD-1"}' }],
  usage:  { input_tokens: 20 },
};

beforeEach(() => {
  process.env.LLM_API_KEY   = 'test-key-not-a-real-credential';
  process.env.LLM_AGENT_URL = 'https://gateway.invalid/responses';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = realKey;
  if (realUrl === undefined) delete process.env.LLM_AGENT_URL; else process.env.LLM_AGENT_URL = realUrl;
});

// ---------------------------------------------------------------------------
// The item array — the reason this function exists
// ---------------------------------------------------------------------------

test('callLlmWithTools: an item-array input reaches the gateway unchanged', async () => {
  stubGateway(messageEnvelope);

  const items = [
    { role: 'user', content: 'where is my order?' },
    { type: 'function_call', call_id: 'toolu_01', name: 'lookup_order', arguments: '{"order_id":"ORD-1"}' },
    { type: 'function_call_output', call_id: 'toolu_01', output: '{"status":"shipped"}' },
  ];

  await callLlmWithTools('anthropic/claude-sonnet-4-6', 'sys', items, [], 'trace-1', 512);

  assert.deepEqual(sent.input, items, 'items must not be reshaped, reordered, or stringified');
});

test('callLlmWithTools: a string input still works', async () => {
  stubGateway(messageEnvelope);
  await callLlmWithTools('anthropic/claude-sonnet-4-6', 'sys', 'plain prompt', [], 'trace-1', 512);
  assert.equal(sent.input, 'plain prompt');
});

test('callLlmWithTools: output is returned verbatim, ready to echo forward', async () => {
  stubGateway(toolCallEnvelope);
  const { output } = await callLlmWithTools('m', 'sys', 'q', [], 't', 512);
  assert.deepEqual(output, toolCallEnvelope.output);
});

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

test('callLlmWithTools: tools are sent when supplied', async () => {
  stubGateway(toolCallEnvelope);
  const tools = [{
    type: 'function',
    name: 'lookup_order',
    description: 'Look up an order',
    parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
  }];

  await callLlmWithTools('m', 'sys', 'q', tools, 't', 512);
  assert.deepEqual(sent.tools, tools);
});

test('callLlmWithTools: the tools key is omitted when there are none', async () => {
  stubGateway(messageEnvelope);

  await callLlmWithTools('m', 'sys', 'q', undefined, 't', 512);
  assert.ok(!('tools' in sent), 'undefined must not send an empty tools key');

  await callLlmWithTools('m', 'sys', 'q', [], 't', 512);
  assert.ok(!('tools' in sent), 'an empty array must not send an empty tools key');
});

test('callLlmWithTools: no response_format is sent — tool schemas do that job', async () => {
  stubGateway(toolCallEnvelope);
  await callLlmWithTools('m', 'sys', 'q', [{ type: 'function', name: 'f' }], 't', 512);
  assert.ok(!('response_format' in sent));
});

// ---------------------------------------------------------------------------
// text extraction
// ---------------------------------------------------------------------------

test('callLlmWithTools: text joins message blocks and trims', async () => {
  stubGateway({
    output: [{ type: 'message', content: [{ text: '  hello ' }, { text: 'world  ' }] }],
    usage:  {},
  });
  const { text } = await callLlmWithTools('m', 'sys', 'q', [], 't', 512);
  assert.equal(text, 'hello world');
});

test('callLlmWithTools: text is empty on a pure tool call, and that is not an error', async () => {
  stubGateway(toolCallEnvelope);
  const { text, output } = await callLlmWithTools('m', 'sys', 'q', [], 't', 512);
  assert.equal(text, '', 'a function_call carries no text');
  assert.equal(output[0].type, 'function_call', 'and the call itself is still returned');
});

test('callLlmWithTools: text skips non-message items when both are present', async () => {
  stubGateway({
    output: [
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'message', content: [{ text: 'and here is why' }] },
    ],
    usage: {},
  });
  const { text } = await callLlmWithTools('m', 'sys', 'q', [], 't', 512);
  assert.equal(text, 'and here is why');
});

// ---------------------------------------------------------------------------
// usage and failure
// ---------------------------------------------------------------------------

test('callLlmWithTools: usage is returned so the caller can read the cache counters', async () => {
  stubGateway(messageEnvelope);
  const { usage } = await callLlmWithTools('m', 'sys', 'q', [], 't', 512);
  assert.equal(usage.input_tokens_details.cache_read_input_tokens, 5);
});

test('callLlmWithTools: an empty output array throws rather than returning silence', async () => {
  stubGateway({ output: [], usage: {} });
  await assert.rejects(
    () => callLlmWithTools('m', 'sys', 'q', [], 't', 512),
    /no output items/,
  );
});

test('callLlmWithTools: a missing key throws before any request is attempted', async () => {
  stubGateway(messageEnvelope);
  delete process.env.LLM_API_KEY;
  await assert.rejects(
    () => callLlmWithTools('m', 'sys', 'q', [], 't', 512),
    /LLM_API_KEY env var not set/,
  );
  assert.equal(sent, null, 'no request should have been sent');
});

test('callLlmWithTools: max_output_tokens falls back when unspecified', async () => {
  stubGateway(messageEnvelope);
  await callLlmWithTools('m', 'sys', 'q', [], 't');
  assert.equal(typeof sent.max_output_tokens, 'number');
  assert.ok(sent.max_output_tokens > 0);
});
