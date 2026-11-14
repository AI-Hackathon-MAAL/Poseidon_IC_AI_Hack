# Poseidon backend: what the front end can rely on

Poseidon watches marine protected areas (MPAs) for vessels with gaps in vessel tracking or apparent fishing
inside them, investigates each one, and writes a cited brief. This page is the contract between the
backend (`notebooks/poseidon`) and the front end.

**Start here:** `data/poseidon_snapshot.json` contains the team’s real export. It is a saved historical run collection, not a live feed. The synthetic fixture, `data/poseidon_snapshot.sample.json`, is only for tests.

Every case is a **lead for review, not proof**. Show `disclaimer` and `attribution` somewhere visible.

## 1. Opening the monitor

Run `npm start` in this checkout and open `http://127.0.0.1:3000/`. The original Poseidon globe reads the notebook contract from `GET /api/snapshot`; old `/monitor` bookmarks lead to the same globe. Select an area and case, then **Open brief** to inspect the exported findings, sources, news and agent decisions in the evidence drawer. The bundled export contains 74 Galápagos cases and 19 Hermandad cases from three historical runs (14 November 2026 export). The page opens on the latest run’s area. A tracking gap is a gap in reception; transmitters classified as gear do not identify a fishing vessel. A browser refresh reads the latest export. In **Date**, filter by observation date or by the investigation's history/live mode. These controls select existing cases; use the notebook or a scheduled job to launch a new run. Published historical replays remain available at `/archive`.

**Use a local export.** Download `poseidon_snapshot.json` from the notebook's export volume. In PowerShell set `$env:POSEIDON_SNAPSHOT_PATH = 'C:/path/to/poseidon_snapshot.json'` before starting the server. An unavailable configured export returns HTTP 503. The server reports `X-Poseidon-Source: bundled-export` for the checked-in notebook output or `export` for a configured file or volume. Newer notebooks include explicit source flags. The bundled file predates those flags and is retained as supplied.

**Use the monitor inside Databricks.**

1. Run `notebooks/poseidon` in the Git folder. Choose `data_source=sample` for synthetic vessels or `gfw` for Global Fishing Watch. For the latter, the notebook uses the secrets `hackathon/gfw_token` and, for Linkup, `hackathon/linkup_key`. The default output is `/Volumes/workspace/poseidon/exports/poseidon_snapshot.json` for real data and `/Volumes/workspace/poseidon_sample/exports/poseidon_snapshot.json` for the sample.
2. Create a Databricks App for this repository root. Add a Unity Catalog volume resource named `poseidon-exports` with read access to the desired exports volume. Deploy the root containing `app.yaml`, `package.json` and `server.mjs`.
3. Open the app. Its service principal reads the export through the workspace Files API. The browser requests only the app's own `/api/snapshot`. Refresh the page to see the newly exported cases after a notebook run.

Databricks documents the app's [volume resource path](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/environment-variables), [service principal authentication](https://docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m) and [file download API](https://docs.databricks.com/api/workspace/files/download).

## 2. Snapshot shape

```jsonc
{
  "product": "Poseidon",
  "data_source": "gfw",
  "generated_at": "2026-11-14T20:00:00+00:00",
  "attribution": "...", "disclaimer": "...",
  "latest_run": { /* one row of `runs`: mode, window, counts, triage, notes */ },
  "runs":  [ /* the last 20 runs, short form */ ],
  "mpas":  [ /* one per protected area: `mpa_status` fields + news_summary, rules_summary, rules_sources */ ],
  "cases": [ /* one per vessel per area, highest risk first: `cases` fields + "events": [...] + "steps": [...] */ ],
  "news":  [ /* cited news items, newest first */ ]
}
```

Inside the snapshot, JSON columns (`reasons`, `sources`, `evidence`, ...) are already parsed objects.
In the tables they are JSON strings.

## 3. Which data feeds which screen

