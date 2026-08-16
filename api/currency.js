// /api/festivals.js — Vercel serverless function
// Fetches real public holidays from Nager.Date (date.nager.at) — genuinely
// free, no API key, no signup. Proxied through this backend (rather than
// called directly from the browser) because Nager.Date's docs flag
// inconsistent CORS support for direct browser requests — a server-to-server
// call sidesteps that entirely, and needs zero new account setup from you.
//
// Covers a curated set of 18 countries spanning every populated continent.
// Results are the next ~20 upcoming public holidays across all of them,
// closest first, so things like Diwali (India), Christmas, or a country's
// Independence Day naturally surface as they approach.

const COUNTRIES = ['US','IN','GB','CA','AU','DE','FR','JP','BR','CN','ZA','NG','MX','IT','ES','KR','AE','NZ'];

let cache = { data: null, ts: 0 };
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours — this data changes at most daily

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (cache.data && Date.now() - cache.ts < CACHE_MS) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  try{
    const now = new Date();
    const year = now.getFullYear();
    // Pull both this year and next year so the list never runs dry in December.
    const requests = [];
    COUNTRIES.forEach(cc => {
      requests.push(fetch(`https://date.nager.at/api/v3/publicholidays/${year}/${cc}`).then(r => r.ok ? r.json() : []).catch(() => []));
      requests.push(fetch(`https://date.nager.at/api/v3/publicholidays/${year + 1}/${cc}`).then(r => r.ok ? r.json() : []).catch(() => []));
    });
    const results = await Promise.all(requests);
    const all = results.flat().filter(Boolean);

    const todayStr = now.toISOString().slice(0, 10);
    const upcoming = all
      .filter(h => h.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 40)
      .map(h => ({
        date: h.date,
        name: h.name,
        localName: h.localName,
        countryCode: h.countryCode,
        isToday: h.date === todayStr,
      }));

    const payload = { holidays: upcoming, updated: now.toISOString() };
    cache = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);
  } catch (e) {
    if (cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(200).json({ holidays: [], updated: new Date().toISOString(), error: 'Holiday provider unreachable.' });
  }
};
