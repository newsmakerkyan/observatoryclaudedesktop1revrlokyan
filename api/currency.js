// /api/currency.js — Vercel serverless function
//
// SWITCHED PRIMARY SOURCE: exchangerate.fun kept returning HTTP 403 to our
// server even after adding a browser-like User-Agent — likely deeper bot
// protection (e.g. TLS fingerprinting) that a header alone can't get past.
// Rather than keep chasing that, currency rates now come from Frankfurter
// (European Central Bank reference rates) — a long-established, genuinely
// free, no-key, no-blocking API with no reports of this problem.
//
// TRADEOFF: Frankfurter covers ~30 major currencies but not AED, SAR, RUB,
// PKR, or EGP. AED and SAR are added back via their real currency-board
// pegs (UAE and Saudi Arabia both fix their currency to the US dollar by
// law — these aren't estimates, they're the actual maintained peg rates).
// RUB, PKR, and EGP float and can't be safely hardcoded, so those three
// show "—" until a reliable free source for them is found.
//
// Metals (gold/silver/copper) aren't something Frankfurter/ECB provides at
// all. Gold and silver now come from xaus.com (https://xaus.com/api/v1/spot)
// — confirmed free, no key, no auth, no rate limits, single call gives both.
// Copper still isn't available from any free source I could find, so it
// keeps attempting the old exchangerate.fun call as a last-ditch try; if
// that keeps failing, only Copper shows "—" — everything else is unaffected.

const AED_PEG = 3.6725; // UAE Central Bank law, fixed since 1997
const SAR_PEG = 3.75;   // Saudi Central Bank (SAMA), fixed since 1986

let cache = { data: null, ts: 0 };
const CACHE_MS = 20 * 60 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (cache.data && Date.now() - cache.ts < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  const rates = {};
  let currencyOk = false, goldSilverOk = false, copperOk = false;

  try{
    const r = await fetch('https://api.frankfurter.app/latest?from=USD');
    if(r.ok){
      const d = await r.json();
      Object.assign(rates, d.rates);
      rates.AED = AED_PEG;
      rates.SAR = SAR_PEG;
      currencyOk = true;
    }
  }catch(e){ /* handled by currencyOk staying false */ }

  try{
    const r2 = await fetch('https://xaus.com/api/v1/spot?compact=1');
    if(r2.ok){
      const d2 = await r2.json();
      // Frontend expects the same "inverse rate" convention as the old
      // source (rates.XAU = ounces of gold per 1 USD), so we convert xaus's
      // direct $/oz prices to that same shape — keeps the rest of the code
      // (and the $/kg math already there) unchanged.
      if(d2.spot_usd_oz) rates.XAU = 1 / d2.spot_usd_oz;
      if(d2.silver_usd_oz) rates.XAG = 1 / d2.silver_usd_oz;
      goldSilverOk = true;
    }
  }catch(e){ /* handled by goldSilverOk staying false */ }

  try{
    const r3 = await fetch('https://api.exchangerate.fun/latest?base=USD', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    if(r3.ok){
      const d3 = await r3.json();
      if(d3.rates?.XCU) rates.XCU = d3.rates.XCU;
      copperOk = true;
    }
  }catch(e){ /* handled by copperOk staying false */ }

  const payload = {
    rates,
    source: {
      currency: currencyOk ? 'frankfurter' : 'unavailable',
      goldSilver: goldSilverOk ? 'xaus.com' : 'unavailable',
      copper: copperOk ? 'exchangerate.fun' : 'unavailable',
    },
    updated: new Date().toISOString(),
  };

  if(currencyOk || goldSilverOk || copperOk){
    cache = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);
  }
  if(cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
  return res.status(200).json({ rates: {}, error: 'All providers unreachable.' });
};
