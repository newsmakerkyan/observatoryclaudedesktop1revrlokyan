// /api/finance.js — Secure Serverless Endpoint
// Pulls real-time quotes from Finnhub using your Vercel cloud variable.

const STOCKS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'NFLX'];

const INDEX_PROXIES = {
  SPX: 'SPY',      // S&P 500
  DJI: 'DIA',      // Dow Jones
  IXIC: 'QQQ',     // Nasdaq
  FTSE: 'FLGB',    // FTSE 100
  GDAXI: 'EWG',    // DAX
  FCHI: 'EWQ',     // CAC 40
  N225: 'EWJ',     // Nikkei 225
  HSI: 'EWH',      // Hang Seng
  SHCOMP: 'ASHR',  // Shanghai Composite
};

let cache = { data: null, ts: 0 };
const CACHE_MS = 60 * 1000; // Refreshes prices from the market every 1 minute

function simulatedPayload(){
  const zero = { price: 0, change: 0 };
  const stocks = {}, indices = {};
  STOCKS.forEach(s => stocks[s] = zero);
  Object.keys(INDEX_PROXIES).forEach(i => indices[i] = zero);
  return { stocks, indices, updated: new Date().toISOString(), simulated: true };
}

async function fetchQuote(symbol, key){
  try {
    const url = `https://finnhub.io{encodeURIComponent(symbol)}&token=${key}`;
    const r = await fetch(url);
    if(!r.ok) return null;
    const d = await r.json();
    if(!d || typeof d.c !== 'number' || d.c === 0) return null;
    return { price: d.c, change: d.dp };
  } catch (err) {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET method only' });

  if (cache.data && Date.now() - cache.ts < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    return res.status(200).json(simulatedPayload());
  }

  try{
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
