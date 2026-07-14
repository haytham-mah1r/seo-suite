# Edge SEO — serverless proxy (Cloudflare Worker)

This is the piece that actually calls DataForSEO (and, optionally, an LLM
provider) on your app's behalf, so your credentials never sit exposed in
`index.html` or your browser.

## One-time setup

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up if you don't have one.
2. Install the CLI:
   ```
   npm install -g wrangler
   ```
3. Log in (opens a browser window):
   ```
   wrangler login
   ```
4. From this `proxy` folder, set your secrets — you'll be prompted to paste
   each value, they are never written to disk or shown again:
   ```
   wrangler secret put DATAFORSEO_LOGIN
   wrangler secret put DATAFORSEO_PASSWORD
   ```
   Optional, only needed for the LLM Visibility "Auto-check" button and the
   Content Grader's "deep review":
   ```
   wrangler secret put ANTHROPIC_API_KEY
   wrangler secret put OPENAI_API_KEY
   wrangler secret put PERPLEXITY_API_KEY
   ```
5. Deploy:
   ```
   wrangler deploy
   ```
   Wrangler will print a URL like `https://edge-seo-proxy.yoursubdomain.workers.dev`.

6. Copy that URL into Edge's **API & Settings** tab under "Serverless proxy
   endpoint URL" and save.

## Updating later

If you edit `worker.js`, just run `wrangler deploy` again — no need to
touch the secrets unless a credential changes (`wrangler secret put NAME`
overwrites the old value).

## Notes on the DataForSEO endpoints used

- `serp_rank` → `/serp/google/organic/live/advanced` (position) +
  `/keywords_data/google_ads/search_volume/live` (volume)
- `keyword_ideas` → `/dataforseo_labs/google/keyword_ideas/live`
- `backlink_opportunities` → `/backlinks/referring_domains/live` (a simple
  starting point — swap in `/backlinks/domain_intersection/live` once you
  want true competitor-gap analysis against 2-3 named competitors)
- `competitor_snapshot` → `/backlinks/summary/live` +
  `/dataforseo_labs/google/domain_intersection/live`

Your DataForSEO plan/subscription level determines which of these
endpoints you have access to — if one comes back with an auth or
subscription error, check your DataForSEO dashboard for which APIs are
enabled on your account and adjust the path in `worker.js` accordingly.
