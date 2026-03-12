# Population Health Evidence Portal (MVP)

Minimal two-tab web app that returns ranked **real** web links for secondary-data references.

Tabs/pages included:
- Search
- History

No extra pages or advanced features are included.

## What This MVP Does

- Accepts a query (for example: `Median household income`, `Food insecurity`, `Life expectancy by county`).
- Runs deterministic two-stage search:
  - Stage A: priority-domain restricted query
  - Stage B: unrestricted fallback only if Stage A returns fewer than 8 results
- Ranks results using deterministic rules only:
  - priority-domain bonus
  - keyword overlap in title/snippet
  - query-term match in URL
- Stores search history in browser `localStorage` with:
  - query
  - timestamp
  - returned results (title, url, snippet, domain, priority flag)
- Allows replaying saved results from History without re-running search.
- Adds source-specific **Download data** extraction where supported links are detected.

## Tech Stack

- Backend: Node.js (`http`, native `fetch`)
- Frontend: vanilla HTML/CSS/JavaScript
- Storage: browser `localStorage` for history

## Provider Support and Environment Variables

Provider selection order (automatic):
1. `BRAVE_API_KEY`
2. `SERPAPI_KEY`
3. `BING_API_KEY`

Failover behavior:
- If both `BRAVE_API_KEY` and `SERPAPI_KEY` are set, Brave remains primary.
- The app automatically falls back to SerpApi when Brave returns provider-side failures such as `401`, `402`, `403`, `429`, or `5xx`.

Exact env vars used:
- `BRAVE_API_KEY`
- `SERPAPI_KEY`
- `BING_API_KEY`
- `APP_BASIC_AUTH_USER` (optional HTTP Basic Auth username)
- `APP_BASIC_AUTH_PASS` (optional HTTP Basic Auth password)
- `NORMALIZE_QUERY` (optional default for deterministic query normalization, default `false`)
- `PORT` (optional, default `3000`)
- `SEARCH_COST_MODE` (optional: `economy` or `standard`, default `economy`)
- `SEARCH_MAX_PROVIDER_CALLS` (optional override for per-search provider call limit)
- `SEARCH_STANDARD_MAX_PROVIDER_CALLS` (optional cap when auto-upgrading to `standard`)
- `SEARCH_AUTO_ESCALATE_STANDARD` (optional: `true`/`false`, default `true`)
- `SEARCH_ESCALATE_MIN_RESULTS` (optional weak-result threshold, default `8`)
- `SEARCH_ESCALATE_MIN_PRIORITY_RESULTS` (optional weak-result threshold, default `3`)
- `SEARCH_ESCALATE_MIN_DISTINCT_DOMAINS` (optional weak-result threshold, default `3`)
- `SEARCH_CACHE_BACKEND` (optional: `auto`, `memory`, `redis`; default `auto`)
- `SEARCH_CACHE_REDIS_URL` (optional override URL for Redis/Valkey cache)
- `REDIS_URL` (Render Key Value connection URL; used automatically when present)
- `SEARCH_CACHE_NAMESPACE` (optional key prefix, default `sodh:search-cache:v1`)
- `SEARCH_CACHE_TTL_MS` (optional server cache TTL in ms, default `604800000` = 7 days)
- `SEARCH_CACHE_MAX_ENTRIES` (optional cache size cap, default `200`)
- `SEARCH_RATE_LIMIT_WINDOW_MS` (optional search rate-limit window in ms, default `60000`)
- `SEARCH_RATE_LIMIT_MAX_REQUESTS` (optional max searches per window/IP, default `20`)
- `SEARCH_RATE_LIMIT_BLOCK_MS` (optional temporary block duration in ms, default `300000`)
- `SEARCH_MAX_BODY_BYTES` (optional max request body size, default `8192`)
- `SEARCH_MAX_QUERY_CHARS` (optional max query length, default `180`)
- `EXTRACT_CACHE_TTL_MS` (optional extractor result cache TTL in ms, default `604800000`)
- `EXTRACT_CACHE_MAX_ENTRIES` (optional extractor cache size cap, default `300`)
- `EXTRACT_JOB_TTL_MS` (optional extraction artifact retention in ms, default `172800000`)
- `EXTRACT_LINK_CATALOG_TTL_MS` (optional TDH index catalog cache TTL in ms, default `86400000`)
- `CENSUS_API_KEY` (optional Census API key)
- `CDC_SOCRATA_APP_TOKEN` (optional CDC Socrata app token)

If no key is present, the app runs in **Not Configured** mode and does not perform any search.

## Local Run

1. Ensure Node.js 18+ is installed.
2. Create a `.env` file in the project root.
3. Add at least one provider key.
4. Start the server.
5. Open the app in your browser.

