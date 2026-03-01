import http from "http";
import { readFileSync } from "fs";
import { readFile, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import {
  ProviderRequestError,
  getProviderSelectionStatus,
  resolveConfiguredProvider
} from "./src/search/providers.js";
import { getSearchCostConfig, runSearchPipeline } from "./src/search/ranker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

loadDotEnv();
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = parsePositiveInt(process.env.SEARCH_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = parsePositiveInt(process.env.SEARCH_CACHE_MAX_ENTRIES, 200);
const AUTO_ESCALATE_STANDARD = parseBoolean(process.env.SEARCH_AUTO_ESCALATE_STANDARD, true);
const ESCALATE_MIN_RESULTS = parsePositiveInt(process.env.SEARCH_ESCALATE_MIN_RESULTS, 8);
const ESCALATE_MIN_PRIORITY_RESULTS = parsePositiveInt(
  process.env.SEARCH_ESCALATE_MIN_PRIORITY_RESULTS,
  3
);
const ESCALATE_MIN_DISTINCT_DOMAINS = parsePositiveInt(
  process.env.SEARCH_ESCALATE_MIN_DISTINCT_DOMAINS,
  3
);
const searchResponseCache = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/config" && req.method === "GET") {
      const costConfig = getSearchCostConfig({
        mode: process.env.SEARCH_COST_MODE,
        maxProviderCalls: process.env.SEARCH_MAX_PROVIDER_CALLS
      });

      return respondJson(res, 200, {
        ...getProviderSelectionStatus(process.env),
        setupSteps: buildSetupSteps(),
        searchCost: costConfig,
        autoEscalation: {
          enabled: AUTO_ESCALATE_STANDARD,
          fromMode: "economy",
          toMode: "standard",
          minResults: ESCALATE_MIN_RESULTS,
          minPriorityResults: ESCALATE_MIN_PRIORITY_RESULTS,
          minDistinctDomainsTop8: ESCALATE_MIN_DISTINCT_DOMAINS
        },
        cache: {
          enabled: CACHE_TTL_MS > 0,
          ttlMs: CACHE_TTL_MS,
          maxEntries: CACHE_MAX_ENTRIES
        }
      });
    }

    if (requestUrl.pathname === "/api/search" && req.method === "POST") {
      return handleSearch(req, res);
    }

    if (req.method === "GET") {
      return serveStatic(requestUrl.pathname, res);
    }

    return respondJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    return respondJson(res, 500, {
      error: "Unexpected server error.",
      details: String(error)
    });
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

async function handleSearch(req, res) {
  const provider = resolveConfiguredProvider(process.env);
  const requestedCostConfig = getSearchCostConfig({
    mode: process.env.SEARCH_COST_MODE,
    maxProviderCalls: process.env.SEARCH_MAX_PROVIDER_CALLS
  });
  const standardCostConfig = getSearchCostConfig({
    mode: "standard",
    maxProviderCalls: process.env.SEARCH_STANDARD_MAX_PROVIDER_CALLS
  });

  if (!provider) {
    return respondJson(res, 400, {
      error: "Search provider not configured.",
      code: "NOT_CONFIGURED",
      missing: ["BRAVE_API_KEY", "SERPAPI_KEY", "BING_API_KEY"],
      setupSteps: buildSetupSteps()
    });
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    return respondJson(res, 400, { error: "Invalid JSON body." });
  }

  const query = String(payload?.query || "").trim();
  if (!query) {
    return respondJson(res, 400, { error: "Query is required." });
  }

  const cacheKey = buildSearchCacheKey({
    query,
    providerName: provider.name,
    costMode: requestedCostConfig.mode
  });
  const cachedEntry = getCachedSearch(cacheKey);
  if (cachedEntry) {
    const cachedMetadata = cachedEntry.metadata || {};
    return respondJson(res, 200, {
      query,
      timestamp: new Date().toISOString(),
      provider: provider.name,
      results: cachedEntry.results,
      metadata: {
        ...cachedMetadata,
        requestedCostMode: cachedMetadata.requestedCostMode || requestedCostConfig.mode,
        effectiveCostMode:
          cachedMetadata.effectiveCostMode || cachedMetadata.costMode || requestedCostConfig.mode,
        cacheHit: true,
        providerRequestCount: 0,
        providerRequestLimit: cachedMetadata.providerRequestLimit || requestedCostConfig.providerRequestLimit
      }
    });
  }

  try {
    const initialOutput = await runSearchPipeline({
      query,
      provider,
      options: {
        costMode: requestedCostConfig.mode,
        maxProviderCalls: requestedCostConfig.providerRequestLimit
      }
    });

    const initialMetadata = normalizeSearchMetadata(initialOutput.metadata, requestedCostConfig);
    let selectedOutput = initialOutput;
    let selectedMetadata = initialMetadata;
    let escalationAttempted = false;
    let escalationTriggered = false;
    let escalationReason = "";
    let escalatedMetadata = null;

    if (shouldEscalateSearch({ requestedCostMode: requestedCostConfig.mode, results: initialOutput.results })) {
      escalationAttempted = true;
      escalationTriggered = true;
      escalationReason = "weak_results";

      try {
        const standardOutput = await runSearchPipeline({
          query,
          provider,
          options: {
            costMode: "standard",
            maxProviderCalls: standardCostConfig.providerRequestLimit
          }
        });

        escalatedMetadata = normalizeSearchMetadata(standardOutput.metadata, standardCostConfig);

        const initialScore = computeQualityScore(initialOutput.results, initialMetadata);
        const escalatedScore = computeQualityScore(standardOutput.results, escalatedMetadata);

        if (escalatedScore >= initialScore) {
          selectedOutput = standardOutput;
          selectedMetadata = escalatedMetadata;
        }
      } catch (escalationError) {
        escalationReason = "weak_results_escalation_failed";
        escalationTriggered = false;
      }
    }

    const mergedMetadata = {
      ...selectedMetadata,
      requestedCostMode: requestedCostConfig.mode,
      effectiveCostMode: selectedMetadata.costMode,
      costMode: selectedMetadata.costMode,
      cacheHit: false,
      autoEscalationAttempted: escalationAttempted,
      autoEscalated: escalationTriggered && selectedMetadata.costMode === "standard",
      autoEscalationReason: escalationReason || null,
      providerRequestCountInitial: initialMetadata.providerRequestCount,
      providerRequestLimitInitial: initialMetadata.providerRequestLimit
    };

    if (escalationAttempted && escalatedMetadata) {
      mergedMetadata.providerRequestCountEscalated = escalatedMetadata.providerRequestCount;
      mergedMetadata.providerRequestLimitEscalated = escalatedMetadata.providerRequestLimit;
      mergedMetadata.providerRequestCount =
        initialMetadata.providerRequestCount + escalatedMetadata.providerRequestCount;
      mergedMetadata.providerRequestLimit =
        initialMetadata.providerRequestLimit + escalatedMetadata.providerRequestLimit;
    }

    setCachedSearch(cacheKey, {
      results: selectedOutput.results,
      metadata: mergedMetadata
    });

    return respondJson(res, 200, {
      query,
      timestamp: new Date().toISOString(),
      provider: provider.name,
      results: selectedOutput.results,
      metadata: mergedMetadata
    });
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      return respondJson(res, 502, {
        error: error.message,
        provider: error.provider,
        providerStatusCode: error.statusCode,
        details: error.details,
        setupSteps: buildSetupSteps()
      });
    }

    return respondJson(res, 500, {
      error: "Search pipeline failed.",
      details: String(error)
    });
  }
}

