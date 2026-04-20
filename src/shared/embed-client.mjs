// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/embed-client.mjs
//
// Perplexity embeddings API wrapper.
// Used by:
//   src/serv/table.mjs  — write-time auto-embedding (insertRow, updateRows)
//
// Model: pplx-embed-v1-0.6b — 1024 dimensions, INT8 quantization, $0.004/M tokens.
// Sufficient for domain alias semantic matching and workflow routing similarity.
//
// API key and endpoint are injected as Lambda environment variables by CloudFormation
// ({{resolve:ssm:...}} at deploy time). No runtime SSM call required.
//
// Response format: base64-encoded signed INT8 values per the Perplexity embeddings spec.
// Decoded to a number[] before storage — pgvector accepts integer values and normalises
// internally for cosine distance (<=> operator).

const EMBEDDING_MODEL     = 'pplx-embed-v1-0.6b';
const EMBEDDING_DIMENSION = 1024;

// ---------------------------------------------------------------------------
// embedText — convert text to a 1024-dimension integer array
// ---------------------------------------------------------------------------

/**
 * Embed text using Perplexity pplx-embed-v1-0.6b.
 * Returns a number[] of EMBEDDING_DIMENSION signed integer values (INT8 decoded).
 * pgvector stores these as float4 and normalises for cosine similarity.
 *
 * @param {string} text     Source text to embed
 * @param {string} traceId  Correlation ID for logging
 * @returns {Promise<number[]>}
 */
export async function embedText(text, traceId) {
  if (!text || !text.trim()) {
    throw new Error('embedText: text must be a non-empty string');
  }

  const apiUrl = process.env.EMBEDDINGS_API_URL;
  const apiKey = process.env.EMBEDDING_API_KEY;

  if (!apiUrl) throw new Error('EMBEDDINGS_API_URL env var is not set');
  if (!apiKey) throw new Error('EMBEDDING_API_KEY env var is not set');

  const resp = await fetch(apiUrl, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:  EMBEDDING_MODEL,
      input:  [text.trim()],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Perplexity embeddings API error ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const b64  = data?.data?.[0]?.embedding;

  if (typeof b64 !== 'string') {
    throw new Error(`embedText: unexpected response shape from Perplexity (traceId=${traceId})`);
  }

  const vector = decodeBase64Int8(b64);

  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `embedText: expected ${EMBEDDING_DIMENSION} dimensions, got ${vector.length} (traceId=${traceId})`
    );
  }

  console.info('embed-client: embedded text', { traceId, chars: text.length, dims: vector.length });
  return vector;
}

// ---------------------------------------------------------------------------
// decodeBase64Int8 — decode Perplexity base64_int8 response to number[]
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded signed INT8 embedding string to a plain number array.
 * Perplexity returns base64_int8 by default — each byte is a signed 8-bit integer.
 *
 * @param {string} b64  Base64-encoded INT8 embedding from API response
 * @returns {number[]}
 */
function decodeBase64Int8(b64) {
  const buf  = Buffer.from(b64, 'base64');
  const int8 = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return Array.from(int8);
}

// ---------------------------------------------------------------------------
// parseVector — parse PostgreSQL vector string → number[]
//
// pgvector returns vector columns as the string "[0.1,0.2,...]" because the
// pg library treats unknown OID types as text. Parse before cosine comparisons.
// ---------------------------------------------------------------------------

/**
 * Convert a PostgreSQL vector string or an already-parsed number[] to number[].
 *
 * @param {string|number[]} pgVal  Raw value from pg row
 * @returns {number[]}
 */
export function parseVector(pgVal) {
  if (Array.isArray(pgVal)) return pgVal;
  if (typeof pgVal === 'string') {
    return pgVal.replace(/^\[|\]$/g, '').split(',').map(Number);
  }
  throw new Error(`parseVector: cannot parse value of type ${typeof pgVal}`);
}
