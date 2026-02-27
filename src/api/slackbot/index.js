export default async function handler(req, res) {
  console.log("🚀 Slackbot HIT!");
  
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const body = req.body;
  
  if (body.command === '/ping') {
    const count = body.text || 1;
    
    // Immediate 200 OK response (no timeout)
    res.status(200).json({ 
      response_type: 'ephemeral',
      text: `:wave: pong! Count: ${count} (quick ack)`
    });

    // Async test message via chat.postEphemeral (RELIABLE)
    (async () => {
      try {
        
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay
        console.log("📤 Sending follow-up via chat.postEphemeral...");
        
        const response = await fetch('https://slack.com/api/chat.postEphemeral', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
          },
          body: JSON.stringify({
            channel: body.channel_id,
            user: body.user_id,
            text: '✅ Follow-up test message via chat.postEphemeral (WORKS!)'
          })
        });
        
        const data = await response.json();
        console.log("✅ postEphemeral result:", data.ok);
        
      } catch (error) {
        console.error("❌ postEphemeral failed:", error);
      }
    })();
  } else {
    res.status(404).json({ error: 'Command not found' });
  }
}
