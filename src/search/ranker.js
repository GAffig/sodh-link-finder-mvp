import { PRIORITY_DOMAINS } from "./providers.js";

const MAX_PRIORITY_RESULTS = 10;
const MIN_GOOD_RESULTS = 8;
const TARGET_RESULT_COUNT = 12;
const ABSOLUTE_MAX_RESULTS = 15;

const STAGE_A_DOMAIN_BATCH_SIZE = 4;
const STAGE_A_BATCH_RESULT_COUNT = 20;
const STAGE_A_DOMAIN_RESULT_COUNT = 10;
const STAGE_A_BUFFER_LIMIT = 24;
const STAGE_A_MAX_RESULTS_PER_DOMAIN = 3;
const MIN_STAGE_A_DIVERSE_DOMAINS = 4;
const MAX_RESULTS_PER_DOMAIN = 3;

const DATA_CENSUS_HOST = "data.census.gov";
const DATA_CENSUS_BONUS = 160;
const DATA_ASSET_HINT_BONUS = 90;
const DATA_FILE_EXTENSION_BONUS = 140;
const DATA_MAP_HINT_BONUS = 45;
const NON_DATA_HINT_PENALTY = 45;
const DATA_CENSUS_SEED_QUERY_COUNT = 12;
const PRIORITY_ASSET_QUERY_SUFFIX = "dataset table download csv xlsx";

const LOCATION_SIGNAL_BONUS = 70;
const MISSING_LOCATION_SIGNAL_PENALTY = 90;
const CENSUS_WHEN_TOPIC_PENALTY = 190;

const DATA_ASSET_HINTS = [
  "table",
  "tables",
  "dataset",
  "datasets",
  "data",
  "download",
  "indicator",
  "csv",
  "xls",
  "xlsx",
  "api",
  "open data",
  "microdata",
  "shapefile",
  "geojson",
  "map",
  "gis"
];

const DATA_FILE_EXTENSIONS = [
  ".csv",
  ".xls",
  ".xlsx",
  ".zip",
  ".json",
  ".geojson",
  ".shp",
  ".gpkg",
  ".kml",
  ".kmz"
];

const DATA_MAP_HINTS = [
  "map",
  "arcgis",
  "geoplatform",
  "atlas",
  "hifld",
  "gis"
];

const NON_DATA_HINTS = [
  "news",
  "press release",
  "blog",
  "about",
  "careers",
  "privacy",
  "terms",
  "contact us"
];

const LOW_SIGNAL_TERMS = new Set([
  "for",
  "both",
  "and",
  "or",
  "the",
  "to",
  "of",
  "in",
  "by",
  "with",
  "rate",
  "rates",
  "county",
  "counties",
  "data",
  "map",
  "maps",
  "table",
  "tables"
]);

const LOCATION_SIGNAL_GROUPS = [
  { id: "tn", aliases: ["tn", "tennessee"] },
  { id: "va", aliases: ["va", "virginia"] }
];

const TOPIC_DOMAIN_BOOST_RULES = [
  {
    triggerTerms: ["absent", "absence", "attendance", "chronic"],
    domains: ["nces.ed.gov", "tn.gov", "vdh.virginia.gov"],
    bonus: 420
  },
  {
    triggerTerms: ["incarceration", "incarcerated", "jail", "prison", "offender"],
    domains: ["ucr.fbi.gov", "urban.org", "tn.gov"],
    bonus: 430
  },
  {
    triggerTerms: ["drought", "dry", "water"],
    domains: ["droughtmonitor.unl.edu", "epa.gov", "tn.gov"],
    bonus: 460
  },
  {
    triggerTerms: ["opportunity", "mobility", "atlas"],
    domains: ["opportunityinsights.org"],
    bonus: 560
  }
];

const CENSUS_SEED_TERMS = new Set([
  "income",
  "household",
  "poverty",
  "housing",
  "rent",
  "commute",
  "population",
  "demographic",
  "median",
  "uninsured",
  "insurance",
  "acs",
  "census"
]);

