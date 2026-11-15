# Poseidon

**A maritime investigation workspace for reviewing vessel activity in Marine Protected Areas.**

Poseidon combines Global Fishing Watch event data, public-source research, and a tool-using agent to help reviewers decide which vessel activity deserves a closer look. It brings tracking gaps, apparent fishing events, vessel identity, source links, and an investigation brief into one globe-based interface.

Built for the Imperial AI Hackathon.

Every case is a **lead for review, not proof of illegal activity**. A tracking gap does not establish where a vessel travelled while its signal was absent, and a high risk score is not a legal finding.

## Why we built it

A vessel can lose AIS coverage near a protected area, reappear hours later, and have a complicated identity history across several registries. Understanding that sequence takes more than plotting a point on a map. A reviewer needs to check the area boundary, the vessel's activity before and after the gap, its history, and any relevant public reporting.

Poseidon gathers those checks into a repeatable investigation. It records what was checked, which sources were returned, what remains unknown, and why the case received its score. The website makes that evidence readable without requiring the reviewer to work through a notebook or query the underlying tables.

## What the project does

- Explore published vessels and protected areas on an interactive globe.
- Inspect recorded positions, tracking gaps, apparent fishing, encounters, and loitering events.
- Review vessel identity, dated evidence, risk-score reasons, and cited briefs.
- Follow the agent's recorded tool choices and results.
- Search published news and protected-area context.
- Run historical analyses from the website by choosing an area and date window.
- Run the same backend as a scheduled Databricks monitoring job.
- Browse bundled data locally without API credentials.

The globe displays observations from the loaded dataset. It is not a live vessel-position feed.

## Project architecture and pipeline

### Figma diagram

> **Space reserved for the project skeleton and end-to-end pipeline diagram.**
>
> Add your Figma link and exported diagram here. Suggested labels: website inputs → Python server → Databricks job → data collection → agent investigation → Delta tables / JSON export → website results.

<!-- Replace this block with your real diagram and URL when ready:
[View the architecture in Figma](YOUR_FIGMA_URL)

![Poseidon project architecture and pipeline](docs/images/poseidon-pipeline.png)
-->

### How a website request runs

```text
Reviewer selects a protected area and date window
                         |
                         v
Website → Python server → Databricks Jobs API
                         |
                         v
              notebooks/poseidon.py
                         |
          +--------------+---------------+
          |                              |
          v                              v
Global Fishing Watch            Linkup / Tavily
Events, identity, boundaries     Public sources and area rules
          |                              |
          +--------------+---------------+
                         v
              Case building and triage
                         |
                         v
              Agent investigation loop
        Model selects a tool; Python executes it
                         |
                         v
         Deterministic score + cited brief
                         |
                         v
        Delta tables + JSON in a UC Volume
                         |
                         v
       Python server reads the request's JSON
                         |
                         v
           Globe, case details, and reports
```

Scheduled monitoring uses the same notebook without a website submission. It publishes a shared snapshot for the website to read. Website-requested analyses use separate tables and output files, so they do not replace the scheduled publication.

## How the investigation works

### 1. Choose the area and time window

The notebook supports two modes:

| Mode | Time window | Typical use |
| --- | --- | --- |
| `history` | Explicit `start_date` and `end_date` | Investigate a past period |
| `live` | Rolling `lookback_days`, recomputed each run | Scheduled monitoring |

Website analysis submissions use history mode. The end date is exclusive, must be after the start date, and cannot be in the future. The website API limits each request to 366 days.

### 2. Fetch events and build cases

The pipeline retrieves Global Fishing Watch events for the selected areas and groups them by protected area and vessel. A case is identified by `mpa_id:vessel_id`.

The regional collection covers tracking gaps, apparent fishing, encounters, and loitering. Vessel-level checks can also use port-visit records. Boundary checks help distinguish a signal lost or regained inside an area from a gap whose endpoints both lie outside it.

Configurable vessel-type exclusions remove categories outside the intended fishing-review scope. If every fetched event is excluded, the run can correctly produce zero eligible cases.

### 3. Triage the leads

