// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-truncation.test.mjs
//
// A response severed at the output ceiling used to end the session (session 1121,
// 2026-08-01): Novia wrote 8192 tokens of prose and was cut mid-sentence, the parse
// failed, and the round exited with "Agent reasoning failed" in Slack. The turn's work
// was never written to PGC_SessionEntry, so nothing of it survived.
//
// Truncation is not a malformed response and must not be treated as one. The correction
// path echoes the raw output back to be re-emitted as valid JSON — which is the right
// remedy for bad escaping and precisely the wrong one here, since that output is what
// exhausted the budget. The same question is asked again instead, with the cut-off
// stated.
//
// Run: node --test tests/unit/minds-eye-truncation.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLlmFailure, buildUserMessage } from '../../src/proc/minds-eye.mjs';

const truncated = () => {
  const e = new Error('LLM returned invalid JSON: Unexpected token \'G\'');
  e.isParseError = true;
  e.rawOutput    = 'Good catch — serv_upsert is exactly the right tool here.';
  e.isTruncated  = true;
  return e;
};

const badEscaping = () => {
  const e = new Error('LLM returned invalid JSON: Bad control character');
  e.isParseError = true;
  e.rawOutput    = '{ "action": "respond", "message": "line one\nline two" }';
  return e;
};

describe('classifyLlmFailure', () => {

  it('re-asks a truncated response instead of correcting it', () => {
    assert.equal(classifyLlmFailure(truncated(), false), 'reask');
  });

  it('gives up when a re-ask truncates too — the notice did not land', () => {
    assert.equal(classifyLlmFailure(truncated(), true), 'fail');
  });

  it('still corrects a complete response with broken escaping', () => {
    assert.equal(classifyLlmFailure(badEscaping(), false), 'correct');
  });

  it('corrects broken escaping even directly after a truncated turn', () => {
    // lastTurnTruncated only bars a second re-ask. A different failure on the retry is
    // its own case and gets its own remedy.
    assert.equal(classifyLlmFailure(badEscaping(), true), 'correct');
  });

  it('fails a transport error — nothing to correct and nothing to re-ask', () => {
    assert.equal(classifyLlmFailure(new Error('LLM call timed out after 170s'), false), 'fail');
  });

  it('fails a parse error carrying no raw output', () => {
    const e = new Error('LLM returned empty response');
    e.isParseError = true;
    assert.equal(classifyLlmFailure(e, false), 'fail');
  });

  it('does not throw on a missing error object', () => {
    assert.equal(classifyLlmFailure(undefined, false), 'fail');
  });
});

describe('buildUserMessage — the truncation notice', () => {
  const prefs = { name: 'Agent', tone: 'concise', advisory_level: 'proactive' };
  const history = [{ role: 'user', content: 'build me a workflow' }];

  it('omits the notice when a turn was not truncated', () => {
    const withNone = buildUserMessage('LAYER1', null, history, prefs, null);
    assert.ok(!withNone.includes('output limit'));
  });

  it('appends the notice last, nearest the response it constrains', () => {
    const notice  = 'NOTICE-SENTINEL';
    const message = buildUserMessage('LAYER1', null, history, prefs, notice);
    assert.ok(message.endsWith(notice), 'the notice must be the final section');
    assert.ok(message.includes('LAYER1'), 'context is still carried');
    assert.ok(message.includes('build me a workflow'), 'the conversation is still carried');
  });

  it('carries the conversation intact — a re-ask loses only the severed response', () => {
    const before = buildUserMessage('LAYER1', 'LAYER2', history, prefs, null);
    const after  = buildUserMessage('LAYER1', 'LAYER2', history, prefs, 'NOTICE');
    assert.ok(after.startsWith(before), 'the re-ask is the same message plus the notice');
  });
});
