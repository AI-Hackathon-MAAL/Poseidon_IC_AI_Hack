-- Run in the intended catalog and schema in an authorized SQL warehouse.
-- Set DATABRICKS_CANDIDATES_TABLE and DATABRICKS_BRIEFS_TABLE to these
-- tables' fully qualified names in the server environment.
CREATE TABLE IF NOT EXISTS soundings_candidates (
  payload STRING NOT NULL
) USING DELTA;

CREATE TABLE IF NOT EXISTS soundings_briefs (
  brief_id STRING NOT NULL,
  payload STRING NOT NULL,
  recorded_at TIMESTAMP NOT NULL
) USING DELTA;

-- After loading the case JSON, run this query against the measured gap rows.
-- The general perimeter of Revillagigedo is the rectangle in the 2017 decree:
-- https://simec.conanp.gob.mx/pdf_decretos/82_decreto.pdf
-- Each result identifies which reported endpoint lies inside that perimeter.
-- The path during a gap is unknown.
WITH perimeter(area_id, effective_date, west, south, east, north) AS (
  VALUES ('revillagigedo', DATE '2017-11-28', -115.471415, 17.655231, -110.078093, 20.008631)
),
events AS (
  SELECT DISTINCT
    get_json_object(payload, '$.id') AS event_id,
    get_json_object(payload, '$.areaId') AS area_id,
    try_cast(get_json_object(payload, '$.date') AS DATE) AS event_date,
    try_cast(get_json_object(payload, '$.start') AS TIMESTAMP) AS last_signal_at,
    try_cast(get_json_object(payload, '$.end') AS TIMESTAMP) AS signal_resumed_at,
    from_json(get_json_object(payload, '$.mapPoints'),
              'ARRAY<STRUCT<lon:DOUBLE,lat:DOUBLE,label:STRING>>') AS endpoints
  FROM soundings_candidates
  WHERE get_json_object(payload, '$.evidenceType') = 'measured-gap'
),
matched AS (
  SELECT e.event_id, e.last_signal_at, e.signal_resumed_at,
         filter(e.endpoints, p -> p.lon BETWEEN b.west AND b.east
                             AND p.lat BETWEEN b.south AND b.north) AS inside_endpoints
  FROM events e
  JOIN perimeter b ON e.area_id = b.area_id AND e.event_date >= b.effective_date
  WHERE e.signal_resumed_at > e.last_signal_at
)
SELECT event_id, last_signal_at, signal_resumed_at,
       transform(inside_endpoints, p -> p.label) AS observed_inside
FROM matched
WHERE size(inside_endpoints) > 0
ORDER BY last_signal_at, event_id;
