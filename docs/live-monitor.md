# Galápagos monitoring

Import the repository as a Databricks Git folder. The new notebook
`notebooks/03_live_mpa_monitor` is self-contained and does not require notebooks 00–02.
Install `requirements.txt` on its Python environment if requests is unavailable.

Create the Databricks secret `hackathon/gfw_token` using your Global Fishing Watch
API token. Never paste a token into notebook source or chat. Permit outbound HTTPS
to `gateway.api.globalfishingwatch.org` in the Databricks workspace.

Run the notebook from its `notebooks/` directory. It searches the GFW MPA catalog
for `Galapagos`, ignoring accents, and prints the selected IDs and names. Several
protected areas may match; to monitor one particular boundary, set `mpa_ids` to
its catalog ID. Explicit IDs override the name search.

Defaults: rolling 30-day window, 12-hour qualifying gap threshold. Adjust
`lookback_days` and `gap_hours` to your investigative needs. These are review
criteria, not legal rules. No synthetic fallback is used.

The notebook displays a current-window brief for each matching MPA and appends
it to `workspace.dark_fishing.monitor_reports`. The SQL view
`workspace.dark_fishing.latest_mpa_briefs` returns the most recently successful
report per MPA. Check `fetched_at` on every read: a failed job leaves the previous
successful report in place. `latest_event_at` describes returned events, not a
provider guarantee of complete coverage. Empty results do not establish coverage.

To refresh automatically, create a Databricks Job with this notebook as its task,
set a one-hour schedule and maximum concurrent runs of 1, and enable failure
notifications in Databricks. Pass the same widgets as job parameters. Failed API
requests and incomplete pagination fail the task; retry the job after resolving
access/rate-limit errors. Historical reports remain available.

The tracking assessment considers only events returned within the selected MPA
query and time window. It is distinct from the existing agent's wider risk score.
It cannot establish that every ship in the MPA is tracking continuously. GFW
publication can lag current activity; this is latest-available event monitoring,
not a real-time AIS position feed. Real-time tracking requires a suitable AIS
provider and a separate position/geofence pipeline.

Briefs use the existing deterministic writer, so no LLM or web-search key is
required. Vessel history enrichment may be incomplete; inspect `agent_trace`
in `briefs_json` for API errors. The gap assessment itself uses the successfully
fetched MPA events. GFW detections represent apparent activity and investigative
leads, never proof of misconduct.

Local checks: `.venv/bin/python -m unittest discover -s tests -v`.
Hosted Spark/Delta writes, catalog response shape, API authorization and job
scheduling require validation in the target Databricks workspace.
