// /api/chat.js — Vercel serverless function
// Two providers only: Groq (fastest) and Cloudflare Workers AI.
// OpenRouter was removed entirely — its free tier (50 requests/day) wasn't
// reliable enough to be worth the added complexity of a third provider.
//
// Also handles:
//   - IMAGE GENERATION: via Cloudflare Workers AI's Flux model, triggered
//     when the user's message looks like an image request.
//   - LINK READING: if the user's message contains a URL, this fetches that
//     page's text content server-side and feeds it to the model as context,
//     so it can actually discuss what's on the page instead of guessing.
//
// Env vars needed: GROQ_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN

const PROVIDERS = {
  'auto': null, // special-cased — tries Groq, falls back to Cloudflare

  // Verified against Groq's own deprecation log (2026-09-27):
  //   - llama-3.1-8b-instant, llama-3.3-70b-versatile, qwen/qwen3-32b,
  //     llama-4-scout-17b-16e-instruct, llama-4-maverick-17b-128e-instruct
  //     are ALL DEAD on Groq now (Maverick was killed Feb 20, 2026).
  //   - qwen/qwen3.6-27b was ALSO shut down on 2026-09-14 (replaced by qwen3.8-27b).
  //   - openai/gpt-oss-120b, openai/gpt-oss-20b, qwen/qwen3.8-27b are the
  //     confirmed-alive models Groq itself recommends as replacements.
  'groq-gptoss120b': { kind: 'groq', model: 'openai/gpt-oss-120b' },
  'groq-gptoss20b':  { kind: 'groq', model: 'openai/gpt-oss-20b' },
  'groq-qwen38':     { kind: 'groq', model: 'qwen/qwen3.8-27b' },

  // All verified against Cloudflare's live model catalog (65 active models,
  // checked 2026-09-27). Their catalog rotates weekly with no notice, so if
  // any of these ever 404, re-check https://developers.cloudflare.com/workers-ai/models/
  'cf-gemma':       { kind: 'cloudflare', model: '@cf/google/gemma-4-26b-a4b-it' },       // was 27b — wrong, fixed to 26b
  'cf-llama':       { kind: 'cloudflare', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }, // confirmed current
  'cf-llama4scout': { kind: 'cloudflare', model: '@cf/meta/llama-4-scout-17b-16e-instruct' },  // new — flagship, alive on CF even though Groq killed its copy
  'cf-mistral':     { kind: 'cloudflare', model: '@cf/mistralai/mistral-small-3.1-24b-instruct' }, // old v0.1 slug was dead — this is CF's current Mistral flagship
  'cf-qwen':        { kind: 'cloudflare', model: '@cf/qwen/qwen3-30b-a3b-fp8' },          // old qwen1.5-7b-chat no longer exists — this is CF's current Qwen flagship
  'cf-deepseek':    { kind: 'cloudflare', model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b' }, // confirmed current
  'cf-gptoss120b':  { kind: 'cloudflare', model: '@cf/openai/gpt-oss-120b' },             // new — same model Groq serves, useful as a CF-side fallback
};
const DEFAULT_PROVIDER_KEY = 'auto';
const AUTO_CHAIN = ['groq-gptoss120b', 'cf-gptoss120b', 'cf-gemma'];

// flux-2-dev requires a multipart/form-data request (different API contract
// than the standard JSON body used everywhere else here), which caused
// EVERY image request to fail with "required properties at '/' are
// 'multipart'". Reverted to flux-1-schnell, which uses the same simple JSON
// format as everything else and is confirmed working. Quality is lower than
// flux-2-dev, but a working lower-quality image beats a broken high-quality one.
// Verified live against Cloudflare's catalog (2026-09-28). Two response
// shapes exist across their image models — this matters, not just cosmetic:
//   - "json": returns { result: { image: <base64 JPEG> } }  (Flux family)
//   - "binary": returns the raw image bytes directly with an image/* content
//     type (classic SDXL-style models) — must be read as an ArrayBuffer and
//     base64-encoded manually, r.json() would fail on these.
// flux-2-dev is deliberately excluded — it requires a multipart/form-data
// request (a different contract entirely), which broke every request last
// time it was tried. Re-add it only if that's implemented properly.
const IMAGE_MODELS = {
  'flux-schnell':  { model: '@cf/black-forest-labs/flux-1-schnell', responseType: 'json', steps: 4 },
  'sdxl':          { model: '@cf/stabilityai/stable-diffusion-xl-base-1.0', responseType: 'binary', steps: 20 },
  'dreamshaper':   { model: '@cf/lykon/dreamshaper-8-lcm', responseType: 'binary', steps: 8 },
};
const DEFAULT_IMAGE_MODEL_KEY = 'flux-schnell';

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

// ===== Link reading =====
// If the message contains a URL, fetch it and strip it down to plain text
// so the model can actually discuss the page's real content.
const URL_REGEX = /https?:\/\/[^\s]+/i;
async function fetchLinkContent(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ObservatoryBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    // Crude but dependency-free HTML-to-text: strip scripts/styles/tags,
    // collapse whitespace. Not perfect, but enough for a model to work with.
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 4000); // keep it bounded
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = (context, linkContent) =>
  'You are OPERATOR, a genuine, full-featured AI chatbot — think and respond like a normal, capable AI assistant ' +
  '(the kind people have real conversations with), not a narrow search tool or a bot that only answers questions ' +
  'about the page it happens to live on. You can discuss absolutely anything: general knowledge, advice, ' +
  'explanations, creative requests, casual conversation, coding help, whatever the person actually wants. You can ' +
  'also generate images when asked (the system handles that separately) and read web pages when the person shares ' +
  'a link. You also happen to be embedded in a live dashboard called Observatory, so you can reference its data ' +
  'when relevant, but that is a bonus feature, not your whole personality.\n\n' +
  'IMPORTANT — image generation: you personally CANNOT generate images. If you are being asked to respond, the ' +
  'system already tried and failed to detect an image request, or they asked something else entirely. NEVER output ' +
  'markdown image syntax like ![description](...) or pretend an image was created — that is always fake coming ' +
  'from you. If it looks like they wanted an image, tell them plainly to try rephrasing as "draw/generate a picture ' +
  'of X" instead of faking a result.\n\n' +
  'Default to giving thorough, complete answers with real detail, the way a knowledgeable person would actually ' +
  'explain something — not a one-line summary. Only stay brief for genuinely simple things; for anything involving ' +
  'explanation, opinion, how-to, or discussion, write a full, well-developed answer.\n\n' +
  'THINK BEFORE ANSWERING — for anything with real complexity, actually reason through it: consider the angles, ' +
  'weigh them, then give a clear conclusion. If a question has a "well, it depends" quality, say what it depends ' +
  'on rather than hiding the nuance.\n\n' +
  'For coding questions: write complete, correct, well-commented code. Use proper markdown code fences with the ' +
  'language specified (```javascript, ```python, etc.) since the interface renders these specially and lets the ' +
  'person download the code as a file.\n\n' +
  'The one place to be careful: if asked for a specific LIVE number this dashboard tracks (a stock price, crypto ' +
  'price, quake magnitude, currency rate, weather reading, etc.), only state a figure if it actually appears in ' +
  'the "Live dashboard data" block below — say "I don\'t have that in the current live feed" rather than guess. ' +
  'This matters MOST for financial figures — never state one from memory, even a plausible-sounding one.\n\n' +
  (linkContent ? `The person shared a link. Here is the actual text content of that page — use it to answer their question about it:\n"""${linkContent}"""\n\n` : '') +
  (context ? `Live dashboard data (only source of truth for THIS dashboard's own numbers): ${JSON.stringify(context).slice(0, 2000)}` : 'No live dashboard data was passed for this question.');

async function callGroq(env, model, messages) {
  if (!env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set.');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0.6 }),
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error('Groq error'); err.detail = t.slice(0, 300); throw err;
  }
  const d = await r.json();
  const reply = d.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('Groq returned an empty reply.');
  return { reply, model };
}

async function callCloudflare(env, model, messages) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new Error('CF_ACCOUNT_ID and/or CF_API_TOKEN is not set.');
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.CF_API_TOKEN}` },
    body: JSON.stringify({ messages, max_tokens: 1500 }),
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error('Cloudflare Workers AI error'); err.detail = t.slice(0, 300); throw err;
  }
  const d = await r.json();
  const reply = d.result?.response?.trim();
  if (!reply) throw new Error('Cloudflare Workers AI returned an empty reply.');
  return { reply, model };
}

// ===== Image generation (Cloudflare Workers AI — Flux) =====
async function generateImage(env, prompt, imageModelKey) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new Error('CF_ACCOUNT_ID and/or CF_API_TOKEN is not set — needed for image generation.');
  }
  const cfg = IMAGE_MODELS[imageModelKey] || IMAGE_MODELS[DEFAULT_IMAGE_MODEL_KEY];
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${cfg.model}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.CF_API_TOKEN}` },
    body: JSON.stringify({ prompt, num_steps: cfg.steps, steps: cfg.steps }),
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error('Image generation error'); err.detail = t.slice(0, 300); throw err;
  }

  let b64;
  if (cfg.responseType === 'json') {
    const d = await r.json();
    b64 = d.result?.image; // Flux: already base64
  } else {
    // SDXL-style models return raw image bytes directly, not JSON.
    const buf = await r.arrayBuffer();
    b64 = Buffer.from(buf).toString('base64');
  }
  if (!b64) throw new Error('Image generation returned no image.');
  return { imageBase64: b64, model: cfg.model };
}