export async function runSearchPipeline({ query, provider }) {
  const queryContext = buildQueryContext(query);

  const seenUrls = new Set();
  const stageAPriorityResults = [];
  const stageADomainCounts = new Map();

  // Run topic-focused domain seeds first to pull domain-authoritative links for specialized queries.
  for (const activeRule of queryContext.activeTopicRules) {
    for (const domain of activeRule.domains) {
      const domainSeedRows = await searchQueryAllow422(provider, `${query} site:${domain}`, 12);
      appendUniquePriorityRows({
        rows: domainSeedRows,
        queryContext,
        seenUrls,
        target: stageAPriorityResults,
        domainCounts: stageADomainCounts,
        maxPerDomain: 2
      });
    }
  }

  // Seed Stage A with direct data.census.gov retrieval only for census-like indicator intents.
  if (shouldSeedDataCensus(queryContext)) {
    for (const seedQuery of buildDataCensusSeedQueries(query)) {
      const seedRows = await searchQueryAllow422(provider, seedQuery, DATA_CENSUS_SEED_QUERY_COUNT);
      appendUniquePriorityRows({
        rows: seedRows,
        queryContext,
        seenUrls,
        target: stageAPriorityResults,
        domainCounts: stageADomainCounts,
        maxPerDomain: 2
      });

      if (hasEnoughStageAResults(stageAPriorityResults)) {
        break;
      }
    }
  }

  const stageABatches = chunkArray(
    PRIORITY_DOMAINS.filter((domain) => domain !== DATA_CENSUS_HOST),
    STAGE_A_DOMAIN_BATCH_SIZE
  );

  for (const domainBatch of stageABatches) {
    const stageARaw = await searchPriorityBatch({ query, domainBatch, provider });

    appendUniquePriorityRows({
      rows: stageARaw,
      queryContext,
      seenUrls,
      target: stageAPriorityResults,
      domainCounts: stageADomainCounts,
      maxPerDomain: STAGE_A_MAX_RESULTS_PER_DOMAIN
    });

    if (hasEnoughStageAResults(stageAPriorityResults)) {
      break;
    }
  }

  const combined = [...stageAPriorityResults];
  const shouldRunFallback = stageAPriorityResults.length < MIN_GOOD_RESULTS;

  if (shouldRunFallback) {
    const stageBRaw = await provider.searchWeb(query, { count: 50 });

    for (const row of stageBRaw) {
      const normalized = normalizeRow(row, queryContext);
      if (!normalized) {
        continue;
      }

      if (seenUrls.has(normalized.urlKey)) {
        continue;
      }

      seenUrls.add(normalized.urlKey);
      combined.push(normalized);

      if (combined.length >= TARGET_RESULT_COUNT * 2) {
        break;
      }
    }
  }

  const sorted = combined.sort(compareByScore);
  const balanced = limitResultsPerDomain(sorted, MAX_RESULTS_PER_DOMAIN, ABSOLUTE_MAX_RESULTS);

  return {
    results: balanced.map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      domain: item.domain,
      isPriority: item.isPriority
    })),
    metadata: {
      fallbackUsed: shouldRunFallback,
      priorityResultCount: stageAPriorityResults.length,
      totalResultCount: balanced.length
    }
  };
}

async function searchPriorityBatch({ query, domainBatch, provider }) {
  const batchQuery = buildDomainBatchQuery(query, domainBatch);

  try {
    return await provider.searchWeb(batchQuery, { count: STAGE_A_BATCH_RESULT_COUNT });
  } catch (error) {
    // Some providers reject long/complex OR site filters with 422.
    if (Number(error?.statusCode) !== 422) {
      throw error;
    }
  }

  const merged = [];
  for (const domain of domainBatch) {
    try {
      const domainQuery = `${query} site:${domain}`;
      const rows = await provider.searchWeb(domainQuery, { count: STAGE_A_DOMAIN_RESULT_COUNT });
      merged.push(...rows);
    } catch (error) {
      if (Number(error?.statusCode) !== 422) {
        throw error;
      }
    }
  }

  return merged;
}

async function searchQueryAllow422(provider, query, count) {
  try {
    return await provider.searchWeb(query, { count });
  } catch (error) {
    if (Number(error?.statusCode) === 422) {
      return [];
    }
    throw error;
  }
}

