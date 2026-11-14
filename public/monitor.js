'use strict';

const byId = id => document.getElementById(id);
const shortDate = new Intl.DateTimeFormat('en-GB', {day:'2-digit', month:'short', year:'numeric', timeZone:'UTC'});
const snapshotTime = new Intl.DateTimeFormat('en-GB', {day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'UTC'});
const positionMap = document.createElement('div');
positionMap.className = 'position-map';
let snapshot;
let bundledSample = false;
let selectedId;
let section = 'Agent steps';

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function date(value) {
  const time = value ? new Date(value) : null;
  return time && Number.isFinite(+time) ? shortDate.format(time) : 'Date unavailable';
}

function period(record) {
  return [record?.window_start, record?.window_end].filter(Boolean).map(date).join(' – ');
}

function modeLabel(mode) {
  return ({live:'Live monitoring', history:'Historical investigation'})[mode] || 'Mode unavailable';
}

function readable(value) {
  return String(value || 'Unknown').replaceAll('_', ' ');
}

function sampleRun(run) {
  return run?.data_source === 'sample' || run?.llm_endpoint === 'sample-scripted-model';
}

function simulated(row) {
  if (bundledSample || snapshot.synthetic === true || snapshot.data_source === 'sample' || row.data_source === 'sample' || String(row.mpa_id).startsWith('sample-')) return true;
  return sampleRun([snapshot.latest_run, ...snapshot.runs].find(run => run?.run_id === row.run_id));
}

