# Dark Fishing Watch — Imperial AI Hackathon

An autonomous agent that spots vessels **switching off tracking to fish inside marine protected areas (MPAs)**, investigates them, and writes a cited one-page brief for investigators.

Every output is a **lead, not an accusation**: Global Fishing Watch labels its detections "apparent".

## How it fits together

```
Global Fishing Watch API ──> Databricks notebooks ──> candidates table
                                                         │
                                                         ▼
Front end  <── briefs table  <── agent loop (vessel history, web check, score, brief)
```

## Repo layout

| Path | What it is |
| --- | --- |
| `notebooks/` | Databricks notebooks (source format — import via Workspace > Import, or Git folder) |
| `agent/` | Agent loop, tools and prompts |
| `app/` | Front end (built from the Figma frames) |
| `data/` | Small **synthetic** sample data so everyone can build before the real data lands |
| `docs/schema.md` | Table schemas the agent and front end agree on |

## Setup

1. **Secrets** — never commit keys. Store them as Databricks secrets in the scope `hackathon`:
   - `gfw_token` — Global Fishing Watch API token
   - `linkup_key` or `tavily_key` — web search key
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

Front end: build against `data/sample_briefs.json` (same shape as the `briefs` table) until the real table is ready.

Tables live in `workspace.dark_fishing` by default (change the `catalog` / `schema` widgets if needed).

## Data attribution

Uses data from [Global Fishing Watch](https://globalfishingwatch.org) under their API terms (non-commercial use; attribution required).

## Latest available Galápagos brief

Run `notebooks/03_live_mpa_monitor.py` in Databricks for a rolling-window GFW
brief, explicit tracking-gap assessments, and retained report history.
See [live monitoring setup](docs/live-monitor.md) for credentials, MPA selection,
hourly scheduling, and data-freshness limits.
