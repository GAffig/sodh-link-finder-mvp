import { createHash } from "crypto";

export function rowsToCsvBuffer(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const columns = collectColumns(safeRows);
  const lines = [columns.map(escapeCsvCell).join(",")];

  for (const row of safeRows) {
    lines.push(columns.map((column) => escapeCsvCell(row?.[column])).join(","));
  }

  return Buffer.from(lines.join("\n"), "utf8");
}

export function collectColumns(rows) {
  const columns = [];
  const seen = new Set();

  for (const row of rows) {
    const entries = Object.keys(row || {});
    for (const key of entries) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      columns.push(key);
    }
  }

  return columns;
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

export function parseYear(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const year = Math.floor(parsed);
  if (year < 1900 || year > 2100) {
    return null;
  }
  return year;
}

export function normalizeOutputFormat(value) {
  const normalized = normalizeText(value);
  if (normalized === "xlsx") {
    return "xlsx";
  }
  return "csv";
}

export function toRecordKey(value) {
  const normalized = normalizeText(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "unknown";
}

export function buildQueryString(params) {
  const urlParams = new URLSearchParams();
  const entries = Object.entries(params || {});
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    urlParams.set(key, String(value));
  }
  return urlParams.toString();
}

export function resolveHost(candidateUrl) {
  try {
    return new URL(candidateUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function hostMatches(hostname, expectedHost) {
  return hostname === expectedHost || hostname.endsWith(`.${expectedHost}`);
}

export function asAbsoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

export function parseCsvRecords(csvText) {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) {
    return [];
  }

  const header = rows[0].map((value) => String(value || "").trim());
  const records = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.length === 0) {
      continue;
    }

    const record = {};
    for (let columnIndex = 0; columnIndex < header.length; columnIndex += 1) {
      const key = header[columnIndex] || `column_${columnIndex + 1}`;
      record[key] = row[columnIndex] ?? "";
    }
    records.push(record);
  }

  return records;
}

export function parseCsvRows(csvText) {
  const text = String(csvText || "");
  if (!text) {
    return [];
  }

  const rows = [];
  let currentRow = [];
  let currentCell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        currentCell += "\"";
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === ",") {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      currentRow.push(currentCell);
      currentCell = "";
      if (currentRow.some((cell) => String(cell).trim() !== "")) {
        rows.push(currentRow);
      }
      currentRow = [];
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    if (currentRow.some((cell) => String(cell).trim() !== "")) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function escapeCsvCell(value) {
  if (value === undefined || value === null) {
    return "";
  }

  const text = String(value);
  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, "\"\"")}"`;
}
