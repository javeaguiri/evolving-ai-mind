// handler.mjs - Lambda entry point for both /api/process/* and /api/slackbot/*

import processRouter from "./src/api/process/index.mjs";
import slackbotRouter from "./src/api/slackbot/index.mjs";

export async function handler(req, res) {
  const url = req.url; // or your Lambda event → req adapter

  if (url.startsWith("/api/process/")) {
    return processRouter(req, res);
  }

  if (url.startsWith("/api/slackbot/")) {
    return slackbotRouter(req, res);
  }

  return res.status(404).json({ error: "Not found" });
}
