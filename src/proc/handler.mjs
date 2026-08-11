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

import { parseEvent, err, ok, buildReqFromSqs } from '../shared/lambda-utils.mjs';
import { enqueueCallback, deleteReceivedBatch } from '../shared/sqs-callback.mjs';
import { getRows, updateRows }                  from '../shared/serv-client.mjs';
import { handle as pingLlm }            from './ping-llm.mjs';
import { handle as pingCore }           from './ping-core.mjs';
import { handle as createDomain }       from './create-domain.mjs';
import { handle as designDomain }       from './design-domain.mjs';
import { handle as reviewOutput }       from './review-output.mjs';
import { handle as shutdown }           from './shutdown.mjs';
import { handle as runWorkflow, dispatchSqs } from './run-workflow.mjs';
import { handle as deleteDomain }       from './delete-domain.mjs';
import { handle as help }               from './help.mjs';
import { handle as classifyIntent }     from './classify-intent.mjs';
import { handle as simulateWorkflow }   from './simulate-workflow.mjs';
import { handle as createWorkflow }     from './create-workflow.mjs';
import { handle as troubleshootWorkflow } from './troubleshoot-workflow.mjs';
import { handle as fixWorkflow }        from './fix-workflow.mjs';
import { handle as diagnosePromptSchema } from './diagnose-prompt-schema.mjs';
import { handle as monitorPromptQuality } from './monitor-prompt-quality.mjs';
import { handle as chat }               from './chat.mjs';
import { handle as explain }            from './explain.mjs';
import { handle as deleteWorkflow }     from './delete-workflow.mjs';
import { handle as writeMemory }        from './memory-writer.mjs';
import { handle as mindsEye }           from './minds-eye.mjs';
import { handle as replay }             from './replay.mjs';
import { processScheduledRun }          from './scheduled-run.mjs';

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
 * Messages are deleted from SQS immediately on receipt — before any processing.
 * DB state (PGC_WorkflowRun) is the source of truth; Lambda crashes are recovered
 * via Novia or manual restart, not SQS retry. If pre-delete fails, the error
 * propagates and ESM retries the batch normally (fallback to old behaviour).
 * On per-record processing failure, a HUMAN_NOTIFICATION is sent to the
 * originating Slack channel so the user knows the run is stalled.
 */
