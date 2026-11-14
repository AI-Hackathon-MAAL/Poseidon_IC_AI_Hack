# Poseidon backend: what the front end can rely on

Poseidon watches marine protected areas (MPAs) for vessels that switch off tracking or appear to fish
inside them, investigates each one, and writes a cited brief. This page is the contract between the
backend (`notebooks/poseidon`) and the front end.

**Start here:** `data/poseidon_snapshot.sample.json` is a synthetic example of the exact JSON the
backend produces. Build against it now; swap in the real file later with no code changes.

Every case is a **lead for review, not proof**. Show `disclaimer` and `attribution` somewhere visible.

## 1. Getting the data

| Way | What you get | When to use |
| --- | --- | --- |
| `data/poseidon_snapshot.json` in GitHub | The latest real snapshot, committed from Databricks | Easiest for the front end: just pull the repo |
| Snapshot file | One JSON document with everything | Simplest. Written on every run to `/Volumes/workspace/poseidon/exports/poseidon_snapshot.json` (download it from Catalog Explorer and bundle it with the app) |
| Delta tables | `workspace.poseidon.*` (section 4) | A Databricks App, dashboard or Genie space reading live |

A browser cannot call Databricks directly (it needs a secret token). For live data in a web front end,
serve it through a Databricks App; ask and the snapshot can be exposed as `/api/snapshot` there.

## 2. Snapshot shape

```jsonc
{
  "product": "Poseidon",
  "generated_at": "2026-11-14T20:00:00+00:00",
  "attribution": "...", "disclaimer": "...",
  "latest_run": { /* one row of `runs`: mode, window, counts, triage, notes */ },
  "runs":  [ /* the last 20 runs, short form */ ],
  "mpas":  [ /* one per protected area: `mpa_status` fields + news_summary, rules_summary, rules_sources */ ],
  "cases": [ /* one per vessel per area, highest risk first: `cases` fields + "events": [...] + "steps": [...] */ ],
  "news":  [ /* cited news items per area, newest first */ ],
  "global_news": [ /* worldwide news items with place_type, place_name, lat, lon for the globe */ ]
}
```

Each entry of `mpas[]` also carries the outline for the map:

```jsonc
{ "mpa_id": "11753", "mpa_name": "...", /* status counts */,
  "boundary": { "type": "MultiPolygon", "coordinates": [...] },   // simplified GeoJSON, [lon, lat]; null if not found
  "bbox": [west, south, east, north], "center_lat": -0.5, "center_lon": -90.5,
  "boundary_source": "WDPA (UNEP-WCMC and IUCN, Protected Planet)" }
```

Inside the snapshot, JSON columns (`reasons`, `sources`, `evidence`, ...) are already parsed objects.
In the tables they are JSON strings.

## 3. Which data feeds which screen

| Screen | Use |
| --- | --- |
| Map | `cases[].lat/lon` (pin, colour by `risk_level`); `cases[].events[]` with `lat/lon` and, for gaps, `end_lat/end_lon` (draw the line from where tracking went off to where it came back) |
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
| `reasons` | JSON list of `{text, points, basis}`; `basis` is `events`, `gfw_vessel`, `gfw_history` or `web` |
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
| `fingerprint` | Memory key: changes when the case's events change |
| `n_steps`, `llm_decisions`, `policy_decisions` | How the investigation ran |
| `mode`, `window_start`, `window_end`, `run_id`, `investigated_at` | Which run produced this row |

### `events` — one row per Global Fishing Watch event (key: `event_id`, `event_type`)

| Field | Meaning |
| --- | --- |
| `event_id`, `event_type` | `gap` (tracking off), `fishing`, `encounter`, `loitering` |
| `mpa_id`, `mpa_name`, `case_id` | Where it belongs |
| `vessel_id`, `vessel_name`, `mmsi`, `flag`, `vessel_type` | Vessel as reported in the event |
| `start_time`, `end_time`, `duration_hours` | UTC |
| `lat`, `lon` | Event position; for gaps, where tracking went **off** |
| `end_lat`, `end_lon` | For gaps, where tracking came back **on** |
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

