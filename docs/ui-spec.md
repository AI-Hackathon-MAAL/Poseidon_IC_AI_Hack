# Poseidon UI specification

A build brief for the front end. It says what every screen contains and which data field feeds each element.
Field names refer to the snapshot JSON described in [backend.md](backend.md).

## 1. Product in one paragraph

Poseidon is a maritime intelligence console. An autonomous agent watches marine protected areas (MPAs) for
vessels that switch off their tracking ("go dark") or appear to fish inside them. For each suspicious vessel
it runs its own investigation (identity, behaviour around the gap, history, live web search), scores the risk
with auditable rules, and writes a cited brief. The UI's job is to let an analyst answer three questions in
under a minute: **What needs my attention? Why does the system think so? Can I trust it?**

Every case is a **lead for review, not proof**. The UI must never present a case as a confirmed violation.

## 2. Data source

- Load one JSON file: `data/poseidon_snapshot.json` (real). If it is missing, load
  `data/poseidon_snapshot.sample.json` (synthetic, same shape) and show a visible `SYNTHETIC DATA` badge
  (the sample has `"synthetic": true`).
- Top-level keys: `latest_run`, `runs[]`, `mpas[]` (with outlines), `cases[]`, `news[]`, `global_news[]`, `generated_at`, `attribution`, `disclaimer`.
- `data/mpa_index.json` (optional): `{id, name}` for every protected area, for the search box. If missing, search only `mpas[]`.
- Each case carries its own `events[]` (map and timeline) and `steps[]` (the agent's decisions).
- No backend calls are needed. Treat the file as read-only. All filtering and sorting happens client-side.
- Times are ISO 8601 UTC. Display as `14 NOV 2026 · 20:41Z`.

## 3. Design language

Mission-control aesthetic: dark, dense, calm, precise. It should feel like an operations console, not a
marketing dashboard.

| Element | Rule |
| --- | --- |
| Background | Near-black navy (`#070B12`), panels one step lighter (`#0D1420`), 1px hairline borders (`#1C2636`). No drop shadows, no gradients except the map |
| Text | Off-white (`#E6EDF5`) primary, slate (`#8A97A8`) secondary |
| Accent | One accent only: cyan (`#35D0E6`) for selection, focus and live indicators |
| Risk colours | High `#FF4D4F`, medium `#FFB020`, low `#3DDC97`, queued/unknown `#5B6B80`. Used only for risk, never decoration |
| Typography | Geometric sans for UI (Inter or similar). Monospace (JetBrains Mono or similar) for all numbers, ids, coordinates, timestamps and MMSI/IMO. Section labels in small caps with wide letter-spacing (`CASE QUEUE`, `AGENT TRACE`) |
| Layout | 8px grid, tight padding, square or 2px-radius corners. Panels dock edge to edge, no floating cards |
| Motion | Minimal and functional: 150ms fades, a slow pulse on the live indicator, step-by-step reveal in the agent trace. Nothing bounces |
| Iconography | Thin-line icons. Vessel markers are small chevrons or diamonds, not pins |
| Tone of copy | Terse and factual: "Tracking lost 100 h", "Identity unresolved", "3 sources". No exclamation marks, no emoji |

## 4. App shell (present on every screen)

**Left rail (collapsed icons, expands on hover):** Globe · Live · Cases · Agent · Areas · Intel · Method.

**Top status bar (always visible, single line):**

| Element | Data |
| --- | --- |
| Wordmark `POSEIDON` + trident glyph | static |
| Mode chip: `HISTORY` or `LIVE` | `latest_run.mode` |
| Window | `latest_run.window_start` → `latest_run.window_end` |
| Areas under watch | `latest_run.mpa_names[]` |
| Last run | `latest_run.finished_at` as relative time ("updated 12 min ago") with a pulsing dot when under 2 hours old |
| Agent summary | "`n_investigated` investigated · `n_skipped_unchanged` unchanged · `n_queued` queued" |
| Data badge | `SYNTHETIC DATA` if `synthetic`, else none |

**Footer strip:** `disclaimer` and `attribution`, always visible, small secondary text.

**Global behaviours:** clicking any vessel name anywhere opens its case dossier. `Esc` closes drawers.
`/` focuses search. Search matches `vessel_name`, `mmsi`, `imo`, `flag`, `owner`, `mpa_name`.

## 5. Views

### 5.1 Globe (landing)

Purpose: the world at a glance, then drill down. Three levels on one map: globe → area → vessel.

**Level 1: Globe.**

- Dark world map (MapLibre globe projection if available, else flat). Opens zoomed out.
- **Protected-area outlines:** draw `mpas[].boundary` (GeoJSON MultiPolygon) for every area. Fill at about 12%
  opacity and stroke in the colour of its highest risk: `n_high > 0` red, else `n_medium > 0` amber, else
  `n_low > 0` green, else grey ("watched, nothing flagged"). If `boundary` is null, show a ring marker at
  `center_lat`/`center_lon` instead. Label each area by name when zoomed in enough.
- **Global intel markers:** `global_news[]` items with `lat`/`lon`, as small cyan diamonds. Cluster when close.
  Hover shows `title` and source domain; click opens the article link. Items with `place_type == "none"`
  appear only in the feed. Country-level markers sit at an approximate country centre: style them lighter
  and label them "country-level".
- **KPI strip (top, monospace numerals):** areas watched (`mpas.length`) · high-risk leads · vessels gone
  dark (`longest_gap_hours != null`) · unidentified vessels · sources cited.
- **Search bar (top centre, `/` to focus):** searches `data/mpa_index.json` (every protected area) plus
  vessels. Choosing an area that exists in `mpas[]` flies the map to its `bbox` and opens its panel.
  Choosing one that does not shows a card: "Not investigated yet. Poseidon can watch this area: run the
  notebook with mpa_ids = <id>."
- **Right rail:** *Global intel feed* (`global_news[]`, newest first, with place tags) above *Priority queue*
  (top 8 cases worldwide by `risk_score`).
- **Bottom ticker:** latest agent activity across all cases (last 6 `steps[]` by `at`).

**Level 2: Area (click an outline, or zoom in past a threshold).**

- Map flies to the area's `bbox`. Its cases appear as markers (coloured by `risk_level`, sized by
  `risk_score`, hollow when queued). For each `gap` event with `end_lat`/`end_lon`, draw the dashed
  "dark segment" from where tracking was lost to where it resumed. Other events as small glyphs.