async function serveStatic(requestPath, res) {
  const safePath = sanitizePath(requestPath);
  if (!safePath) {
    return respondText(res, 400, "Bad request path.", "text/plain");
  }

  const filePath = path.join(PUBLIC_DIR, safePath);

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      return respondText(res, 404, "Not Found", "text/plain");
    }

    const content = await readFile(filePath);
    return respondBuffer(res, 200, content, contentType(filePath));
  } catch {
    return respondText(res, 404, "Not Found", "text/plain");
  }
}

function sanitizePath(requestPath) {
  if (requestPath === "/") {
    return "index.html";
  }

  const normalized = path.normalize(requestPath).replace(/^([.][.][/\\])+/, "");
  const cleaned = normalized.replace(/^[/\\]+/, "");

  if (!cleaned || cleaned.includes("..")) {
    return null;
  }

  return cleaned;
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "application/octet-stream";
}

function buildSetupSteps() {
  return [
    "Create a .env file in the project root.",
    "Add one key: BRAVE_API_KEY, or SERPAPI_KEY, or BING_API_KEY.",
    "Optional cost controls: SEARCH_COST_MODE=economy|standard and SEARCH_MAX_PROVIDER_CALLS=<number>.",
    "Optional auto-upgrade on weak economy results: SEARCH_AUTO_ESCALATE_STANDARD=true.",
    "Restart the app so environment variables reload.",
    "Run a search again from the Search tab."
  ];
}

function respondJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function respondText(res, statusCode, body, type) {
  res.writeHead(statusCode, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function respondBuffer(res, statusCode, body, type) {
  res.writeHead(statusCode, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  return JSON.parse(raw || "{}");
}

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const delimiterIndex = trimmed.indexOf("=");
      if (delimiterIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, delimiterIndex).trim();
      const value = trimmed.slice(delimiterIndex + 1).trim();

      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional; app can still run in Not Configured mode.
  }
}

function normalizeSearchMetadata(rawMetadata, costConfig) {
  const metadata = rawMetadata || {};
  return {
    ...metadata,
    costMode: metadata.costMode || costConfig.mode,
    providerRequestCount: Number(metadata.providerRequestCount || 0),
    providerRequestLimit: Number(metadata.providerRequestLimit || costConfig.providerRequestLimit),
    priorityResultCount: Number(metadata.priorityResultCount || 0),
    totalResultCount: Number(metadata.totalResultCount || 0)
  };
}

function shouldEscalateSearch({ requestedCostMode, results }) {
  if (!AUTO_ESCALATE_STANDARD || requestedCostMode !== "economy") {
    return false;
  }

  const quality = computeSearchQualitySignals(results);
  return (
    quality.totalResults < ESCALATE_MIN_RESULTS ||
    quality.priorityResults < ESCALATE_MIN_PRIORITY_RESULTS ||
    quality.distinctDomainsTop8 < ESCALATE_MIN_DISTINCT_DOMAINS
  );
}

function computeQualityScore(results, metadata) {
  const quality = computeSearchQualitySignals(results);
  const topPriorityBonus = results[0]?.isPriority ? 3 : 0;

  return (
    quality.totalResults * 5 +
    quality.priorityResults * 7 +
    quality.distinctDomainsTop8 * 4 +
    metadata.priorityResultCount * 2 +
    topPriorityBonus
  );
}

function computeSearchQualitySignals(results) {
  const safeResults = Array.isArray(results) ? results : [];
  const topSlice = safeResults.slice(0, 8);
  return {
    totalResults: safeResults.length,
    priorityResults: safeResults.filter((row) => Boolean(row?.isPriority)).length,
    distinctDomainsTop8: new Set(topSlice.map((row) => String(row?.domain || ""))).size
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseBoolean(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function buildSearchCacheKey({ query, providerName, costMode }) {
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ").trim();
  return `${providerName}|${costMode}|${normalizedQuery}`;
}

function getCachedSearch(cacheKey) {
  if (CACHE_TTL_MS <= 0) {
    return null;
  }

  const entry = searchResponseCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.savedAt > CACHE_TTL_MS) {
    searchResponseCache.delete(cacheKey);
    return null;
  }

  // Refresh insertion order to preserve simple LRU behavior.
  searchResponseCache.delete(cacheKey);
  searchResponseCache.set(cacheKey, entry);
  return entry.value;
}

function setCachedSearch(cacheKey, value) {
  if (CACHE_TTL_MS <= 0) {
    return;
  }

  if (searchResponseCache.has(cacheKey)) {
    searchResponseCache.delete(cacheKey);
  }

  searchResponseCache.set(cacheKey, {
    savedAt: Date.now(),
    value
  });

  while (searchResponseCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = searchResponseCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    searchResponseCache.delete(oldestKey);
  }
}
