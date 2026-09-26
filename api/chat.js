// /api/chat.js — Vercel serverless function
// Multi-provider AI chat: Groq, Google AI Studio (Gemini), Cloudflare Workers AI,
// and OpenRouter, selectable via the `provider` field sent from the frontend.
//
// ===== MODEL NOTES (verified against each provider's docs, 2026-09) =====
//
// GROQ — fastest, tried first in 'auto' mode.
//   ⚠ llama-3.3-70b-versatile was deprecated 2026-08-16.
//   ⚠ llama-4-scout-17b-16e-instruct was deprecated 2026-07-17.
//   Both are DEAD — using Groq's own recommended replacements instead:
//     openai/gpt-oss-120b   — best all-round quality/speed replacement
//     qwen/qwen3.6-27b      — Groq's other recommended replacement
//     meta-llama/llama-4-maverick-17b-128e-instruct — NOT in Groq's deprecation
//       list as of this writing, so presumed still live — but Groq's free-tier
//       catalog rotates without warning, so re-check console.groq.com/docs/models
//       if this one ever errors.
//
// GOOGLE AI STUDIO — DROPPED. Google AI Studio requires the account holder
//   be 13+ (enforced via Google Family Link on younger accounts), so this
//   provider isn't usable here. Removed rather than left in half-broken.
//
// LIVE WEB SEARCH — OpenRouter supports appending ":online" to almost any
//   model slug to have it run a real web search (via Exa) before answering,
//   instead of only knowing what's in its training data or the dashboard's
//   own live-data context. This is what makes answers behave like ChatGPT's
//   web-browsing mode rather than a closed-book model. Uses a bit more of
//   the ~50/day free-request budget per search, so it's offered as its own
//   selectable option rather than forced on every message.
//
// CLOUDFLARE WORKERS AI — needs a free Cloudflare account (NOT the same as
//   hosting your site there) plus an Account ID + an AI-scoped API token.
//   Billed in "Neurons" (10,000 free/day), not tokens. Model IDs below are
//   current as of this writing; Cloudflare's catalog changes too, so if one
//   404s, check developers.cloudflare.com/workers-ai/models/ for the live name:
//     @cf/google/gemma-4-27b-a4b-it            — Gemma
//     @cf/meta/llama-3.3-70b-instruct-fp8-fast — Llama (Workers AI kept this
//       one alive even though Groq killed its own copy — different catalogs)
//     @cf/mistral/mistral-7b-instruct-v0.1     — Mistral
//     @cf/qwen/qwen1.5-7b-chat                 — Qwen
//     @cf/deepseek-ai/deepseek-r1-distill-qwen-32b — DeepSeek (verify this
//       exact slug in Cloudflare's catalog before relying on it — DeepSeek
//       naming on Workers AI wasn't fully confirmable at the time of writing)
//
// OPENROUTER — backup, ~50 free requests/day shared across all free models.
//   Confirmed live free slugs as of 2026-09:
//     google/gemma-4-31b-it:free
//     nvidia/nemotron-3-ultra-550b-a55b:free
//     z-ai/glm-4.5-air:free
//   Same 3-per-request cap as before applies to the `models` fallback array.

