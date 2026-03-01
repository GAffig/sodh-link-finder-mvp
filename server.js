import http from "http";
import { timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { readFile, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "redis";

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
const BASIC_AUTH_USER = (process.env.APP_BASIC_AUTH_USER || "").trim();
const BASIC_AUTH_PASS = (process.env.APP_BASIC_AUTH_PASS || "").trim();
const BASIC_AUTH_ENABLED = Boolean(BASIC_AUTH_USER && BASIC_AUTH_PASS);
const MAX_REQUEST_BODY_BYTES = parsePositiveInt(process.env.SEARCH_MAX_BODY_BYTES, 8192);
const MAX_QUERY_CHARS = parsePositiveInt(process.env.SEARCH_MAX_QUERY_CHARS, 180);
const CACHE_TTL_MS = parsePositiveInt(process.env.SEARCH_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = parsePositiveInt(process.env.SEARCH_CACHE_MAX_ENTRIES, 200);
const CACHE_BACKEND_REQUESTED = String(process.env.SEARCH_CACHE_BACKEND || "auto").trim().toLowerCase();
const CACHE_REDIS_URL = (process.env.SEARCH_CACHE_REDIS_URL || process.env.REDIS_URL || "").trim();
const CACHE_NAMESPACE = String(process.env.SEARCH_CACHE_NAMESPACE || "sodh:search-cache:v1").trim();
const CACHE_BACKEND_MODE = resolveCacheBackendMode(CACHE_BACKEND_REQUESTED, CACHE_REDIS_URL);
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
const SEARCH_RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.SEARCH_RATE_LIMIT_WINDOW_MS, 60000);
const SEARCH_RATE_LIMIT_MAX_REQUESTS = parsePositiveInt(process.env.SEARCH_RATE_LIMIT_MAX_REQUESTS, 20);
const SEARCH_RATE_LIMIT_BLOCK_MS = parsePositiveInt(process.env.SEARCH_RATE_LIMIT_BLOCK_MS, 300000);
const SEARCH_RATE_LIMIT_MAX_KEYS = parsePositiveInt(process.env.SEARCH_RATE_LIMIT_MAX_KEYS, 10000);
const searchResponseCache = new Map();
const searchRateLimitState = new Map();
let redisClient = null;
let redisConnectPromise = null;
let redisLastConnectFailureAt = 0;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ")
};

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/healthz" && req.method === "GET") {
      return respondJson(res, 200, { ok: true });
    }

    if (BASIC_AUTH_ENABLED && !isRequestAuthorized(req)) {
      return respondUnauthorized(res);
    }

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
        security: {
          basicAuthEnabled: BASIC_AUTH_ENABLED,
          rateLimitWindowMs: SEARCH_RATE_LIMIT_WINDOW_MS,
          rateLimitMaxRequests: SEARCH_RATE_LIMIT_MAX_REQUESTS,
          rateLimitBlockMs: SEARCH_RATE_LIMIT_BLOCK_MS,
          maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
          maxQueryChars: MAX_QUERY_CHARS
        },
        cache: {
          enabled: CACHE_TTL_MS > 0,
          ttlMs: CACHE_TTL_MS,
          maxEntries: CACHE_MAX_ENTRIES,
          backend: CACHE_BACKEND_MODE,
          requestedBackend: CACHE_BACKEND_REQUESTED,
          shared: CACHE_BACKEND_MODE === "redis",
          redisUrlConfigured: Boolean(CACHE_REDIS_URL)
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
    return respondJson(res, 500, { error: "Unexpected server error." });
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
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return respondJson(res, 413, {
        error: "Request body too large.",
        maxBytes: MAX_REQUEST_BODY_BYTES
      });
    }
    return respondJson(res, 400, { error: "Invalid JSON body." });
  }

  const query = String(payload?.query || "").trim();
  if (!query) {
    return respondJson(res, 400, { error: "Query is required." });
  }
  if (query.length > MAX_QUERY_CHARS) {
    return respondJson(res, 400, {
      error: `Query is too long. Maximum ${MAX_QUERY_CHARS} characters.`
    });
  }

  const rateLimit = applySearchRateLimit(req);
  if (!rateLimit.allowed) {
    return respondJson(
      res,
      429,
      {
        error: "Rate limit exceeded for search requests. Try again shortly.",
        retryAfterSeconds: rateLimit.retryAfterSeconds
      },
      { "Retry-After": String(rateLimit.retryAfterSeconds) }
    );
  }

  const cacheKey = buildSearchCacheKey({
    query,
    providerName: provider.name,
    costMode: requestedCostConfig.mode
  });
  const cachedEntry = await getCachedSearch(cacheKey);
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

    await setCachedSearch(cacheKey, {
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
        error: "Search provider request failed.",
        provider: error.provider,
        providerStatusCode: error.statusCode,
        setupSteps: buildSetupSteps()
      });
    }

    return respondJson(res, 500, { error: "Search pipeline failed." });
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
    "Optional API protection: APP_BASIC_AUTH_USER and APP_BASIC_AUTH_PASS.",
    "Optional cost controls: SEARCH_COST_MODE=economy|standard and SEARCH_MAX_PROVIDER_CALLS=<number>.",
    "Optional auto-upgrade on weak economy results: SEARCH_AUTO_ESCALATE_STANDARD=true.",
    "Optional shared cache: SEARCH_CACHE_BACKEND=redis and REDIS_URL from Render Key Value.",
    "Restart the app so environment variables reload.",
    "Run a search again from the Search tab."
  ];
}

