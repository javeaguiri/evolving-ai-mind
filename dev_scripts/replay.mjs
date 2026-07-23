// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.

// dev_scripts/replay.mjs
// A8 — the replay harness developer loop (docs/arch-replay.md §9 "Dev script").
//
// A thin wrapper over the three /proc/replay HTTP endpoints, with NO logic of its own:
//
//   start run  →  poll  →  on break, write assembled prompt + drift report to a local file
//              →  wait for a resume file  →  POST the resolution  →  continue
//
// The drift disposition (A9), blast radius (A12) and per-key input diff (A6) are computed
// server-side and stashed on the break frame; this script only renders what the GET returns
// and posts back what the developer decides. It never decides a resolution itself.
//
// Usage:
//   node dev_scripts/replay.mjs <sourceRunId> [flags]      replay an existing run
//   node dev_scripts/replay.mjs --workflow <name> --input <file.json> --record [flags]
//                                                          record a workflow that never ran
//
// Flags:
//   --record            breakPolicy: always (break at every llm_call). Default: on_miss.
//   --policy <p>        never | on_miss | always (overrides --record).
//   --auto <resolution> resolve EVERY break the same payload-free way, unattended:
//                       use_recorded | call_live | abort. Never valid for `supplied`.
//                       On a clean corpus with --policy on_miss there are no breaks and
//                       this never fires — a $0 regression assertion (arch-replay.md §10).
//   --dir <path>        working directory for break/prompt/resume files. Default: ./.replay
//   --interval <ms>     poll interval. Default: 3000.
//
// Resolving a break by hand (when --auto is not set): the script writes
//   <dir>/prompt-<runId>-step<step>.txt   the assembled prompt, verbatim
//   <dir>/break-<runId>-step<step>.json   the drift report (disposition, blast radius, input diff)
// then waits for you to create
//   <dir>/resume-<runId>.json   e.g. { "resolution": "use_recorded" }
//                                    { "resolution": "supplied", "response": { ... } }
//                                    { "resolution": "call_live", "breakPolicy": "always" }
// The break can also be resolved out-of-band from the Slack buttons (A11); the script
// notices the run left the break and continues either way.
//
// Env: SERV_API_URL and INTERNAL_API_KEY (already exported via .bashrc). Same as the
// upsert-* scripts — the replay routes sit behind the same API Gateway as SERV.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';

const BASE = process.env.SERV_API_URL;
const KEY  = process.env.INTERNAL_API_KEY;
const POLICIES     = ['never', 'on_miss', 'always'];
const PAYLOAD_FREE = ['use_recorded', 'call_live', 'abort'];
const TERMINAL     = ['completed', 'failed', 'cancelled'];

if (!BASE) { console.error('ERROR: SERV_API_URL env var not set'); process.exit(1); }
if (!KEY)  { console.error('ERROR: INTERNAL_API_KEY env var not set'); process.exit(1); }

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--record') { flags.record = true; continue; }
    if (a.startsWith('--')) { flags[a.slice(2)] = argv[++i]; continue; }
    positional.push(a);
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));

const sourceRunId = positional[0] != null ? Number(positional[0]) : null;
const policy      = flags.policy ?? (flags.record ? 'always' : 'on_miss');
const auto        = flags.auto ?? null;
const workDir     = flags.dir ?? '.replay';
const interval    = flags.interval != null ? Number(flags.interval) : 3000;

if (!POLICIES.includes(policy)) {
  console.error(`ERROR: --policy must be one of: ${POLICIES.join(', ')}`);
  process.exit(1);
}
if (auto != null && !PAYLOAD_FREE.includes(auto)) {
  console.error(`ERROR: --auto must be one of: ${PAYLOAD_FREE.join(', ')} (supplied carries a payload and cannot be automated)`);
  process.exit(1);
}
if (sourceRunId == null && !flags.workflow) {
  console.error('Usage: node dev_scripts/replay.mjs <sourceRunId> [flags]');
  console.error('       node dev_scripts/replay.mjs --workflow <name> --input <file.json> --record [flags]');
  process.exit(1);
}

if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

// ---------------------------------------------------------------------------
// HTTP helpers — the three endpoints, nothing else
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`${method} ${path} → ${resp.status}: ${data.error ?? text}`);
  }
  return data;
}

const startReplay  = (bodyExtra) => api('POST', '/api/v1/proc/replay', { breakPolicy: policy, ...bodyExtra });
const getReplay    = (runId)     => api('GET',  `/api/v1/proc/replay/${runId}`);
const resumeReplay = (runId, b)  => api('POST', `/api/v1/proc/replay/${runId}/resume`, b);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Break rendering
// ---------------------------------------------------------------------------
// Mirrors run-workflow.mjs summariseInputDrift — same input_diff shape the server stashes on
// the frame (added/removed: {key, chars}; changed: {key, was_chars, chars}; unchanged: [key]).
function summariseInputDiff(diff) {
  if (!diff) return null;
  const fmt = (e) => `${e.key} (${e.chars ?? '?'} chars)`;
  const parts = [];
  if (diff.added?.length)   parts.push(`added: ${diff.added.map(fmt).join(', ')}`);
  if (diff.removed?.length) parts.push(`removed: ${diff.removed.map(fmt).join(', ')}`);
  if (diff.changed?.length) parts.push(`changed: ${diff.changed.map(e => `${e.key} (${e.was_chars ?? '?'}→${e.chars ?? '?'} chars)`).join(', ')}`);
  if (!parts.length) return null;
  if (diff.unchanged?.length) parts.push(`unchanged: ${diff.unchanged.join(', ')}`);
  return parts.join('  |  ');
}