function normalizeRow(row, queryContext) {
  const title = String(row?.title || "").trim();
  const url = String(row?.url || "").trim();
  const snippet = String(row?.snippet || "").trim();
  const domain = extractDomain(url);

  if (!title || !url || !domain) {
    return null;
  }

  const lowerTitle = title.toLowerCase();
  const lowerSnippet = snippet.toLowerCase();
  const lowerUrl = url.toLowerCase();

  const coreCoverage = computeTermCoverage(queryContext.coreTerms, lowerTitle, lowerSnippet, lowerUrl);
  if (queryContext.coreTerms.length > 0 && coreCoverage.uniqueMatches === 0) {
    return null;
  }

  const isPriority = isPriorityDomain(domain);
  const score = scoreResult(
    {
      title,
      snippet,
      url,
      domain,
      isPriority,
      lowerTitle,
      lowerSnippet,
      lowerUrl
    },
    queryContext,
    coreCoverage
  );

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

function appendUniquePriorityRows({ rows, queryContext, seenUrls, target, domainCounts, maxPerDomain }) {
  for (const row of rows) {
    if (target.length >= STAGE_A_BUFFER_LIMIT) {
      break;
    }

    const normalized = normalizeRow(row, queryContext);
    if (!normalized || !normalized.isPriority) {
      continue;
    }

    if (seenUrls.has(normalized.urlKey)) {
      continue;
    }

    const currentDomainCount = domainCounts.get(normalized.domain) || 0;
    if (currentDomainCount >= maxPerDomain) {
      continue;
    }

    seenUrls.add(normalized.urlKey);
    target.push(normalized);
    domainCounts.set(normalized.domain, currentDomainCount + 1);
  }
}

function scoreResult(result, queryContext, coreCoverage) {
  let score = 0;

  if (result.isPriority) {
    score += 1000;
  }

  if (matchesHost(result.domain.toLowerCase(), DATA_CENSUS_HOST)) {
    score += DATA_CENSUS_BONUS;
  }

  if (containsAnyHint(DATA_ASSET_HINTS, result.lowerUrl, result.lowerTitle, result.lowerSnippet)) {
    score += DATA_ASSET_HINT_BONUS;
  }

  if (containsAnyHint(DATA_MAP_HINTS, result.lowerUrl, result.lowerTitle, result.lowerSnippet)) {
    score += DATA_MAP_HINT_BONUS;
  }

  if (hasDataFileExtension(result.lowerUrl)) {
    score += DATA_FILE_EXTENSION_BONUS;
  }

  if (containsAnyHint(NON_DATA_HINTS, result.lowerUrl, result.lowerTitle, result.lowerSnippet)) {
    score -= NON_DATA_HINT_PENALTY;
  }

  score += coreCoverage.titleMatches * 24;
  score += coreCoverage.snippetMatches * 12;
  score += coreCoverage.urlMatches * 8;
  score += coreCoverage.uniqueMatches * 18;

  for (const term of queryContext.queryTerms) {
    if (containsToken(result.lowerTitle, term)) {
      score += 8;
    }
    if (containsToken(result.lowerSnippet, term)) {
      score += 4;
    }
    if (containsToken(result.lowerUrl, term)) {
      score += 3;
    }
  }

  const locationMatches = countLocationSignalMatches(queryContext.locationSignals, result);
  if (queryContext.locationSignals.length > 0) {
    if (locationMatches === 0) {
      score -= MISSING_LOCATION_SIGNAL_PENALTY;
    } else {
      score += locationMatches * LOCATION_SIGNAL_BONUS;
    }
  }

  score += getTopicDomainBoost(queryContext.activeTopicRules, result.domain);
  score += getTopicMismatchPenalty(queryContext.activeTopicRules, queryContext.queryTerms, result.domain);

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

function buildQueryContext(query) {
  const queryTerms = tokenize(query);
  const coreTerms = queryTerms.filter((term) => !LOW_SIGNAL_TERMS.has(term));

  return {
    queryTerms,
    coreTerms: coreTerms.length > 0 ? coreTerms : queryTerms,
    locationSignals: extractLocationSignals(queryTerms),
    activeTopicRules: TOPIC_DOMAIN_BOOST_RULES.filter((rule) =>
      rule.triggerTerms.some((term) => queryTerms.includes(term))
    )
  };
}

function shouldSeedDataCensus(queryContext) {
  if (queryContext.activeTopicRules.length > 0 && !queryContext.queryTerms.includes("census")) {
    return false;
  }

  return queryContext.queryTerms.some((term) => CENSUS_SEED_TERMS.has(term));
}

function tokenize(value) {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) || [];
  const filtered = tokens.filter((token) => token.length > 1);
  return [...new Set(filtered)];
}

function computeTermCoverage(terms, lowerTitle, lowerSnippet, lowerUrl) {
  let titleMatches = 0;
  let snippetMatches = 0;
  let urlMatches = 0;
  let uniqueMatches = 0;

  for (const term of terms) {
    const inTitle = containsToken(lowerTitle, term);
    const inSnippet = containsToken(lowerSnippet, term);
    const inUrl = containsToken(lowerUrl, term);

    if (inTitle) {
      titleMatches += 1;
    }
    if (inSnippet) {
      snippetMatches += 1;
    }
    if (inUrl) {
      urlMatches += 1;
    }

    if (inTitle || inSnippet || inUrl) {
      uniqueMatches += 1;
    }
  }

  return { titleMatches, snippetMatches, urlMatches, uniqueMatches };
}

function extractLocationSignals(queryTerms) {
  const presentTerms = new Set(queryTerms);

  return LOCATION_SIGNAL_GROUPS.filter((group) =>
    group.aliases.some((alias) => presentTerms.has(alias))
  );
}

function countLocationSignalMatches(locationSignals, result) {
  let matches = 0;

  for (const signal of locationSignals) {
    const matched = signal.aliases.some((alias) => {
      return (
        containsToken(result.lowerTitle, alias) ||
        containsToken(result.lowerSnippet, alias) ||
        containsToken(result.lowerUrl, alias) ||
        containsToken(result.domain.toLowerCase(), alias)
      );
    });

    if (matched) {
      matches += 1;
    }
  }

  return matches;
}

function getTopicDomainBoost(activeTopicRules, domain) {
  let bonus = 0;

  for (const rule of activeTopicRules) {
    if (rule.domains.some((targetDomain) => matchesHost(domain.toLowerCase(), targetDomain))) {
      bonus += rule.bonus;
    }
  }

  return bonus;
}

function getTopicMismatchPenalty(activeTopicRules, queryTerms, domain) {
  if (activeTopicRules.length === 0) {
    return 0;
  }

  if (queryTerms.includes("census")) {
    return 0;
  }

  const lowerDomain = domain.toLowerCase();
  if (matchesHost(lowerDomain, "census.gov") || matchesHost(lowerDomain, DATA_CENSUS_HOST)) {
    return -CENSUS_WHEN_TOPIC_PENALTY;
  }

  return 0;
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
    return matchesHost(hostname, normalizedPriority);
  });
}

