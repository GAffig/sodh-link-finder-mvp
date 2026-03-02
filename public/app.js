const HISTORY_KEY = "sodh-link-finder-history-v1";
const NORMALIZE_QUERY_PREF_KEY = "sodh-link-finder-normalize-query-v1";
const IS_DEBUG_MODE = new URLSearchParams(window.location.search).get("debug") === "1";

const tabButtons = document.querySelectorAll(".tab");
const views = {
  search: document.getElementById("view-search"),
  history: document.getElementById("view-history")
};

const queryInput = document.getElementById("query-input");
const searchButton = document.getElementById("search-button");
const advancedOptions = document.getElementById("advanced-options");
const normalizeQueryToggle = document.getElementById("normalize-query-toggle");
const normalizeQueryNote = document.getElementById("normalize-query-note");
const searchConfigNote = document.getElementById("search-config-note");
const loadingIndicator = document.getElementById("loading-indicator");
const errorPanel = document.getElementById("error-panel");
const setupPanel = document.getElementById("setup-panel");
const resultContext = document.getElementById("result-context");
const resultsList = document.getElementById("results-list");
const extractPanel = document.getElementById("extract-panel");
const extractCloseButton = document.getElementById("extract-close");
const extractTarget = document.getElementById("extract-target");
const extractSource = document.getElementById("extract-source");
const extractMode = document.getElementById("extract-mode");
const extractYear = document.getElementById("extract-year");
const extractState = document.getElementById("extract-state");
const extractMeasure = document.getElementById("extract-measure");
const extractMaxFiles = document.getElementById("extract-max-files");
const extractFormat = document.getElementById("extract-format");
const extractRunButton = document.getElementById("extract-run");
const extractStatus = document.getElementById("extract-status");
const extractDownloads = document.getElementById("extract-downloads");
const extractDataLink = document.getElementById("extract-data-link");
const extractManifestLink = document.getElementById("extract-manifest-link");

const historyEmpty = document.getElementById("history-empty");
const historyTable = document.getElementById("history-table");
const historyBody = document.getElementById("history-body");
const clearHistoryButton = document.getElementById("clear-history");

let appConfig = null;
let historyItems = loadHistory();
let lastRenderedResults = [];
let activeExtractContext = null;

initialize();

async function initialize() {
  bindEvents();
  renderHistory();
  if (advancedOptions && IS_DEBUG_MODE) {
    advancedOptions.open = true;
  }
  await loadConfig();
}

function bindEvents() {
  for (const button of tabButtons) {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  }

  searchButton.addEventListener("click", () => runSearch());
  queryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      runSearch();
    }
  });

  if (normalizeQueryToggle) {
    normalizeQueryToggle.addEventListener("change", () => {
      const enabled = Boolean(normalizeQueryToggle.checked);
      saveNormalizeQueryPreference(enabled);
      renderNormalizeQueryNote(enabled, appConfig?.normalization?.defaultEnabled);
    });
  }

  clearHistoryButton.addEventListener("click", () => {
    historyItems = [];
    saveHistory();
    renderHistory();
    clearResultContext();
  });

  if (resultsList) {
    resultsList.addEventListener("click", onResultsListClick);
  }
  if (extractCloseButton) {
    extractCloseButton.addEventListener("click", () => hideExtractPanel());
  }
  if (extractRunButton) {
    extractRunButton.addEventListener("click", () => runExtractJob());
  }
  if (extractSource) {
    extractSource.addEventListener("change", () => applyExtractSourceDefaults());
  }
}

function switchTab(tabName) {
  for (const button of tabButtons) {
    button.classList.toggle("active", button.dataset.tab === tabName);
  }

  for (const [name, element] of Object.entries(views)) {
    element.classList.toggle("active", name === tabName);
  }
}

async function loadConfig() {
  hideError();
  try {
    const response = await fetch("/api/config", { method: "GET" });
    const data = await response.json();
    appConfig = data;
    renderSetupPanel(data);
    renderSearchConfigNote(data);
    applyNormalizeQueryConfig(data);
  } catch (error) {
    appConfig = { configured: false };
    showError(`Failed to load app configuration: ${String(error)}`);
    renderSearchConfigNote(appConfig);
    applyNormalizeQueryConfig({ configured: false, normalization: { defaultEnabled: false } });
  }
}

