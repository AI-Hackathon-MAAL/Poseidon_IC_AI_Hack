# Guide for coding agents working in this repository

## What this project is

**Poseidon**: an autonomous agent that watches marine protected areas for vessels that switch off tracking
or appear to fish inside them, investigates each one, and writes a cited brief. Built for a hackathon.

There are two halves:

| Half | Where | Runs on |
| --- | --- | --- |
| Backend (done) | `poseidon/` package + `notebooks/poseidon.py` | Databricks. Do not try to run it locally against real APIs |
| Front end (to build) | `app/` | A static web app that reads one JSON file |

## If you are building the front end, read these three files and nothing else first

1. `docs/ui-spec.md` — what every screen contains and which field feeds it.
2. `docs/backend.md` — the data contract (snapshot shape, every field, allowed values).
3. `data/poseidon_snapshot.sample.json` — a synthetic example of the exact JSON to load.

The real data file is `data/poseidon_snapshot.json` (same shape; may not exist yet). Load it if present,
otherwise the sample. The front end makes no API calls and needs no keys.

Put all front-end code in `app/`. Do not modify `poseidon/`, `notebooks/`, `agent/` or `tests/`.

## Map of the repository

| Path | Purpose |
| --- | --- |
| `poseidon/` | Backend package: GFW client, Linkup search, agent loop, scoring, briefs, data contract |
| `notebooks/poseidon.py` | The one notebook that runs the backend (history and live modes) |
| `docs/ui-spec.md`, `docs/backend.md` | Front-end brief and data contract |
| `data/` | Snapshot JSON files (sample is synthetic) |
| `app/` | Front end goes here |
| `agent/`, `notebooks/00`–`03`, `docs/schema.md`, `docs/live-monitor.md` | Earlier pipeline, superseded. Ignore |
| `tests/` | Backend unit tests: `python -m unittest discover -s tests` |

## Rules

- Never commit secrets or API keys.
- Every case is a lead for review, not proof. Use "apparent fishing" and "flagged for review"; never state
  that a vessel acted illegally.
- Keep the Global Fishing Watch attribution and the disclaimer visible in the UI.
