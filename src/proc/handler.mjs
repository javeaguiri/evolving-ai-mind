// src/proc/handler.mjs
// Lambda entry point for the PROC (Process Orchestration) layer.
// Owns: /api/v1/proc/{proxy+}
//
// Sub-route switching lives here — NOT in template.yaml.

import { parseEvent, err } from '../../shared/ping-utils.mjs';
import { handle as pingLlm } from './ping-llm.mjs';

/**
 * AWS Lambda handler — called by API Gateway for every
 * /api/v1/proc/* request.
 */
export async function handler(event) {
  const req = parseEvent(event);

  switch (req.route) {
    case 'ping-llm':
      return pingLlm(req);

    // Future routes added here:
    // case 'run-flow':    return runFlow(req);
    // case 'schema-create': return schemaCreate(req);

    default:
      return err(404, `PROC route "${req.route}" not found`, req.correlationId);
  }
}