async function processSqsBatch(records) {
  await deleteReceivedBatch(records);

  for (const record of records) {
    let message;
    try {
      message = JSON.parse(record.body);
      console.info('proc: SQS message received', { messageId: record.messageId, type: message.type, action: message.action, workflowRunId: message.workflowRunId, traceId: message.traceId });

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
      if (message.type === 'PING_CORE') {
        const req = buildReqFromSqs(message);
        await pingCore(req);
        continue;
      }
      if (message.type === 'HELP') {
        const req = buildReqFromSqs(message);
        await help(req);
        continue;
      }
      // DESIGN_DOMAIN — Phase 2 create-domain flow, step 1
      if (message.type === 'DESIGN_DOMAIN') {
        const req = buildReqFromSqs(message);
        await designDomain(req);
        continue;
      }
      // WORKFLOW_STEP — all actions (execute_top, resume_gate, cancel) route to
      // run-workflow.mjs dispatchSqs which handles them generically.
      if (message.type === 'WORKFLOW_STEP') {
        await dispatchSqs(message);
        continue;
      }
      // SCHEDULED_RUN — an EventBridge schedule fired. Category 1: no workflowRunId, because
      // the run does not exist until this creates it. Delivered by EventBridge Scheduler
      // itself, not by any part of this system.
      if (message.type === 'SCHEDULED_RUN') {
        await processScheduledRun(message);
        continue;
      }
      // DELETE_WORKFLOW — development/testing cleanup
      if (message.type === 'DELETE_WORKFLOW') {
        const req = buildReqFromSqs(message);
        await deleteWorkflow(req);
        continue;
      }
      // DELETE_DOMAIN — development/testing cleanup
      if (message.type === 'DELETE_DOMAIN') {
        const req = buildReqFromSqs(message);
        await deleteDomain(req);
        continue;
      }
      // CLASSIFY_INTENT — natural language input from /mind Slack command
      if (message.type === 'CLASSIFY_INTENT') {
        const req = buildReqFromSqs(message);
        await classifyIntent(req);
        continue;
      }
      // CREATE_WORKFLOW — heavy-lift dispatch from classify-intent.mjs or direct
      // /create-workflow Slack command. domain field may be null (direct command path)
      // or a resolved alias (classify-intent heavy-lift path).
      if (message.type === 'CREATE_WORKFLOW') {
        const req = buildReqFromSqs(message);
        await createWorkflow(req);
        continue;
      }
      // TROUBLESHOOT_WORKFLOW — Tier 1 reactive repair: Level 1 static analysis.
      // Enqueued by run-workflow.mjs on step failure or stuck-step guard fire.
      // Also triggered manually via curl or /m troubleshoot workflow <n>.
      if (message.type === 'TROUBLESHOOT_WORKFLOW') {
        const req = buildReqFromSqs(message);
        await troubleshootWorkflow(req);
        continue;
      }
      // FIX_WORKFLOW — Tier 1 reactive repair: LLM-driven correction + human gate.
      // Enqueued by troubleshoot-workflow.mjs when autoFix=true and issues found.
      // Also triggered manually via curl.
      if (message.type === 'FIX_WORKFLOW') {
        const req = buildReqFromSqs(message);
        await fixWorkflow(req);
        continue;
      }
      // DIAGNOSE_PROMPT_SCHEMA — Tier 1b reactive repair: deterministic output_schema
      // compatibility fix. Enqueued by run-workflow.mjs when an llm_call step
      // receives Agent API error 400 (structured output spec violation).
      if (message.type === 'DIAGNOSE_PROMPT_SCHEMA') {
        const req = buildReqFromSqs(message);
        await diagnosePromptSchema(req);
        continue;
      }
      // MONITOR_PROMPT_QUALITY — fire-and-forget right-brain quality monitor.
      // Enqueued by review-output.mjs after 2-attempt validation failure.
      // Also triggerable manually via POST /proc/monitor-prompt-quality.
      if (message.type === 'MONITOR_PROMPT_QUALITY') {
        const req = buildReqFromSqs(message);
        await monitorPromptQuality(req);
        continue;
      }
      // CHAT_MESSAGE — general-purpose LLM conversation started by /chat Slack command.
      if (message.type === 'CHAT_MESSAGE') {
        const req = buildReqFromSqs(message);
        await chat(req);
        continue;
      }
      // EXPLAIN_QUERY — diagnostic conversation anchored to a specific llm_call step.
      if (message.type === 'EXPLAIN_QUERY') {
        const req = buildReqFromSqs(message);
        await explain(req);
        continue;
      }
      // SHUTDOWN — cancel active runs; notifies via callback. Enqueued by slackbot/shutdown.mjs.
      if (message.type === 'SHUTDOWN') {
        const req = buildReqFromSqs(message);
        await shutdown(req);
        continue;
      }
      // REPLAY — start a replay (sourceRunId) or list recent runs (none), from the
      // /replay Slack command. Resume/inspect of a broken replay is HTTP-only (arch-replay §9).
      if (message.type === 'REPLAY') {
        const req = buildReqFromSqs(message);
        await replay(req);
        continue;
      }
      // REPLAY_RESUME — a break-resolution button click from Slack (A11). Routes to the same
      // resume path as the HTTP endpoint; writes the resolution onto the break frame and enqueues
      // resume_llm. Only payload-free resolutions arrive here — `supplied` stays HTTP-only.
      if (message.type === 'REPLAY_RESUME') {
        const req = buildReqFromSqs(message);
        await replay(req);
        continue;
      }
      // MEMORY_WRITE — fire-and-forget episodic memory write on domain run completion.
      // Enqueued by run-workflow.mjs after qualifying CRUD workflow run completes.
      if (message.type === 'MEMORY_WRITE') {
        const req = buildReqFromSqs(message);
        await writeMemory(req);
        continue;
      }
      // MINDS_EYE — agentic reasoning session (new message or thread continuation).
      if (message.type === 'MINDS_EYE') {
        const req = buildReqFromSqs(message);
        await mindsEye(req);
        continue;
      }
      // MINDS_EYE_RESUME — resume after a human gate (action tool approval or turn-limit gate).
      if (message.type === 'MINDS_EYE_RESUME') {
        const req = buildReqFromSqs(message);
        await mindsEye(req);
        continue;
      }

      const req = buildReqFromSqs(message);
      await dispatch(req);

    } catch (error) {
      console.error('proc: SQS record failed', {
        messageId:     record.messageId,
        type:          message?.type,
        workflowRunId: message?.workflowRunId,
        error:         error.message,
      });
      if (message?.workflowRunId) {
        try {
          const rows = await getRows('PGC_WorkflowRun',
            [{ column: 'id', op: 'eq', value: message.workflowRunId }],
          );
          const run = rows?.[0];
          await updateRows('PGC_WorkflowRun',
            [{ column: 'id', op: 'eq', value: message.workflowRunId }],
            { status: 'failed', error: { message: error.message } },
          );
          if (run?.callback) {
            await enqueueCallback(run.callback, {
              type:    'HUMAN_NOTIFICATION',
              traceId: message.traceId,
              message: `Run ${run.id} (${run.workflow_name}) failed with an unexpected error. Use Novia to diagnose or re-enqueue the run manually.\n\nError: ${error.message}`,
            });
          }
        } catch (notifyErr) {
          console.error('proc: failed to send failure notification', { notifyErr: notifyErr.message });
        }
      }
    }
  }

  return { batchItemFailures: [] };
}

