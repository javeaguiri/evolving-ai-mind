import { App } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

app.command("/ping", (req, ctx) => {
  return ctx.ack(":wave: pong");
});

export default async function handler(req, res) {
  console.log("🚀 Slackbot HIT!");
  if (req.method === 'POST') {
    await app.processEvent(req, res);
  } else {
    res.status(405).send('Method Not Allowed');
  }
}
