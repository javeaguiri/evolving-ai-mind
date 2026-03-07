// /api/slackbot/index.mjs - router for Slackbot endpoints

import pingHandler from "../slackbot/ping.mjs";

export default async function handler(req, res) {
  // You can route multiple Slack endpoints here later.
  // Example: /api/slackbot/ping
  const path = req.url.split("/").slice(-1)[0] || "ping";

  switch (path) {
    case "ping":
      return pingHandler(req, res);
    default:
      return res.status(404).json({ error: `Slackbot endpoint "${path}" not found` });
  }
}
