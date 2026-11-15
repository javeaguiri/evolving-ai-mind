// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/workflow-error.test.mjs
//
// A WORKFLOW_ERROR's summary, shared by both experience layers (src/ui/shared/workflow-error.mjs).

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { summariseWorkflowError } from '../../src/ui/shared/workflow-error.mjs';

describe('summariseWorkflowError', () => {
  it('counts the schema errors of an llm_call validation failure', () => {
    const raw = 'llm_call validation failed: [{"keyword":"required"},{"keyword":"type"}]';
    assert.equal(summariseWorkflowError(raw), 'LLM output validation failed after 2 attempts (2 schema errors). The prompt has been logged for improvement.');
  });

  it('shows an LLM call failure up to 200 characters', () => {
    const raw = `LLM call timed out ${'x'.repeat(300)}`;
    const summary = summariseWorkflowError(raw);
    assert.ok(summary.startsWith('LLM call failed: LLM call timed out'));
    assert.equal(summary.length, 'LLM call failed: '.length + 200);
  });

  it('shows any other error up to 500 characters', () => {
    assert.equal(summariseWorkflowError('y'.repeat(600)), 'y'.repeat(500));
  });

  it('falls back when the message is not a string', () => {
    assert.equal(summariseWorkflowError(undefined), 'An unexpected error occurred.');
  });
});
