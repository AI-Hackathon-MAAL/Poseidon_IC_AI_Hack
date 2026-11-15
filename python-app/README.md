# Poseidon

Self-contained Python maritime monitoring application for inspecting Global Fishing Watch (GFW) apparent fishing activity around Marine Protected Areas (MPAs) and running autonomous multi-step vessel lead investigations.

All findings are **apparent fishing** leads **flagged for review** based on AIS/GFW event telemetry and public records — never an accusation or determination of illegal activity.

## Where this sits in the repository

This folder is Abdullah's standalone Python host for Poseidon. It reuses the rest of the repository instead of carrying its own copies:

- `app.py` — Python HTTP server (`ThreadingHTTPServer`) serving `web/` and the `/api/*` endpoints.
- `web/` — the globe front end for this host.
- `../poseidon/` — the investigation agent, GFW client, web search client, scoring and briefs (shared).
- `../data/` — the published snapshot and MPA index (shared, read-only from here).
- `../app/assets/` — globe imagery, terrain tiles and fonts (shared).
- `data/` — created on first investigation; holds this app's own working copy of the snapshot. Git-ignored, so it never overwrites the snapshot published from Databricks.
- `scripts/build_clean_snapshot.py` — one-off tool that merged two snapshot exports.

The Databricks App at the repository root (`app.yaml`, `server.mjs`, `app/`) is a separate host and is not changed by this folder.

## Quick Start

From the repository root:

```bash
pip install -r python-app/requirements.txt
python python-app/app.py
```

Then open `http://127.0.0.1:8000` (set `PORT` to change it).

Optional live credentials: copy `python-app/.env.example` to `python-app/.env` (git-ignored) and fill in `GFW_TOKEN`, `LINKUP_API_KEY`, and `DATABRICKS_HOST` + `DATABRICKS_TOKEN`. Never commit that file.

## Offline / Hybrid Mode vs. Live Mode

- **Offline / Hybrid Mode (no API keys required):** `app.py` wraps `poseidon/` with `SnapshotGFWAdapter` and `SnapshotSearchAdapter`, allowing you to explore the globe, inspect existing briefs, and run `POST /api/investigate` locally against cached snapshot telemetry and search evidence without external API calls.
- **Live Mode:** When `GFW_TOKEN`, `LINKUP_API_KEY`, and `DATABRICKS_HOST` + `DATABRICKS_TOKEN` are set, `POST /api/investigate` runs the live Python agent against external APIs, and `POST /api/sync-databricks` pulls the latest `poseidon_snapshot.json` from `POSEIDON_VOLUME` via the Databricks Files API.

## API Endpoints

- `GET /api/status` — Engine capabilities, API key/configuration status, and snapshot summary counts.
- `GET /api/snapshot` — Active `poseidon_snapshot.json` payload.
- `POST /api/investigate` — Runs the Python `poseidon` agent for `{"case_id": "..."}` and saves the updated case into `python-app/data/poseidon_snapshot.json`.
- `POST /api/sync-databricks` — Syncs `poseidon_snapshot.json` from `POSEIDON_VOLUME` on Databricks when `DATABRICKS_HOST` and `DATABRICKS_TOKEN` are configured.

## Running Tests

From the repository root:

```bash
python -m unittest discover -s tests -v
```
