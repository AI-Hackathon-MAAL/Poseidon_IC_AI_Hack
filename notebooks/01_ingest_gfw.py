# Databricks notebook source
# MAGIC %md
# MAGIC # 01 · Ingest Global Fishing Watch data
# MAGIC
# MAGIC 1. Checks the workspace can reach the GFW API.
# MAGIC 2. Pulls the MPA list (`public-mpa-all`) into the `mpas` table and lets you search it by name.
# MAGIC 3. For the MPAs you choose, pulls tracking-gap, fishing, encounter and loitering events into `candidates`.
# MAGIC
# MAGIC Needs the secret `hackathon/gfw_token`. Data © Global Fishing Watch — non-commercial use, attribution required.

# COMMAND ----------

dbutils.widgets.text("catalog", "workspace")
dbutils.widgets.text("schema", "dark_fishing")
dbutils.widgets.text("mpa_search", "", "Search MPAs by name")
dbutils.widgets.text("mpa_ids", "", "MPA ids to ingest (comma-separated)")
dbutils.widgets.text("start_date", "2025-01-01")
dbutils.widgets.text("end_date", "2025-12-31")
dbutils.widgets.text("event_types", "gap,fishing,encounter,loitering")

CATALOG = dbutils.widgets.get("catalog")
SCHEMA = dbutils.widgets.get("schema")
spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")

# COMMAND ----------

import json, time, requests

BASE = "https://gateway.api.globalfishingwatch.org/v3"
TOKEN = dbutils.secrets.get("hackathon", "gfw_token")
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

DATASETS = {
    "gap": "public-global-gaps-events:latest",          # intentional tracking-off events only
    "fishing": "public-global-fishing-events:latest",
    "encounter": "public-global-encounters-events:latest",
    "loitering": "public-global-loitering-events:latest",
}

# Connectivity check — a DNS/connection error means outbound internet is still blocked (verify the workspace with LinkedIn)
try:
    r = requests.get(f"{BASE}/datasets/public-mpa-all/context-layers", headers=HEADERS, timeout=20)
    print("GFW reachable, HTTP", r.status_code)
    r.raise_for_status()
except requests.exceptions.ConnectionError as e:
    raise RuntimeError("Cannot reach GFW — outbound internet is blocked in this workspace.") from e

# COMMAND ----------

# MAGIC %md ## MPA list

# COMMAND ----------

mpa_payload = r.json()
mpa_records = mpa_payload if isinstance(mpa_payload, list) else mpa_payload.get("entries", mpa_payload.get("data", []))
mpa_rows = [
    {"mpa_id": str(m.get("id")), "mpa_name": m.get("label") or m.get("name"), "raw": json.dumps(m)}
    for m in mpa_records
]
print(f"{len(mpa_rows)} MPAs")
spark.createDataFrame(mpa_rows).write.mode("overwrite").saveAsTable(f"{CATALOG}.{SCHEMA}.mpas")

search = dbutils.widgets.get("mpa_search").strip()
if search:
    display(spark.sql(f"SELECT mpa_id, mpa_name FROM {CATALOG}.{SCHEMA}.mpas WHERE lower(mpa_name) LIKE lower('%{search}%') LIMIT 50"))
else:
    print("Tip: type a name in the 'Search MPAs by name' widget, rerun this cell, and copy ids into 'mpa_ids'.")

# COMMAND ----------

# MAGIC %md ## Events for the chosen MPAs

# COMMAND ----------

