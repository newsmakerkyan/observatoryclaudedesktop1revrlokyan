// /api/currency.js — Vercel serverless function
// Proxies exchangerate.fun (free, no key) with server-side caching. Same
// reasoning as news.js: a slow or occasionally-unresponsive free API is much
// less noticeable to visitors when only OUR server has to wait for it once
// every 20 minutes, instead of every visitor's own browser racing a timeout.

let cache = { data: null, ts: 0 };
const CACHE_MS = 20 * 60 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (cache.data && Date.now() - cache.ts < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  try{
    const r = await fetch('https://api.exchangerate.fun/latest?base=USD');
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    cache = { data: d, ts: Date.now() };
    return res.status(200).json(d);
  } catch (e) {
    if (cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(200).json({ rates: {}, error: e.message });
  }
};