The pipeline ranks cases using signals such as long or repeated gaps, apparent fishing, unresolved identity, and new events. It investigates within a configurable budget and leaves other cases queued.

The notebook applies `max_cases` separately to each selected protected area. The dedicated website job selects one area and defaults to five investigations with up to eight agent steps per case.

### 4. Let the agent choose its checks

When a chat endpoint is available, the model selects the next permitted tool based on the evidence gathered so far. Python validates the choice and runs the tool.

Available checks include:

| Check | Purpose |
| --- | --- |
| Resolve identity | Look for vessel names, identifiers, flags, and registry information |
| Activity around the event | Examine activity before and after the event |
| Vessel history | Check event counts over the preceding 12 months |
| Encounter partner | Investigate the other vessel in an encounter |
| Vessel / owner search | Find relevant public reporting |
| Protected-area rules | Gather sourced context on the area's restrictions |
| Regional news | Gather reporting relevant to the area |

The trace records the chosen tool, reason, result, timing, and whether the decision came from the model or fallback policy. Failed checks remain part of the record. If a model is unavailable, a rule-based policy selects checks instead.

### 5. Score and write the brief

Risk scores come from Python rules, not a model-generated number. Each contribution has a reason and a basis in the evidence. The output also records confidence, caveats, and missing information.

The brief is written from the gathered evidence and includes source links. A deterministic template is available when model-based brief generation is unavailable. Cases can be `complete`, `incomplete`, or `queued`; those labels describe investigation progress, not whether a vessel complied with the law.

### 6. Store and publish

Databricks stores events, cases, runs, agent steps, and area context in Delta tables. The notebook then builds a JSON snapshot for the website.

The scheduled workflow can reuse previous case records. Its memory is read from the Databricks `cases` table, not from the exported JSON. Completed cases with the same event fingerprint can be skipped; changed evidence, incomplete cases, and explicit reinvestigation requests can trigger further work. The fingerprint tracks event identifiers and types, so it is not a guarantee that every underlying field is unchanged.

## Repository structure

```text
.
├── app.py                         # Python HTTP server, local investigation, snapshot APIs
├── databricks_analyses.py          # Website job submission, status checks, result retrieval
├── app.yaml                       # Databricks App command and resource bindings
├── requirements.txt
├── .env.example                   # Local configuration template; contains no credentials
├── web/
│   ├── index.html
│   ├── globe/                     # Globe workspace, reports, news, analysis form
│   ├── assets/                    # Map imagery, terrain, fonts, and branding
│   └── *.mjs                      # Shared snapshot and case-view helpers
├── poseidon/
│   ├── gfw.py                     # Global Fishing Watch client and date-window handling
│   ├── geo.py                     # Boundaries and geometry helpers
│   ├── search.py                  # Linkup / Tavily client
│   ├── agent.py                   # Tool definitions and investigation loop
│   ├── scoring.py                 # Deterministic scoring and caveats
│   ├── brief.py                   # Model / template brief generation
│   ├── pipeline.py                # Event collection, case grouping, triage, and memory
│   ├── contract.py                # Table definitions and snapshot construction
│   ├── intel.py                   # Global news layer
│   └── sample.py                  # Synthetic fixtures
├── notebooks/
│   └── poseidon.py                # Databricks pipeline entry point
├── deploy/
│   ├── poseidon-analysis.job.json  # Dedicated website-triggered job
│   └── poseidon-hourly.job.json    # Scheduled monitoring job template
├── data/
│   ├── poseidon_snapshot.json
│   ├── poseidon_snapshot.sample.json
│   └── mpa_index.json
├── scripts/                       # Sample generation and snapshot maintenance
└── tests/                         # Agent, pipeline, and Databricks integration unit tests
```

This README describes the Python application (`app.py` and `web/`). Older Node-based frontends and earlier numbered notebooks are separate versions of the project; their startup commands do not apply to this app.

## Run locally

Use Python 3.12 for the tested development setup. No Node dependency installation or frontend build is required.

### 1. Create an environment and install dependencies

From the repository root:

```bash
python -m venv .venv
```

Activate it on Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

Or on macOS / Linux:

