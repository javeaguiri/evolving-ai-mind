// src/proc/ping-llm.mjs
// Handles POST /api/v1/proc/ping-llm
//
// Validates: ProcFunction Lambda + Perplexity LLM API.
// No Slack, SQS, or DB calls.
// Safe to invoke directly via curl or from Slack /ping-llm command.
// If this fails → LLM_API_KEY in SSM, ProcFunction config, or API Gateway issue.
//
// Preserves the Perplexity sonar + fetch pattern from the original ping.mjs.

import { ok, err } from '../shared/ping-utils.mjs';

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

/**
 * @param {ReturnType<import('../../shared/ping-utils.mjs').parseEvent>} req
 */
export async function handle(req) {
  const llmKey = process.env.LLM_API_KEY;

  if (!llmKey) {
    console.error('ping-llm: LLM_API_KEY env var not set');
    return err(500, 'LLM_API_KEY not configured', req.correlationId);
  }

  console.info('ping-llm', { correlationId: req.correlationId });

  try {
    const response = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${llmKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role:    'system',
            content: 'You are a friendly AI fortune cookie generator. Respond with ONE short, wise fortune cookie message only (10-15 words max). No quotes, no explanation.',
          },
          {
            role:    'user',
            content: 'Give me one short, randomized wise fortune cookie message about serverless computing or AI.',
          },
        ],
        max_tokens:  50,
        temperature: 0.8,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Perplexity ${response.status}: ${body}`);
    }

    const data    = await response.json();
    const fortune = data?.choices?.[0]?.message?.content?.trim()
                 || 'Your serverless functions will achieve enlightenment. 🍪';

    return ok({
      success:       true,
      message:       fortune,
      model:         data?.model || 'sonar',
      correlationId: req.correlationId,
      timestamp:     new Date().toISOString(),
    }, req.correlationId);

  } catch (error) {
    console.error('ping-llm error:', error.message);
    return err(500, `LLM call failed: ${error.message}`, req.correlationId);
  }
}