# Databricks notebook source
# MAGIC %md
# MAGIC # 02 · Run the Dark Fishing agent
# MAGIC
# MAGIC Reads `candidates`, investigates each vessel-in-MPA lead (vessel history → web check → score → brief)
# MAGIC and writes the `briefs` table the front end reads.
# MAGIC
# MAGIC Secrets used (missing ones are skipped gracefully): `hackathon/gfw_token`, `hackathon/linkup_key`.
# MAGIC The brief is written by a Databricks Foundation Model endpoint; if it fails, a template brief is used.

# COMMAND ----------

dbutils.widgets.text("catalog", "workspace")
dbutils.widgets.text("schema", "dark_fishing")
dbutils.widgets.dropdown("source", "sample", ["sample", "gfw", "all"])
dbutils.widgets.dropdown("search_provider", "linkup", ["linkup"])
dbutils.widgets.text("llm_endpoint", "databricks-meta-llama-3-3-70b-instruct")
dbutils.widgets.text("max_leads", "10")
dbutils.widgets.text("start_date", "2025-01-01")
dbutils.widgets.text("end_date", "2025-12-31")

CATALOG, SCHEMA = dbutils.widgets.get("catalog"), dbutils.widgets.get("schema")
SOURCE = dbutils.widgets.get("source")
PROVIDER = dbutils.widgets.get("search_provider")

# COMMAND ----------

import os, sys, json
sys.path.append(os.path.abspath("../agent"))
import importlib, dark_fishing_agent as agent
importlib.reload(agent)

def secret(key):
    try:
        return dbutils.secrets.get("hackathon", key)
    except Exception:
        print(f"(secret hackathon/{key} not set — skipping)")
        return None

tools = agent.Tools(gfw_token=secret("gfw_token"), search_provider=PROVIDER,
                    search_key=secret(f"{PROVIDER}_key"))

# COMMAND ----------

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.serving import ChatMessage, ChatMessageRole

w = WorkspaceClient()
ENDPOINT = dbutils.widgets.get("llm_endpoint")

def llm(prompt: str) -> str:
    resp = w.serving_endpoints.query(
        name=ENDPOINT,
        messages=[ChatMessage(role=ChatMessageRole.USER, content=prompt)],
        max_tokens=1200, temperature=0.2)
    return resp.choices[0].message.content

try:
    print(llm("Reply with the single word: ready"))
except Exception as e:
    print(f"LLM endpoint '{ENDPOINT}' failed ({e}). Check Serving for an available endpoint name. Using template briefs.")
    llm = None

# COMMAND ----------

q = spark.table(f"{CATALOG}.{SCHEMA}.candidates")
if SOURCE != "all":
    q = q.where(f"source = '{SOURCE}'")
candidates = [r.asDict() for r in q.collect()]
print(f"{len(candidates)} candidate events")
if not candidates:
    dbutils.notebook.exit(
        f"No candidate events with source = '{SOURCE}'. "
        "For 'gfw': run 01_ingest_gfw first (search an MPA, put its id in mpa_ids, Run all) and check it prints events > 0. "
        "Or set source to 'sample' to test with synthetic data.")

briefs = agent.run(candidates, tools, llm=llm,
                   start=dbutils.widgets.get("start_date"), end=dbutils.widgets.get("end_date"),
                   max_leads=int(dbutils.widgets.get("max_leads")))
print(f"{len(briefs)} briefs written")

# COMMAND ----------

from pyspark.sql import functions as F

df = (spark.createDataFrame(briefs)
      .withColumn("start_time", F.to_timestamp("start_time"))
      .withColumn("end_time", F.to_timestamp("end_time"))
      .withColumn("created_at", F.to_timestamp("created_at"))
      .withColumn("lat", F.col("lat").cast("double"))
      .withColumn("lon", F.col("lon").cast("double"))
      .withColumn("risk_score", F.col("risk_score").cast("int")))
df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{CATALOG}.{SCHEMA}.briefs")

display(spark.table(f"{CATALOG}.{SCHEMA}.briefs").select("vessel_name", "mpa_name", "risk_score", "risk_level", "event_type").orderBy(F.desc("risk_score")))

# COMMAND ----------

# MAGIC %md ### Read the top brief

# COMMAND ----------

top = spark.table(f"{CATALOG}.{SCHEMA}.briefs").orderBy(F.desc("risk_score")).first()
displayHTML("<pre style='white-space:pre-wrap'>" + top.brief_markdown + "</pre>")
for step in json.loads(top.agent_trace):
    print(f"[{step['step']}] {step['detail']}")
