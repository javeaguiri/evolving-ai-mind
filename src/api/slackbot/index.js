export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const body = req.body;
  if (body.command === '/ping') {
    return res.json({ text: ':wave: pong' });
  }
  res.status(404).end();
}
