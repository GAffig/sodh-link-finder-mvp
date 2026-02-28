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

- [ ] Add team-specific prompts from real analyst workflows to keep evolving the 28-case suite.

### Next

- [x] Phase 2 planning: define optional query normalization rules that do not alter authority ranking.
- [x] Add baseline update protocol for quarterly recalibration of `tests/relevance/baseline-summary.json`.

### Newly Shipped (Latest Cycle)

- [x] Quarterly baseline update script (`scripts/relevance-baseline-update.js`) with dry-run and explicit `--write` mode.
- [x] Baseline recalibration runbook (`docs/BASELINE_UPDATE_PROTOCOL.md`) and checklist linkage.

## Phase 2 - Assisted Search (Future)

- [ ] Optional query normalization and typo correction without changing authority ranking rules.
- [x] Planning spec drafted (`docs/PHASE2_QUERY_NORMALIZATION_PLAN.md`).

## Phase 3 - Intelligence Layer (Long-Term)

- [ ] Citation-aware summarization and CHNA narrative assistance linked to original sources.
