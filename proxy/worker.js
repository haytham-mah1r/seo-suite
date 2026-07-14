/**
 * EDGE SEO COMMAND CENTER — serverless proxy (Cloudflare Worker)
 */

const ALLOWED_ORIGIN = "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function dataforseoAuthHeader(env) {
  const token = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  return `Basic ${token}`;
}

async function dataforseoPost(env, path, tasks) {
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, {
    method: "POST",
    headers: {
      Authorization: dataforseoAuthHeader(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tasks),
  });
  if (!res.ok) throw new Error(`DataForSEO ${path} failed: ${res.status}`);
  return res.json();
}

// Builds location targeting: GPS coordinates + radius (most precise) if
// given, otherwise the single named location string as-is (trusted to be
// exact since the front end now only offers pre-vetted suggestions).
function buildLocationTask(payload) {
  const { lat, lng, radiusKm, location } = payload;
  if (lat && lng) {
    return { location_coordinate: `${lat},${lng},${radiusKm || 5}` };
  }
  return { location_name: (location || "United States").trim() };
}

async function serpRank(env, payload) {
  const { keyword, device, domain } = payload;
  const locationTask = buildLocationTask(payload);

  const serp = await dataforseoPost(env, "/serp/google/organic/live/advanced", [
    {
      keyword,
      ...locationTask,
      language_code: "en",
      device: (device || "Desktop").toLowerCase(),
      depth: 100,
    },
  ]);

  let position = null;
  const items = serp?.tasks?.[0]?.result?.[0]?.items || [];
  const cleanDomain = (domain || "").replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/^www\./, "");
  for (const item of items) {
    if (item.type === "organic" && item.domain && item.domain.replace(/^www\./, "") === cleanDomain) {
      position = item.rank_absolute;
      break;
    }
  }

  let volume = null;
  try {
    const volLocation = payload.location || "United States";
    const vol = await dataforseoPost(env, "/keywords_data/google_ads/search_volume/live", [
      { keywords: [keyword], location_name: volLocation, language_code: "en" },
    ]);
    volume = vol?.tasks?.[0]?.result?.[0]?.search_volume ?? null;
  } catch (e) { /* volume is a nice-to-have, don't fail the whole check over it */ }

  return { position, volume };
}

async function liveSerp(env, payload) {
  const { keyword, device } = payload;
  const locationTask = buildLocationTask(payload);

  const serp = await dataforseoPost(env, "/serp/google/organic/live/advanced", [
    {
      keyword,
      ...locationTask,
      language_code: "en",
      device: (device || "Desktop").toLowerCase(),
      depth: 20,
    },
  ]);

  const result = serp?.tasks?.[0]?.result?.[0] || {};
  const items = (result.items || [])
    .filter((it) => it.type === "organic" || it.type === "featured_snippet" || it.type === "local_pack")
    .slice(0, 20)
    .map((it) => ({
      rank: it.rank_absolute ?? null,
      type: it.type,
      title: it.title || it.domain || "(untitled)",
      url: it.url || null,
      domain: it.domain || null,
      description: it.description || it.snippet || null,
    }));

  return {
    keyword,
    location_name: locationTask.location_name || `coordinates ${locationTask.location_coordinate}`,
    checkedAt: result.datetime || new Date().toISOString(),
    resultCount: result.se_results_count ?? null,
    items,
  };
}

async function keywordIdeas(env, payload) {
  const { seed, location } = payload;
  const res = await dataforseoPost(env, "/dataforseo_labs/google/keyword_ideas/live", [
    { keywords: [seed], location_name: location || "United States", language_code: "en", limit: 25 },
  ]);
  const items = res?.tasks?.[0]?.result?.[0]?.items || [];
  const suggestions = items.map((it) => {
    const monthly = it.keyword_info?.monthly_searches || [];
    const recent = monthly.slice(-3).map((m) => m.search_volume || 0);
    const trend = recent.length >= 2
      ? (recent[recent.length - 1] > recent[0] ? "up" : recent[recent.length - 1] < recent[0] ? "down" : "flat")
      : "flat";
    return {
      term: it.keyword,
      volume: it.keyword_info?.search_volume ?? null,
      trend,
      difficulty: it.keyword_properties?.keyword_difficulty ?? null,
    };
  });
  return { suggestions };
}