function printBreak(runId, report) {
  const b = report;
  console.log('');
  console.log(`🛑  Run ${runId} — BROKE at step ${b.step_id} · ${b.intent_category}`);
  console.log(`    reason      ${b.reason}${Array.isArray(b.drift) && b.drift.length ? `  (drift: ${b.drift.join(', ')})` : ''}`);
  if (b.disposition?.headline) console.log(`    disposition ${b.disposition.headline}`);
  const inputTxt = summariseInputDiff(b.input_diff);
  if (inputTxt) console.log(`    input       ${inputTxt}`);
  for (const [k, readers] of Object.entries(b.blast_radius ?? {})) {
    console.log(`    ⤷ ${k} is also read by step${readers.length > 1 ? 's' : ''} ${readers.join(', ')} — accepting here only defers that decision`);
  }
  if (b.candidate_ids?.length) console.log(`    recordings  ${b.candidate_ids.join(', ')}${b.candidate_ids.length > 1 ? ' (name one with "sessionId")' : ''}`);
}

// ---------------------------------------------------------------------------
// Break resolution — write the report, then either auto-resolve or wait for a file
// ---------------------------------------------------------------------------
async function resolveBreak(runId, report) {
  const stepTag    = String(report.step_id).replace(/[^\w.-]/g, '_');
  const promptFile = join(workDir, `prompt-${runId}-step${stepTag}.txt`);
  const breakFile  = join(workDir, `break-${runId}-step${stepTag}.json`);
  const resumeFile = join(workDir, `resume-${runId}.json`);

  writeFileSync(promptFile, report.instructions ?? '(no assembled prompt on the frame)');
  // The drift report without the (large) assembled prompt — that lives in the .txt.
  const { instructions, ...driftReport } = report;
  writeFileSync(breakFile, JSON.stringify(driftReport, null, 2));

  printBreak(runId, report);
  console.log(`    prompt   → ${promptFile}`);
  console.log(`    report   → ${breakFile}`);

  if (auto != null) {
    console.log(`    auto-resolving: ${auto}`);
    await resumeReplay(runId, { resolution: auto });
    return;
  }

  console.log(`    write a resolution to ${resumeFile}  e.g. {"resolution":"use_recorded"}`);
  console.log('    (or resolve from the Slack buttons — the script will notice)');

  // Wait for either a resume file to appear, or the run to leave the break out-of-band.
  for (;;) {
    await sleep(interval);
    if (existsSync(resumeFile)) {
      let body;
      try { body = JSON.parse(readFileSync(resumeFile, 'utf8')); }
      catch (e) { console.error(`    ✗ ${resumeFile} is not valid JSON (${e.message}) — fix it`); continue; }
      renameSync(resumeFile, `${resumeFile}.done`);   // consume it so it is not re-read
      await resumeReplay(runId, body);
      console.log(`    ✓ resumed: ${body.resolution}`);
      return;
    }
    const now = await getReplay(runId);
    if (now.status !== 'awaiting_llm_break') {
      console.log('    (break resolved elsewhere — continuing)');
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  let start;
  if (sourceRunId != null) {
    start = await startReplay({ sourceRunId });
    console.log(`▶  replay run ${start.runId} started — replaying run ${sourceRunId}, policy ${policy}`);
  } else {
    const input = JSON.parse(readFileSync(flags.input, 'utf8'));
    start = await startReplay({ workflow: flags.workflow, input });
    console.log(`▶  record run ${start.runId} started — workflow ${flags.workflow}, policy ${policy}`);
  }

  const runId = start.runId;
  let phase = 'polling';   // 'polling' | 'resuming' — after a resume, ignore the break until the run moves

  for (;;) {
    const { status, break: report } = await getReplay(runId);

    if (TERMINAL.includes(status)) {
      console.log(`\n${status === 'completed' ? '✅' : '⛔'}  Run ${runId} — ${status}`);
      process.exit(status === 'completed' ? 0 : 1);
    }

    if (status === 'awaiting_llm_break' && phase === 'polling' && report) {
      await resolveBreak(runId, report);
      phase = 'resuming';
      continue;
    }

    if (status !== 'awaiting_llm_break' && phase === 'resuming') {
      phase = 'polling';   // the run accepted the resume and moved on
    }

    if (status === 'awaiting_human_gate') {
      process.stdout.write('⌛ awaiting human gate (answer in Slack)\r');
    }

    await sleep(interval);
  }
}

main().catch(e => { console.error(`\nreplay: ${e.message}`); process.exit(1); });
