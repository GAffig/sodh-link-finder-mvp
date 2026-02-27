# AGENTS.md

## Project Purpose

This application is a lightweight Population Health / Social Determinants of Health (SoDH) search tool designed to improve access to trusted secondary data sources used in Community Health Needs Assessments (CHNAs) and population health analysis.

The system prioritizes accessibility, reliability, and transparency over automation or intelligence.

## Core Principles

### Simplicity First

Only essential features are allowed.

Avoid dashboards, analytics layers, or complex workflows unless explicitly approved.

### Deterministic Results

Search ranking must be explainable.

Priority domains and keyword matching drive results.

### Source Authority Over AI Interpretation

The app surfaces trusted sources.

It does not interpret or summarize data in the MVP phase.

### Healthcare Workflow Alignment

Results must be citable.

Analysts must easily trace original sources.

## MVP Scope (Phase 1)

Allowed features:

- Search page
- History page
- Priority-source ranking
- Real search provider integration

Not allowed:

- AI summarization
- embeddings/vector DB
- semantic search
- recommendation engines
- dashboards

## Development Roadmap

### Phase 1 — Retrieval (Current Phase)

Goal: Reliable access to trusted data sources.

Features:

- deterministic search
- CHNA priority domains
- history tracking

Success Criteria:

analysts find sources faster than manual Google search.

### Phase 2 — Assisted Search (Future)

AI allowed ONLY as optional assistance.

Possible additions:

- query normalization
- synonym expansion (SoDH terminology)
- spelling correction
- guided search suggestions

AI must NOT change ranking authority rules.

### Phase 3 — Intelligence Layer (Long-Term)

AI becomes valuable here.

Potential capabilities:

- summarize multiple sources
- generate CHNA narrative drafts
- compare indicators across counties
- citation-aware summaries
- explain indicators for non-technical users

AI outputs must always link back to original sources.

## Architectural Rules for AI Agents

When contributing to this repository:

- Do NOT introduce new pages without approval.
- Do NOT add databases unless required.
- Prefer localStorage before backend storage.
- Prefer deterministic logic over probabilistic logic.
- Always maintain priority-source ranking.
- If unsure, choose the simpler implementation.

## Guiding Question

Before adding a feature, ask:

“Does this improve access to trusted population health data without increasing system complexity?”

If not, do not implement it.
