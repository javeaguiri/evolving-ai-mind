import { App } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // ✅ FIX TIMEOUTS
  processBeforeResponse: true,
  unhandledRequestTimeoutMillis: 5000,
  unhandledRequestHandler: () => {}
});

app.command('/ping', async ({ command, client }) => {
  console.log('Ping from:', command.user_id);
  
  // Direct ephemeral - works immediately
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text: `:wave: pong! Count: ${command.text || 1}`
  });
});

export default async function handler(req, res) {
  console.log('🚀 Slackbot HIT!');
  if (req.method === 'POST') {
    await app.processEvent(req, res);
  } else {
    res.status(405).send('Method Not Allowed');
  }
}
