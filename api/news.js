// /api/news.js — Vercel serverless function
// Proxies Noozra (free, no-key news API) instead of calling it directly from
// the browser. Two real benefits, not just "cleaner architecture":
//
// 1. Noozra's free tier caps at 100 requests/day PER IP. Calling it directly
//    from the browser means every refresh/test during development burns that
//    cap on YOUR home network's IP. Proxied through here, requests come from
//    Vercel's server IP instead — a completely fresh quota, unaffected by any
//    testing you've already done from your own connection.
// 2. Server-side caching means many page visits within the cache window only
//    cost ONE upstream request total, not one per visit — so the 100/day cap
//    stretches much further under real traffic too.

let cache = {}; // keyed by category
const CACHE_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const category = (req.query.category || 'general').toString().slice(0, 30);
  const limit = Math.min(parseInt(req.query.limit) || 12, 20);

  const cached = cache[category];
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  try{
    const r = await fetch(`https://noozra.com/api/articles?category=${encodeURIComponent(category)}&limit=${limit}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    cache[category] = { data: d, ts: Date.now() };
    return res.status(200).json(d);
  } catch (e) {
    if (cached) return res.status(200).json({ ...cached.data, cached: true, stale: true });
    return res.status(200).json({ articles: [], error: e.message });
  }
};