| Screen | Use |
| --- | --- |
| Map | `cases[].lat/lon` (pin, colour by `risk_level`); `cases[].events[]` with `lat/lon` and, for gaps, `end_lat/end_lon` (show the two observed endpoints and label the intervening route unknown) |
| Alert queue | `cases[]`: `headline`, `risk_score`, `risk_level`, `confidence`, `status`, `change`, `vessel_name`, `flag`, `mpa_name`, `longest_gap_hours` |
| Case page | `brief_markdown` (render as Markdown), `reasons[]` (text + points), `unknowns[]`, `sources[]` (numbered links; `[n]` in the brief refers to `sources[].n`) |
| "Watch the agent think" | `cases[].steps[]`: `step_no`, `tool`, `decided_by` (`llm` or `policy`), `reason`, `ok`, `result`. Replay them in order |
| Area overview | `mpas[]`: counts by risk level, event counts, `news_summary`, `rules_summary` |
| News feed | `news[]`: `title`, `url`, `snippet`, `mpa_name`, `fetched_at` |
| Run banner | `latest_run`: `mode`, `window_start/end`, `n_investigated`, `n_skipped_unchanged`, `llm_decisions`, `policy_decisions`, `notes[]` |

## 4. Tables (`workspace.poseidon`)

### `cases` — one row per vessel per protected area (key: `case_id`)

| Field | Meaning |
| --- | --- |
| `case_id` | `<mpa_id>:<vessel_id>` |
| `mpa_id`, `mpa_name` | Protected area |
| `vessel_id` | Global Fishing Watch vessel id |
| `vessel_name` | Best known name, or `Unidentified vessel (MMSI ...)` |
| `vessel_identified` | `false` when no name could be established |
| `flag`, `mmsi`, `imo`, `callsign`, `vessel_type`, `owner` | Identity details (null when unknown) |
| `risk_score` | 0–100, computed by code from evidence |
| `risk_level` | `high` (70+), `medium` (40–69), `low` |
| `confidence` | `high` / `medium` / `low`: how much of the evidence could be gathered |
| `status` | `complete`, `incomplete` (a key check failed; see `unknowns`), `queued` (not investigated yet) |
| `tracking_status` | `flagged_for_review` (gap of 12 h+), `insufficient_data`, `no_qualifying_gap_found` |
| `headline` | One-line summary for cards |
| `reasons` | JSON list of `{text, points, basis}`; `basis` identifies the event or vessel record supporting each point. Web search results are leads for review and contribute no points |
| `unknowns` | JSON list of plain sentences: what could not be established |
| `sources` | JSON list of `{n, kind, title, url, snippet}`; `kind` is the check that found it |
| `evidence` | JSON object: raw result of every check the agent ran (keyed by tool name) |
| `event_ids`, `event_types`, `n_events` | The events behind the case |
| `first_event_at`, `last_event_at`, `longest_gap_hours` | Timing |
| `lat`, `lon` | Position of the main event (where tracking went off, for gaps) |
| `brief_markdown` | The brief (null while `queued`) |
| `brief_written_by` | `llm` or `template` |
| `change` | `new`, `updated` (new events since last time), `retry`, `forced` |
| `previous_risk_score` | Score from the previous investigation, if any |
| `fingerprint` | Memory key, refreshed when event IDs or their recorded evidence change. Existing ID-only fingerprints are refreshed on the first matching run after this upgrade |
| `n_steps`, `llm_decisions`, `policy_decisions` | How the investigation ran |
| `mode`, `window_start`, `window_end`, `run_id`, `investigated_at` | Which run produced this row |

### `events` — one row per Global Fishing Watch event (key: `event_id`, `event_type`)

| Field | Meaning |
| --- | --- |
| `event_id`, `event_type` | `gap` (tracking off), `fishing`, `encounter`, `loitering` |
| `mpa_id`, `mpa_name`, `case_id` | Where it belongs |
| `vessel_id`, `vessel_name`, `mmsi`, `flag`, `vessel_type` | Vessel as reported in the event |
| `start_time`, `end_time`, `duration_hours` | UTC |
| `lat`, `lon` | Event position; for gaps, last observed position before the gap |
| `end_lat`, `end_lon` | For gaps, next observed position after the gap |
| `details` | JSON: `gap_distance_km`, `in_no_take_mpa`, `partner_vessel_name`, ... (only present keys) |
| `also_in_mpas` | JSON list of other selected areas that also contain this event |
| `mode`, `run_id`, `fetched_at` | Which run fetched it |

### `agent_steps` — the agent's decisions (key: `run_id`, `case_id`, `step_no`)

