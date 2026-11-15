# Poseidon vessel explorer

Select a ship on the globe or in the explorer to see its latest recorded position. Move the time slider left to visit earlier observations. **Investigation** switches between protected-area cases for the same vessel. **View agent report** opens the published risk score, review priority, evidence confidence and main finding. Expand **Score breakdown** to see what contributed points, or expand **Agent trace** and select **Replay agent trace** to follow the recorded decisions. Queued cases display **Awaiting investigation**.

The fleet index includes every published vessel, even without a mappable position or completed report. Ships and tracked gear have separate counts; turn off **Include tracked fishing gear** for ships only. **Area details** narrows the fleet by event type, minimum risk and vessel identity. Breadcrumbs or Escape take you from the vessel back to its area and then the globe.

**Watch overview** shows the highest-priority cases, recent agent activity and a global news preview. Open **News** to search headlines, sources and article text. Filter global coverage by location or map coordinates, or choose **By area** for coverage of a particular reserve. Dates in the feed show when the articles were retrieved. **Dataset details** shows publication time, latest observation and the agent's triage decisions. The explorer checks for a newer publication every minute while visible. Vessel markers show dated observations.

Scroll or pinch over the globe to zoom. The **News markers** control toggles the diamonds for articles with a published location. Articles without coordinates stay in the feed. The globe also shows published area outlines. The optional `data/mpa_index.json` extends search to protected areas beyond those in the snapshot. When it is absent, you can still search the published areas and vessels. See the [UI specification](../docs/ui-spec.md).

From the repository root:

- **Local or Databricks-hosted app:** Run `npm start` with Node.js 22+ and open [Poseidon](http://127.0.0.1:3000/). To use a downloaded export, set `POSEIDON_SNAPSHOT_PATH` to the file. A Databricks App can read the notebook's exports volume using the resource in [app.yaml](../app.yaml). **About** opens the historical replay.
- **Static preview:** Run `python -m http.server 3102 --bind 127.0.0.1` and open [the globe](http://127.0.0.1:3102/app/). Keep `app/`, `public/` (shared styles and helpers) and `data/` as siblings. The historical archive is read-only on a static host.

The globe loads the real [Poseidon snapshot](../data/poseidon_snapshot.json) first. If the file is missing, contains invalid JSON, or fails the snapshot contract, the globe loads the sample and displays **SYNTHETIC DATA**. A network, permissions or service error shows the publication as unavailable. The browser needs no GFW, Linkup or Databricks keys.
