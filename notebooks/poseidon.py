# Databricks notebook source
# /// script
# [tool.databricks.environment]
# environment_version = "6"
# ///
# MAGIC %md
# MAGIC # Poseidon — protector of the sea
# MAGIC
# MAGIC One notebook, two modes. The only difference between them is the time window.
# MAGIC
# MAGIC | mode | window | use it for |
# MAGIC | --- | --- | --- |
# MAGIC | `history` | `start_date` to `end_date` | investigating a past period |
# MAGIC | `live` | the last `lookback_days` days up to now | scheduled monitoring (run it as an hourly Job) |
# MAGIC
# MAGIC Each run: fetch Global Fishing Watch events → triage the vessels (skipping ones it already investigated,
# MAGIC unless new evidence arrived) → for each case the agent chooses its own checks, one at a time, until it
# MAGIC judges the evidence sufficient → code scores the case → a cited brief is written.
# MAGIC
# MAGIC **Secrets** (scope `hackathon`): `gfw_token` (required), `linkup_key` (web search; optional but recommended).
# MAGIC Open this notebook from inside the Git folder. Tables are documented in `docs/backend.md`.
# MAGIC
# MAGIC Data © Global Fishing Watch (apparent activity; non-commercial use). Every case is a lead, not proof.

# COMMAND ----------

import sys, json, html, types
from pathlib import Path

sys.dont_write_bytecode = True
MODULES = ["gfw", "search", "scoring", "agent", "brief", "pipeline", "contract", "sample", "geo", "intel"]   # dependency order
roots = [Path.cwd(), *Path.cwd().parents]
try:  # Databricks can run a notebook with a working directory outside the Git folder
    nb_path = dbutils.notebook.entry_point.getDbutils().notebook().getContext().notebookPath().get()
    here = Path("/Workspace") / nb_path.lstrip("/")
    roots = [here.parent, *here.parent.parents, *roots]
except Exception:
    nb_path, here = None, None
for name in [m for m in sys.modules if m == "poseidon" or m.startswith("poseidon.")]:
    del sys.modules[name]   # pick up freshly pulled code without restarting


def load_from_files():
    repo = next((r for r in roots if (r / "poseidon" / "agent.py").is_file()), None)
    if repo is None:
        raise FileNotFoundError("poseidon/ folder not found next to notebooks/")
    if str(repo) not in sys.path:
        sys.path.insert(0, str(repo))
    import poseidon.agent, poseidon.contract  # noqa: F401  (raises OSError if the files cannot be read)
    return repo


def load_via_workspace_api():
    """Fallback for folders whose .py files cannot be read directly (copies, Shared folders):
    fetch each module's source through the Workspace API and build the package in memory."""
    import base64
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.service.workspace import ExportFormat
    wc = WorkspaceClient()
    base = "/" + str(here.parent.parent).replace("/Workspace/", "", 1).lstrip("/") if here else None
    if not base:
        raise RuntimeError("Cannot tell where this notebook lives.")
    pkg = types.ModuleType("poseidon")
    pkg.__path__, pkg.__package__ = [], "poseidon"
    sys.modules["poseidon"] = pkg
    for mod in MODULES:
        code = None
        for candidate in (f"{base}/poseidon/{mod}.py", f"{base}/poseidon/{mod}"):
            try:
                code = base64.b64decode(wc.workspace.export(candidate, format=ExportFormat.SOURCE).content).decode("utf-8")
                break
            except Exception:
                continue
        if code is None:
            raise RuntimeError(f"Could not read poseidon/{mod} under {base}. Pull the latest code.")
        m = types.ModuleType(f"poseidon.{mod}")
        m.__package__ = "poseidon"
        m.__file__ = f"{base}/poseidon/{mod}.py"
        sys.modules[m.__name__] = m
        exec(compile(code, m.__file__, "exec"), m.__dict__)
        setattr(pkg, mod, m)
    return Path("/Workspace" + base)


try:
    repo = load_from_files()
except Exception as first_error:
    print(f"Direct import failed ({type(first_error).__name__}: {str(first_error)[:120]}); loading via the Workspace API.")
    for name in [m for m in sys.modules if m == "poseidon" or m.startswith("poseidon.")]:
        del sys.modules[name]
    repo = load_via_workspace_api()

