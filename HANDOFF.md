# Poseidon — project handoff

Written 14 Nov 2026, 22:00 London time, to hand this project from a Claude chat session to Claude Code.
Read this first, then `AGENTS.md`, `docs/backend.md` and `docs/ui-spec.md`.

## 1. The situation

- **Event:** Imperial AI hackathon, Autonomous Agents track. **Submission deadline: Sunday 15 Nov 2026, 12:00 London time.**
- **Bounties targeted:** Databricks (main; scored on creativity, technical depth, real-world impact), Linkup (agent that researches and verifies fresh information with cited sources).
- **Team:** Kingston (backend lead, owns this session), aarin (owns the GitHub org; wrote the earlier live monitor `notebooks/03_live_mpa_monitor.py`), Louis (front end, using ChatGPT Codex, building in `app/`).
- **Repo:** `AI-Hackathon-MAAL/Imperial-AI-Hackathon` (private), branch `main`. Earlier lived at `aarinr/Imperial-AI-Hackathon`.

## 2. The product

**Poseidon, "protector of the sea"**: an autonomous agent that watches marine protected areas (MPAs) for
vessels that switch off AIS tracking ("go dark") or appear to fish inside them, investigates each vessel,
and writes a cited brief. Every case is a **lead for review, not proof**.

Pitch: "Poseidon does the first hour of an investigator's work on every suspicious vessel, ranks them, and
hands over a cited lead with its uncertainty spelled out."

Honest framing the team agreed on: it speeds up investigation of events Global Fishing Watch already
publishes; it does not detect vessels with no AIS; data is delayed (days); a gap is not guilt; the scoring
weights are judgement, not validated.

## 3. What makes it an autonomous agent (and not a pipeline)

1. **Triage** — ranks every vessel-in-area case (long or repeated gaps, fishing, gap then fishing, unnamed vessel, new evidence) and works down the list within a budget.
2. **Chooses its own checks** — per case, a Databricks foundation model picks the next tool from those currently allowed and decides when to stop. Tools unlock as evidence arrives (owner search needs an identified owner).
3. **Adapts** — failures are recorded; transient errors (5xx, 429, network) are retried once; 404s are not; a case that cannot be completed is `incomplete` with `unknowns`.
4. **Remembers** — a fingerprint of each case's event ids; unchanged complete cases are skipped next run; new events reopen a case and show `previous_risk_score`.
5. **Auditable** — scores, durations, positions and complete/incomplete come from code. The model never sets a number. If the model is unavailable or answers badly, a rule-based policy decides; every step records `decided_by` = `llm` or `policy` and a reason.

## 4. Repository map

| Path | Purpose | Status |
| --- | --- | --- |
| `notebooks/poseidon.py` | **The one notebook to run.** Widgets, connections, run, save tables, snapshot | Current |
| `poseidon/gfw.py` | GFW v3 client (retries, pagination), `resolve_window()` (only difference between modes), `flatten_event()`, `summarize_identity()` | Current |
| `poseidon/search.py` | Linkup client; returns `{answer, sources[]}`; retries without date filters on HTTP 400 | Current |
| `poseidon/agent.py` | `Case`, 8 tools, `available_tools()`, `choose_next()` (LLM → JSON), `policy_choice()`, `investigate()` loop, `assess()` | Current, core |
| `poseidon/scoring.py` | Deterministic score with reasons; `web_risk_hits()` only counts sources naming this vessel/owner AND a risk term | Current |
| `poseidon/brief.py` | LLM brief from facts only, `clean_markdown()`, template fallback, caveat line | Current |
| `poseidon/pipeline.py` | `select_mpas()`, `collect_events()` (dedup across overlapping areas), `build_cases()`, `fingerprint()`, `triage()`, `run()` | Current |
| `poseidon/contract.py` | `TABLES` (single source of truth for Delta tables), `mpa_status_rows()`, `build_snapshot()` | Current |
| `poseidon/geo.py` | MPA outlines: GFW then WDPA ArcGIS, Douglas-Peucker simplification, bbox/centre | Current, **untested against real sources** |
| `poseidon/intel.py` | Global news via 3 Linkup searches, placed by area or country name match (code, not model) | Current |
| `poseidon/sample.py` | Synthetic GFW, Linkup and scripted LLM for tests and `data_source = sample` | Current |
| `tests/test_poseidon.py` | 35 unit tests (with `tests/test_live_monitor.py`). Run `python -m unittest discover -s tests` | All pass |
| `scripts/make_sample_snapshot.py` | Regenerates `data/poseidon_snapshot.sample.json` | Current |
| `docs/backend.md` | Data contract: snapshot shape, every table and field, widgets, autonomy explanation | Current |
| `docs/ui-spec.md` | Front-end spec (Anduril/Palantir style console; Globe → Area → Vessel) | Current |
| `AGENTS.md` | Instructions for Codex (Louis) | Current |
| `data/poseidon_snapshot.sample.json` | Synthetic snapshot, same shape as real | Current |
| `data/poseidon_snapshot.json`, `data/mpa_index.json` | Real outputs, committed from Databricks | **Not created yet** |
| `agent/`, `notebooks/00`–`03`, `docs/schema.md`, `docs/live-monitor.md`, `data/sample_*.json` | Earlier pipeline (Kingston's 00–02, aarin's 03). Superseded by Poseidon; left in place because 03 is aarin's | Legacy |

