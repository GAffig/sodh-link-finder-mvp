const HISTORY_KEY = "sodh-link-finder-history-v1";

const tabButtons = document.querySelectorAll(".tab");
const views = {
  search: document.getElementById("view-search"),
  history: document.getElementById("view-history")
};

const queryInput = document.getElementById("query-input");
const searchButton = document.getElementById("search-button");
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
      const message = payload?.error || "Search failed.";
      showError(message);

      if (payload?.code === "NOT_CONFIGURED") {
        renderSetupPanel({ configured: false, setupSteps: payload.setupSteps || [] });
      }
      return;
    }

    renderResults(payload.results);
    showResultContext(`Showing ${payload.results.length} results from ${payload.provider}.`);

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

  for (const result of results) {
    const li = document.createElement("li");
    li.className = "result";

    const badge = result.isPriority ? '<span class="badge">Priority Source</span>' : "";

    li.innerHTML = `
      <a href="${escapeAttribute(result.url)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(result.title)}
      </a>
      ${badge}
      <div class="url">${escapeHtml(result.domain || result.url)}</div>
      <p class="snippet">${escapeHtml(result.snippet || "")}</p>
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
      <td><button type="button" data-id="${escapeAttribute(item.id)}">Open</button></td>
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
