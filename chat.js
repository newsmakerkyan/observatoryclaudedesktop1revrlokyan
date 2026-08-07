// /api/chat.js — Vercel serverless function
// Holds the AI provider key server-side. NEVER exposed to the browser.
// Set GROQ_API_KEY in your hosting platform's Environment Variables.
//
// Uses Groq (free tier, Llama 3.3 70B) by default. To use OpenAI/Claude/Gemini
// instead, swap the fetch URL + auth header + model name below — the request/
// response shape you send to the frontend can stay identical.

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20; // requests per IP per minute
const hits = new Map();
// NOTE: this in-memory limiter resets whenever the function cold-starts —
// normal on serverless, fine for personal traffic. For real traffic, swap
// for a durable store (Vercel Edge Config or Upstash Redis, both free-tier).

function isRateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT_MAX;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests — slow down a moment.' });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "Server is missing GROQ_API_KEY. Set it in your host's environment variables." });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { message, context } = body || {};

  if (!message || typeof message !== 'string' || message.length > 500) {
    return res.status(400).json({ error: 'Send a "message" string under 500 characters.' });
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content:
              'You are OPERATOR, the AI assistant embedded in a live mission-control dashboard called Observatory. ' +
              'Answer briefly — 2 to 4 sentences, calm and precise, no fluff. ' +
              (context ? `Live dashboard data you can reference if relevant: ${JSON.stringify(context).slice(0, 2000)}` : ''),
          },
          { role: 'user', content: message },
        ],
        max_tokens: 300,
        temperature: 0.6,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return res.status(502).json({ error: 'AI provider error', detail: errText.slice(0, 300) });
    }
    const data = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "I couldn't generate a reply — try rephrasing.";
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: 'Request to AI provider failed.' });
  }
};