```bash
source .venv/bin/activate
```

Then install and start:

```bash
python -m pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:8000`. Use the same Python environment for installation and startup.

### 2. Browse the bundled snapshot

No credentials are needed to browse the bundled data. The server loads `data/poseidon_snapshot.json`, falls back to the sample when needed, and serves the website from `web/`.

Local case investigation can use cached snapshot adapters when live credentials are absent. This reuses existing telemetry and sources; it does not fetch fresh observations. Website-triggered Databricks analysis requires the configuration below.

### 3. Create `.env` beside `app.py`

Copy `.env.example` to `.env` in the project root:

```text
poseidon-app/
├── .env
├── .env.example
├── app.py
└── ...
```

Fill only the settings needed for your workflow and restart the server after changes. Keep `.env` out of Git; add it to `.gitignore` if it is not already excluded.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABRICKS_HOST` | Workspace origin, such as `https://dbc-example.cloud.databricks.com`; omit notebook paths and query parameters |
| `DATABRICKS_TOKEN` | Optional local personal access token; never put it in browser code or commit it |
| `DATABRICKS_MODEL_ENDPOINT` | Exact serving endpoint name used by the local app's model calls |
| `POSEIDON_ANALYSIS_JOB_ID` | Numeric ID of the dedicated website analysis job |
| `POSEIDON_VOLUME` | Shared export volume, default `/Volumes/workspace/poseidon/exports` |
| `GFW_TOKEN` | Live GFW access for investigations executed inside the local website process |
| `LINKUP_API_KEY` | Live Linkup research for local investigations |
| `TAVILY_API_KEY` | Alternative search provider for local investigations |
| `PORT` | Local server port, default `8000` |
| `DATABRICKS_APP_PORT` | Platform-provided Databricks App port; takes precedence over `PORT` |

Example local configuration, with placeholders:

```dotenv
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
DATABRICKS_TOKEN=YOUR_LOCAL_TOKEN
DATABRICKS_MODEL_ENDPOINT=YOUR_SERVING_ENDPOINT
POSEIDON_ANALYSIS_JOB_ID=123456789
POSEIDON_VOLUME=/Volumes/workspace/poseidon/exports
PORT=8000
```

`POSEIDON_ANALYSIS_JOB_ID` is a job ID, not a notebook path or model endpoint. Find it in the job details or in the job URL.

The website job integration uses `databricks-sdk` authentication: injected App OAuth credentials on Databricks, or supported local SDK credentials/profile during development. The older local model-call and manual-sync endpoints in `app.py` use `DATABRICKS_HOST` and `DATABRICKS_TOKEN` directly; they do not automatically inherit that SDK authentication path.

The notebook independently chooses its model through the `llm_endpoint` widget (`auto` by default). Setting `DATABRICKS_MODEL_ENDPOINT` in the website does not change the notebook's job parameters.

## Connect the full pipeline on Databricks

### 1. Put the code in a Databricks Git folder

Import or clone the project into the workspace. The notebook must be able to load the sibling `poseidon/` package. Use the updated notebook that supports `request_id` and `export_volume` for website analyses.

### 2. Configure backend secrets and access

Store API credentials in the Databricks secret scope `hackathon`:

| Secret | Used for |
| --- | --- |
| `gfw_token` | Required for real Global Fishing Watch collection |
| `linkup_key` | Linkup research when `search_provider=linkup` |
| `tavily_key` | Alternative provider when `search_provider=tavily` |

The job's run-as identity needs access to these secrets, its code, a usable model endpoint for model-based decisions, and the required Unity Catalog objects. Without search or model access, the pipeline can fall back, but the evidence and report will reflect those limitations.

Allow outbound access to `gateway.api.globalfishingwatch.org`, the chosen search provider (`api.linkup.so` or `api.tavily.com`), and your Databricks workspace as required by the runtime.

### 3. Create the export volume

Provision the shared export location, for example:

```sql
CREATE SCHEMA IF NOT EXISTS workspace.poseidon;
CREATE VOLUME IF NOT EXISTS workspace.poseidon.exports;
```

