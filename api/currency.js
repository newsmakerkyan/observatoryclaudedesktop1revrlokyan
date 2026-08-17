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
    // Vercel's serverless fetch sends a minimal Node.js User-Agent by default,
    // and some APIs (including this one, apparently) reject requests that
    // don't look like they're coming from a real client — a plain
    // server-to-server 403, unrelated to rate limits or the API being down.
    // A normal browser-like header fixes it.
    const r = await fetch('https://api.exchangerate.fun/latest?base=USD', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    cache = { data: d, ts: Date.now() };
    return res.status(200).json(d);
  } catch (e) {
    if (cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(200).json({ rates: {}, error: e.message });
  }
};
