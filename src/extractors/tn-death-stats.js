import {
  asAbsoluteUrl,
  normalizeText,
  parseCsvRecords,
  parseYear,
  resolveHost,
  hostMatches,
  toRecordKey
} from "./helpers.js";

const DEFAULT_TDH_INDEX_URL =
  "https://www.tn.gov/health/health-program-areas/statistics/health-data/death-statistics.html";

let cachedXlsxModule = null;

export const tnDeathStatsExtractor = Object.freeze({
  id: "tdh_death_stats",
  label: "TN Death Statistics (TDH Index)",
  method: "download_index",
  description: "Extracts TDH link catalogs and optionally converts downloaded XLSX/CSV files into tidy rows.",
  supportedDomains: Object.freeze(["tn.gov"]),
  supportedOutputFormats: Object.freeze(["csv"]),
  defaultParameters: Object.freeze({
    mode: "catalog",
    includePdf: true,
    includeExcel: true,
    maxFiles: 3
  }),
  eligibility(result) {
    const host = resolveHost(result?.url);
    if (!host || !hostMatches(host, "tn.gov")) {
      return null;
    }

    const combined = `${normalizeText(result?.title)} ${normalizeText(result?.snippet)} ${normalizeText(result?.url)}`;
    if (!combined.includes("death") && !combined.includes("mortality") && !combined.includes("statistics")) {
      return null;
    }

    return {
      sourceId: this.id,
      label: this.label,
      method: this.method,
      supportedOutputFormats: [...this.supportedOutputFormats],
      defaults: this.defaultParameters
    };
  },
  async extract({ url, parameters, fetchImpl, caches }) {
    const indexUrl = String(parameters?.indexUrl || url || DEFAULT_TDH_INDEX_URL).trim() || DEFAULT_TDH_INDEX_URL;
    const includePdf = parseBoolean(parameters?.includePdf, true);
    const includeExcel = parseBoolean(parameters?.includeExcel, true);
    const yearFilter = parseYear(parameters?.year);
    const mode = normalizeMode(parameters?.mode);
    const sectionContains = normalizeText(
      parameters?.sectionContains || parameters?.section || parameters?.measure || ""
    );
    const maxFiles = normalizeMaxFiles(parameters?.maxFiles);

    const cacheKey = buildCatalogCacheKey({ indexUrl, includePdf, includeExcel });
    const links = await loadLinkCatalog({
      fetchImpl,
      caches,
      cacheKey,
      indexUrl,
      includePdf,
      includeExcel
    });

    const filtered = filterLinks({
      links,
      yearFilter,
      sectionContains
    });
    if (filtered.length === 0) {
      throw createExtractorError("No TDH files match the selected filters.", 404);
    }

    if (mode === "catalog") {
      return buildCatalogOutput({
        source: this.id,
        sourceUrl: indexUrl,
        method: this.method,
        includePdf,
        includeExcel,
        yearFilter,
        sectionContains,
        rows: filtered.map((item) => catalogRowFromLink(this.id, item))
      });
    }

    const tidyRows = await extractTidyRows({
      sourceId: this.id,
      links: filtered,
      maxFiles,
      fetchImpl
    });
    if (tidyRows.length === 0) {
      throw createExtractorError(
        "No tabular rows could be extracted from the selected TDH files. Try mode=catalog or adjust filters.",
        422
      );
    }

    return {
      source: this.id,
      sourceUrl: indexUrl,
      method: `${this.method}_tidy`,
      parameters: {
        indexUrl,
        mode,
        includePdf,
        includeExcel,
        year: yearFilter || null,
        sectionContains: sectionContains || null,
        maxFiles
      },
      requestDetails: {
        endpoint: indexUrl,
        queryString: ""
      },
      licenseOrTermsUrl: indexUrl,
      rows: tidyRows
    };
  }
});