function renderSetupPanel(config) {
  if (config.configured) {
    setupPanel.classList.add("hidden");
    return;
  }

  const steps = Array.isArray(config.setupSteps) ? config.setupSteps : [];
  const providerOrder = Array.isArray(config.providerEnvOrder)
    ? config.providerEnvOrder.join(" -> ")
    : "BRAVE_API_KEY -> SERPAPI_KEY -> BING_API_KEY";

  setupPanel.innerHTML = `
    <h3>Setup Search Provider</h3>
    <p>No provider key is configured. Search is disabled until one key exists.</p>
    <p><strong>Selection order:</strong> ${escapeHtml(providerOrder)}</p>
    <ol>
      ${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
    </ol>
    <pre>BRAVE_API_KEY=your_key_here
SERPAPI_KEY=your_key_here
BING_API_KEY=your_key_here</pre>
  `;
  setupPanel.classList.remove("hidden");
}

function renderSearchConfigNote(config) {
  if (!searchConfigNote) {
    return;
  }

  if (!IS_DEBUG_MODE) {
    searchConfigNote.classList.add("hidden");
    return;
  }

  searchConfigNote.classList.remove("hidden");

  const cost = config?.searchCost || {};
  const escalation = config?.autoEscalation || {};
  const cache = config?.cache || {};
  const normalization = config?.normalization || {};
  const mode = String(cost.mode || "economy");
  const limit = Number(cost.providerRequestLimit || 0);
  const cacheEnabled = Boolean(cache.enabled);
  const cacheBackend = String(cache.backend || "memory");
  const cacheTtl = Number(cache.ttlMs || 0);
  const escalationText = escalation.enabled ? "on" : "off";
  const normalizeDefault = normalization.defaultEnabled ? "on" : "off";

  if (!config?.configured) {
    searchConfigNote.textContent = "Search disabled until provider key is configured.";
    return;
  }

  const limitText = Number.isFinite(limit) && limit > 0 ? String(limit) : "n/a";
  const cacheText = cacheEnabled ? formatDuration(cacheTtl) : "off";
  searchConfigNote.textContent = `Efficiency mode: ${mode}. Provider call cap/search: ${limitText}. Auto-upgrade: ${escalationText}. Query normalization default: ${normalizeDefault}. Cache backend: ${cacheBackend}. Server cache TTL: ${cacheText}.`;
}

async function runSearch() {
  hideError();
  clearResultContext();
  hideExtractPanel();

  const query = queryInput.value.trim();
  if (!query) {
    showError("Please enter a query.");
    return;
  }

  if (!appConfig?.configured) {
    renderSetupPanel(appConfig || { configured: false, setupSteps: [] });
    showError("Search provider is not configured. Follow setup steps below.");
    return;
  }

  setLoading(true);
  try {
    const normalizeQuery = Boolean(normalizeQueryToggle?.checked);
    const response = await fetch("/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, normalizeQuery })
    });

    const payload = await response.json();

    if (!response.ok) {
      let message = payload?.error || "Search failed.";
      if (payload?.providerStatusCode) {
        message += ` (provider HTTP ${payload.providerStatusCode})`;
      }
      showError(message);

      if (payload?.code === "NOT_CONFIGURED") {
        renderSetupPanel({ configured: false, setupSteps: payload.setupSteps || [] });
      }
      return;
    }

    renderResults(payload.results);
    const metadata = payload?.metadata || {};
    const providerName = String(payload.provider || "").toUpperCase();
    const callLabel = metadata.cacheHit
      ? "cache hit (0 provider calls)"
      : `${metadata.providerRequestCount ?? "?"}/${metadata.providerRequestLimit ?? "?"} provider calls`;
    const requestedMode = metadata.requestedCostMode || metadata.costMode;
    const effectiveMode = metadata.effectiveCostMode || metadata.costMode;
    const queryNormalization = metadata.queryNormalization || {};
    const modeLabel = requestedMode === effectiveMode
      ? `mode: ${effectiveMode}.`
      : `mode: ${requestedMode} -> ${effectiveMode} (auto-upgraded).`;
    const normalizationLabel = buildNormalizationLabel({
      query,
      normalizedQuery: payload.normalizedQuery,
      queryNormalization
    });
    if (IS_DEBUG_MODE) {
      const contextParts = [
        `Showing ${payload.results.length} ranked links from ${providerName}.`,
        modeLabel,
        normalizationLabel,
        `${callLabel}.`
      ].filter(Boolean);
      showResultContext(contextParts.join(" "));
    } else {
      const contextParts = [`Showing ${payload.results.length} ranked links from ${providerName}.`];
      if (queryNormalization?.enabled && queryNormalization?.changed) {
        contextParts.push("Query normalized for better recall.");
      }
      if (metadata.cacheHit) {
        contextParts.push("Served from cache.");
      }
      showResultContext(contextParts.join(" "));
    }

    const historyRecord = {
      id: makeId(),
      query: payload.query,
      normalizedQuery: payload.normalizedQuery || payload.query,
      timestamp: payload.timestamp,
      provider: payload.provider,
      queryNormalization: queryNormalization,
      results: payload.results
    };

    historyItems = [historyRecord, ...historyItems];
    saveHistory();
    renderHistory();
  } catch (error) {
    showError(`Search request failed: ${String(error)}`);
  } finally {
    setLoading(false);
  }
}

