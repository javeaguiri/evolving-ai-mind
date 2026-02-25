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

app.command('/ping', async ({ command, ack, client, respond }) => {
  await ack();
  
  // Clear command input
  await respond({ 
    response_action: 'clear',
    text: `🧪 Ping received! Processing ${command.text} fortunes...`
  });
  
  try {
    // Generate fortunes
    const fortunes = await generateFortunes(command.text);
    
    // Send THREAD (blocks format)
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: command.ts,  // ← CRITICAL: Links to command
      text: `🤖 *${command.text} fortunes for <@${command.user_id}>!*`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🤖 *${command.text} fortunes for <@${command.user_id}>!*`
          }
        },
        ...fortunes.map(f => ({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✨ *${f.title}*\n${f.content}`
          }
        }))
      ]
    });
  } catch (error) {
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: command.ts,
      text: `❌ Error: ${error.message}`
    });
  }
});
app.command('/second-brain', secondBrainHandler);

export default receiver.app;  // ESM export