// src/api/process/ping.js - Single fortune GET endpoint
export default async function handler(req, res) {
  const API_KEY = process.env.API_KEY;
  const LLM_API_KEY = process.env.LLM_API_KEY;

  // Security check (keep for other APIs)
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  // Accept GET (for slackbot) OR POST
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use GET/POST." });
  }

  try {
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
          { role: "system", content: "You are a friendly AI fortune cookie generator. Respond with ONE short, wise fortune cookie message only (10-15 words max). No quotes, no explanation." },
          { role: "user", content: "Give me one short, randomized wise fortune cookie message." }
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

    // SLACK-FRIENDLY FORMAT
    res.status(200).json({
      content: fortune  // ← Exactly what slackbot expects
    });

  } catch (err) {
    console.error("Ping process error:", err);
    res.status(500).json({ 
      error: "Fortune generation failed", 
      content: "The oracle is taking a break. Try again!" 
    });
  }
}