function renderResults(results) {
  resultsList.innerHTML = "";
  lastRenderedResults = Array.isArray(results) ? results : [];

  if (lastRenderedResults.length === 0) {
    const item = document.createElement("li");
    item.className = "panel";
    item.textContent = "No results returned.";
    resultsList.appendChild(item);
    return;
  }

  for (const [index, result] of lastRenderedResults.entries()) {
    const li = document.createElement("li");
    li.className = "result";

    const priorityBadge = result.isPriority ? '<span class="meta-pill priority">Priority Source</span>' : "";
    const extractorCount = Array.isArray(result.extractors) ? result.extractors.length : 0;
    const downloadBadge = extractorCount > 0
      ? `<span class="download-badge">Download ready</span>`
      : "";
    const displayDomain = escapeHtml(result.domain || result.url);
    const openUrl = escapeAttribute(result.url);
    const downloadAction = extractorCount > 0
      ? `<button type="button" class="secondary download-action" data-action="download" data-index="${index}">Download data</button>`
      : "";

    li.innerHTML = `
      <div class="result-head">
        <span class="result-rank">#${index + 1}</span>
        <div class="result-title-group">
          <a class="result-title" href="${openUrl}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(result.title)}
          </a>
          <div class="result-meta">
            <span class="meta-pill">${displayDomain}</span>
            ${priorityBadge}
          </div>
        </div>
      </div>
      <p class="snippet">${escapeHtml(result.snippet || "")}</p>
      <div>
        <a class="open-link" href="${openUrl}" target="_blank" rel="noopener noreferrer">Open source</a>
        ${downloadBadge}
      </div>
      ${downloadAction}
    `;

    resultsList.appendChild(li);
  }
}

function onResultsListClick(event) {
  const button = event.target.closest("button[data-action='download']");
  if (!button) {
    return;
  }

  const index = Number(button.dataset.index);
  if (!Number.isFinite(index) || index < 0 || index >= lastRenderedResults.length) {
    return;
  }

  const result = lastRenderedResults[index];
  openExtractPanel(result);
}

function openExtractPanel(result) {
  const extractors = Array.isArray(result?.extractors) ? result.extractors : [];
  if (extractors.length === 0) {
    showError("No extractor is configured for this result.");
    return;
  }

  activeExtractContext = {
    url: result.url,
    title: result.title,
    extractorMap: Object.fromEntries(extractors.map((item) => [item.sourceId, item]))
  };

  if (extractTarget) {
    extractTarget.textContent = `Target: ${result.title}`;
  }

  if (extractSource) {
    extractSource.innerHTML = "";
    for (const extractor of extractors) {
      const option = document.createElement("option");
      option.value = extractor.sourceId;
      option.textContent = extractor.label;
      extractSource.appendChild(option);
    }
  }

  if (extractFormat) {
    extractFormat.value = "csv";
  }
  if (extractMode) {
    extractMode.value = "catalog";
  }
  if (extractMaxFiles) {
    extractMaxFiles.value = "3";
  }
  clearExtractResultLinks();
  setExtractStatus("");
  applyExtractSourceDefaults();
  extractPanel?.classList.remove("hidden");
}

function hideExtractPanel() {
  activeExtractContext = null;
  clearExtractResultLinks();
  setExtractStatus("");
  if (extractPanel) {
    extractPanel.classList.add("hidden");
  }
}

