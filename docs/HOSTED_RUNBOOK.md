# Hosted Deployment Runbook

## Purpose

Operational runbook for hosting the Population Health Evidence Portal for team use.

## Runtime Requirements

- Node.js 20+
- Outbound network access to search provider API endpoints
- Environment variables configured on host

## Required Environment Variables

At least one provider key is required:

- `BRAVE_API_KEY` (preferred)
- `SERPAPI_KEY` (fallback)
- `BING_API_KEY` (fallback)

Optional:

- `PORT` (defaults to `3000`)
- `SEARCH_COST_MODE` (`economy` default, or `standard`)
- `SEARCH_MAX_PROVIDER_CALLS` (override per-search call cap)
- `SEARCH_STANDARD_MAX_PROVIDER_CALLS` (override cap for auto-upgraded `standard` reruns)
- `SEARCH_AUTO_ESCALATE_STANDARD` (auto-upgrade weak economy results, default `true`)
- `SEARCH_ESCALATE_MIN_RESULTS` (weak-result threshold, default `8`)
- `SEARCH_ESCALATE_MIN_PRIORITY_RESULTS` (weak-result threshold, default `3`)
- `SEARCH_ESCALATE_MIN_DISTINCT_DOMAINS` (weak-result threshold, default `3`)
- `SEARCH_CACHE_BACKEND` (`auto` default, `memory`, or `redis`)
- `SEARCH_CACHE_REDIS_URL` (optional override URL for Redis/Valkey cache)
- `REDIS_URL` (Render Key Value URL; used automatically when present)
- `SEARCH_CACHE_NAMESPACE` (optional key prefix for shared cache)
- `SEARCH_CACHE_TTL_MS` (server cache TTL in milliseconds)
- `SEARCH_CACHE_MAX_ENTRIES` (server cache size cap)

## Deployment Steps

1. Deploy from `master` branch.
2. Install dependencies:
   - `npm install --no-audit --no-fund`
3. Configure environment secrets in host platform.
   - Recommended for cost control:
     - `SEARCH_COST_MODE=economy`
     - `SEARCH_MAX_PROVIDER_CALLS=4`
     - `SEARCH_AUTO_ESCALATE_STANDARD=true`
     - `SEARCH_STANDARD_MAX_PROVIDER_CALLS=8`
     - `SEARCH_CACHE_BACKEND=auto`
     - `SEARCH_CACHE_TTL_MS=604800000`
4. Start command:
   - `npm start`
5. Verify health manually:
   - Open app URL
   - Confirm Search tab loads
   - Run one known query (`Median household income by county Tennessee`)

## Post-Deploy Validation

Run from deployment shell (or staging environment with same env vars):

```bash
npm run test:syntax
npm run test:relevance -- --max-queries 5 --delay-ms 250
```

If either command fails, treat deployment as unhealthy.

## Quarterly Recalibration

Use `docs/BASELINE_UPDATE_PROTOCOL.md` to refresh drift baseline after approved quarterly review.

## Secret Rotation

1. Generate a new provider key in provider dashboard.
2. Update host secret (`BRAVE_API_KEY`) with new value.
3. Restart service.
4. Run one query in UI and one harness smoke test:

```bash
npm run test:relevance -- --max-queries 1 --delay-ms 0
```

## Incident Triage

### Symptom: cache resets after deploy/restart

- Expected with in-memory cache only.
- Attach a Render Key Value instance and ensure `REDIS_URL` is present.
- Keep `SEARCH_CACHE_BACKEND=auto` (or set `redis`) for shared cache behavior.

### Symptom: "Search provider not configured"

- Verify env key exists on host and service was restarted after change.

### Symptom: provider HTTP 401/403

- Verify key validity and account entitlements.
- Rotate key and redeploy.

### Symptom: provider HTTP 429

- Rate limit exceeded.
- Reduce traffic, add retry delay operationally, or upgrade provider plan.

### Symptom: unrelated results dominate top links

- Run full relevance harness.
- Identify failed cases and tune deterministic rules in `src/search/ranker.js`.
- Re-run harness before redeploy.

## Rollback

1. Re-deploy previous known-good commit from Git history.
2. Re-run smoke checks:

```bash
npm run test:syntax
npm run test:relevance -- --max-queries 3 --delay-ms 250
```

3. Confirm UI search and history behavior manually.