// Detects "draw/generate/create an image of X" style requests.
// Stem-based detection instead of a strict prefix regex — tolerates typos
// like "generat" (missing the 'e') and catches the request anywhere in the
// message, not just at the very start.
const IMAGE_VERB_STEMS = /\b(draw|drew|generat|creat|mak|paint|illustrat|sketch)\w*/i;
const IMAGE_NOUN_STEMS = /\b(imag|pictur|photo|drawing|art|illustration|painting|sketch)\w*/i;
function extractImagePrompt(message) {
  if (!IMAGE_VERB_STEMS.test(message) || !IMAGE_NOUN_STEMS.test(message)) return null;
  // Strip the leading trigger phrase if present, otherwise just use the
  // whole message as the prompt — either way the subject comes through.
  const stripped = message.replace(/^(draw|generat\w*|creat\w*|mak\w*|paint\w*|illustrat\w*|sketch\w*)\s+(me\s+)?(an?\s+)?(imag\w*|pictur\w*|photo\w*|drawing|art|illustration|painting|sketch\w*)\s*(of|showing|depicting)?\s*/i, '');
  return stripped.trim() || message.trim();
}

async function callProvider(env, key, messages) {
  const cfg = PROVIDERS[key];
  if (!cfg) throw new Error(`Unknown provider key: ${key}`);
  switch (cfg.kind) {
    case 'groq':       return callGroq(env, cfg.model, messages);
    case 'cloudflare': return callCloudflare(env, cfg.model, messages);
    default: throw new Error(`Unknown provider kind: ${cfg.kind}`);
  }
}

