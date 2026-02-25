// src/api/404.js - Root domain handler
export default function handler(req, res) {
  res.status(200).json({
    message: "🧠 Evolving AI Mind API",
    endpoints: {
      slackbot: "POST /api/slackbot (Slack commands)",
      process: "POST /api/process/ping (fortune cookies)",
      docs: "See README.md"
    },
    status: "ready"
  });
}
