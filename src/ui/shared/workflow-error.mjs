// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/shared/workflow-error.mjs
//
// A WORKFLOW_ERROR's summary — what a person is shown when a run fails. PROC emits the raw
// technical error; summarising it is the experience layer's job (architecture §3.1), and both
// experience layers summarise it the same way: Slack (slackbot/callback.mjs) and the web
// (web/api/handler.mjs). Full detail stays in CloudWatch and PGC_Prompt.error_log. Pure.

/**
 * @param {unknown} errMessage  The WORKFLOW_ERROR's raw `message`
 * @returns {string}
 */
export function summariseWorkflowError(errMessage) {
  if (typeof errMessage !== 'string') return 'An unexpected error occurred.';
  if (errMessage.includes('llm_call validation failed')) {
    const errCount = errMessage.match(/"keyword"/g)?.length ?? '?';
    return `LLM output validation failed after 2 attempts (${errCount} schema errors). The prompt has been logged for improvement.`;
  }
  if (/LLM (returned|call timed)/.test(errMessage)) return `LLM call failed: ${errMessage.slice(0, 200)}`;
  return errMessage.slice(0, 500);
}