function sourceLink(source, label = source.title) {
  let url;
  try { url = new URL(source.url); } catch { return node('span', label || 'Source unavailable'); }
  if (!['http:', 'https:'].includes(url.protocol)) return node('span', label || 'Source unavailable');
  const link = node('a', label || url.hostname);
  link.href = url.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function metric(list, label, value) {
  const group = node('div');
  group.append(node('dt', label), node('dd', value ?? '—'));
  list.append(group);
}

function listItems(items, emptyText) {
  if (!items.length) return node('p', emptyText, 'subtle');
  const ul = node('ul', null, 'text-list');
  for (const item of items) ul.append(node('li', item));
  return ul;
}

function sourceList(sources) {
  const list = node('ol', null, 'source-list');
  for (const source of sources) {
    const item = node('li');
    if (Number.isInteger(source.n)) item.value = source.n;
    item.append(sourceLink(source));
    if (source.snippet) item.append(node('p', source.snippet, 'subtle'));
    list.append(item);
  }
  return list;
}

function renderRun() {
  const run = snapshot.latest_run;
  byId('dataset').textContent = bundledSample ? 'Synthetic demo · scripted investigations'
    : snapshot.synthetic === true || snapshot.data_source === 'sample' || sampleRun(run) ? 'Databricks export · synthetic data' : 'Databricks export';
  byId('run-title').textContent = run ? modeLabel(run.mode) : 'No runs recorded';
  byId('run-window').textContent = run ? period(run) : '';
  const metrics = byId('run-metrics');
  metrics.replaceChildren();
  if (run) {
    metric(metrics, 'Investigated', run.n_investigated);
    metric(metrics, 'Queued', run.n_queued);
    metric(metrics, bundledSample || run.llm_endpoint === 'sample-scripted-model' ? 'Scripted model decisions' : 'Model decisions', run.llm_decisions);
    metric(metrics, 'Policy decisions', run.policy_decisions);
  }
  const notes = byId('run-notes');
  notes.hidden = !run?.notes?.length;
  notes.querySelector('ul').replaceChildren(...(run?.notes || []).map(note => node('li', note)));
  byId('attribution').textContent = snapshot.attribution || 'Poseidon';
  byId('disclaimer').textContent = snapshot.disclaimer || 'Leads for human review.';
}

function renderBrief(container, selected) {
  const sources = selected.sources || [];
  if (selected.brief_markdown) {
    const body = node('div', null, 'written-brief');
    const sourceMap = new Map(sources.map(source => [String(source.n), source]));
    let list;
    for (const row of selected.brief_markdown.split(/\r?\n/)) {
      const line = row.trim();
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (!line || heading) {
        list = null;
        if (heading) body.append(node(heading[1] === '#' ? 'h3' : 'h4', heading[2]));
        continue;
      }
      const bullet = line.match(/^([-*]|\d+\.)\s+(.+)$/);
      let block;
      if (bullet) {
        const tag = /^\d/.test(bullet[1]) ? 'ol' : 'ul';
        if (!list || list.localName !== tag) { list = node(tag); body.append(list); }
        block = node('li');
        list.append(block);
      } else {
        list = null;
        block = node('p');
        body.append(block);
      }
      const content = (bullet ? bullet[2] : line).replace(/^_(.+)_$/, '$1');
      const tokens = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\[(\d+)\]|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
      let cursor = 0;
      for (const token of content.matchAll(tokens)) {
        block.append(content.slice(cursor, token.index));
        const [, title, url, number, bold, italic] = token;
        if (url) block.append(sourceLink({title, url}));
        else if (number && sourceMap.has(number)) block.append(sourceLink(sourceMap.get(number), token[0]));
        else if (bold || italic) block.append(node(bold ? 'strong' : 'em', bold || italic));
        else block.append(token[0]);
        cursor = token.index + token[0].length;
      }
      block.append(content.slice(cursor));
    }
    container.append(body);
  } else {
    container.append(node('p', selected.status === 'queued' ? 'This case is waiting for investigation.' : 'This export contains no written brief for the case.', 'subtle'));
  }
  if (sources.length) {
    const details = node('details', null, 'extra');
    details.append(node('summary', 'Source records (' + sources.length + ')'), sourceList(sources));
    container.append(details);
  }
}

function renderEvidence(container, selected) {
  const list = node('ul', null, 'reasons');
  container.append(node('h3', 'Score breakdown'));
  for (const reason of selected.reasons || []) {
    const item = node('li');
    item.append(node('span', reason.text), node('strong', (reason.points > 0 ? '+' : '') + reason.points));
    list.append(item);
  }
  container.append(list.children.length ? list : node('p', 'No scoring reasons recorded.', 'subtle'));
  container.append(node('h3', 'What remains unknown'), listItems(selected.unknowns || [], 'No uncertainties were listed in this case.'));
  const events = selected.events || [];
  if (events.length) {
    container.append(node('h3', 'Recorded events'));
    const records = node('ul', null, 'text-list');
    for (const event of events) {
      const item = node('li', readable(event.event_type) + ' · ' + date(event.start_time));
      const positions = [];
      if (Number.isFinite(event.lat) && Number.isFinite(event.lon)) positions.push('Event position ' + event.lat + '°, ' + event.lon + '°');
      if (Number.isFinite(event.end_lat) && Number.isFinite(event.end_lon)) positions.push('Resumed at ' + event.end_lat + '°, ' + event.end_lon + '°');
      if (positions.length) item.append(node('p', positions.join(' · '), 'subtle'));
      records.append(item);
    }
    container.append(records);
  }
}

function renderPositions(container, selected) {
  const points = [];
  function add(lat, lon, label) {
    if (Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180) {
      points.push({lat, lon, label});
    }
  }
  for (const event of selected.events || []) {
    add(event.lat, event.lon, readable(event.event_type) + ' · ' + date(event.start_time));
    add(event.end_lat, event.end_lon, 'End position · ' + date(event.end_time));
  }
  if (!points.length) add(selected.lat, selected.lon, 'Main event');
  if (!points.length) { container.append(node('p','This case contains no recorded positions.','subtle')); return; }
  container.append(positionMap);
  window.SoundingsMap?.render(positionMap, {
    area:{id:selected.mpa_id, name:selected.mpa_name}, map:null, points,
    caseId:selected.case_id, caseTitle:selected.vessel_name, focusArea:true
  });
  container.append(listItems(points.map(p => p.label + ' · ' + p.lat.toFixed(4) + '°, ' + p.lon.toFixed(4) + '°'), ''));
}

const toolNames = {
  resolve_identity:'Resolve vessel identity', activity_around_event:'Check activity around the event',
  vessel_history:'Review vessel history', encounter_partner:'Identify encounter partner',
  web_search_vessel:'Search vessel records', web_search_owner:'Search owner records',
  mpa_rules:'Check protected-area rules', regional_news:'Search regional news', finish:'Finish investigation'
};

function renderSteps(container, selected) {
  const steps = [...(selected.steps || [])].sort((a,b) => a.step_no - b.step_no);
  if (!steps.length) {
    container.append(node('p', selected.status === 'queued' ? 'The agent has not started this queued case.' : 'No decision log was exported for this case.', 'subtle'));
    return;
  }
  const trail = node('ol', null, 'decision-log');
  const run = [snapshot.latest_run, ...snapshot.runs].find(item => item?.run_id === selected.run_id);
  const modelLabel = bundledSample || run?.llm_endpoint === 'sample-scripted-model' ? 'Scripted model' : 'Model';
  for (const step of steps) {
    const item = node('li');
    const heading = node('div', null, 'decision-heading');
    const origin = {llm:modelLabel, policy:'Policy'};
    heading.append(node('h3', toolNames[step.tool] || readable(step.tool)), node('span', origin[step.decided_by] || 'Unknown', 'decision-by'));
    item.append(heading);
    if (step.reason) item.append(node('p', step.reason, 'subtle'));
    if (step.ok === false) item.append(node('strong', 'Check failed', 'failure'));
    if (step.result) item.append(node('p', step.result));
    trail.append(item);
  }
  container.append(trail);
}

function showSection(selected, container, buttons) {
  buttons.forEach(button => button.setAttribute('aria-pressed', String(button.textContent === section)));
  container.replaceChildren();
  if (section === 'Agent steps') renderSteps(container, selected);
  else if (section === 'Evidence') renderEvidence(container, selected);
  else if (section === 'Positions') renderPositions(container, selected);
  else renderBrief(container, selected);
}

function renderDetail(selected) {
  const detail = byId('detail');
  detail.replaceChildren();
  const title = node('h2', selected ? selected.vessel_name || 'Unidentified vessel' : 'No matching cases');
  title.id = 'case-name';
  if (!selected) { detail.append(title, node('p', 'Select another area or mode to see more investigations.', 'subtle')); return; }
  const state = [simulated(selected) ? 'Synthetic case' : 'Case record', readable(selected.status), modeLabel(selected.mode)];
  detail.append(node('p', state.join(' · '), 'eyebrow'), title, node('p', selected.headline, 'case-headline'));
  const meta = [selected.mpa_name, period(selected), selected.mmsi && 'MMSI ' + selected.mmsi].filter(Boolean);
  detail.append(node('p', meta.join(' · '), 'subtle'));
  const metrics = node('dl', null, 'metrics case-metrics');
  metric(metrics, 'Review score', selected.risk_score == null ? '—' : selected.risk_score + ' / 100');
  metric(metrics, 'Confidence', readable(selected.confidence));
  metric(metrics, 'Longest gap', selected.longest_gap_hours == null ? '—' : selected.longest_gap_hours + ' h');
  detail.append(metrics);
  const controls = node('div', null, 'section-switcher');
  controls.setAttribute('role','group');
  controls.setAttribute('aria-label','Case detail');
  const panel = node('div', null, 'case-body');
  panel.id = 'case-body';
  const buttons = ['Agent steps','Evidence','Brief','Positions'].map(label => {
    const button = node('button',label);
    button.type = 'button';
    button.setAttribute('aria-controls',panel.id);
    button.addEventListener('click',() => { section = label; showSection(selected,panel,buttons); });
    return button;
  });
  controls.append(...buttons);
  detail.append(controls,panel);
  showSection(selected,panel,buttons);
}

function renderCases() {
  const area = byId('area-filter').value;
  const mode = byId('mode-filter').value;
  const cases = snapshot.cases.filter(c => (!area || String(c.mpa_id) === area) && (!mode || c.mode === mode));
  const selected = cases.find(c => c.case_id === selectedId) || cases[0];
  selectedId = selected?.case_id;
  byId('case-total').textContent = String(cases.length);
  const list = byId('case-list');
  list.replaceChildren();
  for (const record of cases) {
    const button = node('button', null, 'vessel-row');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(record === selected));
    button.setAttribute('aria-controls','detail');
    const text = node('span');
    text.append(node('strong', record.vessel_name || 'Unidentified vessel'), node('small', [record.mpa_name, readable(record.status)].filter(Boolean).join(' · ')));
    const score = node('span', record.risk_score ?? '—', 'vessel-score');
    score.dataset.level = record.risk_level;
    score.setAttribute('aria-label','Review score ' + (record.risk_score ?? 'unavailable'));
    button.append(text,score);
    button.addEventListener('click',() => {
      selectedId = record.case_id;
      list.querySelectorAll('button').forEach(row => row.setAttribute('aria-pressed', String(row === button)));
      renderDetail(record);
    });
    list.append(button);
  }
  if (!cases.length) list.append(node('p', 'No cases match these filters.', 'empty'));
  renderDetail(selected);
  renderNews(area);
}

