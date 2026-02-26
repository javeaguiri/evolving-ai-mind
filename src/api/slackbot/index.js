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
      text: `:wave: pong! Count: ${count} (check back in 10s...)`
    });
    
    // Async follow-up after 10s delay (proves background processing works)
    (async () => {
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10s delay
      
      console.log("⏰ 10s DELAY COMPLETE - Sending follow-up");
      
      // Use response_url for guaranteed delivery (stores for 30min)
      await fetch(body.response_url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          response_type: 'ephemeral',
          text: `⏰ *DELAY SUCCESS!* Fortune: "Your async code works perfectly! 🎉" (after 10s)`
        })
      });
    })();
    
  } else {
    res.status(404).json({ error: 'Command not found' });
  }
}
