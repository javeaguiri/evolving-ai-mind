// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/step-type-registry.mjs
//
// The one read of PGC_StepType on behalf of validation.
//
// L0 (simulation-engine.mjs) composes its assertions from `input_contract`, and
// the engine is pure — so every consumer of L0 has to supply the contracts. That
// is four call sites (the simulate step type, the standalone endpoint,
// troubleshoot-workflow, and the upsert pre-write guard) which would otherwise
// each carry their own copy of this query. A registry read written four times is
// how a registry copy drifts from the registry; see arch-minds-eye.md §12.8.
//
// Deliberately NOT shared with llm-harness.mjs, which fetches the same table to
// inject `step_type_contracts` into a prompt. That read is column-scoped and
// ordered because the assembled request is fingerprinted for the replay corpus
// (docs/arch-replay.md §3): a change to what it returns invalidates every
// recording made against those prompts. Coupling the two would put a validation
// change one edit away from silently churning the corpus.
//
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { getRows } from '../shared/serv-client.mjs';

/**
 * Live step type contracts, for L0.
 *
 * Returns null rather than an empty array when the read fails: L0 distinguishes
 * "no contracts supplied" (it reports `ran: false`) from "contracts supplied and
 * this step type is not among them" (an unknown_step_type issue). An empty array
 * would turn a SERV failure into a claim that every step type is invalid.
 *
 * @param {string} [traceId]
 * @returns {Promise<object[]|null>}
 */
export async function loadStepTypeContracts(traceId) {
  const resp = await getRows(
    'PGC_StepType',
    [{ column: 'status', op: 'eq', value: 'live' }],
  );

  if (!resp.success || !Array.isArray(resp.rows) || resp.rows.length === 0) {
    console.warn('step-type-registry: PGC_StepType read returned no contracts — L0 will report not-run', {
      success: resp.success, count: resp.rows?.length ?? 0, traceId,
    });
    return null;
  }

  return resp.rows;
}
