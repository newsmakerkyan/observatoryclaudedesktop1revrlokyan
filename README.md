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
│   └── finance.js    (stocks & indices — needs TWELVEDATA_API_KEY)
└── .env.example
```

## 1. Get your free API keys
- **Groq** (AI chat): groq.com → sign up → API Keys → Create Key. Free tier,
  no credit card, ~14,400 requests/day on Llama 3.3 70B.
- **Twelve Data** (stocks/indices): twelvedata.com → sign up → your API key
  is shown on the dashboard. Free tier: 800 requests/day. finance.js batches
  everything into one call and caches it for 10 minutes, so this budget goes
  a long way even with real visitors.

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
   - `TWELVEDATA_API_KEY` = your Twelve Data key
4. Deploy. You get a free subdomain like `yourname.vercel.app`, and the
   `/api` functions deploy automatically alongside `index.html` — no
   separate setup step.

Netlify can also run this, but its functions expect a `netlify/functions/`
folder and a slightly different handler signature than `api/chat.js` is
written for — Vercel is the simpler path for this project as-is.

## Notes & honest limitations
- **Stock/index data is not truly real-time or unlimited anywhere for free.**
  Twelve Data's free tier is the best available option, but international
  index coverage can be inconsistent — any symbol it doesn't return just
  shows "—" rather than breaking the panel. Verify the exact index ticker
  strings against Twelve Data's symbol search after signup; a couple in
  `api/finance.js` may need adjusting.
- **Oil price isn't included.** No free, no-key source for WTI/Brent crude
  was found that's reliable enough to ship. Gold and silver ARE included and
  need no key at all (via the free `exchangerate.fun` API).
- The rate limiter in `chat.js` is in-memory and resets on cold start —
  fine for personal use. For real traffic, swap it for a durable store like
  Upstash Redis (also free-tier).
