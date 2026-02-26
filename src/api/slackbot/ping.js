export const pingCommand = async ({ command, client }) => {
  const count = Math.min(parseInt(command.text) || 1, 10);
  const channel = command.channel_id;  // ✅ from slash command payload
  const user = command.user_id;        // ✅ from slash command payload

  // 1. Validate channel exists and bot can access it
  try {
    await client.conversations.info({ channel });
  } catch (error) {
    if (error.code === 'channel_not_found') {
      console.log(`❌ Channel ${channel} not accessible`);
      return;
    }
    throw error;
  }

  // 2. Immediate ephemeral response (no fortune yet)
  try {
    await client.chat.postEphemeral({
      channel,
      user,
      text: `🔮 Generating ${count} fortune${count > 1 ? 's' : ''}...`
    });
  } catch (error) {
    console.error('Ephemeral failed:', error.code);
  }

  // 3. Background fortune processing
  (async () => {
    try {
      const fortunes = [];
      for(let i = 0; i < count; i++) {
        const res = await fetch('https://second-brain-api-woad.vercel.app/api/process/ping');
        if (res.ok) fortunes.push(await res.json());
      }
      
      await client.chat.postMessage({
        channel,
        blocks: [
          { 
            type: "section", 
            text: { type: "mrkdwn", text: `🤖 *${count} fortunes for <@${user}>!*` } 
          },
          ...fortunes.map((f, i) => ({
            type: "section", 
            text: { type: "mrkdwn", text: `✨ *Fortune ${i+1}*\n\`${f.content}\`` }
          }))
        ]
      });
    } catch (error) {
      await client.chat.postMessage({
        channel,
        text: `❌ Error: ${error.message}`
      });
    }
  })();
};
