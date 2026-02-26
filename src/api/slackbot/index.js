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
      text: `:wave: pong! Count: ${count} (fetching fortune...)`
    });
    
    // Async call to /api/process/proc-test (reliable, no timeout issues)
    (async () => {
      try {
        console.log("🔄 Calling proc-test...");
        
        const response = await fetch('https://second-brain-api-woad.vercel.app/api/process/proc-test', {
          method: 'GET',
          headers: { 
            'Content-Type': 'application/json',
          }
        });
        
        const data = await response.json();
        console.log("✅ proc-test response:", data);
        
        // Send fortune back via response_url
        await fetch(body.response_url, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            response_type: 'ephemeral',
            text: `🎉 *LLM FORTUNE:* "${data.response || data.text || 'Fortune ready!'}"`
          })
        });
        
      } catch (error) {
        console.error("❌ proc-test error:", error);
        
        // Fallback notification
        await fetch(body.response_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'ephemeral',
            text: `⚠️ Fortune service busy - try again!`
          })
        });
      }
    })();
    
  } else {
    res.status(404).json({ error: 'Command not found' });
  }
}
