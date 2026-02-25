// src/api/slackbot/ping.js - ESM Slack command handler
import axios from 'axios';

export const pingHandler = async ({ command, ack, client }) => {
  await ack(); // Acknowledge immediately

  const channelId = command.channel_id;
  const userId = command.user_id;
  const text = command.text?.trim() || '';
  
  // Parse number of pings (1-10, default 3)
  const numPings = parseInt(text.match(/(\d+)/)?.[1] || '3');
  const count = Math.max(1, Math.min(10, numPings));

  // Initial ephemeral message
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: `🧪 Pinging LLM ${count} times...`
  });

  // Parent message for thread
  const parent = await client.chat.postMessage({
    channel: channelId,
    text: `🧪 Connection test for <@${userId}>: ${count} pings + fortunes...`
  });

  const threadTs = parent.ts;

  // Ping loop
  for (let i = 1; i <= count; i++) {
    try {
      const start = Date.now();
      
      // Call process/ping endpoint
      const pingResult = await axios.post(
        `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}/api/process/ping`,
        { ping: i, total: count },
        { 
          headers: { 
            'Content-Type': 'application/json',
            'x-api-key': process.env.API_KEY 
          },
          timeout: 10000
        }
      );

      const { status, fortune } = pingResult.data;

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `🔢 Ping #${i}/${count}: *${status}*\n🥠 *${fortune}*`
      });

    } catch (error) {
      console.error(`Ping #${i} failed:`, error.message);
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `❌ Ping #${i}/${count}: *Failed* - ${error.message}`
      });
    }

    // Delay between pings
    if (i < count) await new Promise(r => setTimeout(r, 1500));
  }
};
