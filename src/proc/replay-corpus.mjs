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

import { getRows }         from '../shared/serv-client.mjs';
import { COMPONENT_ORDER } from './fingerprint.mjs';

// memory is the only SOFT component (arch-replay.md §8): PGC_Memory accumulates, so
// an identical request assembled later retrieves a different block. Drift confined to
// memory is reused-and-logged (soft); drift in any HARD component breaks.
const SOFT_COMPONENTS = new Set(['memory']);

// ---------------------------------------------------------------------------
// Pure classification — unit-tested; no I/O
// ---------------------------------------------------------------------------

/**
 * Component names that differ between the current call and a candidate recording.
 * Judged over COMPONENT_ORDER — the seven defined components — never over whatever keys
 * happen to be present. A stored request_fingerprint also carries `input_keys` (A6), which
 * is a finer view of `input`, not a component; diffing the raw key union would report it as
 * an eighth drifting component and pollute every drift list.
 */
export function diffComponents(current, candidate) {
  const cur = current ?? {};
  const cand = candidate ?? {};
  const drift = [];
  for (const k of COMPONENT_ORDER) if (cur[k] !== cand[k]) drift.push(k);
  return drift.sort();
}

/** A recording predating the fingerprint seam carries no components to compare against. */
function isFingerprinted(row) {
  const fp = row?.request_fingerprint;
  return fp != null && Object.keys(fp).length > 0;
}

/**
 * Classify a set of source-run candidate recordings (rows carrying
 * `request_fingerprint` component maps) against the current call's components.
 * Returns { status, row?, drift?, candidateIds } — no I/O. `row` is the chosen candidate;
 * `candidateIds` is every recording of the step, so a break report always states what was
 * available and `use_recorded` can name one of them rather than accept the pick.
 */
export function classifyDrift(components, candidates) {
  if (!candidates || candidates.length === 0) return { status: 'miss' };
  const candidateIds = candidates.map(r => r.id);

  // A recording made before the fingerprint seam existed has nothing to compare against.
  // Diffing it against an absent fingerprint would report every component as drifted —
  // an assertion that they moved, when in truth they were never measured. 'unfingerprinted'
  // is its own verdict: it still breaks, but the report says why.
  const comparable = candidates.filter(isFingerprinted);
  if (comparable.length === 0) return { status: 'unfingerprinted', row: candidates[0], candidateIds };

  const scored = comparable.map(row => ({ row, drift: diffComponents(components, row.request_fingerprint) }));

  // Defensive: an empty diff would have matched the composite hash upstream, but if
  // one appears treat it as the hit it is.
  const exact = scored.find(s => s.drift.length === 0);
  if (exact) return { status: 'hit', row: exact.row, drift: [], candidateIds };

  // Soft: every drifting component is soft (memory). Prefer a soft candidate — reuse.
  const soft = scored.find(s => s.drift.every(c => SOFT_COMPONENTS.has(c)));
  if (soft) return { status: 'soft_drift', row: soft.row, drift: soft.drift, candidateIds };

  // Hard: report against the most similar candidate (fewest drifting components).
  scored.sort((a, b) => a.drift.length - b.drift.length);
  return { status: 'hard_drift', row: scored[0].row, drift: scored[0].drift, candidateIds };
}

// ---------------------------------------------------------------------------
// A9 — drift DISPOSITION, not just detection (arch-replay.md §8)
// ---------------------------------------------------------------------------
//
// classifyDrift already knows WHICH components moved. The gap Sessions 4/5 found is that the
// break offered `use_recorded` as "free, keeps the suffix free" REGARDLESS of what moved —
// including step 23 pass 2, where accepting the recording answers a materially different
// question and discards 10KB of repair context. Disposition is a policy over the hashes
// already computed — no new hash. `input` is the one ambiguous component: `step_type_contracts`
// moving is benign (injected contract; accepting was right at step 11/action_key), the
// question-keys moving is fatal. It is disambiguated with A6's per-key diff, never at
// component level alone.

// Headline reflects the MOST severe drifting component; this ranks them.
const DISPOSITION_SEVERITY = { reuse: 0, intended: 0, downstream: 1, judgment: 2, caution: 3, refused: 4 };

// `input` keys that are injected system knowledge, not the user's question. When the only input
// keys that moved are these, the drift is benign and `use_recorded` is defensible.
const BENIGN_INPUT_KEYS = new Set(['step_type_contracts']);

const DISPOSITION_HEADLINE = {
  reuse:      '✅ recorded response answers the same request — use_recorded is safe',
  intended:   '✅ use_recorded is the intended resolution here — accepting keeps this step free',
  downstream: 'use_recorded reuses the recording; review-output guards the schema on resume',
  judgment:   '⚠ use_recorded reuses a response from a different model — your call',
  caution:    '⚠ cannot confirm this is the same request — inspect the prompt before use_recorded',
  refused:    '⛔ a DIFFERENT question was asked — use_recorded would answer the wrong one; call_live or supply',
};

