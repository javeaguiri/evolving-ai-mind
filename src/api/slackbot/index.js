import { App } from '@slack/bolt';
import { pingCommand } from './ping.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

app.command('/ping', ({ command, ack, client }) => {
  console.log('🔥 /ping RECEIVED!', command.text);
  // NO AWAIT - Let Bolt ACK middleware run first, THEN pass context
  pingCommand({ command, ack, client });
});

export default async function handler(req, res) {
  console.log('🚀 Slackbot HIT!');
  await app.processEvent(req, res);
}
