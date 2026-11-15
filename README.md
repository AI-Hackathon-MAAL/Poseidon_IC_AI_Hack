[# Poseidon — protector of the sea (Imperial AI Hackathon)

An autonomous agent on Databricks that watches Marine Protected Areas (MPAs) for vessels that go dark, investigates them, and writes cited briefs.

## Poseidon: the current system

Open the globe locally with `npm start` on Node.js 22 or newer, then visit [Poseidon](http://127.0.0.1:3000/). The globe reads the published snapshot in `data/`. Select a vessel to explore its recorded positions and open its agent report. [Frontend guide](app/README.md)

**Run `notebooks/poseidon`.** One notebook, two modes that differ only by time window:

| Mode | Window | Use |
| --- | --- | --- |
| `history` | `start_date` to `end_date` | Investigate a past period |
| `live` | Last `lookback_days` days up to now | Scheduled monitoring (hourly Databricks Job) |

What makes it an agent rather than a pipeline:

1. **Triage** — ranks every vessel-in-area case (new evidence, long or repeated gaps, fishing, unnamed vessels) and works down the list within a budget.
2. **Chooses its own checks** — for each case a language model picks the next tool (identity lookup, activity before/after the gap, 12-month history, encounter partner, Linkup web searches on the vessel, its owner, the area's rules and recent news) and decides when the evidence is sufficient.
3. **Adapts** — failed checks are recorded, temporary outages retried once, and a case that cannot be completed is marked `incomplete` with what remains unknown.
4. **Remembers** — unchanged cases are skipped on later runs; cases with new events are reopened.
5. **Stays auditable** — scores, durations and the complete/incomplete verdict come from code and source data, never from the model. Every step records who decided (`llm` or `policy`) and why.

Front end: read **[docs/backend.md](docs/backend.md)** and build against `data/poseidon_snapshot.sample.json` (synthetic, same shape as the real output). Tables live in `workspace.poseidon`.

Secrets (scope `hackathon`): `gfw_token` (required), `linkup_key` (web search).

The sections below describe the earlier pipeline (`00`–`03` notebooks, `agent/`), which Poseidon supersedes. They still run.


A Databricks and Python pipeline for investigating suspected illegal fishing inside Marine Protected Areas (MPAs).

## Problem

Fishing vessels sometimes disable their AIS transponders ("going dark") before or during activity inside Marine Protected Areas. Reviewing tracking gaps, cross-referencing vessel identity history, and searching public records for prior sanctions or detentions requires manual effort across multiple tools.

## What we built

An automated investigation pipeline that ingests MPA vessel events, groups them into per-vessel leads, scores risk using explicit rules, enriches each lead with vessel history and web search results, and writes a cited one-page Markdown brief for investigators.

Every output is a **lead, not an accusation**: Global Fishing Watch labels its detections "apparent".

## How it works

```
Global Fishing Watch API ──> Databricks notebooks ──> candidates table
                                                         │
                                                         ▼
Front end  <── briefs table  <── agent loop (history, web search, score, brief)
```

For each `(vessel, MPA)` lead, `agent/dark_fishing_agent.py` runs five steps and records an audit trace:

1. **Gather** — collects candidate events (`gap`, `fishing`, `encounter`, `loitering`) for the vessel in the selected MPA.
2. **History** — queries Global Fishing Watch for vessel name/flag history and recent event counts.
3. **Web search** — queries Linkup for news, sanctions, or IUU fishing reports mentioning the vessel.
4. **Score** — computes a 0–100 rule-based risk score (`low` / `medium` / `high`) with plain-language reasons (e.g., gap duration >= 24h, fishing within 48h of a gap ending, flag changes, web hits).
5. **Brief** — prompts an LLM (or falls back to a deterministic template) to write a cited Markdown brief strictly from the gathered facts.

A separate scheduled notebook (`notebooks/03_live_mpa_monitor.py`) supports rolling-window monitoring (defaulting to Galápagos) and stores historical runs in `monitor_reports` with a `latest_mpa_briefs` SQL view.

## APIs, models, and datasets

### APIs
- **Global Fishing Watch API v3** (`https://gateway.api.globalfishingwatch.org/v3`) — MPA catalog, vessel events, and vessel identity lookup.
- **Linkup Search API** (`https://api.linkup.so/v1/search`) — live web search with sourced answers (default).
- **Databricks SDK** (`databricks-sdk`) — queries Databricks Model Serving endpoints.

### Models
- **`databricks-meta-llama-3-3-70b-instruct`** — served via Databricks Foundation Model APIs (configurable via the `llm_endpoint` widget; falls back to a deterministic template if unavailable).

### Datasets
- **Global Fishing Watch** (non-commercial use; attribution required):
  - `public-mpa-all` — Marine Protected Area boundaries and metadata
  - `public-global-gaps-events:latest` — AIS tracking-off (gap) events
  - `public-global-fishing-events:latest` — apparent fishing events
  - `public-global-encounters-events:latest` — vessel-to-vessel encounter events
  - `public-global-loitering-events:latest` — loitering events
  - `public-global-vessel-identity:latest` — vessel identity and flag history
- **Synthetic sample data** (`data/sample_candidates.json`, `data/sample_briefs.json`) — local fixtures for development and testing without API keys.

## Repo layout

| Path | What it is |
| --- | --- |
| `notebooks/poseidon.py` | **The Poseidon notebook** (history + live modes) |
| `poseidon/` | Poseidon package: GFW client, Linkup search, agent loop, scoring, briefs, data contract |
| `docs/backend.md` | Front-end contract: snapshot shape, tables, fields |
| `scripts/make_sample_snapshot.py` | Regenerates the synthetic sample snapshot |
| `notebooks/` | Databricks notebooks (source format — import via Workspace > Import, or Git folder) |
| `agent/` | Agent loop, tools, prompts, and live monitor client |
| `app/` | Front end (built from the Figma frames) |
| `data/` | Small **synthetic** sample data for testing without API keys |
| `docs/schema.md` | Table schemas the agent and front end agree on |
| `docs/live-monitor.md` | Setup and scheduling notes for `03_live_mpa_monitor.py` |
| `tests/` | Unit tests (Poseidon agent and the earlier live monitor) |

## Setup

1. **Secrets** — never commit keys. Store them as Databricks secrets in the scope `hackathon`:
   - `gfw_token` — Global Fishing Watch API token
   - `linkup_key` — Linkup web search key

2. **Outbound internet** — Databricks Free Edition blocks most outbound domains by default. Verify the workspace with LinkedIn to unlock it, then test:
   ```python
   import requests
   print(requests.get("https://gateway.api.globalfishingwatch.org/v3/datasets", timeout=10).status_code)
   ```
   Any status code = reachable. A connection/DNS error = still blocked.

3. **Run the notebooks in order:**
   - `00_load_sample_data` — writes synthetic data into the tables (no keys needed)
   - `01_ingest_gfw` — pulls real MPA list + events from Global Fishing Watch
   - `02_run_agent` — investigates leads and writes the `briefs` table (set `source` to `gfw` for real data)
   - `03_live_mpa_monitor` — optional hourly rolling-window Galápagos brief (see [docs/live-monitor.md](docs/live-monitor.md))

Front end: build against `data/sample_briefs.json` (same shape as the `briefs` table) until the real table is ready.

Tables live in `workspace.dark_fishing` by default (change the `catalog` / `schema` widgets if needed).

## Local tests

```bash
pip install -r requirements.txt
python -m unittest discover -s tests -v
```

## Data attribution

Uses data from [Global Fishing Watch](https://globalfishingwatch.org) under their API terms (non-commercial use; attribution required).
](http://127.0.0.1:8000/)
