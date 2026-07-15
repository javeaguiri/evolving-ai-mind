// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/replay-schema.test.mjs
//
// Sprint 8 A1 — LLM replay harness schema guards (docs/arch-replay.md §7, §7a).
//
// Two failure modes this locks down:
//   1. The fail-closed-to-`never` trap. run-workflow.mjs reads the break policy off
//      the run row via the LOAD_RUN_COLUMNS whitelist. Drop replay_source_run_id /
//      llm_break_policy from that list and the policy arrives undefined — the run
//      falls back to `never` and silently bills a run that was meant to replay free.
//   2. The one-truth-in-N-places drift. The new columns and the status enum live in
//      the table template AND the seed_PGC_Schema registry. They must not diverge.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LOAD_RUN_COLUMNS } from '../../src/proc/run-workflow.mjs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url)));

const runTemplate     = readJson('../../src/serv/templates/pgc/PGC_WorkflowRun.json');
const sessionTemplate = readJson('../../src/serv/templates/pgc/PGC_Session.json');
const registry        = readJson('../../src/serv/templates/pgc/seeds/seed_PGC_Schema.json');

const registryRow = (name) => registry.find(r => r.table_name === name);
const colNames    = (def)  => new Set(def.columns.map(c => c.name));
const checkExpr   = (def, name) =>
  (def.constraints || []).find(c => c.name === name)?.expression;

describe('replay harness — LOAD_RUN_COLUMNS whitelist', () => {
  it('carries llm_break_policy so the break policy is never undefined at the seam', () => {
    assert.ok(
      LOAD_RUN_COLUMNS.includes('llm_break_policy'),
      'llm_break_policy missing from LOAD_RUN_COLUMNS — run would fail closed to `never` and bill a replay'
    );
  });

  it('carries replay_source_run_id so the corpus lookup is scoped', () => {
    assert.ok(LOAD_RUN_COLUMNS.includes('replay_source_run_id'));
  });
});

describe('replay harness — PGC_WorkflowRun schema', () => {
  it('template + registry both declare the two replay columns', () => {
    for (const def of [runTemplate, registryRow('PGC_WorkflowRun')]) {
      const cols = colNames(def);
      assert.ok(cols.has('replay_source_run_id'), 'replay_source_run_id missing');
      assert.ok(cols.has('llm_break_policy'),     'llm_break_policy missing');
    }
  });

  it('chk_run_status enumerates awaiting_llm_break in template and registry, identically', () => {
    const tpl = checkExpr(runTemplate, 'chk_run_status');
    const reg = checkExpr(registryRow('PGC_WorkflowRun'), 'chk_run_status');
    assert.ok(tpl.includes('awaiting_llm_break'), 'template chk_run_status missing awaiting_llm_break');
    assert.equal(tpl, reg, 'chk_run_status drifted between template and registry');
  });

  it('chk_run_break_policy constrains llm_break_policy in template and registry, identically', () => {
    const tpl = checkExpr(runTemplate, 'chk_run_break_policy');
    const reg = checkExpr(registryRow('PGC_WorkflowRun'), 'chk_run_break_policy');
    assert.ok(tpl, 'chk_run_break_policy missing from template');
    assert.equal(tpl, reg, 'chk_run_break_policy drifted between template and registry');
    for (const v of ['never', 'on_miss', 'always']) assert.ok(tpl.includes(v));
  });
});

describe('replay harness — PGC_Session schema', () => {
  it('template + registry both declare the four fingerprint columns', () => {
    const expected = ['request_fingerprint', 'fingerprint_hash', 'response_source', 'replayed_from_session_id'];
    for (const def of [sessionTemplate, registryRow('PGC_Session')]) {
      const cols = colNames(def);
      for (const c of expected) assert.ok(cols.has(c), `${c} missing from ${def.table_name} columns`);
    }
  });

  it('chk_pgc_session_response_source constrains response_source in template and registry, identically', () => {
    const tpl = checkExpr(sessionTemplate, 'chk_pgc_session_response_source');
    const reg = checkExpr(registryRow('PGC_Session'), 'chk_pgc_session_response_source');
    assert.ok(tpl, 'chk_pgc_session_response_source missing from template');
    assert.equal(tpl, reg, 'chk_pgc_session_response_source drifted between template and registry');
    for (const v of ['live', 'replayed', 'recorded']) assert.ok(tpl.includes(v));
  });
});