`run_id`, `case_id`, `step_no`, `at`, `tool`, `decided_by` (`llm` / `policy`), `reason`, `ok`, `result`, `duration_ms`.

Tools: `resolve_identity`, `activity_around_event`, `vessel_history`, `encounter_partner`,
`web_search_vessel`, `web_search_owner`, `mpa_rules`, `regional_news`, `finish`.

### `runs` — one row per run (key: `run_id`)

`run_id`, `mode`, `window_start`, `window_end`, `mpa_ids`, `mpa_names`, `started_at`, `finished_at`,
`n_events`, `n_cases`, `n_investigated`, `n_skipped_unchanged`, `n_queued`, `n_incomplete`,
`llm_decisions`, `policy_decisions`, `llm_endpoint`, `search_provider`, `gfw_calls`, `search_calls`,
`triage` (JSON: every case with its priority, decision and reason), `notes` (JSON list), `objective`.

### `news` — cited news items (key: `news_id`)

`news_id`, `mpa_id`, `mpa_name`, `title`, `url`, `snippet`, `query`, `from_date`, `provider`, `fetched_at`, `run_id`.

### `mpa_context` — web context per area (key: `mpa_id`)

`mpa_id`, `mpa_name`, `news_summary`, `news_sources`, `rules_summary`, `rules_sources`, `updated_at`, `run_id`.

### `mpa_status` — dashboard numbers per area (rebuilt every run)

`mpa_id`, `mpa_name`, `n_cases`, `n_high`, `n_medium`, `n_low`, `n_incomplete`, `n_queued`,
`n_flagged_for_review`, `n_unidentified`, `top_risk_score`, `n_events`, `n_gap`, `n_fishing`,
`n_encounter`, `n_loitering`, `latest_event_at`, `last_investigated_at`.

## 5. Running it

Open `notebooks/poseidon` from the Git folder, set the widgets, **Run all**.

| Widget | Meaning |
| --- | --- |
| `mode` | `history` (uses `start_date`, `end_date`) or `live` (uses `lookback_days`, counted back from now) |
| `mpa_ids` / `mpa_search` | Ids win; otherwise every area whose name contains the search text (accents ignored). `11753` = Galápagos Marine Reserve |
| `max_cases` | How many cases the agent investigates per run (highest priority first; the rest are `queued`) |
| `max_steps` | Step budget per case |
| `focus` | Comma-separated vessel names, ids or MMSIs to investigate first |
| `force_reinvestigate` | Investigate again even if nothing changed |
| `data_source` | `gfw` (real) or `sample` (synthetic; no keys needed; areas `sample-1`, `sample-2`). For sample live mode the simulated clock is 31 October 2026 |
| `search_provider` | `linkup`, `tavily` or `none` |
| `llm_endpoint` | `auto` finds a working chat model in the workspace |
| `catalog` / `schema` | Set the catalog and base schema. Sample runs use `<schema>_sample`. Normal reruns use stored case memory. |

The unified notebook uses ordinary reruns to switch modes and sources. Older runs with no source label remain in storage. The monitor and case memory use source-tagged runs, so older cases are investigated again when selected. The case list shows the most recently stored investigation for each vessel and area. Its mapped events are the ones used in that investigation.

**Live monitoring:** create a Databricks Job with this notebook as its task, parameters `mode=live`,
schedule hourly, max concurrent runs 1. Because the agent remembers cases, a scheduled run only
investigates vessels that are new or have new events.

## 6. What "autonomous" means here

- **It triages.** Cases are ranked (new evidence, long or repeated gaps, fishing, unnamed vessels) and it works down the list within its budget.
- **It chooses its own checks.** For each case a language model picks the next tool from the ones currently allowed, and decides when to stop. Some tools only become available after others succeed (owner search needs an identified owner).
- **It adapts.** A failed check is recorded; temporary outages are retried once; otherwise it moves on and the case is marked `incomplete` with the reason in `unknowns`.
- **It remembers.** Unchanged cases are skipped; cases with new events are reopened and show `previous_risk_score`.
- **Code keeps it honest.** Scores, durations, positions and the complete/incomplete verdict come from code and source data. The model never sets a number. If the model is unavailable, a rule-based policy makes the choices and `decided_by` says so.
