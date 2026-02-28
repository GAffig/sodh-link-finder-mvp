# Quarterly Baseline Update Protocol

Use this protocol to refresh `tests/relevance/baseline-summary.json` without weakening drift protection.

## Why This Exists

- Relevance performance can shift over time due to provider index changes.
- The drift gate should compare against a recent, vetted baseline.
- Updates must be deliberate and reviewable.

## Prerequisites

- Production/staging key configured (`BRAVE_API_KEY` preferred).
- Local repository is clean.
- Current golden suite passes.

## Quarterly Procedure

1. Generate a fresh report from the full golden suite:

```bash
npm run test:relevance -- --delay-ms 200 --report-file artifacts/relevance-report.json
```

2. Verify no regression before updating baseline:

```bash
npm run test:relevance:drift -- --report-file artifacts/relevance-report.json --baseline-file tests/relevance/baseline-summary.json
```

3. Review baseline candidate in dry-run mode:

```bash
npm run test:relevance:baseline:update -- --report-file artifacts/relevance-report.json
```

4. If results are acceptable, write the new baseline file:

```bash
npm run test:relevance:baseline:update -- --report-file artifacts/relevance-report.json --write
```

5. Re-run drift check against the newly written baseline:

```bash
npm run test:relevance:drift -- --report-file artifacts/relevance-report.json --baseline-file tests/relevance/baseline-summary.json
```

6. Commit both files in one PR/commit:
   - `artifacts/relevance-report.json` (optional to include in commit history; include in PR artifact at minimum)
   - `tests/relevance/baseline-summary.json`

## Guardrails

- Do not update baseline when critical workflow queries are failing.
- Keep or explicitly set `criticalCases`; avoid clearing this list casually.
- Keep tolerances conservative:
  - `maxFailIncrease`
  - `maxPassRateDrop`

## Optional Overrides

- Pin critical cases manually:

```bash
npm run test:relevance:baseline:update -- --report-file artifacts/relevance-report.json --critical-cases "Chronic absenteeism (TN + VA),Drought monitor" --write
```

- Tune tolerances (only with reviewer approval):

```bash
npm run test:relevance:baseline:update -- --report-file artifacts/relevance-report.json --max-fail-increase 3 --max-pass-rate-drop 0.15 --write
```