function respondJson(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, withSecurityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  }));
  res.end(payload);
}

function respondText(res, statusCode, body, type) {
  res.writeHead(statusCode, withSecurityHeaders({
    "Content-Type": type,
    "Cache-Control": "no-store"
  }));
  res.end(body);
}

function respondBuffer(res, statusCode, body, type) {
  res.writeHead(statusCode, withSecurityHeaders({
    "Content-Type": type,
    "Cache-Control": "no-store"
  }));
  res.end(body);
}

async function readJsonBody(req) {
  let raw = "";
  let totalBytes = 0;
  for await (const chunk of req) {
    const chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    totalBytes += chunkBytes;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
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

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large.");
    this.name = "RequestBodyTooLargeError";
  }
}

function withSecurityHeaders(headers) {
  return {
    ...SECURITY_HEADERS,
    ...headers
  };
}

function isRequestAuthorized(req) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string") {
    return false;
  }

  const match = authHeader.match(/^Basic\s+(.+)$/i);
  if (!match) {
    return false;
  }

  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }

  const delimiterIndex = decoded.indexOf(":");
  if (delimiterIndex === -1) {
    return false;
  }

  const username = decoded.slice(0, delimiterIndex);
  const password = decoded.slice(delimiterIndex + 1);

  return secureCompare(username, BASIC_AUTH_USER) && secureCompare(password, BASIC_AUTH_PASS);
}

function respondUnauthorized(res) {
  return respondJson(
    res,
    401,
    { error: "Authentication required." },
    {
      "WWW-Authenticate": 'Basic realm="Population Health Evidence Portal", charset="UTF-8"'
    }
  );
}

function secureCompare(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function applySearchRateLimit(req) {
  const now = Date.now();
  const clientIp = resolveClientIp(req);
  const existing = searchRateLimitState.get(clientIp);
  const state = existing || {
    windowStart: now,
    count: 0,
    blockedUntil: 0
  };

  if (state.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - now) / 1000))
    };
  }

  if (now - state.windowStart >= SEARCH_RATE_LIMIT_WINDOW_MS) {
    state.windowStart = now;
    state.count = 0;
  }

  state.count += 1;

  if (state.count > SEARCH_RATE_LIMIT_MAX_REQUESTS) {
    state.blockedUntil = now + SEARCH_RATE_LIMIT_BLOCK_MS;
    searchRateLimitState.set(clientIp, state);

    if (searchRateLimitState.size > SEARCH_RATE_LIMIT_MAX_KEYS) {
      pruneRateLimitState(now);
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(SEARCH_RATE_LIMIT_BLOCK_MS / 1000))
    };
  }

  searchRateLimitState.set(clientIp, state);
  if (searchRateLimitState.size > SEARCH_RATE_LIMIT_MAX_KEYS) {
    pruneRateLimitState(now);
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

function resolveClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    const segments = forwardedFor.split(",").map((item) => item.trim()).filter(Boolean);
    const first = segments[0];
    if (first) {
      return first;
    }
  }

  return req.socket?.remoteAddress || "unknown";
}

