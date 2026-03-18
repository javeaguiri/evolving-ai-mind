// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/help.mjs
// Handles the HELP workflow — both phases.
//
// Phase 1 — initial HELP message arrives from WorkflowQueue:
//   Enqueues HELP_GATE to CallbackResults so callback.mjs posts the
//   Block Kit question with confirm/cancel buttons to the Slack thread.
//
// Phase 2 — resume_gate arrives after user clicks a button:
//   Reads userResponse from the resume message, enqueues HELP_RESULT
//   to CallbackResults with the appropriate completion message.
//
// Transport-agnostic — no AWS SDK imports here.
// enqueueCallback() from sqs-callback.mjs handles all SQS writes.
//
// Today: simple confirm/cancel loop proving the interactive pipeline.
// Future: Phase 1 will query PGC_DomainHelp + PGC_Capability and return
//         dynamic buttons for available commands on this instance.

import { enqueueCallback } from '../shared/sqs-callback.mjs';

/**
 * Phase 1 — called when HELP SQS message arrives.
 * Sends a HELP_GATE to CallbackResults so the Block Kit question is posted.
 *
 * @param {object} message  Raw SQS message body
 */
export async function handleHelp(message) {
  const { traceId, callback } = message;

  console.info('proc/help: phase 1 — posting help gate', { traceId });

  await enqueueCallback(callback, {
    type:    'HELP_GATE',
    traceId,
    result: {
      traceId,
      // traceId doubles as workflowRunId for now —
      // Step Processor will replace this with PGC_WorkflowRun.id
      workflowRunId: traceId,
    },
  });
}

/**
 * Phase 2 — called when resume_gate SQS message arrives.
 * Routes on userResponse and enqueues the completion message.
 *
 * @param {object} message  Raw SQS resume_gate message body
 */
export async function handleHelpResume(message) {
  const { traceId, userResponse, callback } = message;

  console.info('proc/help: phase 2 — resume_gate received', { traceId, userResponse });

  const responseText = userResponse === 'confirm'
    ? '✅ Great! Here\'s what evolving-mind can do:\n\n• `/create-domain <description>` — design and build a new data domain\n• `/help` — show this message\n\nMore commands coming as the brain evolves 🧠'
    : '👋 No problem — just type `/help` any time you need me.';

  await enqueueCallback(callback, {
    type:    'HELP_RESULT',
    traceId,
    result: {
      success:      true,
      message:      responseText,
      userResponse,
      traceId,
      completedAt:  new Date().toISOString(),
    },
  });
}
