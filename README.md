# Poseidon — protector of the sea (Imperial AI Hackathon)

An autonomous agent on Databricks that watches Marine Protected Areas (MPAs) for vessels that go dark, investigates them, and writes cited briefs.

## Open the investigation monitor

Run `npm start` with Node.js 22 or newer and open [Poseidon](http://127.0.0.1:3000/). Each ship marker shows the vessel’s latest dated observation in the current selection. When ship icons overlap, select a vessel by name. Its map shows its recorded positions, and **Position history** gives the UTC time and coordinates of each observation. For a vessel tracked in two reserves, **Investigation** selects the area-specific case. **View agent report** opens the brief published by Databricks. The explorer supports vessel, MMSI and event searches plus area, date and status filters. The fleet index includes all published vessels and counts tracked gear separately. Clear **Include tracked fishing gear** for a ships-only view. Position counts appear when you select a ship.

The workspace checks its configured export every minute. The default is the team’s saved Databricks export in `data/poseidon_snapshot.json`, which contains historical Global Fishing Watch observations for the Galápagos and Hermandad marine reserves. **Dataset details** shows the observation and publication times. To view a downloaded export, set `POSEIDON_SNAPSHOT_PATH` to its local path before starting the server. The [published historical archive](http://127.0.0.1:3000/archive) is available through **About**.

For a Databricks-hosted monitor, deploy this repository root as a Databricks App with the volume resource described in [the backend contract](docs/backend.md).

## Poseidon: the current system

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

The monitor consumes the snapshot documented in [the backend contract](docs/backend.md). Real runs use `workspace.poseidon` and sample runs use `workspace.poseidon_sample` by default.

Secrets (scope `hackathon`): `gfw_token` (required), `linkup_key` (web search).

The sections below describe the earlier pipeline (`00`–`03` notebooks, `agent/`), which Poseidon supersedes. They still run.


A Databricks and Python pipeline for investigating suspected illegal fishing inside Marine Protected Areas (MPAs).

## Earlier pipeline

### Problem

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
3. **Web search** — queries Linkup or Tavily for news, sanctions, or IUU fishing reports mentioning the vessel.
4. **Score** — computes a 0–100 rule-based risk score (`low` / `medium` / `high`) with plain-language reasons (e.g., gap duration >= 24h, fishing within 48h of a gap ending, flag changes, web hits).
5. **Brief** — prompts an LLM (or falls back to a deterministic template) to write a cited Markdown brief strictly from the gathered facts.

A separate scheduled notebook (`notebooks/03_live_mpa_monitor.py`) supports rolling-window monitoring (defaulting to Galápagos) and stores historical runs in `monitor_reports` with a `latest_mpa_briefs` SQL view.

## APIs, models, and datasets

### APIs
- **Global Fishing Watch API v3** (`https://gateway.api.globalfishingwatch.org/v3`) — MPA catalog, vessel events, and vessel identity lookup.
- **Linkup Search API** (`https://api.linkup.so/v1/search`) — live web search with sourced answers (default).
- **Tavily Search API** (`https://api.tavily.com/search`) — alternative live web search provider.
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
| `app/` | Globe, vessel explorer, published agent reports and static preview ([front-end guide](app/README.md)) |
| `public/`, `server.mjs` | Shared map helpers, historical replay, and server routes for the configured export |
| `data/` | Real notebook export, published archive records, and separate synthetic test fixtures |
| `docs/schema.md` | Table schemas the agent and front end agree on |
| `docs/live-monitor.md` | Setup and scheduling notes for `03_live_mpa_monitor.py` |
| `tests/` | Unit tests (Poseidon agent and the earlier live monitor) |

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
   - `03_live_mpa_monitor` — optional hourly rolling-window Galápagos brief (see [docs/live-monitor.md](docs/live-monitor.md))

The earlier pipeline uses `data/sample_briefs.json` for its `briefs` table.

Tables live in `workspace.dark_fishing` by default (change the `catalog` / `schema` widgets if needed).

## Local tests

```bash
pip install -r requirements.txt
python -m unittest discover -s tests -v
```

## Data attribution

Uses data from [Global Fishing Watch](https://globalfishingwatch.org) under their API terms (non-commercial use; attribution required).

## Published historical globe

Poseidon is a maritime investigation agent for conservation analysts. The workspace opens on an interactive globe. Select a case and choose **Focus area** to inspect the recorded positions, or **Run investigation** to open a cited evidence brief. Saved briefs are available from the selected case.

## Run locally

Install Node.js 22 or newer. The application has no npm dependencies.

```powershell
npm start
```

Open `http://127.0.0.1:3000/archive` for the published replay. To run the checks, use `npm test`. Set the environment variable `PORT` to change the listening port. This archive includes six public historical cases, a rules-based investigator and local JSON brief storage in the ignored `.soundings/briefs/` directory. Its local replay needs no credentials.

## The first investigation

Choose Revillagigedo and the March 2019 case. The last signal on 17 March was outside the park. The next signal, on 18 March, was inside. Poseidon computes 24.86 hours between those timestamps and shows the two positions. The vessel’s activity between them is unknown. The archive includes preselected suspected disabling events, so these observations cannot measure detection accuracy or total fishing activity.

| Protected area | What we checked | What the demo supports |
| --- | --- | --- |
| Revillagigedo, Mexico | The 2017 decree defines the park perimeter and fishing rule. Two historical research records have endpoints inside that perimeter. Separately, CONANP documented two 2025 incidents near Clarión. | Selected for the primary demo. Exact endpoints for the 2019 gaps and attributed report evidence for the 2025 incidents. |
| Dogger Bank, UK | BLOOM estimated 468 hours of apparent trawling during 2023. The UK byelaw regulates bottom-towed gear and provides for transit with gear stowed. | Gear-use follow-up. The available estimate covers the year and cannot resolve the gear deployed or an individual route. |
| Phoenix Islands, Kiribati | Kiribati reported five vessels cruising without fishing on the first day of its 2015 commercial fishing closure. | Real transit control. The dated official assessment changes the recommended action. |

Primary references for Revillagigedo are the [decree](https://dof.gob.mx/nota_detalle_popup.php?codigo=5505736), [CONANP incident report](https://www.gob.mx/conanp/prensa/la-conanp-reporta-a-la-embarcacion-red-rooster-iii-por-sospecha-de-pesca-ilegal-en-el-parque-nacional-revillagigedo) and [UNESCO island reference positions](https://whc.unesco.org/en/list/1510/maps/). Dogger Bank uses [BLOOM p. 22](https://www.bloomassociation.org/en/wp-content/uploads/2024/03/BULLDOZED.pdf#page=22) and the [MMO byelaw](https://www.gov.uk/government/publications/the-dogger-bank-special-area-of-conservation-specified-area-bottom-towed-fishing-gear-byelaw-2022). The Phoenix control comes from [Kiribati’s state of conservation report](https://whc.unesco.org/document/134952).

## Reproduce the gap selection

Download and extract `data/disabling_events.zip` from [Global Fishing Watch’s study archive](https://github.com/GlobalFishingWatch/AIS-disabling-high-seas/tree/main/data). The checked release has archive SHA-256 `d619e1fc256669e1441b62dc6655d03faa34090d95a0c4215988d5987445d6fc`. Credit goes to Welch and colleagues and Global Fishing Watch. [Research methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC9629714/)

```powershell
npm run import:gaps -- C:/path/to/disabling_events.csv
```

The importer reads all 55,368 rows, checks dated endpoints against the four published perimeter vertices, and writes the two qualifying records to `data/gaps.json`. Each record retains its source ID and UTC endpoints. The import uses the strict inside-or-on-boundary criterion. A vessel can cross a boundary unseen; this filter cannot detect such a crossing. The four report-based cases in `data/reports.json` have separate provenance. Their place names supply geographic context without manufacturing AIS coordinates.

## Optional live connections

Set secrets in the server process environment or a private file outside the repository. Node can read that file with `node --env-file=C:/path/to/private.env server.mjs`. Enable each service only in an authorized workspace with known credit coverage. No external services are required to try the published replay.

| Service | Server variables | What changes |
| --- | --- | --- |
| Linkup | `LINKUP_LIVE=1`, `LINKUP_API_KEY` | Searches the case jurisdiction’s source domains. Returned pages remain source leads until an analyst verifies their content. |
| Global Fishing Watch | `GFW_LIVE=1`, `GFW_TOKEN` | Uses a verified MMSI and event date to resolve identity and look up preceding port and encounter records. |
| Databricks SQL | `DATABRICKS_LIVE=1`, `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID`, `DATABRICKS_CANDIDATES_TABLE`, `DATABRICKS_BRIEFS_TABLE` | Reads the candidate collection and saves or retrieves cited briefs in Delta. Provide fully qualified table names. |
| Databricks Model Serving | `DATABRICKS_AGENT_LIVE=1`, `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_MODEL_ENDPOINT` | A tool-calling chat endpoint selects event, history, rule and source lookups and chooses a permitted follow-up. Factual statements stay grounded in the returned evidence. |

For SQL, use your intended catalog and schema and run the two DDL statements in `databricks.sql`. Run `node scripts/seed-sql.mjs catalog.schema.soundings_candidates` locally and execute the printed MERGE in the warehouse. The final query in `databricks.sql` reproduces the endpoint check for loaded gap cases. The server falls back to the published replay or local brief storage when the warehouse is unavailable. The brief displays which data, investigation, search and storage modes were used.

## Scope

For a warehouse import from the full 55,368-event CSV, upload the extracted archive to a Unity Catalog volume and run `ingest-archive.sql` with the `archive_file` path bound. It filters on both real endpoints and the effective date and merges matching records into the same candidates table. On the pinned archive, the local equivalent produced two matches. Warehouse SQL has not been executed against a live account.

This first release is an on-demand analyst workflow with a historical data import. The regional and globe views use locally bundled Natural Earth shaded relief. Drag or use the arrow keys to orbit, use + and - to zoom, and choose Area to fit the selected case. Revillagigedo shows its verified perimeter and individual recorded positions. Dogger Bank and the Phoenix Islands show regional context for reports without track coordinates. The [editable Figma prototype](https://www.figma.com/design/IShW9f361YWtxigeXaes2h?node-id=2-2) covers case selection, globe view, and the cited brief. The source record distinguishes a reporting gap, apparent fishing, a documented referral, and an assessment of transit. Running against live provider accounts and extending coverage to recurring ingestion are follow-up milestones.
