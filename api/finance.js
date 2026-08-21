// /api/finance.js — Vercel serverless function
// Uses Finnhub for real, live US stock quotes. Set FINNHUB_API_KEY in your
// hosting platform's Environment Variables (free key at finnhub.io — 60
// calls/minute, no credit card).
//
// Indices: no free source anywhere gives raw international index points
// (S&P 500, FTSE, DAX, etc.) — that's licensed exchange data everywhere,
// free or paid. Instead these are real, live prices of well-known ETFs that
// TRACK each index (e.g. SPY for the S&P 500) — genuine live data, just of
// the ETF's share price, not the index's own point value. The frontend
// labels each one with its ETF ticker so this is never disguised as
// something it isn't.

const STOCKS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'NFLX'];
const INDEX_PROXIES = {
  SPX: 'SPY', DJI: 'DIA', IXIC: 'QQQ', FTSE: 'FLGB', GDAXI: 'EWG',
  FCHI: 'EWQ', N225: 'EWJ', HSI: 'EWH', SHCOMP: 'ASHR',
};

let cache = { data: null, ts: 0 };
const CACHE_MS = 15 * 60 * 1000;

function simulatedPayload(){
  const zero = { price: 0, change: 0 };
  const stocks = {}, indices = {};
  STOCKS.forEach(s => stocks[s] = zero);
  Object.keys(INDEX_PROXIES).forEach(i => indices[i] = zero);
  return { stocks, indices, updated: new Date().toISOString(), simulated: true };
}

async function fetchQuote(symbol, key){
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
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
    const [stockResults, indexResults] = await Promise.all([
      Promise.all(STOCKS.map(async sym => [sym, await fetchQuote(sym, key)])),
      Promise.all(Object.entries(INDEX_PROXIES).map(async ([id, etf]) => [id, await fetchQuote(etf, key)])),
    ]);

    const stocks = {}, indices = {};
    stockResults.forEach(([sym, q]) => { if(q) stocks[sym] = q; });
    indexResults.forEach(([id, q]) => { if(q) indices[id] = q; });

    if(Object.keys(stocks).length === 0 && Object.keys(indices).length === 0){
      return res.status(200).json(simulatedPayload());
    }

    const payload = { stocks, indices, updated: new Date().toISOString() };
    cache = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);
  } catch (e) {
    if (cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(200).json(simulatedPayload());
  }
};