function renderNews(area) {
  const news = snapshot.news.filter(item => !area || String(item.mpa_id) === area);
  byId('news-total').textContent = String(news.length);
  const container = byId('news');
  container.replaceChildren();
  for (const item of news) {
    const article = node('article');
    const title = node('h3');
    title.append(sourceLink(item));
    article.append(node('p', [item.mpa_name, item.provider].filter(Boolean).join(' · '), 'eyebrow'), title);
    if (item.snippet) article.append(node('p',item.snippet));
    if (item.fetched_at) article.append(node('p', 'Retrieved ' + date(item.fetched_at), 'subtle'));
    container.append(article);
  }
  if (!news.length) container.append(node('p','No news items were exported for this area.','subtle'));
}

async function load() {
  byId('refresh').disabled = true;
  byId('notice').textContent = 'Loading snapshot…';
  try {
    const response = await fetch('/api/snapshot', {cache:'no-store'});
    if (!response.ok) throw new Error('Could not load the monitoring snapshot.');
    const data = await response.json();
    if (data?.product !== 'Poseidon' || !['mpas','cases','news','runs'].every(key => Array.isArray(data[key]))) throw new Error('Unsupported snapshot.');
    snapshot = data;
    bundledSample = response.headers.get('X-Poseidon-Source') === 'sample';
    const area = byId('area-filter');
    const previousArea = area.value;
    area.replaceChildren(new Option('All areas',''), ...data.mpas.map(mpa => new Option(mpa.mpa_name, mpa.mpa_id)));
    if ([...area.options].some(option => option.value === previousArea)) area.value = previousArea;
    renderRun();
    renderCases();
    byId('workspace').hidden = false;
    const generated = data.generated_at ? new Date(data.generated_at) : null;
    byId('notice').textContent = generated && Number.isFinite(+generated) ? 'Snapshot generated ' + snapshotTime.format(generated) + ' UTC' : 'Snapshot loaded';
  } catch {
    byId('notice').textContent = snapshot ? 'Refresh failed. Showing the last loaded snapshot.' : 'Snapshot unavailable. Check the notebook export and try Refresh snapshot.';
  } finally { byId('refresh').disabled = false; }
}

byId('area-filter').addEventListener('change',renderCases);
byId('mode-filter').addEventListener('change',renderCases);
byId('refresh').addEventListener('click',load);
load();
