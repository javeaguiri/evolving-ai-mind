// src/ui/slackbot/callback.mjs
// Lambda entry point for SlackCallbackListenerFunction.
// Triggered by SQS SYSSQSSlackResults — NOT by API Gateway.
//
// TODO (ping-sqs step): implement Slack threaded reply posting.
// This stub prevents a deploy error — the function exists but
// logs and acks the message without crashing.

export async function handler(event) {
  for (const record of event.Records) {
    console.info('callback stub received SQS message', {
      messageId: record.messageId,
      body:      record.body,
    });
    // Returning without throwing = SQS message acknowledged (deleted from queue)
  }
}
