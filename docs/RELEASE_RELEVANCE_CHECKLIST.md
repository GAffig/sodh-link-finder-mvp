# Release Relevance Checklist

Use this checklist before production release.

## Pre-Release Gate

- [ ] `npm run test:syntax` passes.
- [ ] `npm run test:relevance` passes.
- [ ] No regression in chronic absenteeism query (`TN` + `VA`).
- [ ] No regression in incarceration query.
- [ ] No regression in drought monitor query.
- [ ] No regression in opportunity atlas query.

## Manual Spot Checks

Run these in UI and confirm top results are source-appropriate:

- [ ] `Median household income by county Tennessee`
- [ ] `Uninsured rate by county Tennessee Virginia`
- [ ] `Chronic absent rate for both TN and VA counties`
- [ ] `Drought monitor Tennessee counties`
- [ ] `Income mobility by county opportunity atlas`

## Data-First Relevance Rules to Confirm

- [ ] Priority-source links appear before generic web results.
- [ ] Results include downloadable/table/map-oriented links for relevant topics.
- [ ] Non-relevant Census map/profile links do not dominate topic-specific queries.
- [ ] Top 8 results include at least 3 distinct domains for broad indicators.

## Release Decision

- [ ] If all checks pass -> approve release.
- [ ] If any check fails -> block release and tune ranking rules.
