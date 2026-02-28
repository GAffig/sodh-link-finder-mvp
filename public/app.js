const HISTORY_KEY = "sodh-link-finder-history-v1";

const tabButtons = document.querySelectorAll(".tab");
const views = {
  search: document.getElementById("view-search"),
  history: document.getElementById("view-history")
};

const queryInput = document.getElementById("query-input");
const searchButton = document.getElementById("search-button");
const searchConfigNote = document.getElementById("search-config-note");
const loadingIndicator = document.getElementById("loading-indicator");
const errorPanel = document.getElementById("error-panel");
const setupPanel = document.getElementById("setup-panel");
const resultContext = document.getElementById("result-context");
const resultsList = document.getElementById("results-list");

const historyEmpty = document.getElementById("history-empty");
const historyTable = document.getElementById("history-table");
const historyBody = document.getElementById("history-body");
const clearHistoryButton = document.getElementById("clear-history");

let appConfig = null;
let historyItems = loadHistory();

initialize();

async function initialize() {
  bindEvents();
  renderHistory();
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

  clearHistoryButton.addEventListener("click", () => {
    historyItems = [];
    saveHistory();
    renderHistory();
    clearResultContext();
  });
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
  } catch (error) {
    appConfig = { configured: false };
    showError(`Failed to load app configuration: ${String(error)}`);
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

  const cost = config?.searchCost || {};
  const cache = config?.cache || {};
  const mode = String(cost.mode || "economy");
  const limit = Number(cost.providerRequestLimit || 0);
  const cacheEnabled = Boolean(cache.enabled);
  const cacheTtl = Number(cache.ttlMs || 0);

  if (!config?.configured) {
    searchConfigNote.textContent = "Search disabled until provider key is configured.";
    return;
  }

  const limitText = Number.isFinite(limit) && limit > 0 ? String(limit) : "n/a";
  const cacheText = cacheEnabled ? formatDuration(cacheTtl) : "off";
  searchConfigNote.textContent = `Efficiency mode: ${mode}. Provider call cap/search: ${limitText}. Server cache TTL: ${cacheText}.`;
}

async function runSearch() {
  hideError();
  clearResultContext();

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
    const response = await fetch("/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });

    const payload = await response.json();

    if (!response.ok) {
      let message = payload?.error || "Search failed.";
      if (payload?.providerStatusCode) {
        message += ` (provider HTTP ${payload.providerStatusCode})`;
      }
      if (payload?.details) {
        message += ` Details: ${String(payload.details).slice(0, 220)}`;
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
    const contextParts = [
      `Showing ${payload.results.length} ranked links from ${providerName}.`,
      metadata.costMode ? `mode: ${metadata.costMode}.` : null,
      `${callLabel}.`
    ].filter(Boolean);
    showResultContext(contextParts.join(" "));

    const historyRecord = {
      id: makeId(),
      query: payload.query,
      timestamp: payload.timestamp,
      provider: payload.provider,
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

  if (!Array.isArray(results) || results.length === 0) {
    const item = document.createElement("li");
    item.className = "panel";
    item.textContent = "No results returned.";
    resultsList.appendChild(item);
    return;
  }

  for (const [index, result] of results.entries()) {
    const li = document.createElement("li");
    li.className = "result";

    const priorityBadge = result.isPriority ? '<span class="meta-pill priority">Priority Source</span>' : "";
    const displayDomain = escapeHtml(result.domain || result.url);
    const openUrl = escapeAttribute(result.url);

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
      <a class="open-link" href="${openUrl}" target="_blank" rel="noopener noreferrer">Open source</a>
    `;

    resultsList.appendChild(li);
  }
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
  renderResults(selected.results || []);
  showResultContext(`Loaded saved results from ${formatDate(selected.timestamp)} (no new search run).`);
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
