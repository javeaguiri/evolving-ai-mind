// src/ui/slackbot/handler.mjs
// Lambda entry point for the UI / Slackbot layer.
// Owns: /api/v1/ui/slack/{proxy+}
//
// Sub-route switching lives here — NOT in template.yaml.
// Add a new case for each new Slack command.

import { parseEvent, err } from '../../shared/ping-utils.mjs';
import { handle as pingApi } from './ping.mjs';
import { handle as pingSqs } from './ping-sqs.mjs';

/**
 * AWS Lambda handler — called by API Gateway for every
 * /api/v1/ui/slack/* request.
 */
export async function handler(event) {
  const req = parseEvent(event);

  switch (req.route) {
    case 'ping-api': return pingApi(req);
    case 'ping-sqs': return pingSqs(req);

    // Future routes:
    // case 'commands': return commands(req);
    // case 'interactive': return interactive(req);

    default:
      return err(404, `Slackbot route "${req.route}" not found`, req.correlationId);
  }
}