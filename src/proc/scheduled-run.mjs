// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/scheduled-run.mjs
// SCHEDULED_RUN — turns a fired EventBridge schedule into a workflow run.
//
// A schedule can only deliver a static payload, and a run needs a PGC_WorkflowRun row that
// does not exist until it fires. This is the step between: resolve the workflow by name,
// create the run, enqueue execute_top. Everything after that is the ordinary Step Processor
// path — nothing downstream knows or cares that a schedule started it.
//
// Transport-agnostic like every PROC module: no AWS SDK import here. The scheduler client
// lives in shared/, and the enqueue goes through sqs-callback like every other dispatch.
//
// NO CALLBACK, AND THAT IS THE POINT. An unattended run has no Slack thread to reply into and
// no human waiting. `callback: null` means a human_gate in a scheduled workflow suspends with
// nobody to answer it — which is a real failure mode, and is why the tool description tells
// the author to schedule only workflows that can complete without a gate. Reporting results
// is a `notify` step's job, and a notify step carries its own destination.

import { insertRow, getRows } from '../shared/serv-client.mjs';
import { enqueueWorkflow }    from '../shared/sqs-callback.mjs';
import { randomUUID }         from 'crypto';

/**
 * Handle a SCHEDULED_RUN message from WorkflowQueue.
 *
 * @param {object} message  { type, workflowName, input, scheduleName }
 * @returns {Promise<void>}
 */
export async function processScheduledRun(message) {
  const { workflowName, input = {}, scheduleName } = message;
  const traceId = message.traceId ?? randomUUID();

  if (!workflowName) {
    console.error('proc/scheduled-run: message carries no workflowName', { scheduleName, traceId });
    return;
  }

  const wfResp = await getRows(
    'PGC_Workflow',
    [{ column: 'name', op: 'eq', value: workflowName }],
    { column: 'version', direction: 'desc' },
    1
  );
  const wf = wfResp.rows?.[0];

  if (!wf) {
    // The workflow was renamed or deleted after the schedule was created. Log loudly and
    // stop: there is no user to notify and retrying cannot help, so a DLQ entry here would
    // be noise that recurs on every tick.
    console.error('proc/scheduled-run: workflow not found — schedule is orphaned', {
      workflowName, scheduleName, traceId,
    });
    return;
  }

  const runResp = await insertRow('PGC_WorkflowRun', {
    workflow_id:  wf.id,
    trace_id:     traceId,
    triggered_by: 'schedule',
    status:       'pending',
    input,
    stack:        [],
    state:        {},
    callback:     null,
  });

  if (!runResp.success) {
    console.error('proc/scheduled-run: could not create run', {
      workflowName, scheduleName, traceId, error: runResp.error,
    });
    return;
  }

  await enqueueWorkflow({
    type:          'WORKFLOW_STEP',
    action:        'execute_top',
    workflowRunId: runResp.row.id,
    traceId,
  });

  console.info('proc/scheduled-run: run started from schedule', {
    scheduleName, workflowName, workflowRunId: runResp.row.id, traceId,
  });
}
