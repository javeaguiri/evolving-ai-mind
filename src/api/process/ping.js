// src/api/process/ping.js - ESM fortune cookie endpoint
export default async function handler(req, res) {
  const API_KEY = process.env.API_KEY;
  const LLM_API_KEY = process.env.LLM_API_KEY; // LLM (perplexity) API key

  // Security check
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const { ping, total } = req.body || {};
    
    // Perplexity fortune cookie
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "You are a friendly AI fortune cookie generator. Respond with ONE short, wise fortune cookie message only." },
          { role: "user", content: "Give me one short and randomized wise fortune cookie message." }
        ],
        max_tokens: 50,
        temperature: 0.8
      }),
    });

    if (!response.ok) {
      const errMsg = await response.text();
      throw new Error(`Perplexity API error: ${response.status}`);
    }

    const data = await response.json();
    const fortune = data?.choices?.[0]?.message?.content?.trim() || "Your future shines bright! 🌟";

    res.status(200).json({
      status: "OK",
      ping: ping || 1,
      total: total || 1,
      fortune,
      source: "Perplexity API"
    });

  } catch (err) {
    console.error("Ping process error:", err);
    res.status(500).json({ 
      error: "Ping failed", 
      details: err.message 
    });
  }
}
