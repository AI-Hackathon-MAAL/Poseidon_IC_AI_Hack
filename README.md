# Soundings

A historical case desk for marine conservation analysts. Select a protected area and a date range, investigate a lead, and inspect the map, dated observations, source links, evidence gaps and suggested follow-up. Saved briefs reopen when the case is selected again.

## Run locally

Install Node.js 22 or newer. The application has no npm dependencies.

```powershell
npm start
```

Open `http://127.0.0.1:3000`. To run the checks, use `npm test`. Set the environment variable `PORT` to change the listening port. The default run uses six public historical cases, a rules-based investigator and local JSON brief storage in the ignored `.soundings/briefs/` directory. It needs no credentials and makes no outside requests.

## The first investigation

Choose Revillagigedo and the March 2019 case. The last signal on 17 March was outside the park. The next signal, on 18 March, was inside. Soundings computes 24.86 hours between those timestamps and shows the two positions. The vessel’s activity between them is unknown. The archive includes preselected suspected disabling events, so these observations cannot measure detection accuracy or total fishing activity.

| Protected area | What we checked | What the demo supports |
| --- | --- | --- |
| Revillagigedo, Mexico | The 2017 decree defines the park perimeter and fishing rule. Two historical research records have endpoints inside that perimeter. Separately, CONANP documented two 2025 incidents near Clarión. | Selected for the primary demo. Exact endpoints for the 2019 gaps and attributed report evidence for the 2025 incidents. |
| Dogger Bank, UK | BLOOM estimated 468 hours of apparent trawling during 2023. The UK byelaw regulates bottom-towed gear and provides for transit with gear stowed. | Gear-use follow-up. The available estimate covers the year and cannot resolve the gear deployed or an individual route. |
| Phoenix Islands, Kiribati | Kiribati reported five vessels cruising without fishing on the first day of its 2015 commercial fishing closure. | Real transit control. The dated official assessment changes the recommended action. |

Primary references for Revillagigedo are the [decree](https://dof.gob.mx/nota_detalle_popup.php?codigo=5505736), [CONANP incident report](https://www.gob.mx/conanp/prensa/la-conanp-reporta-a-la-embarcacion-red-rooster-iii-por-sospecha-de-pesca-ilegal-en-el-parque-nacional-revillagigedo) and [UNESCO island reference positions](https://whc.unesco.org/en/list/1510/maps/). Dogger Bank uses [BLOOM p. 22](https://www.bloomassociation.org/en/wp-content/uploads/2024/03/BULLDOZED.pdf#page=22) and the [MMO byelaw](https://www.gov.uk/government/publications/the-dogger-bank-special-area-of-conservation-specified-area-bottom-towed-fishing-gear-byelaw-2022). The Phoenix control comes from [Kiribati’s state of conservation report](https://whc.unesco.org/document/134952).

## Reproduce the gap selection

Download and extract `data/disabling_events.zip` from [Global Fishing Watch’s study archive](https://github.com/GlobalFishingWatch/AIS-disabling-high-seas/tree/main/data). The checked release has archive SHA-256 `d619e1fc256669e1441b62dc6655d03faa34090d95a0c4215988d5987445d6fc`. Credit goes to Welch and colleagues and Global Fishing Watch. [Research methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC9629714/)

```powershell
npm run import:gaps -- C:/path/to/disabling_events.csv
```

The importer reads all 55,368 rows, checks dated endpoints against the four published perimeter vertices, and writes the two qualifying records to `data/gaps.json`. Each record retains its source ID and UTC endpoints. The import uses the strict inside-or-on-boundary criterion. A vessel can cross a boundary unseen; this filter cannot detect such a crossing. The four report-based cases in `data/reports.json` have separate provenance. Their place names supply geographic context without manufacturing AIS coordinates.

## Optional live connections

Set secrets in the server process environment or a private file outside the repository. Node can read that file with `node --env-file=C:/path/to/private.env server.mjs`. Enable each service only in an authorized workspace with known credit coverage. No external services are required to try the published replay.

| Service | Server variables | What changes |
| --- | --- | --- |
| Linkup | `LINKUP_LIVE=1`, `LINKUP_API_KEY` | Searches the case jurisdiction’s source domains. Returned pages remain source leads until an analyst verifies their content. |
| Global Fishing Watch | `GFW_LIVE=1`, `GFW_TOKEN` | Uses a verified MMSI and event date to resolve identity and look up preceding port and encounter records. |
| Databricks SQL | `DATABRICKS_LIVE=1`, `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID`, `DATABRICKS_CANDIDATES_TABLE`, `DATABRICKS_BRIEFS_TABLE` | Reads the candidate collection and saves or retrieves cited briefs in Delta. Provide fully qualified table names. |
| Databricks Model Serving | `DATABRICKS_AGENT_LIVE=1`, `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_MODEL_ENDPOINT` | A tool-calling chat endpoint selects event, history, rule and source lookups and chooses a permitted follow-up. Factual statements stay grounded in the returned evidence. |

For SQL, use your intended catalog and schema and run the two DDL statements in `databricks.sql`. Run `node scripts/seed-sql.mjs catalog.schema.soundings_candidates` locally and execute the printed MERGE in the warehouse. The final query in `databricks.sql` reproduces the endpoint check for loaded gap cases. The server falls back to the published replay or local brief storage when the warehouse is unavailable. The brief displays which data, investigation, search and storage modes were used.

## Scope

For a warehouse import from the full 55,368-event CSV, upload the extracted archive to a Unity Catalog volume and run `ingest-archive.sql` with the `archive_file` path bound. It filters on both real endpoints and the effective date and merges matching records into the same candidates table. On the pinned archive, the local equivalent produced two matches. Warehouse SQL has not been executed against a live account.

This first release is an on-demand analyst workflow with a historical data import. Its map renders the verified Revillagigedo perimeter. The alternative areas use report evidence. The source record distinguishes a reporting gap, apparent fishing, a documented referral, and an assessment of transit. Running against live provider accounts and extending coverage to recurring ingestion are follow-up milestones.
