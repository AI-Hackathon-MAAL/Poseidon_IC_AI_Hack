# Databricks notebook source
# MAGIC %md
# MAGIC # 00 · Load synthetic sample data
# MAGIC
# MAGIC Writes **synthetic** rows into the `candidates` table so the agent and front end can be built before real data lands.
# MAGIC No API keys needed. Vessel and MPA names are fake on purpose.
# MAGIC
# MAGIC Run from a Git folder so `../data/sample_candidates.json` resolves, or paste the JSON into the `SAMPLE` fallback below.

# COMMAND ----------

dbutils.widgets.text("catalog", "workspace")
dbutils.widgets.text("schema", "dark_fishing")
CATALOG = dbutils.widgets.get("catalog")
SCHEMA = dbutils.widgets.get("schema")
spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")

# COMMAND ----------

import json, os
from pyspark.sql import functions as F

path = os.path.abspath("../data/sample_candidates.json")
with open(path) as f:
    rows = json.load(f)
print(f"Loaded {len(rows)} sample rows from {path}")

# COMMAND ----------

df = (
    spark.createDataFrame(rows)
    .withColumn("start_time", F.to_timestamp("start_time"))
    .withColumn("end_time", F.to_timestamp("end_time"))
    .withColumn("duration_hours", F.col("duration_hours").cast("double"))
    .withColumn("lat", F.col("lat").cast("double"))
    .withColumn("lon", F.col("lon").cast("double"))
    .withColumn("raw", F.lit(None).cast("string"))
)

table = f"{CATALOG}.{SCHEMA}.candidates"
# Replace only sample rows; keep any real GFW rows already there
if spark.catalog.tableExists(table):
    spark.sql(f"DELETE FROM {table} WHERE source = 'sample'")
    df.write.mode("append").option("mergeSchema", "true").saveAsTable(table)
else:
    df.write.mode("overwrite").saveAsTable(table)

display(spark.table(table).orderBy("start_time"))
