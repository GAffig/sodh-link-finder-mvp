export const PRIORITY_DOMAINS = [
  "cdc.gov",
  "data.census.gov",
  "census.gov",
  "countyhealthrankings.org",
  "bls.gov",
  "ers.usda.gov",
  "cms.gov",
  "hhs.gov",
  "acf.hhs.gov",
  "tn.gov",
  "vdh.virginia.gov",
  "irs.gov",
  "nces.ed.gov",
  "transportation.gov",
  "hud.gov",
  "epa.gov",
  "ucr.fbi.gov",
  "feedingamerica.org",
  "opportunityinsights.org",
  "urban.org",
  "sparkmaps.com",
  "droughtmonitor.unl.edu",
  "impactlab.org",
  "cnt.org",
  "hifld-geoplatform.opendata.arcgis.com"
];

const PROVIDER_ENV_ORDER = [
  { envVar: "BRAVE_API_KEY", provider: "brave" },
  { envVar: "SERPAPI_KEY", provider: "serpapi" },
  { envVar: "BING_API_KEY", provider: "bing" }
];

const DEFAULT_TIMEOUT_MS = 15000;

export class ProviderRequestError extends Error {
  constructor(message, provider, statusCode = 500, details = "") {
    super(message);
    this.name = "ProviderRequestError";
    this.provider = provider;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function getProviderSelectionStatus(env = process.env) {
  const selected = resolveConfiguredProvider(env);
  return {
    configured: Boolean(selected),
    provider: selected?.name ?? null,
    selectedEnvVar: selected?.envVar ?? null,
    providerEnvOrder: PROVIDER_ENV_ORDER.map((item) => item.envVar),
    setupHint:
      "Configure one key in .env. Selection order: BRAVE_API_KEY, SERPAPI_KEY, then BING_API_KEY."
  };
}

export function resolveConfiguredProvider(env = process.env) {
  for (const { envVar, provider } of PROVIDER_ENV_ORDER) {
    const key = (env[envVar] || "").trim();
    if (!key) {
      continue;
    }

    return {
      name: provider,
      envVar,
      async searchWeb(query, options = {}) {
        const count = options.count ?? 30;
        if (provider === "brave") {
          return searchBrave(key, query, count);
        }
        if (provider === "serpapi") {
          return searchSerpApi(key, query, count);
        }
        return searchBing(key, query, count);
      }
    };
  }

  return null;
}

async function searchBrave(apiKey, query, count) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(count, 1), 50)));

  const payload = await requestJson(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey
    }
  }, "brave");

  const rows = payload?.web?.results || payload?.results || [];
  return normalizeResults(rows, (row) => ({
    title: row?.title || row?.meta_title || "",
    url: row?.url || row?.link || "",
    snippet: row?.description || row?.snippet || ""
  }));
}

async function searchSerpApi(apiKey, query, count) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(Math.max(count, 1), 20)));
  url.searchParams.set("api_key", apiKey);

  const payload = await requestJson(url, {}, "serpapi");

  const rows = payload?.organic_results || [];
  return normalizeResults(rows, (row) => ({
    title: row?.title || "",
    url: row?.link || row?.url || "",
    snippet: row?.snippet || row?.snippet_highlighted_words?.join(" ") || ""
  }));
}

async function searchBing(apiKey, query, count) {
  const url = new URL("https://api.bing.microsoft.com/v7.0/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(count, 1), 50)));
  url.searchParams.set("responseFilter", "Webpages");

  const payload = await requestJson(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey
    }
  }, "bing");

  const rows = payload?.webPages?.value || [];
  return normalizeResults(rows, (row) => ({
    title: row?.name || row?.title || "",
    url: row?.url || "",
    snippet: row?.snippet || row?.description || ""
  }));
}

async function requestJson(url, options, providerName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);

    if (error?.name === "AbortError") {
      throw new ProviderRequestError(
        `Search request timed out for ${providerName}.`,
        providerName,
        504
      );
    }

    throw new ProviderRequestError(
      `Search request failed for ${providerName}.`,
      providerName,
      502,
      String(error)
    );
  }

  clearTimeout(timeout);

  const rawText = await response.text();
  let payload = null;

  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? "API key may be missing, invalid, or lacks access."
      : "Provider request was rejected.";

    throw new ProviderRequestError(
      `Search provider ${providerName} returned HTTP ${response.status}. ${hint}`,
      providerName,
      response.status,
      rawText.slice(0, 400)
    );
  }

  return payload;
}

function normalizeResults(rows, mapRow) {
  const normalized = [];

  for (const row of rows) {
    const mapped = mapRow(row);
    const title = String(mapped?.title || "").trim();
    const url = String(mapped?.url || "").trim();
    const snippet = String(mapped?.snippet || "").trim();

    if (!title || !isHttpUrl(url)) {
      continue;
    }

    normalized.push({ title, url, snippet });
  }

  return normalized;
}

function isHttpUrl(candidate) {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