from poseidon import contract, geo, intel, pipeline, sample
from poseidon.agent import Context
from poseidon.gfw import GFWClient, resolve_window
from poseidon.search import SearchClient
print("Poseidon code loaded from", repo)

# COMMAND ----------

dbutils.widgets.dropdown("mode", "history", ["history", "live"])
dbutils.widgets.text("start_date", "2026-08-01")
dbutils.widgets.text("end_date", "2026-11-14")
dbutils.widgets.text("lookback_days", "30")
dbutils.widgets.dropdown("regions", "custom", ["custom", "flagship"])
dbutils.widgets.text("mpa_search", "Galapagos")
dbutils.widgets.text("exclude_vessel_types", "gear,passenger,seismic_vessel,other_non_fishing,cargo,tanker")
dbutils.widgets.text("mpa_ids", "")
dbutils.widgets.text("max_cases", "5")
dbutils.widgets.text("max_steps", "8")
dbutils.widgets.text("focus", "")
dbutils.widgets.dropdown("force_reinvestigate", "false", ["false", "true"])
dbutils.widgets.dropdown("data_source", "gfw", ["gfw", "sample"])
dbutils.widgets.dropdown("search_provider", "linkup", ["linkup", "none"])
dbutils.widgets.text("llm_endpoint", "auto")
dbutils.widgets.text("catalog", "workspace")
dbutils.widgets.text("schema", "poseidon")
dbutils.widgets.dropdown("reset_tables", "false", ["false", "true"])
dbutils.widgets.dropdown("snapshot_to_repo", "true", ["true", "false"])
dbutils.widgets.dropdown("snapshot_scope", "all_areas", ["all_areas", "this_run_areas"])
dbutils.widgets.dropdown("global_news", "true", ["true", "false"])

W = {k: dbutils.widgets.get(k).strip() for k in
     ["regions", "exclude_vessel_types", "mode", "start_date", "end_date", "lookback_days", "mpa_search", "mpa_ids", "max_cases", "max_steps", "focus",
      "force_reinvestigate", "data_source", "search_provider", "llm_endpoint", "catalog", "schema", "reset_tables",
      "snapshot_to_repo", "snapshot_scope", "global_news"]}
CATALOG, SCHEMA = W["catalog"], W["schema"]
if not all(x.replace("_", "").isalnum() for x in (CATALOG, SCHEMA)):
    raise ValueError("catalog and schema may only contain letters, numbers and underscores")
spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")
try:  # let teammates read and write; only the schema owner can grant, so failure is fine
    spark.sql(f"GRANT ALL PRIVILEGES ON SCHEMA {CATALOG}.{SCHEMA} TO `account users`")
except Exception as e:
    print("(could not grant schema access to the team; the schema owner can run the GRANT)")
try:
    spark.conf.set("spark.sql.session.timeZone", "UTC")
except Exception:
    pass

# COMMAND ----------

# MAGIC %md ## Connect: Global Fishing Watch, Linkup, language model

# COMMAND ----------

def secret(key):
    try:
        return dbutils.secrets.get("hackathon", key)
    except Exception:
        return None

SAMPLE = W["data_source"] == "sample"
if SAMPLE:
    gfw, search = sample.SampleGFW(), sample.SampleSearch()
    print("data_source = sample: using SYNTHETIC vessels and sources (no keys needed).")
else:
    gfw = GFWClient(secret("gfw_token"))
    search = None
    if W["search_provider"] != "none":
        key = secret(f"{W['search_provider']}_key")
        if key:
            search = SearchClient(key, provider=W["search_provider"])
            print("Web search:", W["search_provider"])
        else:
            print(f"WARNING: secret hackathon/{W['search_provider']}_key is not set. The agent will run without web search.")

# COMMAND ----------

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.serving import ChatMessage, ChatMessageRole

w = WorkspaceClient()

def _text(content):
    if isinstance(content, list):   # some models return a list of content blocks
        return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type", "text") == "text")
    return content or ""

def chat(endpoint, system, user, max_tokens=1500):
    try:
        resp = w.serving_endpoints.query(
            name=endpoint, max_tokens=max_tokens, temperature=0.1,
            messages=[ChatMessage(role=ChatMessageRole.SYSTEM, content=system),
                      ChatMessage(role=ChatMessageRole.USER, content=user)])
        return _text(resp.choices[0].message.content)
    except Exception as first:
        try:   # fall back to the raw REST call without optional parameters
            resp = w.api_client.do("POST", f"/serving-endpoints/{endpoint}/invocations",
                                   body={"messages": [{"role": "system", "content": system},
                                                      {"role": "user", "content": user}], "max_tokens": max_tokens})
            return _text(resp["choices"][0]["message"]["content"])
        except Exception:
            raise first

