// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/proc/simulate-workflow.mjs
// Handles POST /api/v1/proc/simulate-workflow
//
// Standalone HTTP endpoint for validating a workflow step array without
// requiring a WorkflowRun. Accepts SimulateWorkflowRequest and returns
// SimulateWorkflowResponse synchronously.
//
// Used for:
//   - Developer testing during workflow authoring (curl / integration tests)
//   - The simulate step type in step-executor.mjs calls runSimulation()
//     directly — not this endpoint — when executing inside a WorkflowRun.
//
// See openapi.yaml SimulateWorkflowRequest / SimulateWorkflowResponse schemas.
// See architecture Section 6.4.6 for validation level design.
//
// Transport-agnostic — no AWS SDK, no Slack SDK.

import { randomUUID }      from 'crypto';
import { ok, err }         from '../shared/lambda-utils.mjs';
import { runSimulation }   from './step-executor.mjs';

export async function handle(req) {
  const body    = req.body ?? {};
  const traceId = body.traceId ?? req.correlationId ?? randomUUID();

  const { steps, mockOutputs, simulationPaths, runInput } = body;

  if (!Array.isArray(steps) || steps.length === 0) {
    return err(400, 'steps is required and must be a non-empty array', req.correlationId);
  }

  // simulationPaths is required by the openapi spec (minItems: 1) but the
  // simulation itself accepts null and runs Level 1 only — match that behaviour
  // so the endpoint is also useful for quick Level 1 smoke tests without paths.
  if (simulationPaths !== undefined && !Array.isArray(simulationPaths)) {
    return err(400, 'simulationPaths must be an array', req.correlationId);
  }

  console.info('simulate-workflow: request received', {
    stepCount:  steps.length,
    hasMocks:   !!mockOutputs,
    pathCount:  Array.isArray(simulationPaths) ? simulationPaths.length : 0,
    traceId,
  });

  const result = runSimulation({
    steps,
    mockOutputs:      mockOutputs      ?? null,
    simulationPaths:  simulationPaths  ?? null,
    runInput:         runInput         ?? {},
    traceId,
  });

  return ok({ ...result, traceId }, req.correlationId);
}
