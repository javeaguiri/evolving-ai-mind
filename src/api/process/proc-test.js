import Perplexity from '@perplexity-ai/perplexity_ai';

export default async function handler(req, res) {
  const API_KEY = process.env.API_KEY;
  const LLM_API_KEY = process.env.LLM_API_KEY; // LLM (perplexity) API key

  // Security check
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  // Method check
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  try {
    // Call Perplexity's API
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "sonar",   
        messages: [
          { role: "system", content: "You are a friendly AI fortune cookie generator." },
          { role: "user", content: "Give me one short and randomized wise fortune cookie message." }
        ],
        max_tokens: 50,
      }),
    });

    if (!response.ok) {
      const errMsg = await response.text();
      throw new Error(`Perplexity API error: ${response.status} ${errMsg}`);
    }

    const data = await response.json();
    const fortune = data?.choices?.[0]?.message?.content?.trim() || "Your future is unclear—try again. 🌙";

    // Return the result
    res.status(200).json({
      status: "OK",
      fortune,
      source: "Perplexity API"
    });

  } catch (err) {
    console.error("Proc-test error:", err);
    res.status(500).json({ error: "Failed to fetch from LLM", details: err.message });
  }
}