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

    // Async test message ONLY – no proc-test call
    (async () => {
      try {
        console.log("📤 Sending follow-up test message...");

        // Simple 2s delay just so you can see it's separate
 //       await new Promise(resolve => setTimeout(resolve, 2000));

        await fetch(body.response_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'ephemeral',
            text: `✅ Follow-up test message after quick ack (no proc-test)`
          })
        });

        console.log("✅ Follow-up test delivered!");
      } catch (error) {
        console.error("❌ Follow-up test failed:", error);
      }
    })();

    // --- OLD proc-test CALL COMMENTED OUT ---
    /*
    (async () => {
      try {
        console.log("🔄 Calling proc-test (GET)...");
        const response = await fetch('https://second-brain-api-woad.vercel.app/api/process/proc-test', {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        await fetch(body.response_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'ephemeral',
            text: `🎉 *LLM FORTUNE:* "${data.response || data.text || 'Fortune ready!'}"`
          })
        });
      } catch (error) {
        console.error("❌ proc-test error:", error);
      }
    })();
    */
  } else {
    res.status(404).json({ error: 'Command not found' });
  }
}