- **Area panel (left drawer):** name; risk distribution bar; counters (`n_cases`, `n_events`, `n_gap`,
  `n_fishing`, `n_unidentified`, `n_flagged_for_review`); `last_investigated_at`; **Rules** (`rules_summary`
  with `rules_sources[]` links); **Regional context** (`news_summary`); the area's cases as a compact list.
- **Query panel (inside the drawer):** controls that filter what is shown for this area, client-side:
  mode (`history` / `live`), date range (filters `events[]` and cases by `first_event_at`/`last_event_at`),
  event types, minimum risk, identified vs unidentified. Show the loaded window from the case's
  `window_start`/`window_end` so the user knows the limits. Below it, a muted note: "To investigate a
  different period, run Poseidon for this area" with the area's id to copy.
- Boundary attribution in the map corner from `boundary_source`.

**Level 3: Vessel (click a marker or a list row).** Opens the case dossier (5.4).

Back navigation: breadcrumb `Globe › Area name › Vessel name`; `Esc` goes up one level.

### 5.2 Live

Purpose: the monitoring view. Same layout as the Globe's area level but filtered to cases with `mode == "live"`, with a
pulsing `LIVE` chip and a freshness banner.

- Banner (mandatory, honest): "Latest available data. Global Fishing Watch publishes events with a delay;
  the most recent days may be incomplete." plus "Window: last N days" from the run window.
- *New since last run* lane: cases where `change` is `new` or `updated`, with `previous_risk_score` →
  `risk_score` shown as a delta (`40 → 75 ▲`).
- *Watch status* per area from `mpas[]`: `n_flagged_for_review`, `n_gap`, `latest_event_at`, `last_investigated_at`.
- Run history sparkline from `runs[]` (events and investigations per run) to show the monitor is working.
- Empty state: "No live runs yet. Run the Poseidon notebook with mode = live."