// ---------------------------------------------------------------------------
// Shared dispatch — called identically from both HTTP and SQS paths
// ---------------------------------------------------------------------------

async function dispatch(req) {
  // Replay endpoints use path params / sub-actions (/replay, /replay/{id},
  // /replay/{id}/resume) that the last-segment `req.route` cannot distinguish — dispatch
  // them by the first proxy segment. SQS reqs have no `proxy`, so this never matches them.
  if ((req.proxy || '').split('/').filter(Boolean)[0] === 'replay') {
    return replay(req);
  }

  switch (req.route) {
    case 'ping-llm':
      return pingLlm(req);

    case 'ping-db':
      return pingDb(req);

    case 'create-domain':
      return createDomain(req);

    case 'design-domain':
      return designDomain(req);

    case 'review-output':
      return reviewOutput(req);

    case 'shutdown':
      return shutdown(req);

    case 'run-workflow':
      return runWorkflow(req);

    case 'delete-domain':
      return deleteDomain(req);

    case 'classify-intent':
      return classifyIntent(req);

    case 'create-workflow':
      return createWorkflow(req);

    case 'troubleshoot-workflow':
      return troubleshootWorkflow(req);

    case 'fix-workflow':
      return fixWorkflow(req);

    case 'diagnose-prompt-schema':
      return diagnosePromptSchema(req);

    case 'monitor-prompt-quality':
      return monitorPromptQuality(req);

    case 'simulate-workflow':
      return simulateWorkflow(req);

    case 'chat':
      return chat(req);

    case 'explain':
      return explain(req);

    case 'delete-workflow':
      return deleteWorkflow(req);

    default:
      return err(404, `PROC route "${req.route}" not found`, req.correlationId);
  }
}

// ---------------------------------------------------------------------------
// ping-db — inline handler: proc → serv (correct tier path for HTTP callers)
// Callers: /ping db in ping.mjs (exp → proc HTTP → this handler → serv)
// ---------------------------------------------------------------------------

async function pingDb(req) {
  const traceId = req.traceId ?? req.correlationId;
  try {
    const url = `${process.env.SERV_API_URL}/api/v1/serv/ping-db`;
    const res = await fetch(url, { headers: { 'x-correlation-id': traceId, 'x-api-key': process.env.INTERNAL_API_KEY ?? '' } });
    if (!res.ok) throw new Error(`Serv HTTP ${res.status}: ${await res.text()}`);
    const body = await res.json();
    return ok({ success: true, message: 'DB ping OK', ...body }, traceId);
  } catch (error) {
    console.error('proc: ping-db error:', error.message);
    return err(500, `DB ping failed: ${error.message}`, traceId);
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
    type:     'PING_SQS_RESULT',
    traceId:  message.traceId,
    callback: message.callback,
    hop:      2,
    result: {
      success:         true,
      message:         'ping-sqs complete — 2 SQS hops confirmed',
      traceId:         message.traceId,
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
  const resp    = await fetch(`${process.env.SERV_API_URL}/api/v1/serv/ping-db`, { headers: { 'x-api-key': process.env.INTERNAL_API_KEY ?? '' } });
  const payload = await resp.json();
  const version = payload?.pgc?.version ?? payload?.pgd?.version ?? 'unknown';

  await enqueueSlackResult({
    type:     'PING_E2E_RESULT',
    traceId:  message.traceId,
    callback: message.callback,
    result: {
      success:     true,
      message:     `ping-e2e complete — full round trip confirmed\n\`${version}\``,
      traceId:     message.traceId,
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
