import pingHandler from './ping.js';

export default async function handler(req, res) {
  const path = req.url.split('/').slice(-1)[0] || 'ping'; // /api/process/ping → "ping"

  switch (path) {
    case 'ping':
      return pingHandler(req, res);
    default:
      res.status(404).json({ error: `Process "${path}" not found` });
  }
}
