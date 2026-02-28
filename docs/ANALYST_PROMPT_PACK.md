# Analyst Prompt Pack

This document defines how team workflow prompts are captured and exercised in relevance checks.

## Files

- Core suite: `tests/relevance/golden-queries.json` (release gate)
- Core baseline: `tests/relevance/baseline-summary.json`
- Team pack v1: `tests/relevance/team-analyst-prompts-v1.json` (workflow expansion)
- Extended baseline: `tests/relevance/baseline-team-summary.json`

## Run Modes

- Validate file structure only:

```bash
npm run test:relevance:validate
```

- Core suite live run:

```bash
npm run test:relevance
```

- Extended suite live run (core + team):

```bash
npm run test:relevance:team
```

- Extended suite drift check:

```bash
npm run test:relevance:team:drift
```

## Add New Team Prompts

1. Add case objects to `tests/relevance/team-analyst-prompts-v1.json`.
2. Keep case names unique across both files.
3. Run `npm run test:relevance:validate`.
4. Run `npm run test:relevance:team` when provider credits are available.
5. Generate/update `artifacts/relevance-report-team.json` and run `npm run test:relevance:team:drift`.
6. Promote stable prompts to core suite only after repeated passes.