async function loadLinkCatalog({ fetchImpl, caches, cacheKey, indexUrl, includePdf, includeExcel }) {
  const cached = getCachedCatalog(caches, cacheKey);
  if (cached) {
    return cached;
  }

  const response = await fetchImpl(indexUrl, { headers: { Accept: "text/html" } });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 250);
    throw createExtractorError(
      `TDH download index returned HTTP ${response.status}. ${body || "Request rejected."}`,
      502
    );
  }

  const html = await response.text();
  const links = extractDownloadLinks(html, indexUrl, { includePdf, includeExcel });
  if (links.length === 0) {
    throw createExtractorError("No downloadable files were found on the TDH index page.", 404);
  }

  setCachedCatalog(caches, cacheKey, links);
  return links;
}

function filterLinks({ links, yearFilter, sectionContains }) {
  return links.filter((item) => {
    if (yearFilter && item.year !== yearFilter) {
      return false;
    }
    if (sectionContains && !normalizeText(item.section || item.label).includes(sectionContains)) {
      return false;
    }
    return true;
  });
}

function buildCatalogOutput({ source, sourceUrl, method, includePdf, includeExcel, yearFilter, sectionContains, rows }) {
  return {
    source,
    sourceUrl,
    method,
    parameters: {
      indexUrl: sourceUrl,
      mode: "catalog",
      includePdf,
      includeExcel,
      year: yearFilter || null,
      sectionContains: sectionContains || null
    },
    requestDetails: {
      endpoint: sourceUrl,
      queryString: ""
    },
    licenseOrTermsUrl: sourceUrl,
    rows
  };
}

async function extractTidyRows({ sourceId, links, maxFiles, fetchImpl }) {
  const selected = links.filter((item) => ["xlsx", "xls", "csv"].includes(item.fileType)).slice(0, maxFiles);
  if (selected.length === 0) {
    throw createExtractorError(
      "No CSV/XLS/XLSX files found in selected TDH links for tidy extraction.",
      422
    );
  }

  const tidyRows = [];
  for (const item of selected) {
    let records = [];
    if (item.fileType === "csv") {
      records = await fetchCsvRecords(item.downloadUrl, fetchImpl);
    } else if (item.fileType === "xlsx" || item.fileType === "xls") {
      records = await fetchWorkbookRecords(item.downloadUrl, fetchImpl);
    }

    for (const record of records) {
      const standardized = normalizeTidyRecord({
        sourceId,
        linkItem: item,
        record
      });
      if (standardized) {
        tidyRows.push(standardized);
      }
      if (tidyRows.length >= 10000) {
        return tidyRows;
      }
    }
  }

  return tidyRows;
}

async function fetchCsvRecords(downloadUrl, fetchImpl) {
  const response = await fetchImpl(downloadUrl, { headers: { Accept: "text/csv,text/plain" } });
  if (!response.ok) {
    throw createExtractorError(`Failed to download CSV file (${response.status}) from ${downloadUrl}.`, 502);
  }

  const text = await response.text();
  return parseCsvRecords(text);
}

async function fetchWorkbookRecords(downloadUrl, fetchImpl) {
  const response = await fetchImpl(downloadUrl, { headers: { Accept: "*/*" } });
  if (!response.ok) {
    throw createExtractorError(`Failed to download workbook file (${response.status}) from ${downloadUrl}.`, 502);
  }

  const arrayBuffer = await response.arrayBuffer();
  const XLSX = await loadXlsxLibrary();
  const workbook = XLSX.read(Buffer.from(arrayBuffer), { type: "buffer" });

  const records = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: "",
      raw: false,
      blankrows: false
    });
    for (const row of rows) {
      records.push({
        __sheet: sheetName,
        ...row
      });
      if (records.length >= 10000) {
        return records;
      }
    }
  }

  return records;
}

