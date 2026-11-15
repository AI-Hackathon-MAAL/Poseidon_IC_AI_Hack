import {appendCaseContext} from './agent-context.mjs';

const rows = value => Array.isArray(value) ? value.filter(Boolean) : [];
const present = value => value != null && value !== '';
const count = (n, noun) => n + ' ' + noun + (n === 1 ? '' : 's');
const titleCase = value => typeof value === 'string' && value ? value.charAt(0).toUpperCase() + value.slice(1) : '—';
const eventLabels = {gap:'AIS reporting gap', fishing:'Apparent fishing', encounter:'Apparent encounter', loitering:'Apparent loitering', port_visit:'Port visit'};
const basisLabels = {events:'Tracking data', gfw_vessel:'Vessel registry', gfw_history:'Vessel history', web:'Public reports'};
const toolLabels = {resolve_identity:'Resolve identity', activity_around_event:'Activity around the event', vessel_history:'12-month vessel history', encounter_partner:'Encounter partner', web_search_vessel:'Vessel search', web_search_owner:'Owner search', mpa_rules:'Protected-area rules', regional_news:'Regional news', finish:'Finish'};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function section(host, title, annotation = '', open = false) {
  const details = node('details', null, 'report-section');
  const summary = node('summary');
  summary.append(node('span', title));
  if (annotation) summary.append(node('small', annotation));
  const content = node('div', null, 'report-content');
  details.open = open;
  details.append(summary, content);
  host.append(details);
  return content;
}

function field(list, label, value) {
  const pair = node('div');
  pair.append(node('dt', label), node('dd', present(value) ? value : '—'));
  list.append(pair);
}

function link(label, address) {
  try {
    const url = new URL(address);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
      const anchor = node('a', label);
      anchor.href = url.href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      return anchor;
    }
  } catch { /* The publication can omit the address. */ }
  return node('span', label);
}

function inline(parent, line, sources) {
  // Only numbered records can supply link destinations. Treat the rest of the brief as text.
  const plain = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^_(.+)_$/, '$1');
  for (const part of plain.split(/(\[\d+\]|\*\*[^*]+\*\*|\*[^*]+\*)/g)) {
    const citation = /^\[(\d+)\]$/.exec(part);
    const source = citation && sources.find(item => String(item.n) === citation[1]);
    if (source) {
      const anchor = link(part, source.url);
      anchor.className = 'report-citation';
      anchor.setAttribute('aria-label', 'Source ' + source.n + ', ' + (source.title || 'Public source'));
      parent.append(anchor);
    } else if (part.startsWith('**') && part.endsWith('**')) {
      parent.append(node('strong', part.slice(2,-2)));
    } else if (part.startsWith('*') && part.endsWith('*')) {
      parent.append(node('em', part.slice(1,-1)));
    } else parent.append(document.createTextNode(part));
  }
}

function markdown(parent, text, sources, foldHeadings = false) {
  let target = parent;
  let list;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    if (line.startsWith('# ')) continue; // The drawer title identifies the case.
    const heading = /^#{2,6}\s+(.+)$/.exec(line);
    const bullet = /^(?:[-*+]\s+|(\d+)[.)]\s+)(.+)$/.exec(line);
    if (heading && foldHeadings) {
      target = section(parent, heading[1]);
      list = null;
      continue;
    }
    if (bullet) {
      const tag = bullet[1] ? 'OL' : 'UL';
      if (!list || list.tagName !== tag) { list = node(tag); target.append(list); }
      const item = node('li');
      if (bullet[1]) item.value = Number(bullet[1]);
      inline(item, bullet[2], sources);
      list.append(item);
    } else {
      list = null;
      const item = node(heading ? 'h3' : 'p');
      inline(item, heading ? heading[1] : line, sources);
      target.append(item);
    }
  }
}

function sourceList(host, sources, evidence = {}) {
  if (!sources.length) { host.append(node('p', 'No public sources were attached to this case.')); return; }
  const list = node('ol', null, 'report-sources');
  for (const source of sources) {
    const item = node('li');
    if (Number.isInteger(source.n)) item.value = source.n;
    item.append(link(source.title || 'Public source', source.url));
    if (source.snippet) item.append(node('p', source.snippet));
    const kind = toolLabels[source.kind] || source.kind;
    const provider = evidence?.[source.kind]?.provider;
    const attribution = [provider === 'linkup' ? 'Linkup' : provider, kind].filter(Boolean).join(' · ');
    if (attribution) item.append(node('small', attribution));
    list.append(item);
  }
  host.append(list);
}

