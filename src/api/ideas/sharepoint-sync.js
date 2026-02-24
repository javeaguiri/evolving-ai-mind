//import fetch from "node-fetch";
import { getAccessToken } from "../../lib/getAccessToken.js";

const SITE_ID = process.env.SHAREPOINT_SITE_ID;
const LIST_ID = process.env.SHAREPOINT_LIST_ID;
const API_KEY = process.env.API_KEY;

export default async function handler(req, res) {
  // API Key check (optional)
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }
  
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const { title, topic, source, notes } = req.body || {};

  if (!topic || typeof topic !== "string" || !topic.trim()) {
    return res.status(400).json({ error: "Missing or invalid 'topic' field" });
  }

  try {
    const accessToken = await getAccessToken();

  
    const url = `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/lists/${LIST_ID}/items`;

    const body = {
      fields: {
        Title: title?.trim() || `Idea: ${topic.slice(0, 50)}`,
        Topic: topic.trim(),
        Source: source || "Vercel",
        Notes: notes || ""
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Graph failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    res.status(200).json({
      status: "OK",
      itemId: data.id,
      fields: data.fields,
      webUrl: "https://xabiavida.sharepoint.com/Lists/IdeasTest"
    });

  } catch (err) {
    console.error("SharePoint error:", err);
    res.status(500).json({ error: "SharePoint insert failed", details: err.message });
  }
}
