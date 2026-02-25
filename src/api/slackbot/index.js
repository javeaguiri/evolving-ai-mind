// src/api/slackbot/index.js - ESM (matches "type": "module")
import { App, ExpressReceiver } from '@slack/bolt';
import { pingHandler } from './ping.js';
import { secondBrainHandler } from './second-brain.js';

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({ 
  token: process.env.SLACK_BOT_TOKEN, 
  receiver 
});

app.command('/ping', pingHandler);
app.command('/second-brain', secondBrainHandler);

export default receiver.app;  // ESM export