## 5. How a run works

`notebooks/poseidon.py` cells: load code → widgets → connect (GFW, Linkup, auto-pick a chat model
endpoint that answers) → window and areas → **`pipeline.run()`** → save tables (MERGE on keys) →
outlines and global news → snapshot (Volume + copy into Git folder) → results display.

Inside `pipeline.run()`: fetch region events (gap, fishing, encounter, loitering) → group into cases
(vessel × MPA) → per-area news (Linkup) → triage with memory (per-area budget) → for each case:
decide → act → observe loop → score → brief → rows.

Agent tools: `resolve_identity` (with MMSI search fallback), `activity_around_event` (±72 h around the
longest gap or first fishing event, all 5 event types incl. port visits), `vessel_history` (12-month
counts), `encounter_partner`, `web_search_vessel`, `web_search_owner`, `mpa_rules`, `regional_news`, `finish`.

Scoring (max 100): gap 30; longest gap ≥24 h +10 or ≥72 h +15; fishing 20; no-take zone 10; GFW
potential-risk flag 5; fishing within 48 h of a gap ending 15; moved ≥50 km while dark 5;
encounter/loitering 10; unidentified 10; multiple flags 5; multiple names 5; ≥3 gaps in 12 months 5;
web hits naming vessel 15; naming owner 15. Levels: high ≥70, medium ≥40.

## 6. Data outputs (`workspace.poseidon`)

Tables: `cases`, `events`, `agent_steps`, `runs`, `news`, `mpa_context`, `mpa_boundaries`, `global_news`,
`mpa_status`. Full field list in `docs/backend.md`; definitions in `poseidon/contract.py`.

Snapshot: `/Volumes/workspace/poseidon/exports/poseidon_snapshot.json`, also copied to
`data/poseidon_snapshot.json` in the Databricks Git folder (`snapshot_to_repo = true`), which the user then
commits via the Git dialog. Real runs also write `data/mpa_index.json` (all ~17,500 MPAs for search).

## 7. Secrets and access

- Databricks secret scope `hackathon`: `gfw_token` (set, working), `linkup_key` (user was setting it up; confirm).
- Team read access was granted with `secrets.put_acl(scope="hackathon", principal="users", READ)`; schema access via GRANT to `account users`.
- **Never** ask the user to paste keys into chat. One GFW token was exposed in a screenshot earlier; the user was told to delete it and create a new one.
- This chat session could not reach Databricks from its sandbox (no network, no CLI). The Databricks Genie MCP connector failed to connect on Free Edition (likely no account-level OAuth); abandoned.

## 8. Known problems and gotchas

- **Git folders in Databricks never auto-sync.** Use branch name → Pull. Shared folders repeatedly broke ("could not be read as a Git repository", `OSError [Errno 5]` reading `.py`). Fix: each person uses a Git folder under `/Users/<email>/`. The notebook now falls back to loading code via the Workspace API, but the user's last error was from an **old copy** in `/Workspace/Shared/Imperial-AI-Hackathon (NEW)` that had not pulled.
- Databricks keeps old widget values: after changing defaults, clear boxes by hand (e.g. `mpa_ids` used to default to `11753`, which silently overrode `mpa_search`).
- GFW gap events are published with a delay and only counted from 12 h; GFW region filter only returns events inside the MPA polygon. Much dark-fleet activity is just outside boundaries (a buffer zone was proposed, not built).
- GFW removed the `gapIntentionalDisabling` parameter; the gaps dataset now serves intentional gaps only.
- `reset_tables = true` drops all Poseidon tables; must be set back to `false`.
- `max_cases` is **per area**. Up to 12 areas per run; comma-separated `mpa_search` takes up to 2 matches per term.
- Free Edition model endpoints vary; `llm_endpoint = auto` probes candidates. Check the run line `Decisions: N by model, N by policy`; all-policy means the model was not used.

## 9. Status of testing

- Unit tests: 35 pass locally against synthetic data.
- Real Databricks: earlier pipeline ran (sample data, MPA search found Galápagos ids 191, 10708, 11753). **Poseidon has not yet completed a real run** as far as this session knows.
- Not yet verified for real: model-driven tool choice in the user's workspace, Linkup from Databricks, outline fetching (`geo.fetch_boundary`), MERGE writes, snapshot copy into the Git folder.

## 9b. Update 22:30 — first real run results

