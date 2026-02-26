import { App } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Manual command listener - bypass Bolt middleware ack requirement
app.command('/ping', async ({ command, client }) => {
  console.log('Ping from:', command.user_id, 'text:', command.text);
  
  // Direct ephemeral response (no ack needed)
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text: ':wave: postEphemeral with ÍD ' + (channel.channel_id || none) + ' User ' + (command.user || none) + ' user pong! Count: ' + (command.text || 1)
  });
});

export default async function handler(req, res) {
  console.log('🚀 Slackbot HIT!');
  
  if (req.method === 'POST') {
    try {
      await app.processEvent(req, res);
    } catch (error) {
      console.error('Bolt error:', error);
      // Manual fallback response
      if (!res.headersSent) {
        res.status(200).json({ text: 'pong!' });
      }
    }
  } else {
    res.status(405).send('Method Not Allowed');
  }
}
