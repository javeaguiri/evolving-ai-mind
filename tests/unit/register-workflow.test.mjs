// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/register-workflow.test.mjs
//
// B2 — the register_workflow gated write tool (Sprint 9, AC4).
//
// Tests the real exported functions, not copies of them: buildIntentMapRows and
// deriveScope are imported from minds-eye.mjs. The parts that need SERV are
// covered by asserting the tool's registration in the harness tables, which is
// where a tool silently fails to be gated.
//
// Run: node --test tests/unit/register-workflow.test.mjs

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAliasDelta, buildIntentMapRows, deriveIntentKeywords, deriveScope } from '../../src/proc/minds-eye.mjs';

const procSrc = readFileSync('src/proc/minds-eye.mjs', 'utf8');

describe('register_workflow — PGC_IntentMap rows', () => {

  it('registers the workflow name as a phrase in its own right', () => {
    const rows = buildIntentMapRows('track_reading', [], 42);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      pattern:         'track_reading',
      intent_category: 'track_reading',
      action_type:     'workflow',
      workflow_id:     42,
      source:          'name',
    });
  });

  it('writes one row per phrase, all pointing at the same workflow', () => {
    const rows = buildIntentMapRows('track_reading', ['log a book', 'add reading'], 42);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.pattern), ['track_reading', 'log a book', 'add reading']);
    assert.ok(rows.every(r => r.intent_category === 'track_reading'));
    assert.ok(rows.every(r => r.workflow_id === 42));
    assert.ok(rows.every(r => r.action_type === 'workflow'));
  });

  it('labels the name row and the supplied phrases differently', () => {
    const rows = buildIntentMapRows('track_reading', ['log a book'], 42);
    assert.equal(rows[0].source, 'name');
    assert.equal(rows[1].source, 'auto');
  });

  it('does not duplicate the name when it is also given as a phrase', () => {
    const rows = buildIntentMapRows('track_reading', ['track_reading', 'log a book'], 42);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter(r => r.pattern === 'track_reading').length, 1);
  });

  it('de-duplicates repeated phrases — two identical patterns route ambiguously', () => {
    const rows = buildIntentMapRows('track_reading', ['log a book', 'log a book'], 42);
    assert.equal(rows.length, 2);
  });

  it('trims surrounding whitespace and drops empty or non-string phrases', () => {
    const rows = buildIntentMapRows('track_reading', ['  log a book  ', '', '   ', null, 7], 42);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].pattern, 'log a book');
  });

  it('tolerates a missing phrase list — the name alone is still registered', () => {
    assert.equal(buildIntentMapRows('track_reading').length, 1);
    assert.equal(buildIntentMapRows('track_reading', null, 1).length, 1);
  });
});

describe('register_workflow — memory scope', () => {

  it('scopes the session to the workflow it registered', () => {
    const history = [{
      role: 'tool',
      content: JSON.stringify({ tool: 'register_workflow', params: { name: 'track_reading' }, result: { success: true } }),
    }];
    assert.equal(deriveScope(history).workflow, 'track_reading');
  });

  it('carries the domain through when the workflow belongs to one', () => {
    const history = [{
      role: 'tool',
      content: JSON.stringify({ tool: 'register_workflow', params: { name: 'track_reading', domain: 'reading_log' }, result: {} }),
    }];
    assert.deepEqual(deriveScope(history), { workflow: 'track_reading', domain: 'reading_log' });
  });

  it('leaves the domain unset for a standalone workflow', () => {
    const history = [{
      role: 'tool',
      content: JSON.stringify({ tool: 'register_workflow', params: { name: 'track_reading', domain: null }, result: {} }),
    }];
    assert.equal(deriveScope(history).domain, undefined);
  });
});

