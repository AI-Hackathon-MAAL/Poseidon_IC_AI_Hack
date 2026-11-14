# Databricks notebook source
# MAGIC %md
# MAGIC # Latest available Galápagos MPA brief
# MAGIC Run hourly as a Databricks Job. GFW events can be delayed; this is not a real-time AIS feed.
# MAGIC Requires Databricks secret `hackathon/gfw_token`. No synthetic fallback is used.

# COMMAND ----------
import os, sys, json, uuid, html, unicodedata
from datetime import datetime, timezone
sys.path.insert(0, os.path.abspath('../agent'))
from live_monitor import GFWClient, DATASETS, window, flatten, assess
import dark_fishing_agent as agent

for name, default in [('catalog', 'workspace'), ('schema', 'dark_fishing'),
                      ('mpa_search', 'Galapagos'), ('mpa_ids', ''),
                      ('lookback_days', '30'), ('gap_hours', '12')]:
    dbutils.widgets.text(name, default)
catalog, schema = dbutils.widgets.get('catalog'), dbutils.widgets.get('schema')
if not all(x.replace('_', '').isalnum() for x in (catalog, schema)):
    raise ValueError('Catalog and schema must contain only letters, numbers and underscores')
spark.sql(f'CREATE SCHEMA IF NOT EXISTS {catalog}.{schema}')
client = GFWClient(dbutils.secrets.get('hackathon', 'gfw_token'))
start, end = window(int(dbutils.widgets.get('lookback_days')))
threshold = float(dbutils.widgets.get('gap_hours'))
if threshold <= 0:
    raise ValueError('gap_hours must be positive')
run_id = str(uuid.uuid4())

def normalized(s):
    return ''.join(c for c in unicodedata.normalize('NFKD', s.lower()) if not unicodedata.combining(c))

mpas = client.mpas()
requested = {x.strip() for x in dbutils.widgets.get('mpa_ids').split(',') if x.strip()}
search = normalized(dbutils.widgets.get('mpa_search').strip())
if not requested and not search:
    raise ValueError('Supply mpa_ids or mpa_search')
selected = [m for m in mpas if (str(m['id']) in requested if requested else
            search in normalized(m.get('label') or m.get('name') or ''))]
if not selected or (requested and requested != {str(m['id']) for m in selected}):
    raise ValueError('MPA selection not found. Check mpa_search or explicit mpa_ids.')
print('Monitoring:', [(m['id'], m.get('label') or m.get('name')) for m in selected])

# COMMAND ----------
# All requests must succeed before publishing a successful report.
# Errors fail the Job, leaving previous reports visibly timestamped.
reports = []
for mpa in selected:
    mpa_id, name = str(mpa['id']), mpa.get('label') or mpa.get('name')
    unique = {}
    for kind in DATASETS:
        for event in client.events(kind, mpa_id, start, end):
            row = flatten(event, kind, mpa_id, name)
            unique[(kind, row['event_id'])] = row
    rows = list(unique.values())
    briefs = []
    for lead in agent.group_leads(rows):
        # History and search are optional enrichment. The monitoring assessment uses fetched events.
        brief = agent.investigate(lead, agent.Tools(client.session.headers['Authorization'][7:]),
                                  llm=None, start=start, end=end)
        brief['tracking_status'] = assess(lead.events, threshold)
        briefs.append(brief)
    latest = max((r['end_time'] or r['start_time'] for r in rows if r['end_time'] or r['start_time']), default=None)
    text = [f'# {name} — latest available GFW brief',
            f'Fetched: {end}. Query window: {start} to {end}.',
            f'Latest returned event time: {latest or "No events returned"}.',
            f'Gap review threshold: {threshold:g} hours. {len(rows)} events; {len(briefs)} vessel leads.',
            'GFW publication may be delayed. No qualifying gap is not proof of continuous tracking or compliance.',
            'Only vessels in returned events are assessed. This is not a list of every ship in the MPA.',
            'A gap is a review signal, not proof of intentional disabling or illegal fishing.',
            'Source: Global Fishing Watch (apparent activity). Non-commercial use; GFW API terms apply.']
    for b in sorted(briefs, key=lambda b: -b['risk_score']):
        text += [f'## Tracking status: {b["tracking_status"]}', b['brief_markdown']]
    if not briefs:
        text.append('No vessel leads returned in this window; coverage cannot be established.')
    reports.append({'run_id': run_id, 'mpa_id': mpa_id, 'mpa_name': name,
                    'fetched_at': end, 'window_start': start, 'window_end': end,
                    'latest_event_at': latest, 'event_count': len(rows),
                    'briefs_json': json.dumps(briefs), 'brief_markdown': '\n\n'.join(text)})

# COMMAND ----------
from pyspark.sql.types import StructType, StructField, StringType, LongType
report_schema = StructType([StructField(k, LongType() if k == 'event_count' else StringType(), True)
                           for k in reports[0]])
spark.createDataFrame(reports, report_schema).write.mode('append').saveAsTable(f'{catalog}.{schema}.monitor_reports')
spark.sql(f'''CREATE OR REPLACE VIEW {catalog}.{schema}.latest_mpa_briefs AS
SELECT * EXCEPT (rn) FROM (
  SELECT *, row_number() OVER (PARTITION BY mpa_id ORDER BY fetched_at DESC, run_id DESC) rn
  FROM {catalog}.{schema}.monitor_reports
) WHERE rn = 1''')
for report in reports:
    displayHTML('<pre style="white-space:pre-wrap">' + html.escape(report['brief_markdown']) + '</pre>')