function applyExtractSourceDefaults() {
  if (!activeExtractContext || !extractSource) {
    return;
  }

  const selectedSourceId = extractSource.value;
  const selected = activeExtractContext.extractorMap?.[selectedSourceId];
  const defaults = selected?.defaults || {};

  if (extractMode) {
    extractMode.value = String(defaults.mode || "catalog");
  }
  if (extractYear) {
    const year = defaults.vintage || defaults.year || "";
    extractYear.value = year ? String(year) : "";
  }
  if (extractState) {
    const state = defaults.state || defaults.stateAbbr || "";
    extractState.value = state ? String(state) : "";
  }
  if (extractMeasure) {
    const measureId = defaults.measureId || "";
    extractMeasure.value = measureId ? String(measureId) : "";
  }
  if (extractMaxFiles) {
    const maxFiles = Number(defaults.maxFiles || 3);
    extractMaxFiles.value = Number.isFinite(maxFiles) && maxFiles > 0 ? String(maxFiles) : "3";
  }
  if (extractFormat) {
    const formats = Array.isArray(selected?.supportedOutputFormats)
      ? selected.supportedOutputFormats
      : ["csv"];
    const canUseXlsx = formats.includes("xlsx");
    const xlsxOption = extractFormat.querySelector("option[value='xlsx']");
    if (xlsxOption) {
      xlsxOption.disabled = !canUseXlsx;
    }
    extractFormat.value = formats.includes("csv") ? "csv" : formats[0];
  }
}

async function runExtractJob() {
  hideError();
  if (!extractRunButton) {
    return;
  }
  if (!activeExtractContext) {
    showError("Choose a result with Download data first.");
    return;
  }
  if (!extractSource?.value) {
    showError("Choose an extractor source.");
    return;
  }

  const selectedSourceId = extractSource.value;
  const selected = activeExtractContext.extractorMap?.[selectedSourceId] || {};
  const outputFormat = String(extractFormat?.value || "csv");
  const selectedMode = String(extractMode?.value || selected.defaults?.mode || "catalog");
  const parameters = {
    ...(selected.defaults || {})
  };

  const yearValue = String(extractYear?.value || "").trim();
  const stateValue = String(extractState?.value || "").trim();
  const measureValue = String(extractMeasure?.value || "").trim();
  const maxFilesValue = String(extractMaxFiles?.value || "").trim();

  if (yearValue) {
    parameters.year = yearValue;
    parameters.vintage = yearValue;
  }
  if (stateValue) {
    parameters.state = stateValue;
    parameters.stateAbbr = stateValue;
  }
  if (measureValue) {
    parameters.measureId = measureValue;
    parameters.measure = measureValue;
    parameters.sectionContains = measureValue;
  }
  if (selectedMode) {
    parameters.mode = selectedMode;
  }
  if (maxFilesValue) {
    parameters.maxFiles = maxFilesValue;
  }
  if (selectedSourceId === "tdh_death_stats") {
    parameters.indexUrl = activeExtractContext.url;
    if (!parameters.mode) {
      parameters.mode = "tidy";
    }
  }
  if (selectedSourceId === "cdc_wonder") {
    if (!parameters.templateId) {
      parameters.templateId = "mortality_county_v1";
    }
  }

  extractRunButton.disabled = true;
  clearExtractResultLinks();
  setExtractStatus("Running extraction...");

  try {
    const response = await fetch("/api/extract/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sourceId: selectedSourceId,
        sourceUrl: activeExtractContext.url,
        query: queryInput.value.trim(),
        outputFormat,
        parameters
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      let message = payload?.error || "Extraction failed.";
      if (payload?.details?.templateId) {
        message += ` (template: ${payload.details.templateId})`;
      }
      setExtractStatus(message);
      return;
    }

    if (extractDataLink) {
      extractDataLink.href = payload.dataDownloadUrl;
    }
    if (extractManifestLink) {
      extractManifestLink.href = payload.manifestDownloadUrl;
    }
    if (extractDownloads) {
      extractDownloads.classList.remove("hidden");
    }
    const cacheText = payload.cached ? "cache hit" : "fresh run";
    setExtractStatus(`Extract ready: ${payload.rowCount} rows (${cacheText}).`);
  } catch (error) {
    setExtractStatus(`Extraction request failed: ${String(error)}`);
  } finally {
    extractRunButton.disabled = false;
  }
}

function clearExtractResultLinks() {
  if (extractDownloads) {
    extractDownloads.classList.add("hidden");
  }
  if (extractDataLink) {
    extractDataLink.href = "#";
  }
  if (extractManifestLink) {
    extractManifestLink.href = "#";
  }
}

function setExtractStatus(message) {
  if (!extractStatus) {
    return;
  }
  extractStatus.textContent = message;
}

