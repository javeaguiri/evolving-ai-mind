// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/fingerprint.mjs
//
// Request fingerprint for the LLM replay harness (docs/arch-replay.md §3).
//
// A recorded response is addressable by the CONTENT of the request that produced
// it — never by its position in a run. Keying on (run_id, step_id) is unsound: it
// still resolves after a prompt edit, a js_transform change, or a gate answered
// differently, and returns a response generated against a DIFFERENT prompt.
//
// Computed fresh at every llm_call from the assembled request and written to
// PGC_Session. Each component is hashed separately so a break report can attribute
// drift to a cause (which of prompt/input/user_input/model/schema/memory/
// system_context moved); `hash` is the composite corpus lookup key.
//
// Pure, no I/O — imported by llm-harness.mjs (write), and by the replay corpus
// lookup (A3) and break frame (A4).

import { createHash } from 'crypto';

// Fixed order — the composite hash must not depend on object key iteration order.
// Also the definitive list of what IS a component: a stored request_fingerprint may carry
// other keys (input_keys, A6), and drift is judged over these seven only.
export const COMPONENT_ORDER = ['prompt', 'input', 'user_input', 'model', 'schema', 'memory', 'system_context'];

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Canonical JSON with recursively sorted keys, so field ordering never changes a
 * hash. Mirrors the stable-stringify contract used by dev_scripts/upsert-prompt.mjs.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * Compute the per-call request fingerprint.
 *
 * @param {object} params
 * @param {object} params.promptRow       PGC_Prompt row — hashes prompt_text + version + output_schema
 * @param {object} params.resolvedInput   step.input resolved against local_state (post step_type_contracts injection)
 * @param {string} params.userInput       resolved step.input.user_input
 * @param {string} params.model           resolved model ID (post alias)
 * @param {string} params.memoryBlock     the memory block actually injected ('' when memory is off)
 * @param {object} params.injectedContext the PGC_SystemContext subset injected into the prompt (see selectInjectedContext)
 * @returns {{ components: object, hash: string }}
 */
export function computeFingerprint({ promptRow, resolvedInput, userInput, model, memoryBlock, injectedContext }) {
  const components = {
    prompt:         sha256(stableStringify({ version: promptRow?.version ?? null, text: promptRow?.prompt_text ?? '' })),
    input:          sha256(stableStringify(resolvedInput ?? {})),
    user_input:     sha256(String(userInput ?? '')),
    model:          sha256(String(model ?? '')),
    schema:         sha256(stableStringify(promptRow?.output_schema ?? null)),
    memory:         sha256(String(memoryBlock ?? '')),
    system_context: sha256(stableStringify(injectedContext ?? {})),
  };
  const hash = sha256(COMPONENT_ORDER.map(k => components[k]).join(':'));
  return { components, hash, inputKeys: hashInputKeys(resolvedInput) };
}

/**
 * Per-key hashes of `resolvedInput`, for the drift report (A6) and the disposition it
 * feeds (A9). Deliberately NOT a component and NOT in the composite: it is a finer view of
 * `input`, which the composite already covers, so adding it here would double-count and
 * invalidate every recording made before it existed.
 *
 * A single `input` hash cannot be decomposed, and `drift: ['input']` is ambiguous — it covers
 * both benign `step_type_contracts` movement and a materially different question, with opposite
 * correct answers (runs 720/721). Distinguishing them requires per-key hashes to have been
 * *written*; reporting alone cannot recover them.
 *
 * `n` is the serialised size, so a report can say WHAT arrived, not merely THAT something did.
 * @returns {Record<string, {h: string, n: number}>}
 */
export function hashInputKeys(resolvedInput) {
  const out = {};
  for (const [k, v] of Object.entries(resolvedInput ?? {})) {
    const s = stableStringify(v);
    out[k] = { h: sha256(s), n: s.length };
  }
  return out;
}

/**
 * Per-key drift within `input`: which keys arrived, vanished, or changed value.
 * `null` when either side predates A6 — absent per-key hashes are unknowable, never "unchanged".
 * @returns {{added: string[], removed: string[], changed: string[], unchanged: string[]}|null}
 */
export function diffInputKeys(current, candidate) {
  if (current == null || candidate == null) return null;
  const added = [], removed = [], changed = [], unchanged = [];
  for (const k of new Set([...Object.keys(current), ...Object.keys(candidate)]).values()) {
    if (!(k in candidate))      added.push(k);
    else if (!(k in current))   removed.push(k);
    else if (current[k]?.h !== candidate[k]?.h) changed.push(k);
    else                        unchanged.push(k);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged: unchanged.sort() };
}
