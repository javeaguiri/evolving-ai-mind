// SLACK-Ping: Tests Vercel→api/process/ping→LLM connections with N pings
import { logger } from '../shared/logger.js';

export const handler = async ({ command, ack, client }) => {
  await ack();
  
  const channelId = command.channel_id;
  const userId = command.user_id;
  const text = command.text?.trim() || '';
  
  // Parse number of pings (1-10, default 3)
  const numPings = parseInt(text.match(/(\d+)/)?.[1] || '3');
  const count = Math.max(1, Math.min(10, numPings)); // clamp 1-10
  
  // 1) Immediate "working" ephemeral
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: `🧪 Pinging connections ${count} times...`
  });
  
  // 2) Post parent message
  const parent = await client.chat.postMessage({
    channel: channelId,
    text: `🧪 Connection test for <@${userId}>: ${count} pings incoming...`
  });
  
  const threadTs = parent.ts;
  
  // 3) Ping your api/process/ping endpoint N times
  for (let i = 1; i <= count; i++) {
    try {
      // Simulate calling your ping test (replace with real endpoint)
      const pingResult = await fetch('http://localhost:3000/api/process/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: i, total: count })
      });
      
      const result = await pingResult.json();
      const status = result?.status || 'OK';
      
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `🔢 Ping #${i}/${count}: *${status}* (RTT: ${Date.now() - start}ms)`
      });
      
    } catch (error) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `❌ Ping #${i}/${count}: *Failed* - ${error.message}`
      });
    }
    
    // Small delay between pings
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
};