def pick_endpoint():
    """Use the widget value, or find a chat model that actually answers in this workspace."""
    if W["llm_endpoint"].lower() not in ("", "auto"):
        candidates = [W["llm_endpoint"]]
    else:
        endpoints = [e for e in w.serving_endpoints.list() if e.name.startswith("databricks-")]
        names = [e.name for e in endpoints if (getattr(e, "task", "") or "") == "llm/v1/chat"]
        if not names:   # task not reported: keep everything that is not an embedding model
            names = [e.name for e in endpoints if not any(x in e.name for x in ("embedding", "gte", "bge"))]
        prefer = ["claude-sonnet", "claude", "gpt-5", "llama-4", "llama-3-3-70b", "llama", "gemini", "gemma", "qwen", "gpt"]
        rank = lambda n: next((i for i, p in enumerate(prefer) if p in n), len(prefer))
        candidates = sorted(names, key=lambda n: (rank(n), [-ord(c) for c in n]))[:8]
        print("Chat endpoints found:", candidates or "none")
    for name in candidates:
        try:
            if chat(name, "You are a connectivity test.", "Reply with the single word: ready", max_tokens=20):
                return name
        except Exception as e:
            print(f"  {name}: not usable ({str(e)[:120]})")
    return None

LLM_ENDPOINT = pick_endpoint()
if LLM_ENDPOINT:
    llm = lambda system, user: chat(LLM_ENDPOINT, system, user)
    print("Language model:", LLM_ENDPOINT, "(chooses the agent's next check and writes briefs)")
else:
    llm = None
    print("WARNING: no chat model is available. The rule-based policy will choose checks and briefs use the template.")

# COMMAND ----------

# MAGIC %md ## Choose the window and the protected areas

# COMMAND ----------

if SAMPLE:
    window_start, window_end = "2026-10-01", "2026-10-31"
    mpas = pipeline.select_mpas(sample.SAMPLE_MPAS, search="sample")
else:
    window_start, window_end = resolve_window(W["mode"], W["start_date"], W["end_date"], W["lookback_days"])
    if W["regions"] == "flagship" and not W["mpa_ids"]:
        mpas = pipeline.select_mpas(gfw.mpas(), search=", ".join(pipeline.FLAGSHIP_REGIONS), per_term=1)
        print(f"Flagship regions: {len(mpas)} of {len(pipeline.FLAGSHIP_REGIONS)} matched")
    else:
        mpas = pipeline.select_mpas(gfw.mpas(), search=W["mpa_search"], ids=W["mpa_ids"])
print(f"Mode: {W['mode']}   Window: {window_start} to {window_end}")
print("Protected areas:")
for m in mpas:
    print(f"  {m['mpa_id']}  {m['mpa_name']}")
if not mpas:
    dbutils.notebook.exit("No protected area matched. Change mpa_search or set mpa_ids.")
if len(mpas) > 12:
    print(f"NOTE: {len(mpas)} areas matched; using the first 12. Set mpa_ids to choose.")
    mpas = mpas[:12]

# COMMAND ----------

# MAGIC %md ## Run the agent
# MAGIC The log shows every decision: `[llm]` means the model chose that check, `[policy]` means the rule-based fallback did.

# COMMAND ----------

def table(name):
    return f"{CATALOG}.{SCHEMA}.{name}"

def read_rows(name):
    """Table -> list of dicts with timestamps as ISO strings."""
    if not spark.catalog.tableExists(table(name)):
        return []
    out = []
    for r in spark.table(table(name)).collect():
        d = r.asDict()
        for k, v in d.items():
            if hasattr(v, "isoformat"):
                d[k] = v.replace(tzinfo=None).isoformat(timespec="seconds") + "Z"
        out.append(d)
    return out

if W["reset_tables"] == "true":
    for name in contract.TABLES:
        spark.sql(f"DROP TABLE IF EXISTS {table(name)}")
    print("All Poseidon tables dropped (reset_tables = true). Set it back to false.")

