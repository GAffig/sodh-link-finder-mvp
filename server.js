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
const CACHE_TTL_MS = parsePositiveInt(process.env.SEARCH_CACHE_TTL_MS, 6 * 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = parsePositiveInt(process.env.SEARCH_CACHE_MAX_ENTRIES, 200);
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
  const costConfig = getSearchCostConfig({
    mode: process.env.SEARCH_COST_MODE,
    maxProviderCalls: process.env.SEARCH_MAX_PROVIDER_CALLS
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
    costMode: costConfig.mode
  });
  const cachedEntry = getCachedSearch(cacheKey);
  if (cachedEntry) {
    return respondJson(res, 200, {
      query,
      timestamp: new Date().toISOString(),
      provider: provider.name,
      results: cachedEntry.results,
      metadata: {
        ...cachedEntry.metadata,
        costMode: costConfig.mode,
        cacheHit: true,
        providerRequestCount: 0,
        providerRequestLimit: costConfig.providerRequestLimit
      }
    });
  }

  try {
    const pipelineOutput = await runSearchPipeline({
      query,
      provider,
      options: {
        costMode: costConfig.mode,
        maxProviderCalls: costConfig.providerRequestLimit
      }
    });

    const metadata = {
      ...pipelineOutput.metadata,
      costMode: costConfig.mode,
      cacheHit: false
    };

    setCachedSearch(cacheKey, {
      results: pipelineOutput.results,
      metadata
    });

    return respondJson(res, 200, {
      query,
      timestamp: new Date().toISOString(),
      provider: provider.name,
      results: pipelineOutput.results,
      metadata
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

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
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