### 5.3 Cases (the queue)

Purpose: triage. A dense, sortable, filterable table. One row per case.

Columns: Risk (`risk_score` + colour bar) · Vessel (`vessel_name`, with an `UNIDENTIFIED` tag when
`vessel_identified == false`) · Flag · Area (`mpa_name`) · Signal (`headline`) · Dark time (`longest_gap_hours`
as `100 h`) · Confidence · Status · Change · Last event (`last_event_at`) · Steps (`n_steps`).

Filters (left panel or top chips): risk level, status (`complete` / `incomplete` / `queued`), confidence,
area, flag, event types (`event_types` contains), identified vs unidentified, mode (`history` / `live`).

Status chips: `complete` (solid), `incomplete` (amber outline, tooltip lists `unknowns[]`), `queued` (grey,
"awaiting investigation"). Change chips: `NEW`, `UPDATED`, `RETRY`, `FORCED`.

Row click opens the dossier. Keyboard: `↑`/`↓` to move, `Enter` to open.

### 5.4 Case dossier (drawer or full page; the most important screen)

Header band: `vessel_name` large; identity line in monospace `FLAG · MMSI · IMO · CALLSIGN · TYPE`; owner;
risk score dial (0–100, coloured); `risk_level`, `confidence` and `status` chips; `headline` as the subtitle.

Sections, in this order:

1. **Assessment.** The list of `reasons[]`: each row shows `text`, `+points`, and a small tag for `basis`
   (`events` = tracking data, `gfw_vessel` = registry, `gfw_history` = 12-month history, `web` = public reports).
   Render as a stacked bar that sums to `risk_score`, so the score is visibly the sum of its reasons.
2. **Timeline.** Horizontal UTC timeline of `events[]`. Gaps drawn as hatched "dark" spans with their duration;
   fishing, encounter and loitering as markers. Add items from `evidence.activity_around_event.before/after`
   (events found by the agent outside the area) in a muted style.
3. **Track map.** Mini map of this case only: off-position, on-position, dashed dark segment, distance moved
   (`evidence.activity_around_event.gap_distance_km`).
4. **Brief.** Render `brief_markdown` as Markdown. Inline citations `[n]` link to source `n`. Label who wrote
   it from `brief_written_by` (`llm` → "Written by model from gathered facts", `template` → "Template brief").
5. **Sources.** Numbered list from `sources[]`: `n`, `title` (link to `url`, opens new tab), `snippet`, and a
   tag for `kind` (vessel / owner / area rules / regional news).
6. **What we don't know.** `unknowns[]` as a plain list in an amber-bordered panel. Never hide this section;
   if empty, show "No gaps flagged in this investigation."
7. **Identity.** From `evidence.resolve_identity`: names, flags, IMO, callsign, owners, gear types, registry
   record count. Highlight multiple names or flags.
8. **History.** From `evidence.vessel_history.counts`: five small counters (gaps, fishing, encounters,
   loitering, port visits) for the previous 12 months.
9. **Agent trace.** The embedded version of 5.5 for this case.

Queued cases show only the header, the events, and "Awaiting investigation".

### 5.5 Agent (how it thinks)

Purpose: prove autonomy and make it auditable. Two parts.

**A. Trace viewer.** Pick a case; show `steps[]` as a vertical sequence. Each step:

