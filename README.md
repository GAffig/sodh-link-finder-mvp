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

## Tech Stack

- Backend: Node.js (`http`, native `fetch`)
- Frontend: vanilla HTML/CSS/JavaScript
- Storage: browser `localStorage` for history

## Provider Support and Environment Variables

Provider selection order (automatic):
1. `BRAVE_API_KEY`
2. `SERPAPI_KEY`
3. `BING_API_KEY`

Exact env vars used:
- `BRAVE_API_KEY`
- `SERPAPI_KEY`
- `BING_API_KEY`
- `PORT` (optional, default `3000`)

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

### Option A: Blueprint (fastest)

1. Push latest `master` to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Connect `GAffig/sodh-link-finder-mvp`.
4. Render will read `render.yaml` and create the web service.
5. In service environment variables, set at least one key:
   - `BRAVE_API_KEY` (preferred), or
   - `SERPAPI_KEY`, or
   - `BING_API_KEY`
6. Deploy and open the generated `onrender.com` URL.

### Option B: Manual Web Service

1. In Render, click **New +** -> **Web Service**.
2. Select repository: `GAffig/sodh-link-finder-mvp`.
3. Set:
   - Runtime: `Node`
   - Build Command: `npm install --no-audit --no-fund`
   - Start Command: `npm start`
4. Add environment variable(s):
   - `BRAVE_API_KEY` (preferred), or fallback keys above
5. Create Web Service and wait for deploy.

After deploy, share the Render URL with teammates.  
If keys are missing, the app still loads but Search shows **Not Configured** setup steps.

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

Optional flags:

```bash
node scripts/relevance-check.js --max-queries 5 --top-n 8 --delay-ms 300
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
3. Put it in `.env`:

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
