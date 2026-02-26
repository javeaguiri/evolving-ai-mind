import { App } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

app.command("/ping", async ({ command, ack }) => {
  await ack(":wave: pong");
});

export default app;
