export const pingCommand = async ({ command, client }) => {
  // NO ack() call here - Bolt middleware handles it
  
  const count = Math.min(parseInt(command.text) || 1, 10);
  
  // Immediate ephemeral response
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text: `🧪 Processing *${count}* fortunes... (~${count*2}s)`
  });

  // Background fortune processing
  (async () => {
    try {
      const fortunes = [];
      for(let i = 0; i < count; i++) {
        const res = await fetch('https://second-brain-api-woad.vercel.app/api/process/ping');
        if (res.ok) fortunes.push(await res.json());
      }
      
      await client.chat.postMessage({
        channel: command.channel_id,
        thread_ts: command.ts,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `🤖 *${count} fortunes for <@${command.user_id}>!*` } },
          ...fortunes.map((f, i) => ({
            type: "section", 
            text: { type: "mrkdwn", text: `✨ *Fortune ${i+1}*\n\`${f.content}\`` }
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
  })();
};