async function loadXlsxLibrary() {
  if (cachedXlsxModule) {
    return cachedXlsxModule;
  }

  try {
    const imported = await import("xlsx");
    cachedXlsxModule = imported.default || imported;
    return cachedXlsxModule;
  } catch {
    throw createExtractorError(
      "Workbook conversion requires the 'xlsx' package. Add dependency 'xlsx' and redeploy to enable TDH tidy conversion for XLSX files.",
      501
    );
  }
}

function normalizeTidyRecord({ sourceId, linkItem, record }) {
  const geographyName = firstValueByKeyPattern(record, ["county", "region", "geography", "state", "area"]);
  const countyFips = normalizeCountyFips(firstValueByKeyPattern(record, ["county_fips", "fips", "county code"]));
  const stateFips = normalizeStateFips(firstValueByKeyPattern(record, ["state_fips", "state code"])) || "47";
  const year = parseYear(firstValueByKeyPattern(record, ["year", "yr"])) || linkItem.year || null;
  const numeric = findBestNumeric(record);
  const measureName = linkItem.section || linkItem.label || "TDH Death Statistics";
  const notes = buildRecordNotes(record, linkItem);

  return {
    source: sourceId,
    vintage_year: year,
    data_year: year,
    geography_type: linkItem.geographyType || inferGeographyType(linkItem.label || ""),
    geography_name: geographyName,
    state_fips: stateFips,
    county_fips: countyFips || null,
    measure_name: measureName,
    measure_id: toRecordKey(measureName),
    value: numeric?.value ?? null,
    unit: inferUnitFromKey(numeric?.key),
    lower_ci: null,
    upper_ci: null,
    notes
  };
}

function buildRecordNotes(record, linkItem) {
  const preview = [];
  const entries = Object.entries(record || {});
  for (const [key, value] of entries.slice(0, 8)) {
    preview.push(`${key}=${String(value).slice(0, 80)}`);
  }
  preview.push(`download_url=${linkItem.downloadUrl}`);
  preview.push(`file_type=${linkItem.fileType}`);
  if (record?.__sheet) {
    preview.push(`sheet=${record.__sheet}`);
  }
  return preview.join("; ");
}

