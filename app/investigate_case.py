# Databricks notebook source
# /// script
# [tool.databricks.environment]
# environment_version = "6"
# ///
"""Job task for one queued case selected in the Poseidon app."""

import base64
import copy
import hashlib
import io
import json
import re
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


def validate_request(case_id, fingerprint, volume):
    if len(case_id) > 255 or not re.fullmatch(r"[\w-]+:[\w.-]+", case_id, flags=re.ASCII):
        raise ValueError("Invalid Poseidon case ID.")
    if not re.fullmatch(r"[a-f0-9]{12}", fingerprint):
        raise ValueError("Invalid event fingerprint.")
    if not re.fullmatch(r"/Volumes/(?:[\w-]+/){2}[\w-]+", volume, flags=re.ASCII):
        raise ValueError("Expected a Unity Catalog export volume.")


def result_path(volume, case_id, fingerprint):
    key = hashlib.sha256(f"{case_id}\n{fingerprint}".encode("utf-8")).hexdigest()
    return f"{volume}/investigations/{key}.json"


def select_case(snapshot, case_id, fingerprint):
    from poseidon import pipeline
    from poseidon.gfw import resolve_window

    if snapshot.get("product") != "Poseidon" or snapshot.get("synthetic") or snapshot.get("data_source") == "sample":
        raise ValueError("This job requires a real Poseidon publication.")
    records = [c for c in snapshot["cases"] if c.get("case_id") == case_id]
    if len(records) != 1:
        raise ValueError("The selected case is missing or ambiguous in the publication.")
    record = records[0]
    area_id = str(record.get("mpa_id") or "")
    if area_id.startswith("sample-") or record.get("synthetic") or record.get("data_source") == "sample":
        raise ValueError("Synthetic cases cannot start an investigation.")
    if record.get("status") != "queued" or record.get("fingerprint") != fingerprint:
        raise ValueError("The case has changed. Refresh the publication.")
    if record.get("mode") not in ("history", "live"):
        raise ValueError("This case has no published investigation mode.")
    # Validate the actual dated window, including a previously published live run.
    # Resolving a new live window here would investigate a different time period.
    resolve_window("history", record.get("window_start"), record.get("window_end"))
    area = next((m for m in snapshot["mpas"] if str(m.get("mpa_id")) == area_id), None)
    if not area or case_id != f"{area_id}:{record.get('vessel_id')}":
        raise ValueError("The published case has no matching vessel and protected area.")
    # Snapshots can retain events from earlier runs. The case's IDs and its
    # fingerprint identify the exact observations that were queued together.
    ids = set(record.get("event_ids") or [])
    events = [e for e in record.get("events") or [] if e.get("event_id") in ids
              and e.get("case_id") == case_id and str(e.get("mpa_id")) == area_id
              and e.get("vessel_id") == record["vessel_id"]]
    cases = pipeline.build_cases(events)
    if len(cases) != 1 or pipeline.fingerprint(cases[0]) != fingerprint:
        raise ValueError("The published observations no longer match the selected case.")
    return record, events, area


def investigate_selection(selection, gfw, search, llm, endpoint):
    from poseidon import pipeline
    from poseidon.agent import Context

    record, events, area = selection
    ctx = Context(gfw=gfw, search=search, llm=llm, mode=record["mode"],
                  window_start=record["window_start"], window_end=record["window_end"], max_steps=8)
    # Only the observation set is fixed. The original agent still calls its
    # own tools for vessel identity, activity, history, rules and web evidence.
    results = pipeline.run(ctx, [area], events=copy.deepcopy(events), max_cases=1,
                           memory=pipeline.memory_from_rows([record]), exclude_types=(),
                           boundaries={str(area["mpa_id"]): area.get("boundary")},
                           llm_endpoint=endpoint, log=lambda message: None)
    if len(results["cases"]) != 1 or results["run"][0]["n_investigated"] != 1:
        raise RuntimeError("The agent returned no investigation for this case.")
    case = {**results["cases"][0], "events": events, "steps": results["steps"]}
    payload = {"case_id": record["case_id"], "fingerprint": record["fingerprint"],
               "case": case, "run": results["run"][0]}
    check_result(payload, record["case_id"], record["fingerprint"])
    return payload


def check_result(payload, case_id, fingerprint):
    case, run = payload["case"], payload["run"]
    if (payload.get("case_id") != case_id or payload.get("fingerprint") != fingerprint
            or case.get("case_id") != case_id or case.get("fingerprint") != fingerprint
            or case.get("status") not in ("complete", "incomplete") or not case.get("brief_markdown")
            or not run.get("run_id") or case.get("run_id") != run["run_id"] or not run.get("finished_at")):
        raise ValueError("The stored investigation does not match this request.")


