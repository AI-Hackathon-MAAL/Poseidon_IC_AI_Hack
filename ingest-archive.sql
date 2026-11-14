-- Run in the same catalog and schema as soundings_candidates.
-- Upload the extracted CSV to a Unity Catalog volume. Bind :archive_file to the
-- full /Volumes/<catalog>/<schema>/<volume>/disabling_events.csv path in SQL.
-- Requires a SQL warehouse with read_files support and access to the volume.
SET TIME ZONE 'UTC';

MERGE INTO soundings_candidates AS destination
USING (
  WITH archive AS (
    SELECT gap_id, cast(mmsi AS STRING) AS mmsi, vessel_class, gap_hours,
           try_cast(gap_start_timestamp AS TIMESTAMP) AS first_at,
           try_cast(gap_end_timestamp AS TIMESTAMP) AS second_at,
           try_cast(gap_start_lat AS DOUBLE) AS lat1, try_cast(gap_start_lon AS DOUBLE) AS lon1,
           try_cast(gap_end_lat AS DOUBLE) AS lat2, try_cast(gap_end_lon AS DOUBLE) AS lon2
    FROM read_files(:archive_file, format => 'csv', header => true,
      schema => 'gap_id STRING, mmsi STRING, vessel_class STRING, flag STRING, vessel_length_m DOUBLE, vessel_tonnage_gt DOUBLE, gap_start_timestamp STRING, gap_start_lat DOUBLE, gap_start_lon DOUBLE, gap_start_distance_from_shore_m DOUBLE, gap_end_timestamp STRING, gap_end_lat DOUBLE, gap_end_lon DOUBLE, gap_end_distance_from_shore_m DOUBLE, gap_hours DOUBLE')
  ), marked AS (
    SELECT *,
      lon1 BETWEEN -115.471415 AND -110.078093 AND lat1 BETWEEN 17.655231 AND 20.008631 AS first_inside,
      lon2 BETWEEN -115.471415 AND -110.078093 AND lat2 BETWEEN 17.655231 AND 20.008631 AS second_inside
    FROM archive
    WHERE first_at >= TIMESTAMP '2017-11-28 00:00:00 UTC' AND second_at > first_at
      AND lon1 BETWEEN -180 AND 180 AND lon2 BETWEEN -180 AND 180
      AND lat1 BETWEEN -90 AND 90 AND lat2 BETWEEN -90 AND 90
  )
  SELECT gap_id, to_json(named_struct(
    'id', gap_id, 'areaId', 'revillagigedo', 'kind', 'AIS reporting gap',
    'title', IF(second_inside, 'Signal resumes inside the park', 'Signal lost inside the park'),
    'vessel', concat('MMSI ',mmsi), 'mmsi', mmsi,
    'date', date_format(first_at,'yyyy-MM-dd'),
    'endDate', date_format(second_at,'yyyy-MM-dd'),
    'start', first_at, 'end', second_at,
    'mapPoints', array(named_struct('lon',lon1,'lat',lat1,'label','Last signal'),
                       named_struct('lon',lon2,'lat',lat2,'label','Signal resumed')),
    'evidenceType', 'measured-gap', 'location', 'Eastern tropical Pacific',
    'datasetHours', try_cast(gap_hours AS DOUBLE), 'gear', vessel_class
  ), map('timeZone','UTC')) AS payload
  FROM marked WHERE first_inside OR second_inside
) AS candidate
ON get_json_object(destination.payload,'$.id') = candidate.gap_id
WHEN MATCHED THEN UPDATE SET payload = candidate.payload
WHEN NOT MATCHED THEN INSERT (payload) VALUES (candidate.payload);
