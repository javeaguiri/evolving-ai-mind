import { App } from '@slack/bolt';
import { pingCommand } from './ping.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

app.command('/ping', async ({ command, ack, client }) => {
  console.log('🔥 /ping RECEIVED!', command.text);
  
  // 1. Pass FULL Bolt context to ping.js
  await pingCommand({ command, ack, client });
});

export default async function handler(req, res) {
  console.log('🚀 Slackbot HIT!');
  await app.processEvent(req, res);
}