async function backlinkOpportunities(env, payload) {
  const { domain, depth } = payload;
  const limit = depth === "deep" ? 50 : 15;
  const res = await dataforseoPost(env, "/backlinks/referring_domains/live", [
    { target: domain, limit, order_by: ["rank,desc"] },
  ]);
  const items = res?.tasks?.[0]?.result?.[0]?.items || [];
  const opportunities = items.map((it) => ({
    domain: it.domain,
    type: /directory|listing|yelp|yellowpages|chamber/i.test(it.domain) ? "free" : "paid",
    notes: `Domain rank ~${it.rank ?? "n/a"} · ${it.backlinks ?? 0} existing backlinks tracked`,
  }));
  return { opportunities };
}

async function competitorSnapshot(env, payload) {
  const { domain, yourDomain } = payload;
  const backlinksSummary = await dataforseoPost(env, "/backlinks/summary/live", [{ target: domain }]);
  const referringDomains = backlinksSummary?.tasks?.[0]?.result?.[0]?.referring_domains ?? null;
  let overlapKeywords = null;
  try {
    const intersection = await dataforseoPost(env, "/dataforseo_labs/google/domain_intersection/live", [
      { target1: yourDomain, target2: domain, location_name: "United States", language_code: "en", limit: 1 },
    ]);
    overlapKeywords = intersection?.tasks?.[0]?.result?.[0]?.total_count ?? null;
  } catch (e) { /* optional */ }
  return { overlapKeywords, backlinks: referringDomains };
}

async function llmVisibilityCheck(env, payload) {
  const { prompt, model, brand, domain } = payload;
  if (model === "Claude") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set on the Worker.");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 800, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || "").join("\n");
    return analyzeAnswerForBrand(text, brand, domain);
  }
  if (model === "ChatGPT") {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set on the Worker.");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    return analyzeAnswerForBrand(data.choices?.[0]?.message?.content || "", brand, domain);
  }
  if (model === "Perplexity") {
    if (!env.PERPLEXITY_API_KEY) throw new Error("PERPLEXITY_API_KEY not set on the Worker.");
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    return analyzeAnswerForBrand(data.choices?.[0]?.message?.content || "", brand, domain);
  }
  throw new Error(`Unknown model: ${model}`);
}

function analyzeAnswerForBrand(text, brand, domain) {
  const lower = text.toLowerCase();
  const brandLower = (brand || "").toLowerCase();
  const domainLower = (domain || "").replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();
  const mentioned = (brandLower && lower.includes(brandLower)) || (domainLower && lower.includes(domainLower));
  let rank = null;
  if (mentioned) {
    const lines = text.split("\n");
    let itemNumber = 0;
    for (const line of lines) {
      if (/^\s*(\d+[\.\)]|[-*])\s+/.test(line)) itemNumber++;
      if (line.toLowerCase().includes(brandLower) || (domainLower && line.toLowerCase().includes(domainLower))) {
        rank = itemNumber || null;
        break;
      }
    }
  }
  return { mentioned, rank, rawAnswer: text.slice(0, 2000) };
}

async function contentDeepReview(env, payload) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set on the Worker.");
  const { text, keyword, pageType, industry } = payload;
  const prompt = `You are an SEO content auditor. Review the following ${pageType} content for a business in the "${industry || "unspecified"}" industry, targeting the keyword "${keyword}". Give a concise, specific critique (5-8 sentences). Content:\n\n${text.slice(0, 6000)}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  const summary = (data.content || []).map((c) => c.text || "").join("\n");
  return { summary };
}

const ACTIONS = {
  serp_rank: serpRank,
  live_serp: liveSerp,
  keyword_ideas: keywordIdeas,
  backlink_opportunities: backlinkOpportunities,
  competitor_snapshot: competitorSnapshot,
  llm_visibility_check: llmVisibilityCheck,
  content_deep_review: contentDeepReview,
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (request.method !== "POST") return json({ error: "Only POST is supported." }, 405);
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON body." }, 400); }
    const { action, payload } = body;
    const handler = ACTIONS[action];
    if (!handler) return json({ error: `Unknown action: ${action}` }, 400);
    try {
      const result = await handler(env, payload || {});
      return json(result);
    } catch (e) {
      return json({ error: e.message || "Proxy call failed." }, 500);
    }
  },
};