```bash
cp .env.example .env
# edit .env and set one key
npm start
# open http://localhost:3000
```

## Deploy on Render

This repo includes a Render Blueprint file: `render.yaml`.

### Option A: Blueprint (fastest, may require paid Render plan)

1. Push latest `master` to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Connect `GAffig/sodh-link-finder-mvp`.
4. Render will read `render.yaml` and create the web service.
5. In service environment variables, set at least one key:
   - `BRAVE_API_KEY` (preferred), or
   - `SERPAPI_KEY`, or
   - `BING_API_KEY`
   - For automatic failover in production, set both `BRAVE_API_KEY` and `SERPAPI_KEY`.
6. Deploy and open the generated `onrender.com` URL.

### Option B: Manual Web Service

1. In Render, click **New +** -> **Web Service**.
2. Select repository: `GAffig/sodh-link-finder-mvp`.
3. Set:
   - Runtime: `Node`
   - Build Command: `npm install --no-audit --no-fund`
   - Start Command: `npm start`
4. Add environment variable(s):
   - `BRAVE_API_KEY` (preferred)
   - `SERPAPI_KEY` (recommended fallback if Brave quota/billing is exhausted)
   - Optional query assist:
     - `NORMALIZE_QUERY=false` (default; user can toggle in Search tab)
   - Optional extractor API credentials:
     - `CENSUS_API_KEY=<optional>`
     - `CDC_SOCRATA_APP_TOKEN=<optional>`
   - Recommended private access control:
     - `APP_BASIC_AUTH_USER=<team_user>`
     - `APP_BASIC_AUTH_PASS=<strong_password>`
   - Recommended cost controls:
     - `SEARCH_COST_MODE=economy`
     - `SEARCH_MAX_PROVIDER_CALLS=4`
     - `SEARCH_AUTO_ESCALATE_STANDARD=true`
     - `SEARCH_STANDARD_MAX_PROVIDER_CALLS=8`
     - `SEARCH_CACHE_BACKEND=auto`
     - `SEARCH_CACHE_TTL_MS=604800000`
5. Create Web Service and wait for deploy.

After deploy, share the Render URL with teammates.  
If keys are missing, the app still loads but Search shows **Not Configured** setup steps.

## Download Data Extractors (Phase 2)

The app now includes an extractor registry for supported source links. When a result is eligible, the Search tab shows a **Download data** action.

Current extractor modules:

- `cdc_places` (Socrata API)
- `census_acs` (Census Data API)
- `cdc_wonder` (preset-driven execution for `wonder.cdc.gov` links with limited inputs)
- `tdh_death_stats` (download-index extraction plus optional tidy conversion for CSV/XLSX)

Extraction API endpoints:

- `GET /api/extractors/catalog`
- `GET /api/extractors/eligibility?url=<encoded-url>`
- `POST /api/extract/run`
- `GET /api/extract/jobs/{jobId}/data`
- `GET /api/extract/jobs/{jobId}/manifest`

Every extraction run returns a downloadable data file and a reproducibility manifest containing request details and a SHA-256 hash.

CDC WONDER template behavior:

- Uses fixed templates only (no free-form request body knobs in UI).
- Current presets: `mortality_county_v1` and `natality_county_v1`.
- Inputs are intentionally limited to template selection + year for deterministic runs.

TDH extractor modes:

- `catalog` -> returns a structured catalog of downloadable TDH files.
- `tidy` -> downloads matching CSV/XLSX files and converts rows into standardized output columns.

## Relevance Regression Harness

Use the golden-query harness to measure ranking quality on real provider results.

```bash
npm run test:relevance
```

Validate query files only (no provider calls):

```bash
npm run test:relevance:validate
```

Run extended suite with team analyst prompt pack:

```bash
npm run test:relevance:team
```

Run extended suite drift check:

```bash
npm run test:relevance:team:drift
```

Harness defaults to `standard` cost mode for baseline comparability. To run lower-cost checks:

```bash
npm run test:relevance -- --cost-mode economy --max-provider-calls 4
```

Run with deterministic query normalization enabled:

```bash
npm run test:relevance -- --normalize-query true
```

Optional flags:

```bash
node scripts/relevance-check.js --max-queries 5 --top-n 8 --delay-ms 300
```

Normalization unit checks (no provider calls):

```bash
npm run test:normalization
```

Extractor registry unit checks (no provider calls):

```bash
npm run test:extractors
```

Write a benchmark report JSON:

```bash
npm run test:relevance -- --report-file artifacts/relevance-report.json
```

Run drift comparison against baseline:

```bash
npm run test:relevance:drift -- --report-file artifacts/relevance-report.json --baseline-file tests/relevance/baseline-summary.json
```

Preview quarterly baseline refresh (dry-run):