# Outlines for the map: fetched once per area, then remembered
have = {b["mpa_id"] for b in read_rows("mpa_boundaries") if b.get("geometry")}
new_shapes = []
for m in mpas:
    if m["mpa_id"] in have:
        continue
    if SAMPLE:
        g = geo.simplify_geometry(sample.SAMPLE_BOUNDARIES.get(m["mpa_id"]))
        bbox, lat, lon = geo.bbox_and_center(g)
        b = {"geometry": g, "bbox": bbox, "center_lat": lat, "center_lon": lon, "source": "synthetic"}
    else:
        b = geo.fetch_boundary(m["mpa_id"], gfw=gfw)
    print(f"  outline for {m['mpa_name']}: " + (f"ok ({b['source']})" if b.get("geometry") else f"not found ({b.get('error')})"))
    new_shapes.append({**m, **b, "fetched_at": pipeline.now_iso()})
BOUNDARIES = {b["mpa_id"]: json.loads(b["geometry"]) if isinstance(b.get("geometry"), str) else b.get("geometry")
              for b in read_rows("mpa_boundaries") if b.get("geometry")}
BOUNDARIES.update({b["mpa_id"]: b["geometry"] for b in new_shapes if b.get("geometry")})


memory = pipeline.memory_from_rows(read_rows("cases"))
print(f"Memory: {len(memory)} case(s) remembered from earlier runs\n")

ctx = Context(gfw=gfw, search=search, llm=llm, window_start=window_start, window_end=window_end,
              mode=W["mode"], max_steps=int(W["max_steps"]))
result = pipeline.run(ctx, mpas, memory=memory, max_cases=int(W["max_cases"]), per_area=True,
                      exclude_types=[t for t in W["exclude_vessel_types"].split(",") if t.strip()],
                      boundaries=BOUNDARIES,
                      force=W["force_reinvestigate"] == "true",
                      focus=[f for f in W["focus"].split(",") if f.strip()], llm_endpoint=LLM_ENDPOINT)
run_row = result["run"][0]
print(f"\nRun {run_row['run_id']}: {run_row['n_investigated']} investigated, {run_row['n_skipped_unchanged']} unchanged, "
      f"{run_row['n_queued']} queued. Decisions: {run_row['llm_decisions']} by model, {run_row['policy_decisions']} by policy.")
for note in run_row["notes"]:
    print("NOTE:", note)

# COMMAND ----------

# MAGIC %md ## Save to the tables the front end reads

# COMMAND ----------

from datetime import datetime, timezone
from pyspark.sql import functions as F
from pyspark.sql.types import StructType, StructField, StringType

SPARK_TYPE = {"string": "string", "json": "string", "int": "int", "double": "double",
              "boolean": "boolean", "timestamp": "timestamp"}

def save(name, rows, overwrite=False):
    spec = contract.TABLES[name]
    if not rows and not overwrite:
        print(f"  {name}: nothing new")
        return
    raw = spark.createDataFrame(contract.to_table_rows(name, rows),
                                StructType([StructField(c, StringType(), True) for c, _ in spec["columns"]]))
    # try_cast: a malformed value becomes null instead of failing the whole run
    df = raw.select([F.expr(f"try_cast(`{c}` AS {SPARK_TYPE[t]})").alias(c) for c, t in spec["columns"]])
    if overwrite or not spark.catalog.tableExists(table(name)):
        df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(table(name))
    else:
        view = f"_poseidon_new_{name}"
        df.createOrReplaceTempView(view)
        on = " AND ".join(f"t.{k} <=> s.{k}" for k in spec["key"])
        tail = f"INTO {table(name)} t USING {view} s ON {on} WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *"
        try:
            spark.sql("MERGE WITH SCHEMA EVOLUTION " + tail)
        except Exception:
            spark.sql("MERGE " + tail)
    print(f"  {name}: {len(rows)} row(s) written")

save("mpa_boundaries", new_shapes)
save("events", result["events"])
save("cases", result["cases"])
save("agent_steps", result["steps"])
save("runs", result["run"])
save("news", result["news"])
save("mpa_context", result["mpa_context"])

# Global intel layer: worldwide news, placed on the map by area or country name
if W["global_news"] == "true" and search is not None:
    areas = [b for b in read_rows("mpa_boundaries")]
    save("global_news", intel.global_news(search, areas, window_end, mode=W["mode"], window_start=window_start,
                                          run_id=run_row["run_id"]))

