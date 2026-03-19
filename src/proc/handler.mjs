// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/handler.mjs
// Lambda entry point for the PROC (Process Orchestration) layer.
// Owns: /api/v1/proc/{proxy+}  (HTTP)
//       SQS WorkflowQueue      (async — added in Step 6)
//
// Dual-trigger dispatch:
//   event.Records   → processSqsBatch() → buildReqFromSqs() → dispatch()
//   event.httpMethod → parseEvent()                         → dispatch()
//
// BatchSize on the SQS trigger is a cost optimisation only — not intra-run
// parallelism. One SQS message per workflowRunId is always in flight.
// processSqsBatch handles concurrent runs across different workflowRunIds
// in a single Lambda invocation.
//
// PROC endpoint modules are transport-agnostic — no AWS SDK, no Slack SDK.
// req.source ('http' | 'sqs') determines response path only.

import { parseEvent, err, buildReqFromSqs } from '../shared/lambda-utils.mjs';
import { handle as pingLlm }  from './ping-llm.mjs';
import { handle as createDomain } from './create-domain.mjs';
import { handleHelp, handleHelpResume }     from './help.mjs';
import { handle as shutdown }           from './shutdown.mjs';

/**
 * AWS Lambda handler — called by API Gateway (HTTP) or SQS WorkflowQueue (async).
 */
export async function handler(event) {
  if (event.Records) {
    return processSqsBatch(event.Records);
  }
  return processHttpRequest(event);
}

// ---------------------------------------------------------------------------
// HTTP path
// ---------------------------------------------------------------------------

async function processHttpRequest(event) {
  const req = parseEvent(event);
  return dispatch(req);
}

// ---------------------------------------------------------------------------
// SQS path
// ---------------------------------------------------------------------------

/**
 * Process a batch of SQS WorkflowQueue records.
 * Each record is normalised to the same req shape as the HTTP path,
 * then dispatched to the same endpoint modules.
 * Ping message types (PING_SQS, PING_E2E) are handled inline here —
 * they are not transport-agnostic routes and read routing from message.callback.
 * ReportBatchItemFailures — only failed records return to the queue.
 */
async function processSqsBatch(records) {
  const failures = [];

  for (const record of records) {
    try {
      const message = JSON.parse(record.body);

      // Ping types are handled inline — they use the generic callback object
      // and are not transport-agnostic PROC routes.
      if (message.type === 'PING_SQS') {
        await handlePingSqs(message);
        continue;
      }
      if (message.type === 'PING_E2E') {
        await handlePingE2e(message);
        continue;
      }
      if (message.type === 'HELP') {
        await handleHelp(message);
        continue;
      }
      // resume_gate — routes to the correct workflow handler.
      // TODO: replace with PGC_WorkflowRun lookup when Step Processor is built.
      // For now: all resume_gate messages are routed to the HELP workflow.
      if (message.type === 'WORKFLOW_STEP' && message.action === 'resume_gate') {
        await handleHelpResume(message);
        continue;
      }
      // cancel — Step Processor will handle this when built (Phase 2 item 5).
      // Discard silently for now — run is already marked cancelled in DB.
      if (message.type === 'WORKFLOW_STEP' && message.action === 'cancel') {
        console.info('proc: cancel message received — discarded (Step Processor not yet built)', {
          workflowRunId: message.workflowRunId,
          traceId:       message.traceId,
        });
        continue;
      }

      const req = buildReqFromSqs(message);
      await dispatch(req);

    } catch (error) {
      console.error('proc: SQS record failed', {
        messageId: record.messageId,
        error:     error.message,
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}

// ---------------------------------------------------------------------------
// Shared dispatch — called identically from both HTTP and SQS paths
// ---------------------------------------------------------------------------

async function dispatch(req) {
  switch (req.route) {
    case 'ping-llm':
      return pingLlm(req);

    case 'create-domain':
      return createDomain(req);

    case 'shutdown':
      return shutdown(req);

    // Routes added here as refactor progresses:
    // case 'run-workflow':  return runWorkflow(req);    // Phase 2 item 5

    default:
      return err(404, `PROC route "${req.route}" not found`, req.correlationId);
  }
}

// ---------------------------------------------------------------------------
// Ping SQS handlers — inline, not transport-agnostic routes, removed after Step 12
// ---------------------------------------------------------------------------

/**
 * Hop 2 — forward ping-sqs result to SlackResults queue.
 * Passes message.callback through intact — SlackCallbackListenerFunction
 * routes on callback.provider to determine the UI target.
 */
async function handlePingSqs(message) {
  await enqueueSlackResult({
    type:      'PING_SQS_RESULT',
    traceId: message.traceId,
    callback:   message.callback,
    hop:        2,
    result: {
      success:         true,
      message:         '📬 ping-sqs complete — 2 SQS hops confirmed ✅',
      traceId:      message.traceId,
      hop1EnqueuedAt:  message.enqueuedAt,
      hop2ProcessedAt: new Date().toISOString(),
    },
  });
  console.info('proc: ping-sqs hop 2 enqueued', { traceId: message.traceId });
}

/**
 * Hop 2 — call SERV ping-db via HTTP fetch, forward result to SlackResults queue.
 * Passes message.callback through intact — SlackCallbackListenerFunction
 * routes on callback.provider to determine the UI target.
 * Replaces the Lambda invoke in step-orchestrator.mjs — uses fetch() instead.
 */
async function handlePingE2e(message) {
  const resp    = await fetch(`${process.env.SERV_API_URL}/api/v1/serv/ping-db`);
  const payload = await resp.json();
  const version = payload?.pgc?.version ?? payload?.pgd?.version ?? 'unknown';

  await enqueueSlackResult({
    type:      'PING_E2E_RESULT',
    traceId: message.traceId,
    callback:   message.callback,
    result: {
      success:     true,
      message:     `🔁 ping-e2e complete — full round trip confirmed ✅\n\`${version}\``,
      traceId:  message.traceId,
      enqueuedAt:  message.enqueuedAt,
      completedAt: new Date().toISOString(),
    },
  });
  console.info('proc: ping-e2e result enqueued', { traceId: message.traceId, version });
}

/**
 * Send a result message to SYSSQSSlackResults.
 * Used only by the legacy ping handlers above — all future routes use
 * enqueueCallback() from src/shared/sqs-callback.mjs instead.
 */
async function enqueueSlackResult(payload) {
  const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
  const sqs = new SQSClient({});
  await sqs.send(new SendMessageCommand({
    QueueUrl:    process.env.SQS_SLACK_RESULTS_URL,
    MessageBody: JSON.stringify(payload),
  }));
}
