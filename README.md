# Observatory — v2 (AI chat + live finance backend)

This version adds a real AI chatbot and stock/index data, both of which need
a secret API key. A key can't live inside a browser-loaded HTML file without
being visible to anyone who views the page source — so this version needs a
tiny **backend** to hold those keys, instead of being a single drag-and-drop
HTML file like before. Still 100% free to run.

## What still works with zero backend
Everything else in this project — the globe, earthquakes, ISS tracking,
weather, world clocks, expanded crypto panel, currency exchange, gold/silver,
and news — calls free public APIs directly from the browser and needs no key
and no backend at all. If you skip the backend setup entirely, the whole
dashboard still works; only the AI chat and the Stocks/Indices panels will
show a "backend not connected" message instead of live data.

## Folder structure
```
observatory/
├── index.html
├── api/
│   ├── chat.js       (AI chat — needs GROQ_API_KEY)
│   ├── finance.js    (stocks — needs FINNHUB_API_KEY)
│   └── festivals.js  (public holidays — no key needed at all)
└── .env.example
```

## 1. Get your free API keys
- **Groq** (AI chat): groq.com → sign up → API Keys → Create Key. Free tier,
  no credit card, ~14,400 requests/day on Llama 3.3 70B.
- **Finnhub** (stocks/indices): finnhub.io → sign up → your API key is shown
  on the dashboard. Free tier: 60 requests/minute, real-time US stock quotes,
  no plan-restriction guessing. finance.js caches results for 10 minutes
  server-side, so this budget goes a long way even with real visitors.

To use Claude, GPT, or Gemini instead of Groq for the chatbot: edit
`api/chat.js` — swap the fetch URL, the Authorization header, and the model
name for your provider of choice. The rest of the function (rate limiting,
error handling, the JSON shape returned to the frontend) can stay the same.

## 2. Deploy to Vercel (free)
1. Push this folder to a new GitHub repo — or skip GitHub entirely and run
   `npx vercel` from inside the folder (also free).
2. On vercel.com → New Project → import the repo.
3. **Before** deploying, add Environment Variables in the project settings:
   - `GROQ_API_KEY` = your Groq key
   - `FINNHUB_API_KEY` = your Finnhub key
4. Deploy. You get a free subdomain like `yourname.vercel.app`, and the
   `/api` functions deploy automatically alongside `index.html` — no
   separate setup step.

If you were previously using Twelve Data: remove the old `TWELVEDATA_API_KEY`
environment variable in Vercel (Settings → Environment Variables) and add
`FINNHUB_API_KEY` instead — the code no longer references Twelve Data at all.

Netlify can also run this, but its functions expect a `netlify/functions/`
folder and a slightly different handler signature than `api/chat.js` is
written for — Vercel is the simpler path for this project as-is.

## Notes & honest limitations
- **The 8 companies (Apple, Microsoft, etc.) are real, live US stock quotes**
  via Finnhub — no restrictions, no guessing, real-time.
- **The 9 "indices" are NOT raw index point values.** No free data source
  anywhere gives out real international index points — that requires a paid
  exchange data license everywhere. Instead, each index is shown via a
  well-known ETF that tracks it (e.g. SPY for the S&P 500, EWG for the DAX).
  These are real, live prices — just of the ETF, not the index itself. The
  panel label shows the ETF ticker in parentheses so this is never disguised
  as something it isn't.
- **If `FINNHUB_API_KEY` is missing, or nothing resolves, the panel shows
  clearly-labeled placeholder values ("— sim") and the section header says
  "NO LIVE BACKEND" — it never shows a fake number that looks like a real
  price. Honest "no data" beats a convincing fake.
- **Oil price isn't included.** No free, no-key source for WTI/Brent crude
  was found that's reliable enough to ship. Gold and silver ARE included and
  need no key at all (via the free `exchangerate.fun` API).
- The rate limiter in `chat.js` is in-memory and resets on cold start —
  fine for personal use. For real traffic, swap it for a durable store like
  Upstash Redis (also free-tier).
- **The AI chatbot is instructed to only state numbers that are in the live
  dashboard data it's given** — it's told explicitly to say "I don't have
  that" rather than guess a stock price, quake magnitude, or headline. This
  reduces hallucination a lot but can't make it impossible; treat anything
  the bot says as a claim to verify against the actual panels, not a fact.
- **`vercel.json` adds security headers** (Content-Security-Policy,
  X-Frame-Options, etc.) restricting the page to only load scripts/data from
  the specific APIs this project actually uses. Honest caveat: the CSP still
  allows `'unsafe-inline'` for scripts/styles because the whole dashboard is
  one inline `<script>`/`<style>` block — true inline-script blocking would
  require splitting the code into external files with a nonce, which is a
  bigger restructure. The CSP still meaningfully limits *where data can be
  sent to or loaded from*, which blocks a large class of injection attacks
  even without that last step.
- News headlines/links are HTML-escaped and URL-validated before rendering,
  since that data comes from a third-party feed and is the one place in this
  project that renders external, not-fully-trusted content.