function downloadBrief(record, markdown) {
  const button = node('button', 'Download brief ↓', 'report-download');
  button.type = 'button';
  button.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([markdown], {type:'text/markdown;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'poseidon-' + String(record.case_id || 'case').replace(/[^a-zA-Z0-9_-]+/g,'-') + '.md';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return button;
}

function appendObservations(body, events, raw, date, open = false) {
  const observations = section(body, 'AIS observations', count(events.length, 'event'), open);
  if ([raw.vessel_type, ...rows(raw.evidence?.resolve_identity?.ship_types)].some(v => String(v).toLowerCase() === 'gear')) {
    observations.append(node('p', 'AIS identifies this signal as tracked gear. Its associated vessel is unconfirmed.'));
  }
  if (events.some(e => e.event_type === 'gap')) observations.append(node('p', 'AIS positions bracket the reporting gap. The route and activity between those observations remain unknown.'));
  for (const event of events) {
    const block = node('div', null, 'report-observation');
    const length = Number.parseFloat(event.duration_hours);
    block.append(node('strong', eventLabels[event.event_type] || event.event_type || 'Observation'),
      node('small', [date(event.start_time),date(event.end_time)].join(' → ') + (Number.isFinite(length) ? ' · ' + Number(length.toFixed(2)) + ' h' : '')));
    observations.append(block);
  }
  if (!events.length) observations.append(node('p', 'No observations were attached to this case.'));
}

export function renderAgentReport(record, catalog, {date}) {
  const raw = record.snapshotCase, snapshot = catalog.snapshot;
  const dialog = document.getElementById('brief-dialog'), body = document.getElementById('brief');
  const tracePanel = dialog.querySelector('.activity-panel');
  const events = rows(record.events ?? raw.events).filter(e => !e.case_id || e.case_id === raw.case_id);
  const reasons = rows(raw.reasons), sources = rows(raw.sources), unknowns = rows(raw.unknowns);
  const run = [snapshot.latest_run, ...rows(snapshot.runs)].find(r => r?.run_id && r.run_id === raw.run_id);
  const region = rows(snapshot.mpas).find(a => a.mpa_id != null && String(a.mpa_id) === String(raw.mpa_id));
  const level = ['high','medium','low'].includes(raw.risk_level) ? raw.risk_level : 'unknown';
  const status = {complete:'Complete', incomplete:'Incomplete', queued:'Awaiting investigation'}[raw.status] || '—';
  const who = {llm: record.synthetic ? 'Scripted model' : 'Model', policy:'Policy', template:'Template'};
  const written = typeof raw.brief_markdown === 'string' ? raw.brief_markdown.trim() : '';
  const observationOnly = raw.status === 'queued' || !written;
  const localReport = raw.report_origin === 'snapshot-python';
  const source = localReport ? 'Generated locally from the published snapshot'
    : record.synthetic ? 'Synthetic snapshot' : 'Published Databricks snapshot';
  document.getElementById('brief-title').textContent = record.vessel || raw.vessel_name || 'Unidentified vessel';
  dialog.querySelector('.drawer-heading .eyebrow').textContent = observationOnly ? 'Observation report' : 'Agent report';
  document.getElementById('close-brief').setAttribute('aria-label', 'Close report');
  // Keep the replay elements inside the dialog when switching between report types.
  body.after(tracePanel);
  tracePanel.hidden = observationOnly;
  body.replaceChildren();
  body.className = 'agent-report';
  const heading = node('div', null, 'report-overview');
  heading.dataset.level = level;
  const place = node('p', region?.mpa_name || raw.mpa_name || '—', 'report-area');
  if (observationOnly) {
    document.getElementById('timeline').replaceChildren();
    tracePanel.open = false;
    heading.append(place, node('p', raw.status === 'queued' ? status : 'Agent brief unavailable', 'report-finding'));
    const byline = node('div', null, 'report-byline');
    byline.append(node('small', source));
    const identity = node('dl', null, 'report-facts');
    field(identity, 'MMSI', raw.mmsi);
    field(identity, 'Flag', raw.flag);
    field(identity, 'First recorded event', date(raw.first_event_at));
    field(identity, 'Last recorded event', date(raw.last_event_at));
    heading.append(byline, identity);
    body.append(heading);
    appendObservations(body, events, raw, date, true);
    return;
  }
  const scoreBlock = node('div', null, 'report-score');
  scoreBlock.append(node('span', 'Risk score', 'report-label'));
  const score = node('strong', present(raw.risk_score) ? raw.risk_score : '—');
  score.append(node('small', ' / 100'));
  scoreBlock.append(score);
  if (Number.isFinite(raw.risk_score)) {
    const meter = node('div', null, 'report-score-meter');
    const fill = node('span');
    fill.style.width = Math.max(0, Math.min(100, raw.risk_score)) + '%';
    meter.setAttribute('aria-hidden','true');
    meter.append(fill);
    scoreBlock.append(meter);
  }
  const bands = node('dl', null, 'report-metrics');
  field(bands,'Review priority',titleCase(raw.risk_level));
  field(bands,'Evidence confidence',titleCase(raw.confidence));
  field(bands,'Investigation',status);
  const assessment = node('div', null, 'report-rating');
  assessment.append(scoreBlock, bands);
  heading.append(place, assessment, node('p', raw.headline || record.title || '—', 'report-finding'));
  body.append(heading);

  const byline = node('div', null, 'report-byline');
  byline.append(node('small', [source, raw.investigated_at && 'Investigated ' + date(raw.investigated_at)].filter(Boolean).join(' · ')));
  byline.append(downloadBrief(raw, raw.brief_markdown));
  body.append(byline);

  const factors = section(body, 'Score breakdown', count(reasons.length, 'factor'));
  for (const reason of reasons) {
    const row = node('div', null, 'report-factor');
    const points = Number.isFinite(reason.points) ? (reason.points >= 0 ? '+' : '') + reason.points : '—';
    const copy = node('div');
    copy.append(node('p', reason.text || '—'), node('small', basisLabels[reason.basis] || reason.basis || '—'));
    row.append(node('span', points, 'report-points'), copy);
    factors.append(row);
  }
  if (!reasons.length) factors.append(node('p', 'No scoring reasons were recorded.'));
  const gaps = section(body, 'Uncertainties', count(unknowns.length, 'open question'), unknowns.length > 0);
  gaps.parentElement.classList.add('report-uncertainties');
  if (unknowns.length) {
    const list = node('ul');
    for (const item of unknowns) list.append(node('li', item));
    gaps.append(list);
  } else gaps.append(node('p', 'No gaps flagged in this investigation.'));
  const brief = section(body, 'Investigation brief', who[raw.brief_written_by] || '');
  markdown(brief, written, sources, true);
  body.append(tracePanel);

  appendObservations(body, events, raw, date);
  const rules = section(body, 'Protected-area rules');
  const references = rows(region?.rules_sources).map((s,i)=>({...s,n:s.n ?? i+1}));
  if (region?.rules_summary) {
    markdown(rules, region.rules_summary, references);
    rules.append(node('p', 'Check the event date, position, gear and authorizations against the official rules for the zone.'));
  }
  else rules.append(node('p','No rules summary was recorded for this area.'));
  if (references.length) {rules.append(node('h3','Sources for area rules'));sourceList(rules, references);}
  const bibliography = section(body,'Case sources', count(sources.length, 'source'));
  if (sources.length) bibliography.append(node('p', 'Match vessel identifiers and dates before attributing a public report to this case.'));
  sourceList(bibliography, sources, raw.evidence);
  appendCaseContext(body, raw);
  const articles = rows(snapshot.news).filter(n => raw.mpa_id != null && String(n.mpa_id) === String(raw.mpa_id));
  if (articles.length) {
    const news = section(body, 'Regional news', count(articles.length, 'article'));
    const queries = [...new Set(articles.map(item => item.query).filter(Boolean))];
    for (const query of queries) news.append(node('p', 'Search query · ' + query));
    for (const item of articles) {
      const row = node('div', null, 'report-observation');
      row.append(link(item.title || 'News article',item.url),node('small',[item.provider, item.fetched_at && 'Retrieved ' + date(item.fetched_at)].filter(Boolean).join(' · ')));
      news.append(row);
    }
  }
  const provenance = section(body, 'Investigation record');
  const metadata = node('dl', null, 'report-facts');
  for (const [key,value] of [
    ['Data source',source],['Run',raw.run_id],['Mode',raw.mode],
    ['Window',[raw.window_start,raw.window_end].filter(Boolean).map(date).join(' – ')],
    ['Brief writer',who[raw.brief_written_by]],['Model endpoint',localReport ? null : run?.llm_endpoint],['Search provider',localReport ? 'Snapshot evidence' : run?.search_provider],
    ['Model decisions',raw.llm_decisions],['Policy decisions',raw.policy_decisions]
  ]) field(metadata,key,value);
  provenance.append(metadata);

  const trace = document.getElementById('timeline');
  const stepNumbers = new Set();
  const steps = rows(raw.steps).filter(step => {
    if ((step.case_id && step.case_id !== raw.case_id) || (step.run_id && step.run_id !== raw.run_id)) return false;
    if (step.step_no == null) return true;
    if (stepNumbers.has(step.step_no)) return false;
    stepNumbers.add(step.step_no);return true;
  }).sort((a,b) => a.step_no-b.step_no);
  trace.replaceChildren();
  for (const step of steps) {
    const block = node('div',null,'step'), text = node('div');
    block.dataset.outcome = step.ok === false ? 'failed' : 'recorded';
    text.append(node('strong',toolLabels[step.tool] || step.tool || 'Investigation check'),
      node('small',[present(step.step_no) && 'Step ' + step.step_no,who[step.decided_by],step.ok === false && 'Check failed', step.at && date(step.at),
        Number.isFinite(step.duration_ms) && (step.duration_ms / 1000).toLocaleString('en-GB',{maximumFractionDigits:2}) + ' s'].filter(Boolean).join(' · ')));
    if (step.reason) text.append(node('p',step.reason));
    if (step.result) text.append(node('p',step.result));
    block.append(text);trace.append(block);
  }
  if (!steps.length) trace.append(node('p', 'No agent steps were recorded.'));
  tracePanel.open = false;
  tracePanel.querySelector('summary').replaceChildren(node('span','Agent trace'), node('small',count(steps.length,'step')));
}