function buildDomainBatchQuery(query, domains) {
  return `${query} ${domains.map((domain) => `site:${domain}`).join(" OR ")}`;
}

function chunkArray(items, chunkSize) {
  const chunks = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

function buildDataCensusSeedQueries(query) {
  return [
    `${query} site:${DATA_CENSUS_HOST} ${PRIORITY_ASSET_QUERY_SUFFIX}`,
    `${query} site:${DATA_CENSUS_HOST}`
  ];
}

function hasEnoughStageAResults(stageAPriorityResults) {
  return (
    stageAPriorityResults.length >= MAX_PRIORITY_RESULTS &&
    countDistinctDomains(stageAPriorityResults) >= MIN_STAGE_A_DIVERSE_DOMAINS
  );
}

function countDistinctDomains(results) {
  return new Set(results.map((item) => item.domain)).size;
}

function limitResultsPerDomain(sortedResults, maxPerDomain, maxTotal) {
  const selected = [];
  const overflow = [];
  const domainCounts = new Map();

  for (const item of sortedResults) {
    const currentCount = domainCounts.get(item.domain) || 0;

    if (currentCount < maxPerDomain) {
      selected.push(item);
      domainCounts.set(item.domain, currentCount + 1);
    } else {
      overflow.push(item);
    }

    if (selected.length >= maxTotal) {
      return selected;
    }
  }

  for (const item of overflow) {
    selected.push(item);
    if (selected.length >= maxTotal) {
      break;
    }
  }

  return selected;
}

function matchesHost(hostname, priorityHost) {
  return hostname === priorityHost || hostname.endsWith(`.${priorityHost}`);
}

function containsAnyHint(hints, lowerUrl, lowerTitle, lowerSnippet) {
  for (const hint of hints) {
    if (
      containsToken(lowerUrl, hint) ||
      containsToken(lowerTitle, hint) ||
      containsToken(lowerSnippet, hint)
    ) {
      return true;
    }
  }

  return false;
}

function hasDataFileExtension(lowerUrl) {
  const cleanUrl = lowerUrl.split("?")[0].split("#")[0];
  return DATA_FILE_EXTENSIONS.some((extension) => cleanUrl.endsWith(extension));
}

function containsToken(haystack, term) {
  if (!term) {
    return false;
  }

  if (term.includes(" ")) {
    return haystack.includes(term);
  }

  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`);
  return pattern.test(haystack);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