| Element | Data |
| --- | --- |
| Step number and time | `step_no`, `at` |
| Tool name as a labelled node | `tool` |
| Who decided | `decided_by`: `llm` → cyan tag "MODEL", `policy` → grey tag "RULES" |
| Why | `reason` (the agent's stated reason) |
| Outcome | `result`, with a success or failure mark from `ok`; failed steps in amber |
| Duration | `duration_ms` |

Include a **Replay** button that reveals steps one at a time (about 700ms each) for demos. The final `finish`
step is rendered as an end cap.

Tool labels for display: `resolve_identity` "Resolve identity" · `activity_around_event` "Activity ±72 h" ·
`vessel_history` "12-month history" · `encounter_partner` "Encounter partner" · `web_search_vessel` "Web: vessel"
· `web_search_owner` "Web: owner" · `mpa_rules` "Web: area rules" · `regional_news` "Web: regional news" · `finish` "Finish".

**B. Run log.** From `latest_run`:
- Counters: `n_events`, `n_cases`, `n_investigated`, `n_skipped_unchanged` ("remembered"), `n_queued`,
  `n_incomplete`, `llm_decisions` vs `policy_decisions` (show as a ratio bar), `gfw_calls`, `search_calls`.
- **Triage table** from `latest_run.triage[]`: `vessel`, `priority`, `decision` (`investigate` /
  `queued` / `skip_unchanged`), `change`, `reason`. This shows the agent choosing what to work on.
- `notes[]` as a plain list (operational warnings).
- `objective` shown as the agent's standing order in a quoted panel.
- `llm_endpoint` and `search_provider` as small metadata.

### 5.6 Areas

Purpose: per protected-area status. One card or row per `mpas[]` entry.

Each area: name; risk distribution bar (`n_high` / `n_medium` / `n_low`); counters (`n_cases`, `n_events`,
`n_gap`, `n_fishing`, `n_encounter`, `n_loitering`, `n_unidentified`, `n_flagged_for_review`);
`top_risk_score`; `latest_event_at`; `last_investigated_at`.

Expanded area view: `rules_summary` with `rules_sources[]` links ("What the rules are"), `news_summary`
("Regional context"), and the area's cases as a compact list.

### 5.7 Intel

Purpose: fresh, cited web context. Two feeds, newest first: *Global* (`global_news[]`, with `place_name` tags) and *By area* (`news[]`).

Each item: `title` (link to `url`), source domain extracted from the URL, `snippet`, `mpa_name` tag,
`fetched_at`, and `provider` ("via Linkup"). Filter by area. Group by day.

### 5.8 Method (trust page)

Purpose: explain the system honestly. Static content plus live numbers.

- How a score is built: the points table. Signal lost or regained inside the area 30 (a gap whose two ends
  are both outside the outline scores only 10: the vessel's presence inside is not established); dark 24 h+
  +10 or 72 h+ +15; apparent fishing inside 20 with no matching public authorization, 15 if unknown, 5 if
  publicly authorized; no-take zone +10; fishing within 48 h of reappearing 15; reappeared 50 km+ away 5;
  encounter 10 (loitering alone 5); unidentified 10; several flags 5; several real names 5 (spelling variants
  do not count); 3+ gaps in 12 months 5; web reports naming the vessel or owner 15 each (vessel-database
  pages do not count). Maximum 100.
- What the agent decides (which checks, when to stop) versus what code decides (scores, durations, status).
- Limits: a gap is not guilt; data is delayed; vessels without AIS are invisible; scores are signals, not probabilities.
- Data sources and attribution.

## 6. States every view must handle

| State | Behaviour |
| --- | --- |
| No snapshot file | Fall back to the sample file with the `SYNTHETIC DATA` badge |
| Empty `cases` | "No cases in this window" with the run window shown |
| `status == "queued"` | Grey treatment; no brief, no trace; "Awaiting investigation" |
| `status == "incomplete"` | Amber outline; surface `unknowns[]` prominently |
| Missing optional fields (`imo`, `owner`, `lat`…) | Show `—`; never "null" or "undefined"; skip map marker if no coordinates |
| No `sources` | "No relevant public reports found" (this is a finding, not an error) |
| `policy_decisions > 0` and `llm_decisions == 0` | Banner on Agent view: "This run used rule-based decisions (no model available)" |

## 7. Wording rules

- Say "apparent fishing", "lead", "flagged for review". Never "illegal vessel", "caught", "guilty" or "violation confirmed".
- Always show `confidence` next to `risk_score`.
- Keep the disclaimer visible in the footer on every screen.

## 8. Suggested build order

1. App shell, theme and snapshot loader (with sample fallback).
2. Cases table.
3. Case dossier (assessment, brief, sources, unknowns).
4. Globe with area outlines, intel markers, search and the area drill-down with dark-gap segments.
5. Agent trace with replay.
6. Live view, Areas, Intel, Method.

Stack suggestion: React + TypeScript + Vite, Tailwind for styling, MapLibre GL (or Leaflet) for the map,
`react-markdown` for briefs. Everything runs as a static site.
