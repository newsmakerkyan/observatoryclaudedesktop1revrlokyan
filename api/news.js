// /api/news.js — Vercel serverless function
//
// SWITCHED PROVIDER: Noozra started returning HTTP 403 to our server the
// same way exchangerate.fun did — same class of bot-protection issue that a
// User-Agent header alone couldn't fix. Rather than keep chasing it, this
// now uses NewsData.io: a well-documented, actively maintained news API
// with a genuine free tier (200 requests/day) that explicitly permits use
// on a public/personal site, unlike some competitors (e.g. GNews) whose
// free tier legally forbids anything but private development.
//
// Needs a free key: sign up at newsdata.io, then set NEWSDATA_API_KEY in
// your hosting platform's Environment Variables. See README.md.
//
// The response is normalized into the SAME shape the frontend already
// expects ({ articles: [{ headline, url, source, published_at }] }) —
// this means index.html needed ZERO changes for this swap.

const CATEGORY_MAP = {
  general: 'top', world: 'world', business: 'business',
  tech: 'technology', science: 'science', sports: 'sports',
};

let cache = {}; // keyed by category
const CACHE_MS = 15 * 60 * 1000; // longer than before — this free tier is 200/day, not unlimited

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const category = (req.query.category || 'general').toString().slice(0, 30);
  const ndCategory = CATEGORY_MAP[category] || 'top';

  const cached = cache[category];
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  if (!process.env.NEWSDATA_API_KEY) {
    return res.status(200).json({ articles: [], error: 'Server is missing NEWSDATA_API_KEY.' });
  }

  try{
    const url = `https://newsdata.io/api/1/latest?apikey=${process.env.NEWSDATA_API_KEY}&category=${ndCategory}&language=en`;
    const r = await fetch(url);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();

    const articles = (d.results || []).slice(0, 12).map(a => ({
      headline: a.title,
      url: a.link,
      source: a.source_id || a.source_name || 'unknown',
      published_at: a.pubDate ? new Date(a.pubDate.replace(' ', 'T') + 'Z').toISOString() : new Date().toISOString(),
    }));

    const payload = { articles };
    cache[category] = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);
  } catch (e) {
    if (cached) return res.status(200).json({ ...cached.data, cached: true, stale: true });
    return res.status(200).json({ articles: [], error: e.message });
  }
};
