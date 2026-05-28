// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/memory-writer.mjs
// Handles MEMORY_WRITE SQS messages — fire-and-forget episodic memory writes.
// Enqueued by run-workflow.mjs after qualifying domain workflow run completion.
// Never throws — failure is logged only.

import { getRows, insertRow } from '../shared/serv-client.mjs';

// System meta-workflows do not generate user-activity episodic memories.
const SYSTEM_WORKFLOWS = new Set([
  'create_domain', 'create_workflow', 'fix_workflow',
  'diagnose_prompt_schema', 'ping_core', 'troubleshoot_workflow',
]);

/**
 * Returns true when a completed run should produce an episodic memory:
 * - run.input.domain is non-null (it is a domain workflow, not a system workflow)
 * - run.workflow_name is not in the system workflow exclusion set
 */
export function shouldWriteEpisodicMemory(run) {
  return run.input?.domain != null && !SYSTEM_WORKFLOWS.has(run.workflow_name);
}

export async function handle(req, { _getRows = getRows, _insertRow = insertRow } = {}) {
  const { runId, workflowName, domain } = req.body ?? {};
  const traceId = req.traceId;

  if (!runId || !workflowName) {
    console.warn('memory-writer: missing runId or workflowName', { runId, workflowName, traceId });
    return;
  }

  try {
    await _getRows('PGC_WorkflowRun', [{ column: 'id', op: 'eq', value: runId }], undefined, 1);

    const content       = distillContent(workflowName, domain);
    const tokenEstimate = Math.ceil(content.length / 4);
    const scope         = domain
      ? { domain, workflow: workflowName }
      : { workflow: workflowName };
    const tags = ['run_complete', workflowName, ...(domain ? [domain] : [])];

    await _insertRow('PGC_Memory', {
      memory_type:     'episodic',
      scope,
      content,
      tags,
      priority:        8,
      token_estimate:  tokenEstimate,
      source_run_id:   runId,
      source_workflow: workflowName,
      source_step:     null,
    });

    console.info('memory-writer: episodic memory written', { runId, workflowName, domain, traceId });
  } catch (error) {
    console.error('memory-writer: failed (non-fatal)', { runId, workflowName, error: error.message, traceId });
  }
}

// Deterministic distillation — zero LLM cost.
// TODO: for runs where local_state contains *_reasoning keys, use a cheap sonar
//       call to distil to 2–3 sentences (see Sprint 4 plan).
function distillContent(workflowName, domain) {
  const domainPart = domain ? ` for domain '${domain}'` : '';
  return `Completed workflow '${workflowName}'${domainPart}.`;
}