// Union of the input keys whose value differs from the recording (added, removed, or changed).
function movedInputKeys(inputDiff) {
  if (!inputDiff) return null;
  return [
    ...(inputDiff.added   ?? []).map(e => e.key),
    ...(inputDiff.removed ?? []).map(e => e.key),
    ...(inputDiff.changed ?? []).map(e => e.key),
  ];
}

// Disposition of ONE drifting component toward use_recorded.
function componentDisposition(component, inputDiff) {
  switch (component) {
    case 'memory':
      return { verdict: 'reuse',      note: 'memory accumulated since the recording — reuse is safe (soft)' };
    case 'prompt':
      return { verdict: 'intended',   note: 'prompt reworded — use_recorded is exactly this case' };
    case 'system_context':
      return { verdict: 'intended',   note: 'injected system context changed, not the question' };
    case 'schema':
      return { verdict: 'downstream', note: 'output schema changed — review-output fails the run if the recording no longer validates' };
    case 'model':
      return { verdict: 'judgment',   note: "different model — use_recorded reuses another model's answer" };
    case 'user_input':
      return { verdict: 'refused',    note: 'the user message changed — a different question was asked' };
    case 'input': {
      const moved = movedInputKeys(inputDiff);
      if (moved == null) {
        return { verdict: 'caution',  note: 'input changed; per-key breakdown unavailable (candidate predates A6) — inspect before use_recorded' };
      }
      const material = moved.filter(k => !BENIGN_INPUT_KEYS.has(k));
      if (material.length === 0) {
        return { verdict: 'intended', note: 'only injected contracts moved (step_type_contracts) — not the question' };
      }
      return { verdict: 'refused',    note: `a different question was asked — ${material.join(', ')} moved; use_recorded would answer the wrong question` };
    }
    default:
      return { verdict: 'judgment',   note: `${component} changed` };
  }
}

/**
 * A9 — how `use_recorded` should be treated given which components drifted. Pure; no I/O.
 * Returns { verdict, headline, components }: `verdict` is the most severe per-component
 * disposition and drives the notification's framing; `components` maps each drifting component
 * to its own { verdict, note }. Meaningful only when a candidate exists (miss/always offer no
 * recording to accept).
 *
 * @param {object} params
 * @param {string[]|null} params.drift     drifting component names (classifyDrift output)
 * @param {object|null}   params.inputDiff describeInputDrift output — disambiguates `input`
 * @param {string}        params.reason    break reason (hit/soft_drift/hard_drift/unfingerprinted/…)
 */
export function dispositionForDrift({ drift, inputDiff = null, reason } = {}) {
  // A candidate that predates the fingerprint seam could not be compared: not "the same
  // request", not a known drift — inspect before accepting.
  if (reason === 'unfingerprinted') {
    return { verdict: 'caution', headline: DISPOSITION_HEADLINE.caution, components: {} };
  }
  if (!Array.isArray(drift) || drift.length === 0) {
    return { verdict: 'reuse', headline: DISPOSITION_HEADLINE.reuse, components: {} };
  }
  const components = {};
  for (const c of drift) components[c] = componentDisposition(c, inputDiff);
  const worst = drift
    .map(c => components[c].verdict)
    .reduce((a, b) => (DISPOSITION_SEVERITY[b] > DISPOSITION_SEVERITY[a] ? b : a));
  return { verdict: worst, headline: DISPOSITION_HEADLINE[worst], components };
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
  return 'break';                          // 'hard_drift' | 'miss' | 'unfingerprinted'
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
 * @returns {Promise<{ status, candidate?, drift?, candidateIds? }>}
 *   status       'hit' | 'soft_drift' | 'hard_drift' | 'miss' | 'unfingerprinted'
 *   candidate    { sessionId, response }  present for hit/soft_drift/hard_drift/unfingerprinted
 *   drift        string[] of drifting component names (soft_drift/hard_drift only —
 *                absent for 'unfingerprinted', where no comparison was possible)
 *   candidateIds session ids of every recording of the step in the source run, newest first.
 *                Absent on a composite-hash hit (no candidate set was read). >1 under
 *                'unfingerprinted' means the pick in `candidate` is arbitrary and cannot be
 *                trusted without a human decision — resolve with an explicit `sessionId`.
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
  return {
    status:       verdict.status,
    candidate:    await withResponse(verdict.row),
    drift:        verdict.drift,
    candidateIds: verdict.candidateIds,
  };
}

/**
 * Fetch the final recorded response for a specific session id — used when a break is
 * resolved with `use_recorded` (arch-replay.md §5), which accepts a named candidate
 * recording rather than re-running the lookup.
 */
export async function getRecordedResponse(sessionId) {
  const { response } = await withResponse({ id: sessionId });
  return response;
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
  // fingerprint travels with the candidate so the seam can diff against it without a second
  // read (A6). Absent on the getRecordedResponse path, which passes a bare { id } and wants
  // only the response.
  return { sessionId: row.id, response: parseMaybeJson(content), fingerprint: row.request_fingerprint ?? null };
}

function parseMaybeJson(content) {
  if (content == null) return null;
  try { return JSON.parse(content); } catch { return content; }
}
