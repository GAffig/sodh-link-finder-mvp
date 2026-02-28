# Roadmap

## Phase 1 - Retrieval (Current)

Goal: reliable access to trusted secondary data sources with deterministic ranking.

### Completed

- [x] Minimal MVP with only `Search` + `History` tabs.
- [x] Real provider integration with env-based selection (`BRAVE_API_KEY`, `SERPAPI_KEY`, `BING_API_KEY`).
- [x] Priority-domain Stage A + unrestricted Stage B fallback.
- [x] Deterministic ranking and priority-source badge rendering.
- [x] Local search history persistence and replay.
- [x] Relevance harness with golden queries (`tests/relevance/golden-queries.json`).
- [x] Topic-aware ranking hardening for chronic absenteeism, incarceration, drought, and opportunity atlas queries.
- [x] Automated CI quality gate for syntax checks and live relevance harness (when `BRAVE_API_KEY` secret is set).

### In Progress

- [ ] Expand golden query set with team-provided real research prompts (target: 25+ cases).

### Next

- [ ] Add deployment runbook for hosted team usage (env setup, secret rotation, incident triage).
- [ ] Add manual "relevance review checklist" for release approvals before production pushes.

## Phase 2 - Assisted Search (Future)

- [ ] Optional query normalization and typo correction without changing authority ranking rules.

## Phase 3 - Intelligence Layer (Long-Term)

- [ ] Citation-aware summarization and CHNA narrative assistance linked to original sources.
