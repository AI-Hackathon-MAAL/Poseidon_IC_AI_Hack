# Instructions for Claude Code

Read `HANDOFF.md` first: it has the project state, decisions, known problems and next steps.
Then `AGENTS.md` (repo map and rules), `docs/backend.md` (data contract) and `docs/ui-spec.md` (front end).

- Backend runs on Databricks (`notebooks/poseidon.py` + `poseidon/`). Test locally with
  `python -m unittest discover -s tests`; real API runs happen in Databricks.
- Never ask for or commit API keys. Secrets live in the Databricks scope `hackathon`.
- Deadline: Sunday 15 Nov 2026, 12:00 London time.
