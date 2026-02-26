import { App } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Log EVERYTHING Bolt passes to handler
app.command('/ping', async (fullContext) => {
  console.log('🔍 FULL BOLT CONTEXT:', JSON.stringify(fullContext, null, 2));
  
  // Try different destructuring patterns
  try {
    const { ack } = fullContext;
    console.log('✅ ACK FOUND:', typeof ack);
    await ack(':wave: new pong message');
  } catch (error) {
    console.error('❌ ACK FAILED:', error.message);
    
    // Fallback: try ctx pattern
    if (fullContext.ctx && fullContext.ctx.ack) {
      console.log('✅ CTX ACK FOUND');
      await fullContext.ctx.ack(':wave: pong');
    } else {
      console.error('❌ NO ACK ANYWHERE');
    }
  }
});

// Global error handler with logging
app.error(async (error) => {
  console.error('💥 BOLT GLOBAL ERROR:', error);
});

export default async function handler(req, res) {
  console.log('🚀 Slackbot HIT!');
  console.log('📥 Method:', req.method);
  console.log('📥 Headers:', Object.keys(req.headers));
  console.log('📥 Body keys:', Object.keys(req.body || {}));
  
  if (req.method === 'POST') {
    try {
      await app.processEvent(req, res);
    } catch (error) {
      console.error('💥 HANDLER ERROR:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Bolt processing failed' });
      }
    }
  } else {
    res.status(405).send('Method Not Allowed');
  }
}