function pruneRateLimitState(now) {
  for (const [key, state] of searchRateLimitState.entries()) {
    const inactive = state.blockedUntil <= now && (now - state.windowStart) > (SEARCH_RATE_LIMIT_WINDOW_MS * 2);
    if (inactive) {
      searchRateLimitState.delete(key);
    }
  }

  if (searchRateLimitState.size <= SEARCH_RATE_LIMIT_MAX_KEYS) {
    return;
  }

  const overage = searchRateLimitState.size - SEARCH_RATE_LIMIT_MAX_KEYS;
  let removed = 0;
  for (const key of searchRateLimitState.keys()) {
    searchRateLimitState.delete(key);
    removed += 1;
    if (removed >= overage) {
      break;
    }
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

function resolveCacheBackendMode(requestedMode, redisUrl) {
  const normalized = String(requestedMode || "").trim().toLowerCase();
  if (normalized === "memory") {
    return "memory";
  }

  if (normalized === "redis") {
    return redisUrl ? "redis" : "memory";
  }

  // auto/default: use redis only when configured, otherwise fallback to memory.
  return redisUrl ? "redis" : "memory";
}

function buildSearchCacheKey({ query, providerName, costMode }) {
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ").trim();
  return `${providerName}|${costMode}|${normalizedQuery}`;
}

async function getCachedSearch(cacheKey) {
  if (CACHE_TTL_MS <= 0) {
    return null;
  }

  if (CACHE_BACKEND_MODE === "redis") {
    const sharedValue = await getCachedSearchRedis(cacheKey);
    if (sharedValue) {
      // Keep local memory warm even when redis is primary.
      setCachedSearchMemory(cacheKey, sharedValue);
      return sharedValue;
    }
  }

  return getCachedSearchMemory(cacheKey);
}

function getCachedSearchMemory(cacheKey) {
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

async function setCachedSearch(cacheKey, value) {
  if (CACHE_TTL_MS <= 0) {
    return;
  }

  if (CACHE_BACKEND_MODE === "redis") {
    const saved = await setCachedSearchRedis(cacheKey, value);
    if (saved) {
      // Also keep local memory hot for this instance.
      setCachedSearchMemory(cacheKey, value);
      return;
    }
  }

  setCachedSearchMemory(cacheKey, value);
}

function setCachedSearchMemory(cacheKey, value) {
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

async function getCachedSearchRedis(cacheKey) {
  const client = await getRedisClient();
  if (!client) {
    return null;
  }

  const redisKey = `${CACHE_NAMESPACE}:${cacheKey}`;
  try {
    const raw = await client.get(redisKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.results) || typeof parsed.metadata !== "object") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function setCachedSearchRedis(cacheKey, value) {
  const client = await getRedisClient();
  if (!client) {
    return false;
  }

  const redisKey = `${CACHE_NAMESPACE}:${cacheKey}`;
  try {
    await client.set(redisKey, JSON.stringify(value), { PX: CACHE_TTL_MS });
    return true;
  } catch {
    return false;
  }
}

async function getRedisClient() {
  if (CACHE_BACKEND_MODE !== "redis" || !CACHE_REDIS_URL) {
    return null;
  }

  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (redisConnectPromise) {
    return redisConnectPromise;
  }

  // Avoid tight reconnect loops when unavailable.
  const now = Date.now();
  if (now - redisLastConnectFailureAt < 30000) {
    return null;
  }

  redisConnectPromise = connectRedisClient();
  try {
    return await redisConnectPromise;
  } finally {
    redisConnectPromise = null;
  }
}

async function connectRedisClient() {
  const client = createClient({ url: CACHE_REDIS_URL });

  client.on("error", () => {
    // Runtime errors should not break search; caller falls back to memory cache.
  });

  try {
    await client.connect();
    redisClient = client;
    return client;
  } catch {
    redisLastConnectFailureAt = Date.now();
    try {
      await client.quit();
    } catch {
      // ignore cleanup errors
    }
    return null;
  }
}

process.on("SIGINT", shutdownRedisClient);
process.on("SIGTERM", shutdownRedisClient);

async function shutdownRedisClient() {
  if (!redisClient?.isOpen) {
    return;
  }

  try {
    await redisClient.quit();
  } catch {
    // ignore shutdown errors
  }
}
