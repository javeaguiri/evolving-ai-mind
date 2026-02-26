const { App } = require('@slack/bolt');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

app.command("/ping", async ({ command, ack, client }) => {
  await ack(":wave: pong");
});

module.exports.app = app;
