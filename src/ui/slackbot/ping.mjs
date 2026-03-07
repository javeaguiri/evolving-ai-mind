// slackbot/ping.mjs - Slackbot /ping slash command handler for Lambda

import { WebClient } from "@slack/web-api";
import { pingCommand } from "./commands/ping-command.mjs";

export default async function handler(req, res) {
  // Slack slash commands come as POST
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const body = req.body;
  if (!body || body.command !== "/ping") {
    return res.status(400).json({ error: "Command not handled by this endpoint" });
  }

  const client = new WebClient(process.env.SLACK_BOT_TOKEN);

  try {
    // Acknowledgment immediately
    res.status(200).json({
      response_type: "ephemeral",
      text: `:wave: pong! Count: ${body.text || 3} (quick ack)`,
    });

    // Background ping command
    (async () => {
      await pingCommand({
        command: { ...body },
        client,
      });
    })();

  } catch (err) {
    console.error("Ping handler error:", err);
    // No secondary Slack message here; pingCommand handles it.
  }
}
