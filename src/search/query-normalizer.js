import { TOKEN_EXPANSIONS } from "./normalization/abbreviations.js";
import { INDICATOR_ALIAS_RULES } from "./normalization/indicator-aliases.js";
import { TYPO_CORRECTIONS } from "./normalization/typos.js";

export const QUERY_NORMALIZATION_VERSION = "2026-03-02-v1";
const MAX_NORMALIZED_TERMS = 24;

export function resolveQueryNormalizationDefault(env = process.env) {
  return parseBooleanLike(env?.NORMALIZE_QUERY, false);
}

export function resolveQueryNormalizationPreference(requestValue, fallbackValue) {
  if (typeof requestValue === "boolean") {
    return requestValue;
  }
  return parseBooleanLike(requestValue, Boolean(fallbackValue));
}

export function normalizeSearchQuery(rawQuery, options = {}) {
  const originalQuery = String(rawQuery || "").trim();
  const enabled = Boolean(options.enabled);
  const normalization = {
    version: QUERY_NORMALIZATION_VERSION,
    enabled,
    changed: false,
    originalQuery,
    normalizedQuery: originalQuery,
    appliedRuleCount: 0,
    appliedRuleTypes: []
  };

  if (!enabled || !originalQuery) {
    return normalization;
  }

  const typoCorrections = [];
  const correctedTokens = tokenize(rawQuery).map((token) => {
    const replacement = TYPO_CORRECTIONS[token] || token;
    if (replacement !== token) {
      typoCorrections.push({
        type: "typo",
        from: token,
        to: replacement
      });
    }
    return replacement;
  });

  const orderedTerms = [];
  const seenTerms = new Set();
  const appliedExpansions = [];

  for (const token of correctedTokens) {
    addTerm(orderedTerms, seenTerms, token);
  }

  const seedTerms = [...orderedTerms];
  for (const token of seedTerms) {
    const expansions = TOKEN_EXPANSIONS[token] || [];
    for (const expansion of expansions) {
      const expansionTokens = tokenize(expansion);
      const beforeSize = seenTerms.size;
      for (const expansionToken of expansionTokens) {
        addTerm(orderedTerms, seenTerms, expansionToken);
      }
      if (seenTerms.size > beforeSize) {
        appliedExpansions.push({
          type: "abbreviation",
          from: token,
          to: expansion
        });
      }
    }
  }

  const correctedPhrase = correctedTokens.join(" ");
  for (const rule of INDICATOR_ALIAS_RULES) {
    if (!isIndicatorRuleTriggered(correctedPhrase, rule.triggerPhrases)) {
      continue;
    }

    for (const expansion of rule.expansionPhrases) {
      const expansionTokens = tokenize(expansion);
      const beforeSize = seenTerms.size;
      for (const expansionToken of expansionTokens) {
        addTerm(orderedTerms, seenTerms, expansionToken);
      }
      if (seenTerms.size > beforeSize) {
        appliedExpansions.push({
          type: "indicator_alias",
          from: rule.id,
          to: expansion
        });
      }
    }
  }

  const normalizedTerms = orderedTerms.slice(0, MAX_NORMALIZED_TERMS);
  const normalizedQuery = normalizedTerms.join(" ").trim() || originalQuery;
  const canonicalOriginal = originalQuery.toLowerCase().replace(/\s+/g, " ").trim();

  const appliedRules = [...typoCorrections, ...appliedExpansions];
  normalization.normalizedQuery = normalizedQuery;
  normalization.changed = normalizedQuery !== canonicalOriginal;
  normalization.appliedRuleCount = appliedRules.length;
  normalization.appliedRuleTypes = [...new Set(appliedRules.map((item) => item.type))];

  return normalization;
}

function tokenize(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized.match(/[a-z0-9]+/g) || [];
}

function addTerm(target, seen, value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return;
  }

  if (seen.has(normalized)) {
    return;
  }

  seen.add(normalized);
  target.push(normalized);
}

function isIndicatorRuleTriggered(queryPhrase, triggerPhrases) {
  const normalized = ` ${String(queryPhrase || "").toLowerCase()} `;
  return triggerPhrases.some((phrase) => {
    const escaped = escapeRegExp(phrase.toLowerCase());
    const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`);
    return pattern.test(normalized);
  });
}

function parseBooleanLike(candidate, fallback) {
  const normalized = String(candidate || "").trim().toLowerCase();
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