async function handleAuto(env, messages) {
  const errors = [];
  for (const key of AUTO_CHAIN) {
    try {
      return await callProvider(env, key, messages);
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
      },
      providers: Object.keys(PROVIDERS),
      image_models: Object.keys(IMAGE_MODELS),
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
  const { message, context, provider, imageModel } = body || {};

  if (!message || typeof message !== 'string' || message.length > 500) {
    return res.status(400).json({ error: 'Send a "message" string under 500 characters.' });
  }
  const cleanMessage = message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
  if (!cleanMessage) {
    return res.status(400).json({ error: 'Message was empty after cleanup.' });
  }

  // Image generation branch — short-circuits before the normal chat flow.
  const imagePrompt = extractImagePrompt(cleanMessage);
  if (imagePrompt) {
    try {
      const result = await generateImage(process.env, imagePrompt, imageModel);
      return res.status(200).json({ image: result.imageBase64, prompt: imagePrompt });
    } catch (e) {
      return res.status(502).json({ error: 'Image generation error', detail: e.detail || e.message });
    }
  }

  // Link-reading: if the message has a URL, fetch its text content first.
  const urlMatch = cleanMessage.match(URL_REGEX);
  const linkContent = urlMatch ? await fetchLinkContent(urlMatch[0]) : null;

  const providerKey = (provider in PROVIDERS) ? provider : DEFAULT_PROVIDER_KEY;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(context, linkContent) },
    { role: 'user', content: cleanMessage },
  ];

  try {
    const result = providerKey === 'auto'
      ? await handleAuto(process.env, messages)
      : await callProvider(process.env, providerKey, messages);
    return res.status(200).json(result);
  } catch (e) {
    // Models get retired without notice. If the person picked a specific
    // model and it failed, quietly try the Auto chain instead of showing an
    // error — and say so honestly, so nobody thinks the picked model answered.
    if (providerKey !== 'auto') {
      try {
        const fallback = await handleAuto(process.env, messages);
        return res.status(200).json({
          ...fallback,
          reply: `${fallback.reply}\n\n(Note: the model you picked isn't available right now, so Auto answered instead.)`,
        });
      } catch { /* fall through to the error below */ }
    }
    return res.status(502).json({ error: 'AI provider error', detail: e.detail || e.message });
  }
};
