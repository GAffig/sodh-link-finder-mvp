# Phase 2 Plan: Optional Query Normalization

## Objective

Improve query quality for analysts while preserving deterministic authority ranking and source transparency.

## Guardrails

- Query normalization is optional and can be toggled on/off per request.
- Normalization must never override priority-source ranking rules.
- No semantic embeddings, no vector search, no LLM-generated ranking decisions.
- Original user query must remain visible for traceability.

## Scope

Planned normalization types:

1. Spelling cleanup for common typos.
2. Abbreviation expansion for known SoDH terms.
3. State abbreviation normalization (`TN` <-> `Tennessee`, `VA` <-> `Virginia`).
4. Indicator alias mapping (for example `uninsured` <-> `health insurance coverage`).

Out of scope:

- AI summarization or interpretation.
- Semantic intent rewriting that changes indicator meaning.
- Any rule that suppresses explicit user terms.

## Deterministic Processing Order

1. Capture original query.
2. Apply exact-token typo corrections from curated dictionary.
3. Apply deterministic abbreviation/alias expansions.
4. Build a normalized query string for provider search.
5. Store both original and normalized query in history metadata.
6. Keep existing ranking function unchanged except term-matching inputs.

## Data Structures (Planned)

- `NORMALIZATION_RULES` static object in source control.
- Versioned dictionaries under `src/search/normalization/`:
  - `typos.json`
  - `abbreviations.json`
  - `indicator_aliases.json`

All rules reviewed in pull requests.

## Acceptance Criteria

- Normalization is disabled by default until explicitly enabled.
- With normalization enabled, golden-query pass rate does not drop.
- Critical cases remain passing:
  - Chronic absenteeism (TN + VA)
  - Incarceration rate
  - Drought monitor
  - Opportunity Atlas
- History replay still opens saved results without re-running search.

## Rollout Plan

1. Implement normalization module with unit tests only (no UI change).
2. Add optional backend flag (`NORMALIZE_QUERY=true/false`).
3. Re-run full relevance harness and compare drift report.
4. If stable, expose small toggle in Search tab (not a new page).

## Risk Controls

- Keep a strict allowlist of substitutions.
- Log original/normalized query pair for QA in non-production only.
- Block release if relevance drift regression is detected.
