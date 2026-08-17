// /api/crypto.js — Vercel serverless function
// Proxies CoinGecko (free, no key) with server-side caching. CoinGecko's free
// tier rate-limits fairly aggressively per IP — proxying through here means
// only OUR server's IP needs to respect that limit, and repeated visits
// within the cache window cost one upstream call total, not one per visitor.

const COINS = ['bitcoin','ethereum','solana','dogecoin','ripple','cardano','binancecoin','polkadot','litecoin','chainlink'];

let cache = { data: null, ts: 0 };
const CACHE_MS = 2 * 60 * 1000; // crypto moves fast, so a shorter cache than news/currency

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (cache.data && Date.now() - cache.ts < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  try{
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${COINS.join(',')}&order=market_cap_desc&price_change_percentage=24h`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const payload = { coins: d };
    cache = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);
  } catch (e) {
    if (cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(200).json({ coins: [], error: e.message });
  }
};
