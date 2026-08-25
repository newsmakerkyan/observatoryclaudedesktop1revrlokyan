// /api/chat.js — Vercel serverless function
// Everything routes through OpenRouter now — ONE key (OPENROUTER_API_KEY)
// gives access to all 5 models below, instead of juggling a separate key
// per provider. Set OPENROUTER_API_KEY in your hosting platform's
// Environment Variables (openrouter.ai — free signup, no card, no Google
// account age-restriction issue like direct Gemini access had).
//
// The "Llama 3.3 70B (Groq)" option specifically asks OpenRouter to route
// through Groq's infrastructure via the `provider.order` field — so you
// still get Groq's speed, just through the single unified key.

const MODELS = {
  'groq-llama':  { model: 'meta-llama/llama-3.3-70b-instruct:free', provider: { order: ['Groq'], allow_fallbacks: true } },
  'deepseek-r1': { model: 'deepseek/deepseek-r1:free' },
  'qwen-coder':  { model: 'qwen/qwen-2.5-coder-32b-instruct:free' },
  'gemini-flash':{ model: 'google/gemini-2.5-flash:free' },
  'mistral-7b':  { model: 'mistralai/mistral-7b-instruct:free' },
};
const DEFAULT_MODEL_KEY = 'gemini-flash';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT_MAX;
}

// Relaxed grounding rule: OPERATOR answers general knowledge like a normal
// assistant. The one strict rule is about THIS DASHBOARD's own live numbers
// specifically — never invent a stock price, quake magnitude, etc. that
// isn't in the data block below.
const SYSTEM_PROMPT = (context) =>
  'You are OPERATOR, a genuine, full-featured AI chatbot — think and respond like a normal, capable AI assistant ' +
  '(the kind people have real conversations with), not a narrow search tool or a bot that only answers questions ' +
  'about the page it happens to live on. You can discuss absolutely anything: general knowledge, advice, ' +
  'explanations, creative requests, casual conversation, whatever the person actually wants to talk about. You ' +
  'also happen to be embedded in a live dashboard called Observatory, so you can reference its data when relevant, ' +
  'but that is a bonus feature, not your whole personality. Respond naturally and conversationally, at whatever ' +
  'length actually fits the question — brief for simple things, more thorough when it\'s warranted.\n\n' +
  'The one place to be careful: if asked for a specific LIVE number this dashboard tracks (a stock price, crypto ' +
  'price, quake magnitude, currency rate, weather reading, etc.), only state a figure if it actually appears in ' +
  'the "Live dashboard data" block below — say "I don\'t have that in the current live feed" rather than guess. ' +
  'That\'s it — everything else, answer like the full assistant you are.\n\n' +
  (context ? `Live dashboard data (only source of truth for THIS dashboard's own numbers): ${JSON.stringify(context).slice(0, 2000)}` : 'No live dashboard data was passed for this question.');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET is not how the chatbot actually talks to this endpoint (it needs
  // POST), but visiting /api/chat directly in a browser is a GET request —
  // so instead of a useless "POST only" error, answer with a real status
  // check. This is the SAME "just visit the URL" diagnostic trick that
  // already works for /api/currency, /api/news, and /api/finance.
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok — this endpoint is reachable',
      openrouter_key_configured: Boolean(process.env.OPENROUTER_API_KEY),
      hint: process.env.OPENROUTER_API_KEY
        ? 'Key is set. If chat still fails, the issue is likely the OpenRouter account itself (invalid key, out of credits, or the specific free model is temporarily unavailable) — check openrouter.ai/activity for the real error.'
        : 'OPENROUTER_API_KEY is NOT set in this deployment. Add it in Vercel → Settings → Environment Variables, then redeploy.',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests — slow down a moment.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { message, context, provider } = body || {};

  if (!message || typeof message !== 'string' || message.length > 500) {
    return res.status(400).json({ error: 'Send a "message" string under 500 characters.' });
  }
  const cleanMessage = message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
  if (!cleanMessage) {
    return res.status(400).json({ error: 'Message was empty after cleanup.' });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "Server is missing OPENROUTER_API_KEY. Set it in your host's environment variables." });
  }

  const chosen = MODELS[provider] || MODELS[DEFAULT_MODEL_KEY];

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        // OpenRouter asks for these two for its free-tier attribution — not
        // required to be your real deployed URL, just good practice to set.
        'HTTP-Referer': 'https://observatory-dashboard.vercel.app',
        'X-Title': 'Observatory',
      },
      body: JSON.stringify({
        model: chosen.model,
        ...(chosen.provider ? { provider: chosen.provider } : {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT(context) },
          { role: 'user', content: cleanMessage },
        ],
        max_tokens: 500,
        temperature: 0.5,
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'AI provider error', detail: t.slice(0, 300) });
    }
    const d = await r.json();
    const reply = d.choices?.[0]?.message?.content?.trim() || "I couldn't generate a reply — try rephrasing.";
    return res.status(200).json({ reply, model: chosen.model });
  } catch (e) {
    return res.status(502).json({ error: 'AI provider error', detail: e.message });
  }
};