all_cases, all_events = read_rows("cases"), read_rows("events")
save("mpa_status", contract.mpa_status_rows(all_cases, all_events), overwrite=True)

# COMMAND ----------

# MAGIC %md ## Snapshot for the front end
# MAGIC One JSON document with everything (cases with their events and agent steps, area status, news, latest run).

# COMMAND ----------

from datetime import datetime, timezone

# The tables keep every area ever run. By default the snapshot only covers this run's areas.
keep = {m["mpa_id"] for m in mpas}
scoped = (lambda rows: rows) if W["snapshot_scope"] == "all_areas" else \
         (lambda rows: [r for r in rows if str(r.get("mpa_id")) in keep])
run_rows = read_rows("runs")
if W["snapshot_scope"] != "all_areas":
    run_rows = [r for r in run_rows if set(json.loads(r.get("mpa_ids") or "[]")) & keep]
case_ids = {c["case_id"] for c in scoped(all_cases)}
snapshot = contract.build_snapshot(run_rows, scoped(all_cases), scoped(all_events),
                                   [s for s in read_rows("agent_steps") if s.get("case_id") in case_ids],
                                   scoped(read_rows("news")), scoped(read_rows("mpa_context")),
                                   datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                   boundaries=scoped(read_rows("mpa_boundaries")),
                                   global_news=read_rows("global_news"), data_source=W["data_source"])
print("Snapshot covers:", ", ".join(m["mpa_name"] for m in snapshot["mpas"]) or "no areas yet")
snapshot_json = json.dumps(snapshot, default=str, ensure_ascii=False, indent=1)
try:
    spark.sql(f"CREATE VOLUME IF NOT EXISTS {CATALOG}.{SCHEMA}.exports")
    path = f"/Volumes/{CATALOG}/{SCHEMA}/exports/poseidon_snapshot.json"
    with open(path, "w", encoding="utf-8") as f:
        f.write(snapshot_json)
    print(f"Snapshot written: {path}  ({len(snapshot_json) // 1024} KB, {len(snapshot['cases'])} cases)")
except Exception as e:
    print(f"Could not write the snapshot file ({str(e)[:200]}). The tables are still up to date.")

if W["snapshot_to_repo"] == "true":
    # Copy into this Git folder so it can be committed and pushed for the front end
    repo_file = repo / "data" / ("poseidon_snapshot.sample.json" if SAMPLE else "poseidon_snapshot.json")
    try:
        repo_file.write_text(snapshot_json, encoding="utf-8")
        print(f"Snapshot copied into the Git folder: {repo_file}")
        if not SAMPLE:   # search index of every protected area, so the UI can find ones not yet investigated
            index = [{"id": str(m.get("id")), "name": m.get("label") or m.get("name")} for m in gfw.mpas()]
            (repo / "data" / "mpa_index.json").write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
            print(f"Search index written: data/mpa_index.json ({len(index)} protected areas)")
        print("To share them: click the branch name (main) at the top -> tick the data/ files -> Commit & Push.")
    except Exception as e:
        print(f"Could not copy the snapshot into the Git folder ({str(e)[:200]}).")

# COMMAND ----------

# MAGIC %md ## Results

# COMMAND ----------

display(spark.sql(f"""
    SELECT risk_score, risk_level, confidence, status, vessel_name, flag, mpa_name, headline, change,
           n_steps, llm_decisions, policy_decisions, investigated_at
    FROM {table('cases')} ORDER BY risk_score DESC, investigated_at DESC"""))

# COMMAND ----------

this_run = [c for c in result["cases"] if c["brief_markdown"]]
if this_run:
    top = max(this_run, key=lambda c: c["risk_score"])
    steps = [s for s in result["steps"] if s["case_id"] == top["case_id"]]
    trail = "\n".join(f"{s['step_no']}. [{s['decided_by']}] {s['tool']} - {s['reason']}\n     -> {s['result']}" for s in steps)
    displayHTML("<h3>How the agent investigated the top case of this run</h3><pre style='white-space:pre-wrap'>"
                + html.escape(trail) + "</pre><h3>Brief</h3><pre style='white-space:pre-wrap'>"
                + html.escape(top["brief_markdown"]) + "</pre>")
else:
    print("No new investigations in this run: every case was already investigated and nothing changed. "
          "Set force_reinvestigate to true, or widen the window, to investigate again.")