A real run worked (`databricks-llama-4-maverick`, 61 model decisions vs 15 policy, Linkup on, briefs written by
the model). Areas: Galápagos 11753 and Hermandad 555745151. Finding: 41 of 93 cases were not fishing vessels:
**gear buoys** (AIS beacons like `D-RUFFO001-99%`, type `gear`, drifting ~0.3 kn with 2,000 h "gaps") topped the
ranking, plus tourist and seismic vessels. Fixed: `exclude_vessel_types` widget drops them before triage.
That run's file, cleaned with `scripts/clean_snapshot.py`, is committed as `data/poseidon_snapshot.json`
(52 cases, no outlines yet). Note: Ecuadorian artisanal boats may fish legally in parts of the Galápagos
reserve; treat ECU artisanal cases with care in the demo.

New `regions = flagship` widget loads 9 regions in one run.

## 9c. Update 23:45 — backend review of the first flagship run

Checked the real snapshot (8 areas, 191 cases) against the code. Found and fixed:

1. **Gap location (biggest).** GFW associates a gap with an area even when the vessel went dark and
   reappeared outside it. 17 of 25 gaps had both ends outside the outline (all the long "Galápagos" ones).
   Now each gap is located against the outline (`gap_start_inside`, `gap_end_inside`); only gaps with an
   end inside score 30, crossing-only gaps score 10 with an explicit caveat. Headlines and briefs reworded.
2. **Web "reports" were vessel-database pages** (MagicPort, Maritime Optima) or a different ship with the
   same name; Linkup's own answer said "no reports". Excluded by domain and by IMO mismatch.
3. **Spelling variants counted as name changes** ("CAP. DANNY B" / "CAP.DANNY B"). Normalised.
4. **Authorised fishing scored as suspicious.** Phoenix Islands had 3,753 fishing events GFW marks
   `publicly_authorized` (Kiribati reopened the area to fishing; Linkup's rules summary there is stale).
   Fishing is now graded by GFW's authorization status (20 / 15 / 5).
5. **Loitering alone was described as meeting another vessel.** Now 5 points with honest wording; encounter 10.
6. Beacons mistyped as fishing vessels are dropped by name; antimeridian bbox/centre fixed
   (Papahānaumokuākea had centre longitude 0); snapshot trimmed.

Effect: high-risk cases 8 -> 1. The credible cluster is **Hermandad**: TUNA PESCA, CAP.DANNY B,
MARIA DE GRACIA and CHACAO all lost or regained signal inside the reserve. `data/poseidon_snapshot.json`
was re-scored with `scripts/rescore_snapshot.py` (template briefs); a fresh Databricks run with
`reset_tables = true` is needed for model-written briefs under the new rules.
Do not demo Phoenix Islands as "illegal fishing": fishing there is authorised.

## 10. Next steps, in order

1. Get one real run working from a Git folder under `/Users/...`: `data_source = gfw`, `mode = history`, `2026-05-01` → `2026-11-14`, `mpa_search = Galápagos - Reserva Marina`, `max_cases = 2`, `max_steps = 6`. Fix whatever breaks (expect small GFW/Linkup/model response-shape issues).
2. Check the `outline for ...` log lines; fix `poseidon/geo.py` if both GFW and WDPA fail.
3. **Back-test (strongest demo evidence):** Red Rooster III, Revillagigedo National Park (Mexico), Jan–Mar 2025, documented by Mongabay Latam and Global Fishing Watch as repeated AIS disabling and incursions. Run blind (`mpa_search = Revillagigedo`, `2025-01-01` → `2025-04-01`, `max_cases = 8`, no focus) and see whether it ranks near the top. Backup case: Fu Yuan Yu Leng 999, Galápagos (11753), Aug 2017 (weaker: mostly transit).
4. Load flagship areas for the globe (three runs): `Galápagos - Reserva Marina, Hermandad, Revillagigedo, Cocos` · `Coiba, Papahanaumokuakea, Phoenix Islands` · `Chagos, Ascension, Great Barrier Reef`. Check matched areas each time.
5. Commit and push `data/poseidon_snapshot.json` and `data/mpa_index.json` for Louis.
6. Schedule live monitoring: Databricks Job running `notebooks/poseidon` with `mode = live`, hourly, max concurrency 1.
7. Optional if time allows: buffer zone around MPAs; "likely coverage gap" check to lower false positives; aisstream.io live layer (test coverage first, Galápagos is ~1,000 km offshore); a Databricks App serving the snapshot as `/api/snapshot` for live front-end data.
8. Demo prep: one real case told as a story, agent trace replay visible (`[llm]` steps), honest limits slide, back-test result. Submit by 11:30.

## 11. Conventions

- Commit messages end with the attribution lines given by the environment. Push to `main` (agreed for this project).
- Do not modify aarin's `notebooks/03_live_mpa_monitor.py` or `agent/live_monitor.py` without asking.
- Keep `docs/backend.md` in sync with `poseidon/contract.py` (every column must be documented).
- Wording: "apparent fishing", "lead", "flagged for review"; never "illegal vessel" or "caught".
- Attribution: Global Fishing Watch (non-commercial, attribution required); WDPA outlines (UNEP-WCMC and IUCN, Protected Planet); Linkup.
