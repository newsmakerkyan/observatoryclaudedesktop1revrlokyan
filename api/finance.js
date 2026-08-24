// /api/finance.js — Vercel serverless function
// Uses Finnhub for real, live US quotes. Set FINNHUB_API_KEY in your hosting
// platform's Environment Variables (free key at finnhub.io — 60 calls/
// minute, no credit card).
//
// Indices & Bonds: no free source gives raw index points or bond yields
// directly — that's licensed data everywhere. These use real, live prices
// of well-known ETFs that TRACK each market segment (e.g. SPY for the S&P
// 500, TLT for long-term Treasuries) — genuine live data, just of the ETF's
// share price. The frontend labels each with its ETF ticker so this is
// never disguised as the underlying index/yield itself.

const STOCKS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'NFLX'];
const SHARES = ['JPM', 'WMT', 'V', 'JNJ', 'BRK.B'];
const INDEX_PROXIES = {
  SPX: 'SPY', DJI: 'DIA', IXIC: 'QQQ', FTSE: 'FLGB', GDAXI: 'EWG',
  FCHI: 'EWQ', N225: 'EWJ', HSI: 'EWH', SHCOMP: 'ASHR',
};
const BOND_PROXIES = {
  US20Y: 'TLT',   // 20+ Year Treasury
  US10Y: 'IEF',   // 7-10 Year Treasury
  TOTAL: 'BND',   // Total US Bond Market
  HIYIELD: 'HYG', // High-Yield Corporate
};

let cache = { data: null, ts: 0 };
const CACHE_MS = 15 * 60 * 1000;

function simulatedGroup(ids){
  const zero = { price: 0, change: 0 };
  const g = {};
  ids.forEach(i => g[i] = zero);
  return g;
}
function simulatedPayload(){
  return {
    stocks: simulatedGroup(STOCKS),
    indices: simulatedGroup(Object.keys(INDEX_PROXIES)),
    shares: simulatedGroup(SHARES),
    bonds: simulatedGroup(Object.keys(BOND_PROXIES)),
    updated: new Date().toISOString(), simulated: true,
  };
}

async function fetchQuote(symbol, key){
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
  if(!r.ok) return null;
  const d = await r.json();
  if(!d || typeof d.c !== 'number' || d.c === 0) return null;
  return { price: d.c, change: d.dp };
}

async function fetchGroup(ids, symbolFor, key){
  const results = await Promise.all(ids.map(async id => [id, await fetchQuote(symbolFor(id), key)]));
  const out = {};
  results.forEach(([id, q]) => { if(q) out[id] = q; });
  return out;
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
    const [stocks, indices, shares, bonds] = await Promise.all([
      fetchGroup(STOCKS, s => s, key),
      fetchGroup(Object.keys(INDEX_PROXIES), id => INDEX_PROXIES[id], key),
      fetchGroup(SHARES, s => s, key),
      fetchGroup(Object.keys(BOND_PROXIES), id => BOND_PROXIES[id], key),
    ]);

    const totalResolved = Object.keys(stocks).length + Object.keys(indices).length;
    if(totalResolved === 0){
      return res.status(200).json(simulatedPayload());
    }

    const payload = { stocks, indices, shares, bonds, updated: new Date().toISOString() };
    cache = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);
  } catch (e) {
    if (cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(200).json(simulatedPayload());
  }
};
