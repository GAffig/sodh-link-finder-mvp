import { hostMatches, normalizeText, parseCsvRecords, resolveHost } from "./helpers.js";

const WONDER_TERMS_URL = "https://wonder.cdc.gov/";

const WONDER_TEMPLATES = Object.freeze({
  mortality_county_v1: Object.freeze({
    id: "mortality_county_v1",
    label: "Mortality by County",
    module: "Underlying Cause of Death",
    requestEndpoint: "https://wonder.cdc.gov/controller/datarequest",
    requestMethod: "POST",
    requestEncoding: "form",
    // User can override these keys in parameters.requestBody.
    defaultRequestBody: Object.freeze({
      stage: "request",
      M_1: "D76.V1-level1",
      "F_D76.V9": "*All*",
      "F_D76.V27": "*All*",
      "I_D76.V1": "*All*"
    }),
    supportedGeographyTypes: Object.freeze(["county", "state"]),
    supportedOutputFormats: Object.freeze(["csv"])
  })
});

export const cdcWonderExtractor = Object.freeze({
  id: "cdc_wonder",
  label: "CDC WONDER (Template)",
  method: "api_template",
  description: "Template-driven CDC WONDER extraction with reproducible query definitions.",
  supportedDomains: Object.freeze(["wonder.cdc.gov", "cdc.gov"]),
  supportedOutputFormats: Object.freeze(["csv"]),
  defaultParameters: Object.freeze({
    templateId: "mortality_county_v1"
  }),
  eligibility(result) {
    const host = resolveHost(result?.url);
    if (!host) {
      return null;
    }

    if (!hostMatches(host, "wonder.cdc.gov") && !hostMatches(host, "cdc.gov")) {
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
  async extract({ url, parameters, fetchImpl }) {
    const templateId = String(parameters?.templateId || "mortality_county_v1").trim();
    const template = WONDER_TEMPLATES[templateId];
    if (!template) {
      throw createExtractorError(
        `Unknown CDC WONDER template "${templateId}". Supported templates: ${Object.keys(WONDER_TEMPLATES).join(", ")}.`,
        400
      );
    }

    const requestBody = buildRequestBody(template, parameters);
    if (Object.keys(requestBody).length === 0) {
      throw createExtractorError(
        `Template "${templateId}" has no request body. Provide parameters.requestBody for the WONDER module request.`,
        400
      );
    }

    const requestPayload = new URLSearchParams();
    for (const [key, value] of Object.entries(requestBody)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      requestPayload.set(key, String(value));
    }

    const response = await fetchImpl(template.requestEndpoint, {
      method: template.requestMethod,
      headers: {
        Accept: "text/csv, text/plain, text/html",
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
      },
      body: requestPayload.toString()
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw createExtractorError(
        `CDC WONDER template request returned HTTP ${response.status}.`,
        502,
        {
          templateId,
          module: template.module,
          endpoint: template.requestEndpoint,
          responseSnippet: rawText.slice(0, 400)
        }
      );
    }

    const csvRecords = parseCsvRecords(rawText);
    if (csvRecords.length === 0) {
      throw createExtractorError(
        "CDC WONDER response did not return CSV rows. Verify template/request body for this module.",
        422,
        {
          templateId,
          module: template.module,
          endpoint: template.requestEndpoint,
          responseSnippet: rawText.slice(0, 400)
        }
      );
    }

    const standardizedRows = csvRecords.map((row) => normalizeWonderRow({
      row,
      templateId,
      templateLabel: template.label,
      parameters
    }));

    return {
      source: this.id,
      sourceUrl: url,
      method: this.method,
      parameters: {
        templateId,
        yearStart: normalizeYear(parameters?.yearStart || parameters?.year || null),
        yearEnd: normalizeYear(parameters?.yearEnd || parameters?.year || null),
        state: String(parameters?.state || "").trim() || null,
        geographyType: String(parameters?.geographyType || "county").trim(),
        requestBody
      },
      requestDetails: {
        endpoint: template.requestEndpoint,
        queryString: "",
        templateId,
        templateModule: template.module
      },
      licenseOrTermsUrl: WONDER_TERMS_URL,
      rows: standardizedRows
    };
  }
});

function buildRequestBody(template, parameters) {
  const base = {
    ...template.defaultRequestBody
  };

  const providedBody = parseRequestBody(parameters?.requestBody, parameters?.requestBodyJson);
  const merged = {
    ...base,
    ...providedBody
  };

  const yearStart = normalizeYear(parameters?.yearStart || parameters?.year || "");
  const yearEnd = normalizeYear(parameters?.yearEnd || parameters?.year || "");
  const state = String(parameters?.state || "").trim();
  const geographyType = String(parameters?.geographyType || "county").trim();

  if (yearStart) {
    merged.year_start = yearStart;
  }
  if (yearEnd) {
    merged.year_end = yearEnd;
  }
  if (state) {
    merged.state = state;
  }
  if (geographyType) {
    merged.geography_type = geographyType;
  }

  return merged;
}

function parseRequestBody(requestBody, requestBodyJson) {
  if (requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)) {
    return sanitizeRecord(requestBody);
  }

  const rawJson = String(requestBodyJson || "").trim();
  if (!rawJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return sanitizeRecord(parsed);
  } catch {
    return {};
  }
}

function sanitizeRecord(record) {
  const output = {};
  for (const [key, value] of Object.entries(record || {})) {
    const safeKey = String(key || "").trim();
    if (!safeKey) {
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    output[safeKey] = String(value);
  }
  return output;
}

function normalizeWonderRow({ row, templateId, templateLabel, parameters }) {
  const geographyType = String(parameters?.geographyType || "county").trim();
  const measureName = String(parameters?.measure || templateLabel || "CDC WONDER").trim();
  const measureId = String(parameters?.measureId || templateId || "cdc_wonder").trim();

  const value = toNumber(firstPresentValue(row, [
    "Deaths",
    "deaths",
    "Count",
    "count",
    "Crude Rate",
    "crude rate",
    "Age-adjusted Rate",
    "age-adjusted rate",
    "Value",
    "value"
  ]));

  return {
    source: "cdc_wonder",
    vintage_year: toYear(firstPresentValue(row, ["Year", "year"])),
    data_year: toYear(firstPresentValue(row, ["Year", "year"])),
    geography_type: geographyType,
    geography_name: firstPresentValue(row, [
      "County",
      "county",
      "County Name",
      "county_name",
      "Residence County",
      "State",
      "state"
    ]),
    state_fips: firstPresentValue(row, ["State Code", "state_code", "State FIPS", "state_fips"]),
    county_fips: firstPresentValue(row, ["County Code", "county_code", "County FIPS", "county_fips"]),
    measure_name: measureName || null,
    measure_id: measureId || null,
    value,
    unit: firstPresentValue(row, ["Unit", "unit"]),
    lower_ci: toNumber(firstPresentValue(row, ["Lower CI", "lower_ci", "Lower 95% CI"])),
    upper_ci: toNumber(firstPresentValue(row, ["Upper CI", "upper_ci", "Upper 95% CI"])),
    notes: summarizeRow(row)
  };
}

function summarizeRow(row) {
  const entries = Object.entries(row || {});
  const trimmed = entries.slice(0, 8).map(([key, value]) => `${key}=${String(value).slice(0, 80)}`);
  return trimmed.join("; ");
}

function firstPresentValue(row, keys) {
  for (const key of keys) {
    const direct = row?.[key];
    if (direct !== undefined && direct !== null && String(direct).trim() !== "") {
      return String(direct).trim();
    }
  }

  for (const [key, value] of Object.entries(row || {})) {
    if (value === undefined || value === null || String(value).trim() === "") {
      continue;
    }
    const normalizedKey = normalizeText(key);
    const matched = keys.some((candidate) => normalizeText(candidate) === normalizedKey);
    if (matched) {
      return String(value).trim();
    }
  }

  return null;
}

function toYear(value) {
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

function normalizeYear(value) {
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

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const cleaned = String(value).replace(/,/g, "").trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function createExtractorError(message, statusCode = 500, details = null) {
  const error = new Error(message);
  error.name = "ExtractorError";
  error.statusCode = statusCode;
  error.details = details;
  return error;
}