def fetch_events(event_type, mpa_id, start, end, page_size=200, max_pages=25):
    """POST /v3/events for one dataset + MPA, following nextOffset."""
    body = {
        "datasets": [DATASETS[event_type]],
        "startDate": start,
        "endDate": end,
        "region": {"dataset": "public-mpa-all", "id": int(mpa_id) if mpa_id.isdigit() else mpa_id},
    }
    out, offset = [], 0
    for _ in range(max_pages):
        resp = requests.post(f"{BASE}/events", params={"offset": offset, "limit": page_size},
                             headers=HEADERS, data=json.dumps(body), timeout=60)
        if resp.status_code == 429:
            time.sleep(5); continue
        if not resp.ok:
            print(f"  {event_type} / MPA {mpa_id}: HTTP {resp.status_code} {resp.text[:300]}")
            break
        payload = resp.json()
        entries = payload.get("entries", [])
        out.extend(entries)
        nxt = payload.get("nextOffset")
        if not entries or nxt is None or nxt == offset:
            break
        offset = nxt
    return out


def flatten(e, event_type, mpa_id, mpa_name):
    v = e.get("vessel") or {}
    pos = e.get("position") or {}
    gap = e.get("gap") or {}
    off = gap.get("offPosition") or {}
    return {
        "event_id": str(e.get("id")),
        "event_type": event_type,
        "mpa_id": str(mpa_id),
        "mpa_name": mpa_name,
        "vessel_id": v.get("id"),
        "vessel_name": v.get("name"),
        "mmsi": v.get("ssvid"),
        "flag": v.get("flag"),
        "start_time": e.get("start"),
        "end_time": e.get("end"),
        "lat": off.get("lat", pos.get("lat")),
        "lon": off.get("lon", pos.get("lon")),
        "source": "gfw",
        "raw": json.dumps(e),
    }

# COMMAND ----------

from pyspark.sql import functions as F

mpa_ids = [m.strip() for m in dbutils.widgets.get("mpa_ids").split(",") if m.strip()]
types = [t.strip() for t in dbutils.widgets.get("event_types").split(",") if t.strip() in DATASETS]
start, end = dbutils.widgets.get("start_date"), dbutils.widgets.get("end_date")
assert mpa_ids, "Set the 'mpa_ids' widget first (use the search above)."

names = {r.mpa_id: r.mpa_name for r in spark.table(f"{CATALOG}.{SCHEMA}.mpas").where(F.col("mpa_id").isin(mpa_ids)).collect()}

rows = []
for mpa_id in mpa_ids:
    for t in types:
        events = fetch_events(t, mpa_id, start, end)
        print(f"MPA {mpa_id} ({names.get(mpa_id)}): {len(events)} {t} events")
        rows += [flatten(e, t, mpa_id, names.get(mpa_id)) for e in events]

print(f"Total: {len(rows)} events")

# COMMAND ----------

from pyspark.sql.types import StructType, StructField, StringType

RAW_SCHEMA = StructType([StructField(c, StringType()) for c in [
    "event_id", "event_type", "mpa_id", "mpa_name", "vessel_id", "vessel_name", "mmsi", "flag",
    "start_time", "end_time", "lat", "lon", "source", "raw"]])

if rows:
    rows = [{k: (None if v is None else str(v)) for k, v in r.items()} for r in rows]
    df = (
        spark.createDataFrame(rows, schema=RAW_SCHEMA)
        .withColumn("start_time", F.to_timestamp("start_time"))
        .withColumn("end_time", F.to_timestamp("end_time"))
        .withColumn("duration_hours", (F.unix_timestamp("end_time") - F.unix_timestamp("start_time")) / 3600.0)
        .withColumn("lat", F.col("lat").cast("double"))
        .withColumn("lon", F.col("lon").cast("double"))
    )
    table = f"{CATALOG}.{SCHEMA}.candidates"
    if spark.catalog.tableExists(table):
        df.createOrReplaceTempView("new_events")
        spark.sql(f"""
            MERGE INTO {table} t USING new_events s
            ON t.event_id = s.event_id AND t.event_type = s.event_type
            WHEN MATCHED THEN UPDATE SET *
            WHEN NOT MATCHED THEN INSERT *
        """)
    else:
        df.write.mode("overwrite").saveAsTable(table)
    display(spark.table(table).where("source = 'gfw'").groupBy("mpa_name", "event_type").count().orderBy("mpa_name"))
