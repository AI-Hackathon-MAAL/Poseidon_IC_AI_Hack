# Poseidon vessel explorer

The original Poseidon globe is the landing page. Select a ship on the globe or in the explorer to focus the map on its recorded positions. **Position history** steps through dated observations; **Investigation** switches between protected-area cases for the same vessel. **View agent report** opens the brief the notebook actually published, including its sources, limits and tool decisions. Queued investigations do not have a report yet.

**Dataset details** shows publication time, latest observation, protected areas, the latest run's triage decisions and regional news. The explorer checks for a newer publication every minute while visible. Markers show dated observations from the selected data, not real-time vessel locations. Gear transmitters are excluded until **Include tracked fishing gear** is selected.

From the repository root:

- **Local or Databricks-hosted app:** Run `npm start` with Node.js 22+ and open [Poseidon](http://127.0.0.1:3000/). A local export path or a Databricks volume can be configured as described in the [backend contract](../docs/backend.md). **About** opens the historical replay.
- **Static preview:** Run `python -m http.server 3102 --bind 127.0.0.1` and open [the globe](http://127.0.0.1:3102/app/). Keep `app/`, `public/` (shared styles and helpers) and `data/` as siblings. The historical archive is read-only on a static host.

The current snapshot is [data/poseidon_snapshot.json](../data/poseidon_snapshot.json). On a static host, a missing real file loads the clearly labeled synthetic sample. A malformed export or service outage does not silently switch data. No GFW, Linkup or Databricks keys belong in the browser.
