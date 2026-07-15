// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/replay-corpus.mjs
//
// Replay corpus read (docs/arch-replay.md §3, §8). Given a request fingerprint,
// find the recorded response that answers the same assembled request and classify
// any drift. A read over the diagnostics log (PGC_Session + PGC_SessionEntry) the
// system already writes for every llm_call — no separate corpus table.
//
// Called from the seam (llm-harness.executeLlmCall) to decide serve-vs-break, and
// (later) from the /proc/replay GET handler to render a break report. SERV reads
// only — no endpoint or SQS concern — so both callers import it without pulling the
// endpoint module into the hot path (which would risk a circular dependency).
//
// Corpus scope (arch-replay.md §12.1): exact composite match is looked up in the
// SOURCE run first, then globally across all runs. Drift classification (soft/hard)
// is judged only against the SOURCE run's recordings for the step — "what did this
// run do here, and how does the current call differ" — which has no meaning globally.

import { getRows } from '../shared/serv-client.mjs';

// memory is the only SOFT component (arch-replay.md §8): PGC_Memory accumulates, so
// an identical request assembled later retrieves a different block. Drift confined to
// memory is reused-and-logged (soft); drift in any HARD component breaks.
const SOFT_COMPONENTS = new Set(['memory']);

// ---------------------------------------------------------------------------
// Pure classification — unit-tested; no I/O
// ---------------------------------------------------------------------------

/** Component names that differ between the current call and a candidate recording. */
export function diffComponents(current, candidate) {
  const cur = current ?? {};
  const cand = candidate ?? {};
  const keys = new Set([...Object.keys(cur), ...Object.keys(cand)]);
  const drift = [];
  for (const k of keys) if (cur[k] !== cand[k]) drift.push(k);
  return drift.sort();
}

/**
 * Classify a set of source-run candidate recordings (rows carrying
 * `request_fingerprint` component maps) against the current call's components.
 * Returns { status, row?, drift? } — no I/O. `row` is the chosen candidate.
 */
export function classifyDrift(components, candidates) {
  if (!candidates || candidates.length === 0) return { status: 'miss' };

  const scored = candidates.map(row => ({ row, drift: diffComponents(components, row.request_fingerprint ?? {}) }));

  // Defensive: an empty diff would have matched the composite hash upstream, but if
  // one appears treat it as the hit it is.
  const exact = scored.find(s => s.drift.length === 0);
  if (exact) return { status: 'hit', row: exact.row, drift: [] };

  // Soft: every drifting component is soft (memory). Prefer a soft candidate — reuse.
  const soft = scored.find(s => s.drift.every(c => SOFT_COMPONENTS.has(c)));
  if (soft) return { status: 'soft_drift', row: soft.row, drift: soft.drift };

  // Hard: report against the most similar candidate (fewest drifting components).
  scored.sort((a, b) => a.drift.length - b.drift.length);
  return { status: 'hard_drift', row: scored[0].row, drift: scored[0].drift };
}

/**
 * The seam decision: break policy × lookup status → action.
 *   'call'  call the LLM (live)      'serve'  serve the recording (zero cost)
 *   'break' suspend for a developer
 */
export function decideReplayAction(breakPolicy, lookupStatus) {
  if (breakPolicy === 'always') return 'break';
  if (breakPolicy !== 'on_miss') return 'call';               // 'never' / null / unknown → live
  if (lookupStatus === 'hit' || lookupStatus === 'soft_drift') return 'serve';
  return 'break';                                              // 'hard_drift' | 'miss'
}

// ---------------------------------------------------------------------------
// lookupRecording — SERV reads + delegates classification to classifyDrift
// ---------------------------------------------------------------------------

/**
 * Find and classify a recording for one llm_call.
 *
 * @param {object} params
 * @param {string} params.compositeHash  the current call's fingerprint_hash
 * @param {object} params.components      the current call's component hash map
 * @param {number|null} params.sourceRunId  run whose corpus is being replayed
 * @param {string} params.stepId          workflow step id
 * @returns {Promise<{ status, candidate?, drift? }>}
 *   status    'hit' | 'soft_drift' | 'hard_drift' | 'miss'
 *   candidate { sessionId, response }  present for hit/soft_drift/hard_drift
 *   drift     string[] of drifting component names (soft_drift/hard_drift)
 */
export async function lookupRecording({ compositeHash, components, sourceRunId, stepId }) {
  // 1 — exact composite match, source run first
  if (sourceRunId != null) {
    const inSource = await findByHash(compositeHash, sourceRunId);
    if (inSource) return { status: 'hit', candidate: await withResponse(inSource) };
  }
  // 2 — exact composite match, any run (global)
  const global = await findByHash(compositeHash, null);
  if (global) return { status: 'hit', candidate: await withResponse(global) };

  // 3 — no exact match: classify against the SOURCE run's recordings for this step
  if (sourceRunId == null) return { status: 'miss' };
  const candidates = await sourceStepSessions(sourceRunId, stepId);
  const verdict = classifyDrift(components, candidates);
  if (verdict.status === 'miss') return { status: 'miss' };
  return { status: verdict.status, candidate: await withResponse(verdict.row), drift: verdict.drift };
}

// --- SERV read helpers ---

async function findByHash(compositeHash, runId) {
  const filters = [{ column: 'fingerprint_hash', op: 'eq', value: compositeHash }];
  if (runId != null) filters.push({ column: 'run_id', op: 'eq', value: runId });
  const resp = await getRows('PGC_Session', filters, { column: 'id', direction: 'desc' }, 1);
  return resp.success && resp.count > 0 ? resp.rows[0] : null;
}

async function sourceStepSessions(sourceRunId, stepId) {
  const resp = await getRows('PGC_Session', [
    { column: 'run_id',  op: 'eq', value: sourceRunId },
    { column: 'step_id', op: 'eq', value: String(stepId) },
  ], { column: 'id', direction: 'desc' });
  return resp.success ? (resp.rows ?? []) : [];
}

// Fetch the FINAL assistant message — the response actually used in the source run
// (the corrected one, if a correction happened). Serving the final response is what
// makes re-validation free: schema is a hard component, so a match means it
// re-validates identically without an LLM correction (see review-output allowLlmCorrection).
async function withResponse(row) {
  const resp = await getRows('PGC_SessionEntry', [
    { column: 'session_id', op: 'eq', value: row.id },
    { column: 'role',       op: 'eq', value: 'assistant' },
  ], { column: 'sequence_number', direction: 'desc' }, 1);
  const content = resp.success && resp.count > 0 ? resp.rows[0].content : null;
  return { sessionId: row.id, response: parseMaybeJson(content) };
}

function parseMaybeJson(content) {
  if (content == null) return null;
  try { return JSON.parse(content); } catch { return content; }
}