describe('register_workflow — harness registration', () => {

  it('is gated, not an inline write — registration is not reversible by a later turn', () => {
    const gated = procSrc.match(/const GATED_WRITE_TOOLS = new Set\(\[([^\]]+)\]/s)?.[1] ?? '';
    assert.match(gated, /'register_workflow'/);
    const inline = procSrc.match(/const INLINE_WRITE_TOOLS = new Set\(\[([^\]]+)\]/s)?.[1] ?? '';
    assert.doesNotMatch(inline, /register_workflow/);
  });

  it('refuses to write a step array that does not validate', () => {
    // The pre-write guard is the whole point: an approved-but-broken registration is
    // discovered by a user running it, which is worse than a refused one.
    const block = procSrc.match(/case 'register_workflow': \{[\s\S]*?\n      \}/g)?.pop() ?? '';
    assert.match(block, /simulateForRegistration/);
    assert.match(block, /if \(!sim\.passed\)[\s\S]*?not registered/);
  });

  it('refuses a name that already exists rather than updating it', () => {
    const block = procSrc.match(/case 'register_workflow': \{[\s\S]*?\n      \}/g)?.pop() ?? '';
    assert.match(block, /already exists/);
    assert.match(block, /propose_workflow_fix/);
  });
});

describe("register_workflow — intent_keywords derivation", () => {

  it("derives keywords from the invocation phrases when the field is omitted", () => {
    assert.deepEqual(
      deriveIntentKeywords(["log a book", "add reading"], null),
      ["log a book", "add reading"]
    );
  });

  it("keeps supplied keywords — derivation fills a gap, it does not overrule a decision", () => {
    assert.deepEqual(deriveIntentKeywords(["log a book"], ["reading"]), ["reading"]);
  });

  it("dedupes case-insensitively and drops blanks", () => {
    assert.deepEqual(
      deriveIntentKeywords(["log a book", "Log A Book", "  ", "add reading"], null),
      ["log a book", "add reading"]
    );
  });

  it("returns null when there is nothing to derive from, so the gate can still warn", () => {
    assert.equal(deriveIntentKeywords([], null), null);
    assert.equal(deriveIntentKeywords([], []), null);
  });

  it("the write persists the derived value, not the raw parameter", () => {
    const block = procSrc.match(/case 'register_workflow': \{[\s\S]*?\n      \}/g)?.pop() ?? "";
    assert.match(block, /intent_keywords: effectiveKeywords/);
  });
});

describe("manage_routing_aliases — applyAliasDelta", () => {

  it("appends additions at the end and drops removals", () => {
    assert.deepEqual(
      applyAliasDelta(["test me", "quiz cards"], { add: ["echame tarjetas"], remove: ["test me"] }),
      ["quiz cards", "echame tarjetas"]
    );
  });

  it("is case-insensitive on both sides — a phrase retyped differently is the same phrase", () => {
    assert.deepEqual(applyAliasDelta(["Test Me"], { remove: ["test me"] }), []);
    assert.deepEqual(applyAliasDelta(["test me"], { add: ["TEST ME"] }), ["test me"]);
  });

  it("never removes the protected value — it is the route of last resort", () => {
    assert.deepEqual(
      applyAliasDelta(["flashcard_quiz", "test me"], { remove: ["FLASHCARD_QUIZ", "test me"] }, "flashcard_quiz"),
      ["flashcard_quiz"]
    );
  });

  it("tolerates a null list and blank entries rather than throwing", () => {
    assert.deepEqual(applyAliasDelta(null, { add: ["  a  ", "", "  "] }), ["a"]);
    assert.deepEqual(applyAliasDelta(undefined, {}), []);
  });

  it("refuses a phrase already bound to another workflow instead of shadowing it", () => {
    const block = procSrc.match(/case 'manage_routing_aliases': \{[\s\S]*?\n      \}/)?.[0] ?? "";
    assert.match(block, /already start a different workflow/);
    assert.match(block, /already resolve to a different domain/);
  });
});

describe("register_workflow — a domain workflow must declare a phrase", () => {

  it("refuses when neither intentPhrases nor intentKeywords is supplied", () => {
    const block = procSrc.match(/case 'register_workflow': \{[\s\S]*?\n      \}/g)?.pop() ?? "";
    assert.match(block, /needs at least one invocation phrase/);
    assert.match(block, /if \(domain && !effectiveKeywords\)/);
  });

  it("leaves a domain-less system workflow alone — ping_core legitimately has none", () => {
    const block = procSrc.match(/case 'register_workflow': \{[\s\S]*?\n      \}/g)?.pop() ?? "";
    assert.doesNotMatch(block, /if \(!effectiveKeywords\)/);
  });
});
