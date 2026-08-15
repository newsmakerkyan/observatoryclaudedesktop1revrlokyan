// /api/finance.js — Vercel serverless function
// Uses Finnhub for real, live US stock quotes. Set FINNHUB_API_KEY in your
// hosting platform's Environment Variables (free key at finnhub.io — 60
// calls/minute, no credit card).
//
// Deliberately stocks-only: an earlier version also showed 9 international
// "indices" via ETF proxies (no free source gives raw index points), but
// that added complexity and still wasn't the real thing. Just the 8
// companies keeps this simple, fast, and 100% real data with no caveats.

const STOCKS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'NFLX'];

let cache = { data: null, ts: 0 };
const CACHE_MS = 10 * 60 * 1000;

function simulatedPayload(){
  const zero = { price: 0, change: 0 };
  const stocks = {};
  STOCKS.forEach(s => stocks[s] = zero);
  return { stocks, updated: new Date().toISOString(), simulated: true };
}

async function fetchQuote(symbol, key){
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const r = await fetch(url);
  if(!r.ok) return null;
  const d = await r.json();
  if(!d || typeof d.c !== 'number' || d.c === 0) return null;
  return { price: d.c, change: d.dp };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (cache.data && Date.now() - cache.ts < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  if (!process.env.FINNHUB_API_KEY) {
    return res.status(200).json(simulatedPayload());
  }

  try{
    const key = process.env.FINNHUB_API_KEY;
    const results = await Promise.all(STOCKS.map(async sym => [sym, await fetchQuote(sym, key)]));
    const stocks = {};
    results.forEach(([sym, q]) => { if(q) stocks[sym] = q; });

    if(Object.keys(stocks).length === 0){
      return res.status(200).json(simulatedPayload());
    }

    const payload = { stocks, updated: new Date().toISOString() };
    cache = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);
  } catch (e) {
    if (cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(200).json(simulatedPayload());
  }
};
