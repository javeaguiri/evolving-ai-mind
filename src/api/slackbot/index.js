import { App } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

app.command('/ping', async ({ command, client }) => {
  console.log('Ping from:', command.user_id);
  
  try {
    // Direct ephemeral - no ack() needed
    await client.chat.postEphemeral({
      channel: command.channel_id,  // C0AEJ87JSKF
      user: command.user_id,        // U0AD8M05TLP
      text: `:wave: pong! Count: ${command.text || 1}`
    });
  } catch (error) {
    console.error('Ephemeral failed:', error.code);
    // Fallback: use response_url
    await fetch(command.response_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ':wave: pong!' })
    });
  }
});

export default async function handler(req, res) {
  console.log('🚀 Slackbot HIT!');
  if (req.method === 'POST') {
    await app.processEvent(req, res);
  } else {
    res.status(405).send('Method Not Allowed');
  }
}
