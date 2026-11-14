> **Superseded.** These are the tables of the earlier `00`–`03` pipeline. Poseidon's tables and the front-end contract are in [backend.md](backend.md).

# Table schemas

All tables live in `<catalog>.<schema>` — default `workspace.dark_fishing`.
The agent writes `briefs`; the front end only reads `briefs` (and optionally `candidates` for the map).

## `mpas`

| Column | Type | Notes |
| --- | --- | --- |
| mpa_id | string | GFW region id in dataset `public-mpa-all` |
| mpa_name | string | Label from GFW |
| raw | string | Full JSON record |

## `candidates`

One row per suspicious event found by the pipeline.

| Column | Type | Notes |
| --- | --- | --- |
| event_id | string | GFW event id (or `sample-…`) |
| event_type | string | `gap`, `fishing`, `encounter`, `loitering` |
| mpa_id | string | MPA the query was run against |
| mpa_name | string | |
| vessel_id | string | GFW vessel id |
| vessel_name | string | |
| mmsi | string | GFW `ssvid` |
| flag | string | ISO3 flag |
| start_time | timestamp | UTC |
| end_time | timestamp | UTC |
| duration_hours | double | |
| lat | double | Event position (for gaps: where tracking went off) |
| lon | double | |
| source | string | `gfw` or `sample` |
| raw | string | Full JSON event |

## `briefs`

One row per lead the agent investigated. **Front end reads this.**

| Column | Type | Notes |
| --- | --- | --- |
| brief_id | string | |
| event_id | string | Links to `candidates` |
| vessel_id | string | |
| vessel_name | string | |
| flag | string | |
| mpa_name | string | |
| event_type | string | |
| start_time | timestamp | |
| end_time | timestamp | |
| lat | double | |
| lon | double | |
| risk_score | int | 0–100 |
| risk_level | string | `high`, `medium`, `low` |
| reasons | string | JSON array of plain-language reasons |
| sources | string | JSON array of `{title, url}` the agent cited |
| brief_markdown | string | The one-page brief |
| agent_trace | string | JSON array of `{step, detail, data, at}` — what the agent did, for the live replay in the UI |
| created_at | timestamp | |
