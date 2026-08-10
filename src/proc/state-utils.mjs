// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/state-utils.mjs
//
// Pure interpretation of a step's output_key against the value the step produced.
// One rule, one implementation — the Step Processor writes local_state with it and
// the simulation engine models local_state with it, so the simulator cannot disagree
// with the engine about what a step leaves behind.
//
// The divergence this exists to prevent (create_domain v58, run 763): the engine
// destructures an object return only when output_key names more than one key, while
// the simulator assigned the whole return value to every listed key. A single
// output_key over an object-returning expression therefore nested the object under
// its own name at runtime — `{{domain_request}}` resolved to
// `{ domain_request: "inventory" }` — and the simulator modelled the multi-key form
// as the object it never becomes.
//
// No I/O. Callers own the write itself, because they write to different things:
// the engine to a stack frame via a dot-path setter, the simulator to a flat mock
// state keyed by base name.

/**
 * Resolve which local_state keys a step's output value populates.
 *
 * A comma-separated output_key ("a,b,c") destructures an object return value into
 * multiple top-level keys; a key the object does not carry is not written, matching
 * the engine's `key in value` test. Every other shape — one key, or a comma list
 * over a non-object — is a single whole-value write.
 *
 * @param {string} outputKey  the step's output_key, verbatim
 * @param {*}      value      the value the step produced
 * @returns {Array<{ key: string, value: * }>} writes to apply, in declaration order
 */
export function resolveOutputWrites(outputKey, value) {
  if (typeof outputKey !== 'string') return [];

  const keys = outputKey.split(',').map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) return [];

  if (keys.length > 1) {
    // A comma list over a non-object cannot be destructured. The engine writes the
    // whole value under the raw output_key in that case, producing a local_state key
    // literally named "a,b" — preserved here rather than corrected, because changing
    // it is a behaviour change and not this fix. Nothing in the seeds hits it.
    if (value === null || typeof value !== 'object') return [{ key: outputKey, value }];
    return keys.filter(k => k in value).map(k => ({ key: k, value: value[k] }));
  }

  return [{ key: keys[0], value }];
}