function renderHistory() {
  historyBody.innerHTML = "";

  if (historyItems.length === 0) {
    historyEmpty.classList.remove("hidden");
    historyTable.classList.add("hidden");
    return;
  }

  historyEmpty.classList.add("hidden");
  historyTable.classList.remove("hidden");

  const ordered = [...historyItems].sort((a, b) => {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  for (const item of ordered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.query)}</td>
      <td>${escapeHtml(formatDate(item.timestamp))}</td>
      <td>${item.results?.length || 0}</td>
      <td><button type="button" class="secondary" data-id="${escapeAttribute(item.id)}">Open</button></td>
    `;

    const openButton = tr.querySelector("button");
    openButton.addEventListener("click", () => openHistoryItem(item.id));

    historyBody.appendChild(tr);
  }
}

function openHistoryItem(itemId) {
  const selected = historyItems.find((item) => item.id === itemId);
  if (!selected) {
    showError("Unable to load saved history item.");
    return;
  }

  queryInput.value = selected.query;
  if (normalizeQueryToggle) {
    normalizeQueryToggle.checked = Boolean(selected?.queryNormalization?.enabled);
    saveNormalizeQueryPreference(Boolean(normalizeQueryToggle.checked));
    renderNormalizeQueryNote(Boolean(normalizeQueryToggle.checked), appConfig?.normalization?.defaultEnabled);
  }
  hideExtractPanel();
  renderResults(selected.results || []);
  if (IS_DEBUG_MODE) {
    const normalizationLabel = buildNormalizationLabel({
      query: selected.query,
      normalizedQuery: selected.normalizedQuery || selected.query,
      queryNormalization: selected.queryNormalization || {}
    });
    showResultContext(
      `Loaded saved results from ${formatDate(selected.timestamp)} (no new search run). ${normalizationLabel}`
    );
  } else {
    showResultContext(`Loaded saved results from ${formatDate(selected.timestamp)} (no new search run).`);
  }
  switchTab("search");
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(historyItems));
}

function setLoading(isLoading) {
  loadingIndicator.classList.toggle("hidden", !isLoading);
  searchButton.disabled = isLoading;
}

function showError(message) {
  errorPanel.textContent = message;
  errorPanel.classList.remove("hidden");
}

function hideError() {
  errorPanel.classList.add("hidden");
  errorPanel.textContent = "";
}

function showResultContext(message) {
  resultContext.textContent = message;
  resultContext.classList.remove("hidden");
}

function clearResultContext() {
  resultContext.classList.add("hidden");
  resultContext.textContent = "";
}

function formatDate(isoTimestamp) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp;
  }
  return date.toLocaleString();
}

function formatDuration(ms) {
  const totalMs = Number(ms);
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return "off";
  }

  const totalMinutes = Math.round(totalMs / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.round(totalMinutes / 60);
  return `${hours}h`;
}

function applyNormalizeQueryConfig(config) {
  if (!normalizeQueryToggle) {
    return;
  }

  const defaultEnabled = Boolean(config?.normalization?.defaultEnabled);
  const savedPreference = loadNormalizeQueryPreference();
  const enabled = savedPreference === null ? defaultEnabled : savedPreference;

  normalizeQueryToggle.checked = enabled;
  normalizeQueryToggle.disabled = !config?.configured;
  renderNormalizeQueryNote(enabled, defaultEnabled);
}

function renderNormalizeQueryNote(enabled, defaultEnabled) {
  if (!normalizeQueryNote) {
    return;
  }

  const defaultState = defaultEnabled ? "on" : "off";
  if (enabled) {
    normalizeQueryNote.textContent =
      `On: typo cleanup, state expansion, and indicator alias matching (default: ${defaultState}).`;
    return;
  }

  normalizeQueryNote.textContent = `Off. Default is ${defaultState}.`;
}

function buildNormalizationLabel({ query, normalizedQuery, queryNormalization }) {
  if (!queryNormalization?.enabled) {
    return IS_DEBUG_MODE ? "normalization: off." : "";
  }

  const changed = Boolean(queryNormalization.changed);
  const ruleCount = Number(queryNormalization.appliedRuleCount || 0);
  if (!changed || !normalizedQuery || normalizedQuery === query) {
    return IS_DEBUG_MODE ? "normalization: on." : "Query normalization enabled.";
  }

  return IS_DEBUG_MODE
    ? `normalization: on (${ruleCount} rules). search query used: "${normalizedQuery}".`
    : "Query normalized for better recall.";
}

function loadNormalizeQueryPreference() {
  try {
    const raw = localStorage.getItem(NORMALIZE_QUERY_PREF_KEY);
    if (raw === null) {
      return null;
    }
    return raw === "1";
  } catch {
    return null;
  }
}

function saveNormalizeQueryPreference(enabled) {
  localStorage.setItem(NORMALIZE_QUERY_PREF_KEY, enabled ? "1" : "0");
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "");
}
