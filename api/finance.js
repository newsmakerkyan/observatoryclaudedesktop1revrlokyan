// /api/finance.js — Vercel serverless function
// Proxies Twelve Data so the API key never reaches the browser and to avoid
// CORS issues calling a paid-tier-gated API directly from client JS.
// Set TWELVEDATA_API_KEY in your hosting platform's Environment Variables.
//
// Free Twelve Data tier: 800 requests/day, 8/minute. This endpoint batches
// ALL symbols into one upstream call and caches the result for 10 minutes
// server-side, so many dashboard visitors only cost Twelve Data ~1 request
// total — not 1 per visitor. Keep the frontend refresh interval at 15+ min.
//
// IMPORTANT: exact index ticker strings vary by data provider and by plan.
// The symbols below are best-effort guesses (SPX, DJI, IXIC, FTSE, GDAXI,
// FCHI, N225, HSI, SHCOMP). After you get your Twelve Data key, use their
// dashboard's symbol search to confirm/correct any that come back empty —
// international index coverage is sometimes restricted on the free plan.
// Any symbol that errors is simply omitted from the response (not fatal) —
// the frontend shows "—" for it rather than breaking the whole panel.

const INDICES = ['SPX', 'DJI', 'IXIC', 'FTSE', 'GDAXI', 'FCHI', 'N225', 'HSI', 'SHCOMP'];
const STOCKS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'NFLX'];

let cache = { data: null, ts: 0 };
const CACHE_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (cache.data && Date.now() - cache.ts < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  if (!process.env.TWELVEDATA_API_KEY) {
    return res.status(500).json({ error: "Server is missing TWELVEDATA_API_KEY." });
  }

  const symbols = [...STOCKS, ...INDICES].join(',');
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols)}&apikey=${process.env.TWELVEDATA_API_KEY}`;
    const r = await fetch(url);
    const raw = await r.json();

    // Twelve Data returns { SYMBOL: {...} } when multiple symbols are requested,
    // or a single flat object if only one symbol resolved. Normalize defensively.
    const lookup = raw && raw.symbol ? { [raw.symbol]: raw } : raw;

    const stocks = {}, indices = {};
    for (const sym of STOCKS) {
      const d = lookup?.[sym];
      if (d && !d.code && d.close) stocks[sym] = { price: +d.close, change: +d.percent_change };
    }
    for (const sym of INDICES) {
      const d = lookup?.[sym];
      if (d && !d.code && d.close) indices[sym] = { price: +d.close, change: +d.percent_change };
    }

    const payload = { stocks, indices, updated: new Date().toISOString() };
    cache = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);
  } catch (e) {
    if (cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(502).json({ error: 'Finance provider unreachable.' });
  }
};
