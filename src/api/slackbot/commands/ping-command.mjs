// slackbot/commands/ping-command.mjs
import { WebClient } from "@slack/web-api";

export const pingCommand = async ({ command, client }) => {
  const count = Math.min(parseInt(command.text) || 3, 10); // default 3, max 10
  const channel = command.channel_id;
  const user = command.user_id;

  // 1. Validate channel exists and bot can access it
  try {
    await client.conversations.info({ channel });
  } catch (error) {
    if (error.code === "channel_not_found") {
      console.log(`❌ Channel ${channel} not accessible`);
      return;
    }
    throw error;
  }

  // 2. Immediate ephemeral response (no fortune yet)
  try {
    await client.chat.postEphemeral({
      channel,
      user,
      text: `🔮 Generating ${count} fortune${count > 1 ? "s" : ""}...`,
    });
  } catch (error) {
    console.error("Ephemeral failed:", error.code);
  }

  // 3. Background fortune processing
  (async () => {
    try {
      const fortunes = [];
      for (let i = 0; i < count; i++) {
        const res = await fetch("https://second-brain-api-woad.vercel.app/api/process/ping");
        if (res.ok) fortunes.push(await res.json());
      }

      await client.chat.postMessage({
        channel,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `🤖 *${count} fortunes for <@${user}>!*`,
            },
          },
          ...fortunes.map((f, i) => ({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✨ *Fortune ${i + 1}*\n${f.content}`,
            },
          })),
        ],
      });
    } catch (error) {
      await client.chat.postMessage({
        channel,
        text: `❌ Error: ${error.message}`,
      });
    }
  })();
};

// Dynamic registry (UI / help list)
export const getCommands = () => [
  {
    name: "/ping [1-10]",
    description: "Test Vercel→LLM connections (default: 3 pings)",
    category: "🧪 Testing",
    example: "/ping 5",
  },
  {
    name: "/second-brain help",
    description: "Show all available commands",
    category: "Core",
  },
];
