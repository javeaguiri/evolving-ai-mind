// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/embed-client.mjs
//
// Perplexity embeddings API wrapper.
// Used by:
//   src/serv/table.mjs  — write-time auto-embedding (insertRow, updateRows)
//
// Model: pplx-embed-v1-4b — 2560 dimensions, INT8 quantization, $0.03/M tokens.
// Higher quality than 0.6b; required for reliable cosine similarity at 0.75 threshold.
// At household scale (~1K classifications/month) cost is under $0.01/month.
//
// API key and endpoint are injected as Lambda environment variables by CloudFormation
// ({{resolve:ssm:...}} at deploy time). No runtime SSM call required.
//
// Response format: base64-encoded signed INT8 values per the Perplexity embeddings spec.
//
// Document embedding strategy — embedTexts():
//   Each source field value (aliases individually, description, domain name) is passed
//   as a separate string in one batched API call. The resulting vectors are averaged
//   component-by-component into a single stored vector. This produces better recall
//   for short focused queries (e.g. "flashcards") because each alias contributes its
//   own dedicated representation to the averaged centroid rather than being diluted
//   into a long concatenated string embedding.
//
// Query embedding — embedText():
//   Single-string embed for query-time use in getRows vectorSearch. Short natural
//   language queries embed correctly as a single input.

const EMBEDDING_MODEL     = 'pplx-embed-v1-4b';
const EMBEDDING_DIMENSION = 2560;

// ---------------------------------------------------------------------------
// callEmbeddingsApi — shared HTTP call; returns decoded vectors in input order
// ---------------------------------------------------------------------------

async function callEmbeddingsApi(inputs, traceId) {
  const apiUrl = process.env.EMBEDDING_API_URL;
  const apiKey = process.env.EMBEDDING_API_KEY;

  if (!apiUrl) throw new Error('EMBEDDING_API_URL env var is not set');
  if (!apiKey) throw new Error('EMBEDDING_API_KEY env var is not set');

  const resp = await fetch(apiUrl, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Perplexity embeddings API error ${resp.status}: ${body}`);
  }

  const data = await resp.json();

  if (!Array.isArray(data?.data) || data.data.length !== inputs.length) {
    throw new Error(`callEmbeddingsApi: unexpected response shape (traceId=${traceId})`);
  }

  // API returns results in the same order as inputs — decode each.
  return data.data
    .sort((a, b) => a.index - b.index)
    .map(item => {
      const vec = decodeBase64Int8(item.embedding);
      if (vec.length !== EMBEDDING_DIMENSION) {
        throw new Error(
          `callEmbeddingsApi: expected ${EMBEDDING_DIMENSION} dims, got ${vec.length} (traceId=${traceId})`
        );
      }
      return vec;
    });
}

// ---------------------------------------------------------------------------
// embedTexts — batch embed multiple strings, return averaged vector
//
// Used at document write time. Each string (alias, description, domain name)
// is embedded separately in one API call and the results are averaged.
// ---------------------------------------------------------------------------

/**
 * Embed multiple text strings and return a single averaged vector.
 * Empty strings are silently filtered before the API call.
 * One Perplexity API call regardless of how many input strings.
 *
 * @param {string[]} texts   Array of text fragments to embed and average
 * @param {string}   traceId Correlation ID for logging
 * @returns {Promise<number[]>}
 */
export async function embedTexts(texts, traceId) {
  const valid = texts.map(t => (t ?? '').trim()).filter(Boolean);
  if (valid.length === 0) throw new Error('embedTexts: no non-empty strings to embed');

  const vectors = await callEmbeddingsApi(valid, traceId);

  const averaged = averageVectors(vectors);
  console.info('embed-client: embedded text batch', {
    traceId, inputs: valid.length, dims: averaged.length,
  });
  return averaged;
}

// ---------------------------------------------------------------------------
// embedText — embed a single string; used for query-time vectorSearch
// ---------------------------------------------------------------------------

/**
 * Embed a single text string.
 * Used by getRows vectorSearch — query text is always a single natural language phrase.
 *
 * @param {string} text     Text to embed
 * @param {string} traceId  Correlation ID for logging
 * @returns {Promise<number[]>}
 */
export async function embedText(text, traceId) {
  if (!text || !text.trim()) {
    throw new Error('embedText: text must be a non-empty string');
  }
  const [vector] = await callEmbeddingsApi([text.trim()], traceId);
  console.info('embed-client: embedded text', { traceId, chars: text.length, dims: vector.length });
  return vector;
}

// ---------------------------------------------------------------------------
// averageVectors — component-wise mean of N float vectors
// ---------------------------------------------------------------------------

/**
 * Average N equal-length vectors component by component.
 * Result is a float[] matching the input dimension — pgvector accepts float values.
 *
 * @param {number[][]} vectors
 * @returns {number[]}
 */
function averageVectors(vectors) {
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += vec[i];
  }
  return sum.map(v => v / vectors.length);
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
