# Databricks notebook source
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
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
MODULES = ["gfw", "search", "scoring", "agent", "brief", "pipeline", "contract", "sample"]   # dependency order
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

from poseidon import contract, pipeline, sample
from poseidon.agent import Context
from poseidon.gfw import GFWClient, resolve_window
from poseidon.search import SearchClient
print("Poseidon code loaded from", repo)

# COMMAND ----------

dbutils.widgets.dropdown("mode", "history", ["history", "live"])
dbutils.widgets.text("start_date", "2026-08-01")
dbutils.widgets.text("end_date", "2026-11-14")
dbutils.widgets.text("lookback_days", "30")
dbutils.widgets.text("mpa_search", "")
dbutils.widgets.text("mpa_ids", "")
dbutils.widgets.text("max_cases", "5")
dbutils.widgets.text("max_steps", "8")
dbutils.widgets.text("focus", "")
dbutils.widgets.dropdown("force_reinvestigate", "false", ["false", "true"])
dbutils.widgets.dropdown("data_source", "gfw", ["gfw", "sample"])
dbutils.widgets.dropdown("search_provider", "linkup", ["linkup", "tavily", "none"])
dbutils.widgets.text("llm_endpoint", "auto")
dbutils.widgets.text("catalog", "workspace")
dbutils.widgets.text("schema", "poseidon")
dbutils.widgets.dropdown("snapshot_to_repo", "true", ["true", "false"])
dbutils.widgets.dropdown("snapshot_scope", "this_run_areas", ["this_run_areas", "all_areas"])

W = {k: dbutils.widgets.get(k).strip() for k in
     ["mode", "start_date", "end_date", "lookback_days", "mpa_search", "mpa_ids", "max_cases", "max_steps", "focus",
      "force_reinvestigate", "data_source", "search_provider", "llm_endpoint", "catalog", "schema", "snapshot_to_repo", "snapshot_scope"]}
SAMPLE = W["data_source"] == "sample"
CATALOG, SCHEMA = contract.storage_namespace(W["catalog"], W["schema"], W["data_source"])
spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")
print(f"Saving {W['data_source']} runs to {CATALOG}.{SCHEMA}")
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

try:
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.service.serving import ChatMessage, ChatMessageRole
    w = WorkspaceClient()
    LLM_ENDPOINT = pick_endpoint()
except Exception as exc:
    print(f"Model setup unavailable ({type(exc).__name__}); continuing with the rule-based policy.")
    LLM_ENDPOINT = None
if LLM_ENDPOINT:
    llm = lambda system, user: chat(LLM_ENDPOINT, system, user)
    print("Language model:", LLM_ENDPOINT, "(chooses the agent's next check and writes briefs)")
else:
    llm = None
    print("WARNING: no chat model is available. The rule-based policy will choose checks and briefs use the template.")

# COMMAND ----------

# MAGIC %md ## Choose the window and the protected areas

# COMMAND ----------

sample_clock = datetime(2026, 10, 31, tzinfo=timezone.utc) if SAMPLE and W["mode"] == "live" else None
window_start, window_end = resolve_window(W["mode"], W["start_date"], W["end_date"], W["lookback_days"], now=sample_clock)
if sample_clock:
    print(f"Synthetic live monitoring clock: {sample_clock.date()} UTC")
mpa_ids = W["mpa_ids"]
if not mpa_ids and not W["mpa_search"]:
    mpa_ids = "sample-1,sample-2" if SAMPLE else "11753"
mpas = pipeline.select_mpas(gfw.mpas(), search=W["mpa_search"], ids=mpa_ids)
print(f"Mode: {W['mode']}   Window: {window_start} to {window_end}")
print("Protected areas:")
for m in mpas:
    print(f"  {m['mpa_id']}  {m['mpa_name']}")
if not mpas:
    dbutils.notebook.exit("No protected area matched. Change mpa_search or set mpa_ids.")
if len(mpas) > 5:
    print(f"NOTE: {len(mpas)} areas matched; using the first 5. Set mpa_ids to choose.")
    mpas = mpas[:5]

# COMMAND ----------

# MAGIC %md ## Run the agent
# MAGIC The log shows every decision: `[llm]` means the model chose that check, `[policy]` means the rule-based fallback did.

# COMMAND ----------

def table(name):
    return f"{CATALOG}.{SCHEMA}.{name}"

def read_rows(name, run_ids=None):
    """Table -> list of dicts with timestamps as ISO strings."""
    if (run_ids is not None and not run_ids) or not spark.catalog.tableExists(table(name)):
        return []
    frame = spark.table(table(name))
    if run_ids is not None:
        frame = frame.where(frame["run_id"].isin(list(run_ids)))
    out = []
    for r in frame.collect():
        d = r.asDict()
        for k, v in d.items():
            if hasattr(v, "isoformat"):
                d[k] = v.replace(tzinfo=None).isoformat(timespec="seconds") + "Z"
        out.append(d)
    return out