```bash
npm run test:relevance:baseline:update -- --report-file artifacts/relevance-report.json
```

Write updated baseline summary:

```bash
npm run test:relevance:baseline:update -- --report-file artifacts/relevance-report.json --write
```

Golden query definitions:

- `tests/relevance/golden-queries.json`
- `tests/relevance/team-analyst-prompts-v1.json` (team workflow prompts)
- `tests/relevance/baseline-team-summary.json` (extended suite baseline)
- Core suite size: `28` cases
- Extended suite size: `38` cases (core + team v1)

Notes:

- This harness uses live provider API calls (no mock data).
- It consumes request quota and may incur cost depending on your plan.
- It exits non-zero when any golden case fails, so it can be used in CI later.

Operations docs:

- Hosted deployment runbook: `docs/HOSTED_RUNBOOK.md`
- Release relevance checklist: `docs/RELEASE_RELEVANCE_CHECKLIST.md`
- Quarterly baseline protocol: `docs/BASELINE_UPDATE_PROTOCOL.md`
- Analyst prompt pack guide: `docs/ANALYST_PROMPT_PACK.md`
- Phase 2 query normalization plan: `docs/PHASE2_QUERY_NORMALIZATION_PLAN.md`
- Extractor contract/spec: `EXTRACTORS.md`

## CI Quality Gate

GitHub Actions workflow:

- `.github/workflows/quality-gate.yml`
- `.github/workflows/relevance-benchmark.yml`

What it does:

- Runs syntax checks on every push/PR to `master`.
- Runs live relevance harness on push/manual `Quality Gate` when repository secret `BRAVE_API_KEY` is configured.
- Runs monthly benchmark + drift check (`Relevance Benchmark`) and uploads JSON report artifact.

Repository setup for live harness in CI:

1. Open repository settings -> Secrets and variables -> Actions.
2. Add a secret named `BRAVE_API_KEY`.
3. Trigger the workflow manually from Actions tab (`Quality Gate`) or push to `master`.

Roadmap tracking:

- See `ROADMAP.md` for current execution status and next items.

## Setup Search Provider Keys

### Option A: Brave Search API (implemented first)

1. Create or sign in to a Brave Search API account.
2. Create an API subscription/key in the provider dashboard.
3. Copy the key into `.env`:

```env
BRAVE_API_KEY=your_brave_key
```

4. Restart the app.

### Option B: SerpAPI

1. Create a SerpAPI account.
2. Copy your API key from the dashboard.
3. Put it in `.env` alongside `BRAVE_API_KEY` if you want automatic fallback:

```env
SERPAPI_KEY=your_serpapi_key
```

4. Restart the app.

### Option C: Bing Web Search API

1. Create an Azure resource for Bing Web Search.
2. Copy the subscription key.
3. Put it in `.env`:

```env
BING_API_KEY=your_bing_key
```

4. Restart the app.

## Basic Cost / Rate Limit Notes

- Brave, SerpAPI, and Bing pricing/limits depend on your account plan and can change.
- Free/trial tiers are typically available for initial testing.
- Expect strict per-minute or monthly quotas on free tiers.
- For production, verify current quotas/pricing in each provider dashboard before heavy usage.
- This app now includes low-credit controls:
  - `SEARCH_COST_MODE=economy` lowers per-search provider calls.
  - `SEARCH_AUTO_ESCALATE_STANDARD=true` upgrades to `standard` only for weak economy results.
  - `SEARCH_CACHE_TTL_MS` caches repeated queries server-side and avoids repeated provider requests.
  - If `REDIS_URL` is configured (Render Key Value), cache is shared across app restarts/instances.
- Security hardening:
  - Optional HTTP Basic Auth gate for all app/API routes.
  - Per-IP rate limiting on search endpoint.
  - Request body size and query length guards.

## Not Configured Behavior

If no provider key is configured:
- Search requests are blocked.
- The Search tab shows a setup panel with exact configuration steps.
- No mock results are returned.

## Priority Domains Used for Ranking and Stage A Search

- `cdc.gov`
- `data.census.gov`
- `census.gov`
- `countyhealthrankings.org`
- `bls.gov`
- `ers.usda.gov`
- `cms.gov`
- `hhs.gov`
- `acf.hhs.gov`
- `tn.gov`
- `vdh.virginia.gov`
- `irs.gov`
- `nces.ed.gov`
- `transportation.gov`
- `hud.gov`
- `epa.gov`
- `ucr.fbi.gov`
- `feedingamerica.org`
- `opportunityinsights.org`
- `urban.org`
- `sparkmaps.com`
- `droughtmonitor.unl.edu`
- `impactlab.org`
- `cnt.org`
- `hifld-geoplatform.opendata.arcgis.com`