function findBestNumeric(record) {
  const candidates = [];
  for (const [key, value] of Object.entries(record || {})) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    const normalizedKey = normalizeText(key);
    if (normalizedKey.includes("year") || normalizedKey.includes("fips")) {
      continue;
    }

    const numericValue = toNumber(value);
    if (!Number.isFinite(numericValue)) {
      continue;
    }

    let score = 0;
    if (normalizedKey.includes("rate")) {
      score += 8;
    }
    if (normalizedKey.includes("death") || normalizedKey.includes("count")) {
      score += 7;
    }
    if (normalizedKey.includes("value")) {
      score += 6;
    }
    if (normalizedKey.includes("percent") || normalizedKey.includes("%")) {
      score += 5;
    }
    score += Math.min(String(value).length, 6);
    candidates.push({ key, value: numericValue, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function inferUnitFromKey(key) {
  const normalized = normalizeText(key);
  if (!normalized) {
    return null;
  }
  if (normalized.includes("rate")) {
    return "rate";
  }
  if (normalized.includes("percent") || normalized.includes("%")) {
    return "percent";
  }
  if (normalized.includes("count") || normalized.includes("death")) {
    return "count";
  }
  return null;
}

function extractDownloadLinks(html, baseUrl, options) {
  const links = [];
  const anchorPattern = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match = anchorPattern.exec(html);

  while (match) {
    const href = String(match[1] || "").trim();
    const label = stripHtml(match[2] || "").trim();
    const absoluteUrl = asAbsoluteUrl(href, baseUrl);
    const fileType = fileTypeFromUrl(absoluteUrl);
    if (!absoluteUrl || !fileType) {
      match = anchorPattern.exec(html);
      continue;
    }

    if (fileType === "pdf" && !options.includePdf) {
      match = anchorPattern.exec(html);
      continue;
    }

    if ((fileType === "xlsx" || fileType === "xls" || fileType === "csv") && !options.includeExcel) {
      match = anchorPattern.exec(html);
      continue;
    }

    const year = parseYear(extractYear(label) || extractYear(absoluteUrl));
    links.push({
      label,
      section: label,
      year,
      geographyType: inferGeographyType(label),
      fileType,
      downloadUrl: absoluteUrl
    });

    match = anchorPattern.exec(html);
  }

  return dedupeLinks(links);
}

function dedupeLinks(links) {
  const unique = [];
  const seen = new Set();
  for (const item of links) {
    if (seen.has(item.downloadUrl)) {
      continue;
    }
    seen.add(item.downloadUrl);
    unique.push(item);
  }
  return unique;
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function fileTypeFromUrl(value) {
  const clean = String(value || "").split("?")[0].split("#")[0].toLowerCase();
  if (clean.endsWith(".xlsx")) {
    return "xlsx";
  }
  if (clean.endsWith(".xls")) {
    return "xls";
  }
  if (clean.endsWith(".csv")) {
    return "csv";
  }
  if (clean.endsWith(".pdf")) {
    return "pdf";
  }
  return "";
}

function extractYear(value) {
  const match = String(value || "").match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

function parseBoolean(value, fallback) {
  const normalized = normalizeText(value);
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

function normalizeMode(value) {
  const normalized = normalizeText(value);
  if (normalized === "tidy") {
    return "tidy";
  }
  return "catalog";
}

function normalizeMaxFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 3;
  }
  return Math.min(Math.floor(parsed), 10);
}

function inferGeographyType(label) {
  const normalized = normalizeText(label);
  if (normalized.includes("county")) {
    return "county";
  }
  if (normalized.includes("state")) {
    return "state";
  }
  return null;
}

function catalogRowFromLink(sourceId, item) {
  return {
    source: sourceId,
    vintage_year: item.year || null,
    data_year: item.year || null,
    geography_type: item.geographyType || null,
    geography_name: null,
    state_fips: "47",
    county_fips: null,
    measure_name: item.section || item.label || "TDH Death Statistics File",
    measure_id: toRecordKey(item.section || item.label || "tdh_file"),
    value: null,
    unit: null,
    lower_ci: null,
    upper_ci: null,
    notes: `download_url=${item.downloadUrl}; file_type=${item.fileType}; label=${item.label || ""}`
  };
}

function firstValueByKeyPattern(record, keyPatterns) {
  const keys = Object.keys(record || {});
  for (const key of keys) {
    const normalized = normalizeText(key);
    for (const pattern of keyPatterns) {
      if (normalized.includes(normalizeText(pattern))) {
        const value = record[key];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
          return String(value).trim();
        }
      }
    }
  }
  return null;
}

function normalizeCountyFips(value) {
  const normalized = String(value || "").trim();
  if (/^\d{3}$/.test(normalized)) {
    return normalized;
  }
  return "";
}

function normalizeStateFips(value) {
  const normalized = String(value || "").trim();
  if (/^\d{2}$/.test(normalized)) {
    return normalized;
  }
  return "";
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const cleaned = String(value).replace(/,/g, "").trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildCatalogCacheKey({ indexUrl, includePdf, includeExcel }) {
  return `tdh|${indexUrl}|pdf:${includePdf ? "1" : "0"}|excel:${includeExcel ? "1" : "0"}`;
}

function getCachedCatalog(caches, key) {
  const store = caches?.linkCatalogStore;
  if (!store) {
    return null;
  }

  const cached = store.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.savedAt > Number(caches.linkCatalogTtlMs || 0)) {
    store.delete(key);
    return null;
  }

  return cached.value;
}

function setCachedCatalog(caches, key, value) {
  const store = caches?.linkCatalogStore;
  if (!store) {
    return;
  }

  store.set(key, {
    savedAt: Date.now(),
    value
  });
}

function createExtractorError(message, statusCode = 500) {
  const error = new Error(message);
  error.name = "ExtractorError";
  error.statusCode = statusCode;
  return error;
}