const PROVIDERS = {
  'auto': null, // special-cased in the handler — chains across providers, see handleAuto()

  'groq-gptoss120b':   { kind: 'groq', model: 'openai/gpt-oss-120b' },
  'groq-qwen36':       { kind: 'groq', model: 'qwen/qwen3.6-27b' },
  'groq-llama4-mav':   { kind: 'groq', model: 'meta-llama/llama-4-maverick-17b-128e-instruct' },

  'cf-gemma':          { kind: 'cloudflare', model: '@cf/google/gemma-4-27b-a4b-it' },
  'cf-llama':          { kind: 'cloudflare', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  'cf-mistral':        { kind: 'cloudflare', model: '@cf/mistral/mistral-7b-instruct-v0.1' },
  'cf-qwen':           { kind: 'cloudflare', model: '@cf/qwen/qwen1.5-7b-chat' },
  'cf-deepseek':       { kind: 'cloudflare', model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b' },

  'or-gemma4-31b':     { kind: 'openrouter', model: 'google/gemma-4-31b-it:free' },
  'or-nemotron3ultra': { kind: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  'or-glm45air':       { kind: 'openrouter', model: 'z-ai/glm-4.5-air:free' },

  // Live-web-search variants — same free models, but ":online" makes
  // OpenRouter run a real internet search before answering. Slower and uses
  // more of the daily free quota, so pick these deliberately, not as default.
  'or-gemma4-31b-web':     { kind: 'openrouter', model: 'google/gemma-4-31b-it:online' },
  'or-nemotron3ultra-web': { kind: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:online' },
  'or-glm45air-web':       { kind: 'openrouter', model: 'z-ai/glm-4.5-air:online' },

  // 'smart-web' is just an alias for the strongest available free
  // combination (GLM 4.5 Air's reasoning quality + real live web search) —
  // this is the closest free setup gets to "smart AND actually current
  // information", so it's the one the dropdown defaults to.
  'smart-web': { kind: 'openrouter', model: 'z-ai/glm-4.5-air:online' },
};
const DEFAULT_PROVIDER_KEY = 'smart-web';

// 'auto' mode tries these in order, fastest/best first, falling through on
// any failure — stops at the first one that actually returns a reply.
// NOTE: 'auto' deliberately does NOT include a :online variant — live search
// is slower and burns free-tier quota faster, so it stays an explicit choice
// in the dropdown rather than something that fires on every default message.
const AUTO_CHAIN = ['groq-gptoss120b', 'cf-gemma', 'or-gemma4-31b'];

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

const SYSTEM_PROMPT = (context) =>
  'You are OPERATOR, a genuine, full-featured AI chatbot — think and respond like a normal, capable AI assistant ' +
  '(the kind people have real conversations with), not a narrow search tool or a bot that only answers questions ' +
  'about the page it happens to live on. You can discuss absolutely anything: general knowledge, advice, ' +
  'explanations, creative requests, casual conversation, whatever the person actually wants to talk about. You ' +
  'also happen to be embedded in a live dashboard called Observatory, so you can reference its data when relevant, ' +
  'but that is a bonus feature, not your whole personality. Default to giving thorough, complete answers with ' +
  'real detail and explanation, the way a knowledgeable person would actually explain something — not a one-line ' +
  'summary. Only stay brief for genuinely simple things (a yes/no fact, a quick lookup); for anything involving ' +
  'explanation, opinion, how-to, or discussion, write a full, well-developed answer.\n\n' +
  'THINK BEFORE ANSWERING — for anything with real complexity (a tradeoff, a multi-step problem, something with ' +
  'nuance or competing considerations), actually reason through it: consider the angles, weigh them, THEN give a ' +
  'clear conclusion — don\'t just pattern-match to a surface-level first answer. If a question has a "well, it ' +
  'depends" quality to it, say what it depends on rather than picking one answer and hiding the nuance. When you ' +
  'have real web search results available for a question, actually use and cite what you found rather than ' +
  'ignoring it in favor of what you already thought you knew.\n\n' +
  'PERSONALITY MATTERS — this applies no matter which underlying model is answering: never respond like a flat, ' +
  'robotic data-lookup tool, even for simple factual questions. Have some warmth and personality — a bit of wit, ' +
  'genuine engagement, a real voice — the way a person would want a smart friend to answer, not a search engine ' +
  'reading out a fact. This matters just as much as being correct.\n\n' +
  'The one place to be careful: if asked for a specific LIVE number this dashboard tracks (a stock price, crypto ' +
  'price, quake magnitude, currency rate, weather reading, etc.), only state a figure if it actually appears in ' +
  'the "Live dashboard data" block below — say "I don\'t have that in the current live feed" rather than guess. ' +
  'This matters MOST for financial figures specifically — never state a stock price, index value, or exchange ' +
  'rate from memory, even one that sounds plausible; always defer to the live data block or say you don\'t have ' +
  'it. That\'s it — everything else, answer like the full assistant you are.\n\n' +
  (context ? `Live dashboard data (only source of truth for THIS dashboard's own numbers): ${JSON.stringify(context).slice(0, 2000)}` : 'No live dashboard data was passed for this question.');

// ===== Per-provider callers =====
// Each returns { reply, model } on success, or throws/returns null on failure
// (handleAuto() treats both a thrown error and a null return as "try the next
// one in the chain" — a manually-selected single provider surfaces the error
// directly instead).

async function callGroq(env, model, messages) {
  if (!env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set.');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0.6 }),
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error('Groq error'); err.detail = t.slice(0, 300); throw err;
  }
  const d = await r.json();
  const reply = d.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('Groq returned an empty reply.');
  return { reply, model: `groq/${model}` };
}

async function callCloudflare(env, model, messages) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new Error('CF_ACCOUNT_ID and/or CF_API_TOKEN is not set.');
  }
  // Cloudflare's Workers AI REST endpoint is separate from Cloudflare Pages —
  // this is just calling their AI inference API like any other external
  // provider; it works the same whether your SITE is hosted on Vercel,
  // Cloudflare, or anywhere else. Needs a Cloudflare account (free) and an
  // API token scoped to "Workers AI: Read", plus your numeric Account ID —
  // both found in the Cloudflare dashboard, NOT the same as any Vercel keys.
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
    },
    body: JSON.stringify({ messages, max_tokens: 1500 }),
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error('Cloudflare Workers AI error'); err.detail = t.slice(0, 300); throw err;
  }
  const d = await r.json();
  const reply = d.result?.response?.trim();
  if (!reply) throw new Error('Cloudflare Workers AI returned an empty reply.');
  return { reply, model: `cloudflare/${model}` };
}