Adjust the catalog/schema to match your workspace and grant the appropriate identities access. The job needs write access to the export volume. The App identity needs read access.

### 4. Create the dedicated analysis job

Use [`deploy/poseidon-analysis.job.json`](deploy/poseidon-analysis.job.json) as the job definition. Replace the notebook path with the actual workspace path and change the catalog if necessary. Configure compatible serverless notebook compute in the workspace.

The website submits these job parameters:

```text
mpa_ids, start_date, end_date, request_id, export_volume, schema
```

Each request uses a `web_<request-id>` schema in the configured catalog. The job identity therefore needs permission to create schemas and tables there. Its result is written to:

```text
<POSEIDON_VOLUME>/requests/<request-id>/poseidon_snapshot.json
```

Keep the dedicated analysis job separate from the scheduled monitoring job. Request schemas and output files are retained until explicitly removed; set a retention policy before repeated or wider use.

### 5. Bind the website to the job

For local use, set the job ID and volume in `.env` and configure SDK authentication.

For a Databricks App:

1. Deploy the Python app using `app.yaml` and `requirements.txt`.
2. Attach the analysis job under the resource key `poseidon-analysis`, with permission to manage runs.
3. Attach the export volume under `poseidon-exports`, with read access.
4. Enable the commented `POSEIDON_ANALYSIS_JOB_ID` binding in `app.yaml`.
5. Make sure the App identity can access the required catalog and schema as well as the volume.

The website passes inputs to the server; it never receives a Databricks token.

### 6. Check a real run

Choose a real area from **Run analysis**, select a historical window, and submit. The UI polls while the job is pending or running and offers **View results** after success. Closing the dialog does not cancel the job; the same browser tab can resume polling after refresh.

Verify all three parts before considering the connection complete:

- The Databricks run parameters match the submitted area and dates.
- The job succeeds and writes the request's JSON to the expected volume path.
- The result page loads that snapshot and shows the expected area and case windows.

A run can succeed with zero cases. Check collection and filtering logs before treating an empty result as a connection failure.

## Scheduled monitoring

[`deploy/poseidon-hourly.job.json`](deploy/poseidon-hourly.job.json) is the monitoring template. It uses live mode with a rolling 30-day window and an hourly UTC schedule. The supplied area IDs target Galápagos and Hermandad; update them for your deployment.

The normal publication path is:

```text
/Volumes/<catalog>/<schema>/exports/poseidon_snapshot.json
```

This is the shared fleet publication. Website-requested analyses are separate and do not automatically merge their tables or results into it. The local app can explicitly pull the shared publication through `/api/sync-databricks`; starting a monitoring job alone does not update a separately running local website.

## Data and snapshot contract

The frontend reads a JSON snapshot instead of calling GFW or the search providers directly. Key sections are:

| Section | Contents |
| --- | --- |
| `product`, `generated_at` | Product identity and publication time |
| `latest_run`, `runs` | Run windows, counts, triage decisions, and notes |
| `mpas` | Protected-area information, boundaries, context, and summaries |
| `cases` | Vessel cases with evidence, events, scores, briefs, and agent steps |
| `news`, `global_news` | Cited reporting and available geographic context |
| `attribution`, `disclaimer` | Source attribution and interpretation limits |

`poseidon/contract.py` defines the table and snapshot construction logic. Preserve that structure when changing the backend so the existing viewer can still load the export.

Important Databricks tables include `events`, `cases`, `agent_steps`, `runs`, `news`, `global_news`, `mpa_context`, `mpa_boundaries`, and `mpa_status`. Case rows are merged by case ID; the shared `cases` table is not an immutable archive of every case revision.

For shared exports, `snapshot_scope=all_areas` includes accumulated records. `this_run_areas` filters by selected area, **not by the current date window**. Old cases for the same area can still appear. Website requests avoid that accumulated-table issue by using a new schema for each request.

## HTTP API

