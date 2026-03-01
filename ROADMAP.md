# Roadmap

## Phase 1 - Retrieval (Current)

Goal: reliable access to trusted secondary data sources with deterministic ranking.

Status: COMPLETE

### Completed

- [x] Minimal MVP with only `Search` + `History` tabs.
- [x] Real provider integration with env-based selection (`BRAVE_API_KEY`, `SERPAPI_KEY`, `BING_API_KEY`).
- [x] Priority-domain Stage A + unrestricted Stage B fallback.
- [x] Deterministic ranking and priority-source badge rendering.
- [x] Local search history persistence and replay.
- [x] Relevance harness with expanded golden queries (`tests/relevance/golden-queries.json`, 28 cases).
- [x] Topic-aware ranking hardening for chronic absenteeism, incarceration, drought, and opportunity atlas queries.
- [x] Automated CI quality gate for syntax checks and live relevance harness (when `BRAVE_API_KEY` secret is set).
- [x] Hosted deployment runbook for team usage (`docs/HOSTED_RUNBOOK.md`).
- [x] Manual release relevance checklist (`docs/RELEASE_RELEVANCE_CHECKLIST.md`).
- [x] Full live harness validation at 28/28 passing.
- [x] Monthly relevance benchmark workflow with drift report and artifact output.

### In Progress

- [x] Add team-specific prompts from real analyst workflows to keep evolving the 28-case suite.

### Next

- [x] Phase 2 planning: define optional query normalization rules that do not alter authority ranking.
- [x] Add baseline update protocol for quarterly recalibration of `tests/relevance/baseline-summary.json`.
- [x] Run and baseline the extended team prompt suite (`tests/relevance/team-analyst-prompts-v1.json`) after provider quota reset.

### Newly Shipped (Latest Cycle)

- [x] Low-credit search controls with deterministic call budgets (`SEARCH_COST_MODE`, `SEARCH_MAX_PROVIDER_CALLS`).
- [x] Automatic weak-result upgrade from `economy` to `standard` with configurable thresholds.
- [x] Server-side response cache for repeated queries (`SEARCH_CACHE_TTL_MS`, `SEARCH_CACHE_MAX_ENTRIES`).
- [x] Search UI visibility for efficiency mode and per-search provider call usage metadata.
- [x] Extended relevance suite baseline established (`tests/relevance/baseline-team-summary.json`) at 38/38 passing.
- [x] Security hardening: optional Basic Auth, per-IP search rate limits, input-size guards, and stricter response headers.

## Phase 2 - Assisted Search (Future)

- [ ] Optional query normalization and typo correction without changing authority ranking rules.
- [x] Planning spec drafted (`docs/PHASE2_QUERY_NORMALIZATION_PLAN.md`).

## Phase 3 - Intelligence Layer (Long-Term)

- [ ] Citation-aware summarization and CHNA narrative assistance linked to original sources.