### `mpa_boundaries` — outline per area (key: `mpa_id`; fetched once, then reused)

`mpa_id`, `mpa_name`, `geometry` (JSON: simplified GeoJSON MultiPolygon, outer rings only, for drawing not
measuring), `bbox` (JSON `[west, south, east, north]`), `center_lat`, `center_lon`, `source`, `error`, `fetched_at`.

### `global_news` — worldwide intel for the globe (key: `news_id`)

`news_id`, `title`, `url`, `snippet`, `query`, `place_type` (`mpa`, `country` or `none`), `place_name`,
`mpa_id`, `lat`, `lon` (null when `place_type` is `none`), `from_date`, `provider`, `fetched_at`, `run_id`.
Placement is by name match in code: a watched area's centre, else an approximate country centre.

### `data/mpa_index.json` — search index (file, not a table)

A list of `{id, name}` for every protected area Global Fishing Watch knows (about 17,500). Use it for the
search box. Areas with an entry in `mpas[]` have data; the rest show "not investigated yet".

### `mpa_status` — dashboard numbers per area (rebuilt every run)

`mpa_id`, `mpa_name`, `n_cases`, `n_high`, `n_medium`, `n_low`, `n_incomplete`, `n_queued`,
`n_flagged_for_review`, `n_unidentified`, `top_risk_score`, `n_events`, `n_gap`, `n_fishing`,
`n_encounter`, `n_loitering`, `latest_event_at`, `last_investigated_at`.

## 5. Running it

Open `notebooks/poseidon` from the Git folder, set the widgets, **Run all**.

| Widget | Meaning |
| --- | --- |
| `mode` | `history` (uses `start_date`, `end_date`) or `live` (uses `lookback_days`, counted back from now) |
| `mpa_ids` / `mpa_search` | Ids win (leave empty to use the search); otherwise every area whose name contains the search text (accents ignored). Several names can be given separated by commas (up to 2 matches each, 12 areas per run). `11753` = Galápagos Marine Reserve |
| `max_cases` | How many cases the agent investigates **per protected area** per run (highest priority first; the rest are `queued`) |
| `max_steps` | Step budget per case |
| `focus` | Comma-separated vessel names, ids or MMSIs to investigate first |
| `force_reinvestigate` | Investigate again even if nothing changed |
| `data_source` | `gfw` (real) or `sample` (synthetic; no keys needed; areas `sample-1`, `sample-2`) |
| `search_provider` | `linkup`, `tavily` or `none` |
| `llm_endpoint` | `auto` finds a working chat model in the workspace |
| `reset_tables` | Drops every Poseidon table first. Set back to `false` afterwards |
| `snapshot_scope` | `all_areas` (default): the snapshot contains every area investigated so far, for the globe. `this_run_areas`: only this run's areas |
| `global_news` | Also fetch worldwide news for the globe (3 Linkup searches per run) |
| `snapshot_to_repo` | Also writes `data/poseidon_snapshot.json` into the Git folder, ready to commit and push |

**Live monitoring:** create a Databricks Job with this notebook as its task, parameters `mode=live`,
schedule hourly, max concurrent runs 1. Because the agent remembers cases, a scheduled run only
investigates vessels that are new or have new events.

## 6. What "autonomous" means here

- **It triages.** Cases are ranked (new evidence, long or repeated gaps, fishing, unnamed vessels) and it works down the list within its budget.
- **It chooses its own checks.** For each case a language model picks the next tool from the ones currently allowed, and decides when to stop. Some tools only become available after others succeed (owner search needs an identified owner).
- **It adapts.** A failed check is recorded; temporary outages are retried once; otherwise it moves on and the case is marked `incomplete` with the reason in `unknowns`.
- **It remembers.** Unchanged cases are skipped; cases with new events are reopened and show `previous_risk_score`.
- **Code keeps it honest.** Scores, durations, positions and the complete/incomplete verdict come from code and source data. The model never sets a number. If the model is unavailable, a rule-based policy makes the choices and `decided_by` says so.