def load_agent(dbutils, workspace, scratch):
    """Prefer the Git checkout. Some managed Git folders only support Workspace export."""
    roots = [Path.cwd(), *Path.cwd().parents]
    notebook = None
    try:
        notebook = dbutils.notebook.entry_point.getDbutils().notebook().getContext().notebookPath().get()
    except Exception:
        pass  # The working directory of a Git job is normally already in its checkout.
    if notebook:
        workspace_path = "/Workspace/" + str(notebook).removeprefix("/Workspace/").lstrip("/")
        roots.insert(0, Path(workspace_path).parent.parent)
    sys.dont_write_bytecode = True
    for root in roots:
        try:
            if (root / "poseidon" / "pipeline.py").is_file():
                sys.path.insert(0, str(root))
                from poseidon import pipeline
                return
        except OSError:
            break
    if not notebook:
        raise RuntimeError("Run this task from app/investigate_case in a checkout containing poseidon/.")
    from databricks.sdk.service.workspace import ExportFormat

    for name in list(sys.modules):
        if name == "poseidon" or name.startswith("poseidon."):
            del sys.modules[name]
    package = Path(scratch) / "poseidon"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    base = str(Path(workspace_path).parent.parent).removeprefix("/Workspace")
    for module in ("gfw", "geo", "search", "scoring", "agent", "brief", "pipeline"):
        path = f"{base}/poseidon/{module}"
        try:
            source = workspace.workspace.export(path + ".py", format=ExportFormat.SOURCE)
        except Exception:
            source = workspace.workspace.export(path, format=ExportFormat.SOURCE)
        (package / (module + ".py")).write_bytes(base64.b64decode(source.content))
    sys.path.insert(0, scratch)


def model_for(workspace, requested, snapshot):
    from databricks.sdk.service.serving import ChatMessage, ChatMessageRole

    endpoint = requested
    if not endpoint or endpoint == "auto":
        endpoint = (snapshot.get("latest_run") or {}).get("llm_endpoint")
        if not endpoint:
            try:
                endpoint = next((e.name for e in workspace.serving_endpoints.list()
                                 if e.name and getattr(e, "task", None) == "llm/v1/chat"), None)
            except Exception:
                endpoint = None
    if not endpoint or endpoint == "sample-scripted-model":
        return None, None

    def chat(system, user):
        messages = [ChatMessage(role=ChatMessageRole.SYSTEM, content=system),
                    ChatMessage(role=ChatMessageRole.USER, content=user)]
        reply = workspace.serving_endpoints.query(name=endpoint, messages=messages, max_tokens=1500)
        content = reply.choices[0].message.content
        if isinstance(content, list):
            return "".join(part.get("text", "") for part in content if isinstance(part, dict))
        return content or ""

    return chat, endpoint


def read_result(files, path, case_id, fingerprint):
    from databricks.sdk.errors import NotFound

    try:
        with files.download(path).contents as contents:
            payload = json.load(contents)
    except NotFound:
        return None
    check_result(payload, case_id, fingerprint)
    return payload


def run_job(dbutils, workspace):
    from databricks.sdk.errors import ResourceConflict
    from poseidon.gfw import GFWClient
    from poseidon.search import SearchClient

    defaults = {"case_id": "", "fingerprint": "", "export_volume": "/Volumes/workspace/poseidon/exports",
                "llm_endpoint": "auto"}
    for name, value in defaults.items():
        dbutils.widgets.text(name, value)
    values = {name: dbutils.widgets.get(name).strip() for name in defaults}
    case_id, fingerprint = values["case_id"], values["fingerprint"]
    volume = values["export_volume"].rstrip("/")
    validate_request(case_id, fingerprint, volume)
    with workspace.files.download(f"{volume}/poseidon_snapshot.json").contents as contents:
        snapshot = json.load(contents)
    selection = select_case(snapshot, case_id, fingerprint)
    path = result_path(volume, case_id, fingerprint)
    prior = read_result(workspace.files, path, case_id, fingerprint)
    if prior is None:
        gfw = GFWClient(dbutils.secrets.get("hackathon", "gfw_token"))
        try:
            linkup_key = dbutils.secrets.get("hackathon", "linkup_key")
        except Exception:
            linkup_key = None
        search = SearchClient(linkup_key) if linkup_key else None
        llm, endpoint = model_for(workspace, values["llm_endpoint"], snapshot)
        payload = investigate_selection(selection, gfw, search, llm, endpoint)
        # A single conditional file upload lets duplicate requests share one
        # finished report. The fleet publication remains owned by its publisher.
        workspace.files.create_directory(f"{volume}/investigations")
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        try:
            workspace.files.upload(path, io.BytesIO(encoded), overwrite=False)
        except ResourceConflict:
            # A concurrent request can win. Verify its file in the same way.
            pass
        prior = read_result(workspace.files, path, case_id, fingerprint)
        if prior is None:
            raise RuntimeError("The completed report could not be read back from the export volume.")
    return {"case_id": case_id, "fingerprint": fingerprint, "run_id": prior["run"]["run_id"]}


if "dbutils" in globals():
    from databricks.sdk import WorkspaceClient

    workspace_client = WorkspaceClient()
    with TemporaryDirectory() as scratch:
        load_agent(dbutils, workspace_client, scratch)
        publication = run_job(dbutils, workspace_client)
    dbutils.notebook.exit(json.dumps(publication))
