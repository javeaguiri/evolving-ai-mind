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

import { parseEvent, err }    from '../shared/ping-utils.mjs';
import { buildReqFromSqs }    from '../shared/lambda-utils.mjs';
import { handle as pingLlm }  from './ping-llm.mjs';

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
 * ReportBatchItemFailures — only failed records return to the queue.
 */
async function processSqsBatch(records) {
  const failures = [];

  for (const record of records) {
    try {
      const message = JSON.parse(record.body);
      const req     = buildReqFromSqs(message);
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

    // Routes added here as refactor progresses:
    // case 'create-domain': return createDomain(req);  // Step 8
    // case 'run-workflow':  return runWorkflow(req);    // Phase 3

    default:
      return err(404, `PROC route "${req.route}" not found`, req.correlationId);
  }
}