previous_runs = read_rows("runs")
source_run_ids = {r["run_id"] for r in contract.runs_for_source(previous_runs, W["data_source"])}
if any(r.get("data_source") is None for r in previous_runs):
    print("Earlier runs have no recorded data source. Their rows remain stored and are excluded from this export and memory.")
memory = pipeline.memory_from_rows(read_rows("cases", source_run_ids))
print(f"Memory: {len(memory)} case(s) remembered from earlier runs\n")

ctx = Context(gfw=gfw, search=search, llm=llm, window_start=window_start, window_end=window_end,
              mode=W["mode"], max_steps=int(W["max_steps"]))
result = pipeline.run(ctx, mpas, memory=memory, max_cases=int(W["max_cases"]),
                      force=W["force_reinvestigate"] == "true",
                      focus=[f for f in W["focus"].split(",") if f.strip()], llm_endpoint=LLM_ENDPOINT)
run_row = result["run"][0]
run_row["data_source"] = W["data_source"]
if sample_clock:
    run_row["notes"].append(f"Synthetic live monitoring used a simulated clock of {sample_clock.date()} UTC.")
print(f"\nRun {run_row['run_id']}: {run_row['n_investigated']} investigated, {run_row['n_skipped_unchanged']} unchanged, "
      f"{run_row['n_queued']} queued. Decisions: {run_row['llm_decisions']} by model, {run_row['policy_decisions']} by policy.")
for note in run_row["notes"]:
    print("NOTE:", note)

# COMMAND ----------

# MAGIC %md ## Save to the tables the front end reads

# COMMAND ----------

from pyspark.sql import functions as F
from pyspark.sql.types import StructType, StructField, StringType

SPARK_TYPE = {"string": "string", "json": "string", "int": "int", "double": "double",
              "boolean": "boolean", "timestamp": "timestamp"}

def save(name, rows):
    spec = contract.TABLES[name]
    exists = spark.catalog.tableExists(table(name))
    if not rows and exists:
        print(f"  {name}: nothing new")
        return
    raw = spark.createDataFrame(contract.to_table_rows(name, rows),
                                StructType([StructField(c, StringType(), True) for c, _ in spec["columns"]]))
    # try_cast: a malformed value becomes null instead of failing the whole run
    df = raw.select([F.expr(f"try_cast(`{c}` AS {SPARK_TYPE[t]})").alias(c) for c, t in spec["columns"]])
    if not exists:
        df.write.format("delta").saveAsTable(table(name))
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

save("events", result["events"])
save("cases", result["cases"])
save("agent_steps", result["steps"])
if spark.catalog.tableExists(table("runs")) and "data_source" not in spark.table(table("runs")).columns:
    spark.sql(f"ALTER TABLE {table('runs')} ADD COLUMNS (data_source STRING)")
save("runs", result["run"])
save("news", result["news"])
save("mpa_context", result["mpa_context"])

runs = contract.runs_for_source(read_rows("runs"), W["data_source"])
source_run_ids = {r["run_id"] for r in runs}
all_cases, all_events = read_rows("cases", source_run_ids), read_rows("events", source_run_ids)
save("mpa_status", contract.mpa_status_rows(all_cases, all_events))

# COMMAND ----------

# MAGIC %md ## Snapshot for the front end
# MAGIC One JSON document with everything (cases with their events and agent steps, area status, news, latest run).

# COMMAND ----------

# Keep the source-specific history, optionally narrowed to this run's protected areas.
keep = {str(m["mpa_id"]) for m in mpas}
def scoped(rows):
    if W["snapshot_scope"] == "all_areas":
        return rows
    return [r for r in rows if str(r.get("mpa_id")) in keep]

run_rows = runs if W["snapshot_scope"] == "all_areas" else [
    r for r in runs if keep.intersection(map(str, contract.parse_row("runs", r).get("mpa_ids") or []))]
case_rows = scoped(all_cases)
case_ids = {c["case_id"] for c in case_rows}
snapshot = contract.build_snapshot(run_rows, case_rows, scoped(all_events),
                                   [s for s in read_rows("agent_steps", source_run_ids) if s.get("case_id") in case_ids],
                                   scoped(read_rows("news", source_run_ids)), scoped(read_rows("mpa_context", source_run_ids)),
                                   datetime.now(timezone.utc).isoformat(timespec="seconds"))
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
        print("To share it: click the branch name (main) at the top -> tick this file -> Commit & Push.")
    except Exception as e:
        print(f"Could not copy the snapshot into the Git folder ({str(e)[:200]}).")

# COMMAND ----------

# MAGIC %md ## Results

# COMMAND ----------

display(spark.sql(f"""
    SELECT risk_score, risk_level, confidence, status, vessel_name, flag, mpa_name, headline, change,
           n_steps, llm_decisions, policy_decisions, investigated_at
    FROM {table('cases')}
    WHERE run_id IN (SELECT run_id FROM {table('runs')} WHERE data_source = '{W["data_source"]}')
    ORDER BY risk_score DESC, investigated_at DESC"""))

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
