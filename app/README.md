# Poseidon vessel explorer

Select a ship on the globe or in the explorer to see its latest recorded position. Move the time slider left to visit earlier observations. **Investigation** switches between protected-area cases for the same vessel. **View agent report** opens the published risk score, review priority, evidence confidence and main finding. Expand **Score breakdown** to see what contributed points, or expand **Agent trace** and select **Replay agent trace** to follow the recorded decisions. Queued cases display **Awaiting investigation**.

The fleet index includes every published vessel, even without a mappable position or completed report. Ships and tracked gear have separate counts; turn off **Include tracked fishing gear** for ships only. **Area details** narrows the fleet by event type, minimum risk and vessel identity. Breadcrumbs or Escape take you from the vessel back to its area and then the globe.

**Watch overview** shows the highest-priority cases, recent agent activity and a global news preview. Open **News** to search headlines, sources and article text. Filter global coverage by location or map coordinates, or choose **By area** for coverage of a particular reserve. Dates in the feed show when the articles were retrieved. **Dataset details** shows publication time, latest observation and the agent's triage decisions. The explorer checks for a newer publication every minute while visible. Vessel markers show dated observations.

Scroll or pinch over the globe to zoom. The **News markers** control toggles the diamonds for articles with a published location. Articles without coordinates stay in the feed. The globe also shows published area outlines. The optional `data/mpa_index.json` extends search to protected areas beyond those in the snapshot. When it is absent, you can still search the published areas and vessels. See the [UI specification](../docs/ui-spec.md).

From the repository root:

- **Local or Databricks-hosted app:** Run `npm start` with Node.js 22+ and open [Poseidon](http://127.0.0.1:3000/). To use a downloaded export, set `POSEIDON_SNAPSHOT_PATH` to the file. A Databricks App can read the notebook's exports volume using the resource in [app.yaml](../app.yaml). **About** opens the historical replay.
- **Static preview:** Run `python -m http.server 3102 --bind 127.0.0.1` and open [the globe](http://127.0.0.1:3102/app/). Keep `app/`, `public/` (shared styles and helpers) and `data/` as siblings. The historical archive is read-only on a static host.

The globe loads the real [Poseidon snapshot](../data/poseidon_snapshot.json) first. If the file is missing, contains invalid JSON, or fails the snapshot contract, the globe loads the sample and displays **SYNTHETIC DATA**. A network, permissions or service error shows the publication as unavailable. The browser needs no GFW, Linkup or Databricks keys.

### Investigate a queued vessel from the app

Select a queued case and choose **Investigate now** in the connected Databricks App. Databricks accepts the request immediately and starts the agent when compute is available. The app shows progress and opens the report for the selected case once the agent publishes it. You can explore another ship and return while the job runs.

1. Pull the team repository into the Databricks Git folder. Create an unscheduled serverless notebook job using the [job definition](../deploy/poseidon-investigate-case.job.json). Replace the notebook path with the workspace path to [app/investigate_case](./investigate_case.py). Set `export_volume` to the same volume used by `poseidon-exports`.
2. The job's **Run as** identity needs read access to the code and `hackathon/gfw_token`, and read/write access to the export volume with its catalog and schema. Give it access to `hackathon/linkup_key` for web searches and a chat endpoint for model decisions. The task uses the same agent and fallback policy as the monitoring pipeline.
3. In the Databricks App's **Resources**, add that job under the key `poseidon-investigate` with **Can manage run**. Enable the two `POSEIDON_JOB_ID` lines under `env` in [app.yaml](../app.yaml), then redeploy the app. The app itself needs only read access to the volume. [Databricks job resources](https://docs.databricks.com/gcp/en/dev-tools/databricks-apps/lakeflow)

The task writes one report in the volume's `investigations/` directory. The app shows it alongside the fleet snapshot while the queued case matches the investigated observations. A newer fleet report takes precedence. The scheduled monitoring job continues to own the fleet export and Delta tables. A static or local preview without a connected job can display published reports.