async function callOpenRouter(env, model, messages) {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set.');
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://observatory-dashboard.vercel.app',
      'X-Title': 'Observatory',
    },
    // Single model per call here (not the 3-item fallback array) since the
    // fallback logic across providers now lives in handleAuto() instead —
    // simpler to reason about than nesting two different fallback systems.
    body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0.6 }),
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error('OpenRouter error'); err.detail = t.slice(0, 300); throw err;
  }
  const d = await r.json();
  const reply = d.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('OpenRouter returned an empty reply.');
  return { reply, model: d.model || `openrouter/${model}` };
}

async function callProvider(env, key, messages) {
  const cfg = PROVIDERS[key];
  if (!cfg) throw new Error(`Unknown provider key: ${key}`);
  switch (cfg.kind) {
    case 'groq':       return callGroq(env, cfg.model, messages);
    case 'cloudflare': return callCloudflare(env, cfg.model, messages);
    case 'openrouter': return callOpenRouter(env, cfg.model, messages);
    default: throw new Error(`Unknown provider kind: ${cfg.kind}`);
  }
}

// 'auto' mode: walk AUTO_CHAIN in order, return the first success, collect
// every failure along the way so a total failure still explains what broke.
async function handleAuto(env, messages) {
  const errors = [];
  for (const key of AUTO_CHAIN) {
    try {
      const result = await callProvider(env, key, messages);
      return result;
    } catch (e) {
      errors.push(`${key}: ${e.detail || e.message}`);
    }
  }
  const err = new Error('All providers in the auto chain failed.');
  err.detail = errors.join(' | ').slice(0, 400);
  throw err;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok — this endpoint is reachable',
      keys_configured: {
        GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY),
        CF_ACCOUNT_ID: Boolean(process.env.CF_ACCOUNT_ID),
        CF_API_TOKEN: Boolean(process.env.CF_API_TOKEN),
        OPENROUTER_API_KEY: Boolean(process.env.OPENROUTER_API_KEY),
      },
      providers: Object.keys(PROVIDERS),
      auto_chain: AUTO_CHAIN,
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

  // NOTE: uses `in` rather than a truthy check — PROVIDERS['auto'] is
  // deliberately `null` (auto is special-cased below, not a real entry), so
  // a plain `PROVIDERS[provider] ? ... : ...` would silently treat "auto"
  // as invalid and always fall through to the default instead.
  const providerKey = (provider in PROVIDERS) ? provider : DEFAULT_PROVIDER_KEY;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(context) },
    { role: 'user', content: cleanMessage },
  ];

  try {
    const result = providerKey === 'auto'
      ? await handleAuto(process.env, messages)
      : await callProvider(process.env, providerKey, messages);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: 'AI provider error', detail: e.detail || e.message });
  }
};
