import { PRIORITY_DOMAINS } from "./providers.js";

const MAX_PRIORITY_RESULTS = 10;
const MIN_GOOD_RESULTS = 8;
const TARGET_RESULT_COUNT = 12;
const ABSOLUTE_MAX_RESULTS = 15;

export async function runSearchPipeline({ query, provider }) {
  const queryTerms = tokenize(query);

  const stageAQuery = `${query} (${PRIORITY_DOMAINS.map((domain) => `site:${domain}`).join(" OR ")})`;
  const stageARaw = await provider.searchWeb(stageAQuery, { count: 40 });

  const seenUrls = new Set();
  const stageAPriorityResults = [];

  for (const row of stageARaw) {
    const normalized = normalizeRow(row, queryTerms);
    if (!normalized || !normalized.isPriority) {
      continue;
    }

    if (seenUrls.has(normalized.urlKey)) {
      continue;
    }

    seenUrls.add(normalized.urlKey);
    stageAPriorityResults.push(normalized);

    if (stageAPriorityResults.length >= MAX_PRIORITY_RESULTS) {
      break;
    }
  }

  const combined = [...stageAPriorityResults];
  const shouldRunFallback = stageAPriorityResults.length < MIN_GOOD_RESULTS;

  if (shouldRunFallback) {
    const stageBRaw = await provider.searchWeb(query, { count: 50 });

    for (const row of stageBRaw) {
      const normalized = normalizeRow(row, queryTerms);
      if (!normalized) {
        continue;
      }

      if (seenUrls.has(normalized.urlKey)) {
        continue;
      }

      seenUrls.add(normalized.urlKey);
      combined.push(normalized);

      if (combined.length >= TARGET_RESULT_COUNT) {
        break;
      }
    }
  }

  const sorted = combined
    .sort(compareByScore)
    .slice(0, ABSOLUTE_MAX_RESULTS)
    .map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      domain: item.domain,
      isPriority: item.isPriority
    }));

  return {
    results: sorted,
    metadata: {
      fallbackUsed: shouldRunFallback,
      priorityResultCount: stageAPriorityResults.length,
      totalResultCount: sorted.length
    }
  };
}

function normalizeRow(row, queryTerms) {
  const title = String(row?.title || "").trim();
  const url = String(row?.url || "").trim();
  const snippet = String(row?.snippet || "").trim();
  const domain = extractDomain(url);

  if (!title || !url || !domain) {
    return null;
  }

  const isPriority = isPriorityDomain(domain);
  const score = scoreResult({ title, snippet, url, isPriority }, queryTerms);

  return {
    title,
    url,
    snippet,
    domain,
    isPriority,
    score,
    urlKey: canonicalUrl(url)
  };
}

function scoreResult(result, queryTerms) {
  const lowerTitle = result.title.toLowerCase();
  const lowerSnippet = result.snippet.toLowerCase();
  const lowerUrl = result.url.toLowerCase();

  let score = 0;
  if (result.isPriority) {
    score += 1000;
  }

  for (const term of queryTerms) {
    if (lowerTitle.includes(term)) {
      score += 15;
    }
    if (lowerSnippet.includes(term)) {
      score += 7;
    }
    if (lowerUrl.includes(term)) {
      score += 5;
    }
  }

  return score;
}

function compareByScore(a, b) {
  if (b.score !== a.score) {
    return b.score - a.score;
  }

  if (a.isPriority !== b.isPriority) {
    return a.isPriority ? -1 : 1;
  }

  if (a.domain !== b.domain) {
    return a.domain.localeCompare(b.domain);
  }

  return a.title.localeCompare(b.title);
}

function tokenize(value) {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) || [];
  const filtered = tokens.filter((token) => token.length > 1);
  return [...new Set(filtered)];
}

function extractDomain(candidateUrl) {
  try {
    return new URL(candidateUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function canonicalUrl(candidateUrl) {
  try {
    const parsed = new URL(candidateUrl);
    parsed.hash = "";
    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return candidateUrl;
  }
}

function isPriorityDomain(hostname) {
  return PRIORITY_DOMAINS.some((priority) => {
    const normalizedPriority = priority.toLowerCase();
    return hostname === normalizedPriority || hostname.endsWith(`.${normalizedPriority}`);
  });
}