| Method | Endpoint | Behaviour |
| --- | --- | --- |
| GET | `/api/status` | Local engine configuration and snapshot summary |
| GET | `/api/snapshot` | Current local/shared snapshot |
| GET | `/api/snapshot?analysis=<run-id>` | Completed request snapshot |
| POST | `/api/analyses` | Validate area/dates and submit a Databricks job; returns HTTP 202 |
| GET | `/api/analyses/<run-id>` | Return `pending`, `running`, `succeeded`, or `failed` |
| GET | `/api/analyses/<run-id>/result` | Read a completed analysis from its volume output |
| POST | `/api/investigate` | Run an individual case investigation in the website's Python process |
| POST | `/api/sync-databricks` | Pull the shared Databricks snapshot into the local store |

Example analysis body:

```json
{
  "mpa_id": "11753",
  "start_date": "2016-01-15",
  "end_date": "2016-05-01"
}
```

`/api/investigate` and `/api/analyses` are different execution paths. The former can use local cached adapters; the latter starts the backend notebook on Databricks. Request result pages are read-only in the UI.

## Tests and validation

Run from the repository root:

```bash
python -m unittest discover -s tests -v
```

The suite covers core investigation behaviour and the added Databricks submission/result path. Databricks integration unit tests mock the SDK; they do not prove that workspace credentials, permissions, compute, or real API access work.

Development validation passed 45 Python tests, JavaScript syntax checks, and local HTTP checks for the page, snapshot, and analysis configuration errors. End-to-end execution against a live Databricks workspace still needs to be verified in the deployment environment.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `ModuleNotFoundError: No module named 'databricks'` | Run `python -m pip install -r requirements.txt` using the same interpreter that starts the app |
| Analysis job is not configured | Set `POSEIDON_ANALYSIS_JOB_ID` or enable the App job-resource binding, then restart |
| Job submission or result retrieval fails | Check SDK authentication, job permissions, compute, and volume access |
| Historical input still shows recent data | Check the actual job parameters, the selected result URL, and whether a shared snapshot includes older stored cases |
| Notebook says it remembers cases absent from JSON | Memory is loaded from the Databricks `cases` table; inspect that catalog/schema |
| Events were fetched but zero cases were investigated | Review excluded vessel types, eligible case count, budget, and unchanged-case count |
| A model is unavailable | Check the exact serving endpoint and identity permissions; inspect whether the run used the fallback policy/template |
| UI filtering does not start a new analysis | Date filters narrow displayed records; use **Run analysis** to submit a new backend run |

Some earlier notebook versions print “every case was already investigated” whenever no brief is produced, including runs with zero eligible cases. Use the numeric triage log to distinguish filtering from memory-based skips. Reinvestigation cannot recover events that were excluded before triage.

For an isolated manual historical test, choose a new schema rather than deleting shared tables. `reset_tables=true` drops Poseidon tables in the selected schema and should not be used as a routine refresh option.

## Limits and deployment notes

- AIS coverage, vessel identity records, and event classifications have gaps. A signal loss alone does not establish intent or location during the gap.
- Historical telemetry is not necessarily paired with evidence available at that historical moment. Identity lookups, public reporting, and model responses can reflect information retrieved later.
- News location markers can be inferred from place names; they are not vessel observations. Retrieval time and article publication time are different.
- The website job flow shares the App's Databricks identity. It does not provide per-user ownership isolation for runs of the configured job. Restrict access to the intended team.
- The notebook contains a schema-sharing grant for `account users`. Review that access policy before storing sensitive material.
- The bundled `ThreadingHTTPServer` is a lightweight application server. Broader deployment needs a review of authentication, request limits, monitoring, and runtime hardening.
- Submitted jobs consume compute and external API quota. Closing the webpage does not cancel them, and the UI does not currently offer job cancellation.
- Browser requests, local investigations, and manual snapshot sync are not a single transactional workflow. The request-specific result path is the supported way to view a website analysis without replacing the shared publication.

## Data attribution

Poseidon uses data from [Global Fishing Watch](https://globalfishingwatch.org/). Follow the applicable API and dataset terms, including attribution and non-commercial-use restrictions. Keep the source attribution and the “lead for review” disclaimer visible when reusing the interface or exporting results.

Public-source reporting belongs to its respective publishers. Preserve citations and read the linked sources before drawing conclusions from a generated brief.
