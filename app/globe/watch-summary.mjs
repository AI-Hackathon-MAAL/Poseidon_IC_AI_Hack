import {newsPreview} from './news-feed.mjs';
export {renderNewsFeed} from './news-feed.mjs';

const records = value => Array.isArray(value) ? value : [];
const labels = {
  resolve_identity: 'Identity check', activity_around_event: 'Activity around the event',
  vessel_history: 'Vessel history', encounter_partner: 'Encounter partner',
  web_search_vessel: 'Vessel search', web_search_owner: 'Owner search',
  mpa_rules: 'Area rules', regional_news: 'Regional news', finish: 'Investigation finished'
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function timeOf(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : -Infinity;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric'
});
function timeLabel(value) {
  const timestamp = timeOf(value);
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  return dateFormat.format(date) + ' · ' + date.toISOString().slice(11, 16) + 'Z';
}

function vesselName(row) {
  return row.vessel_name?.trim().replace(/\s+/g, ' ') || (row.mmsi ? 'MMSI ' + row.mmsi : 'Unidentified ' + (row.vessel_type === 'gear' ? 'gear' : 'vessel'));
}

export function watchCounts(snapshot) {
  const cases = records(snapshot.cases);
  const ships = cases.filter(row => row.vessel_type !== 'gear');
  const vesselKey = row => row.vessel_id || row.mmsi || row.case_id;
  const countShips = predicate => new Set(ships.filter(predicate).map(vesselKey)).size;
  return {
    areas: records(snapshot.mpas).length,
    highRisk: cases.filter(row => row.risk_level === 'high').length,
    gaps: countShips(row => row.longest_gap_hours != null),
    unidentified: countShips(row => row.vessel_identified === false),
    citations: cases.reduce((sum, row) => sum + records(row.sources).length, 0)
  };
}

function renderCounts(snapshot) {
  const counts = watchCounts(snapshot);
  const metrics = element('dl', 'watch-metrics');
  const entries = [
    ['Areas watched', counts.areas], ['High-risk leads', counts.highRisk],
    ['Vessels with AIS gaps', counts.gaps], ['Unidentified vessels', counts.unidentified],
    ['Sources cited', counts.citations]
  ];
  for (const [label, value] of entries) {
    const metric = element('div');
    metric.append(element('dt', '', label), element('dd', '', String(value)));
    metrics.append(metric);
  }
  return metrics;
}

function section(title) {
  const section = element('section', 'watch-section');
  section.append(element('h3', '', title));
  return section;
}

function priorityQueue(cases, onCase) {
  const queue = section('Priority queue');
  const ranked = cases.filter(row => Number.isFinite(row.risk_score))
    .sort((a, b) => b.risk_score - a.risk_score || timeOf(b.last_event_at) - timeOf(a.last_event_at)).slice(0, 8);
  if (!ranked.length) {
    queue.append(element('p', 'watch-empty', 'No scored cases in this publication.'));
    return queue;
  }
  const list = element('ol', 'watch-list watch-queue');
  for (const row of ranked) {
    const item = element('li'), action = element('button', 'watch-case');
    action.type = 'button';
    action.addEventListener('click', () => onCase(row));
    const score = element('span', 'watch-score', String(row.risk_score));
    const queued = row.status === 'queued';
    score.dataset.risk = queued ? 'queued' : row.risk_level || 'unknown';
    score.setAttribute('aria-label', (queued ? 'Preliminary score ' : 'Review score ') + row.risk_score);
    const content = element('span', 'watch-case-copy');
    const identity = [vesselName(row), row.vessel_type === 'gear' ? 'Fishing gear' : '', row.flag].filter(Boolean).join(' · ');
    const metadata = [row.mpa_name, queued ? 'Awaiting investigation' : row.status, row.change].filter(Boolean).join(' · ');
    content.append(element('strong', 'watch-title', identity), element('span', 'watch-meta', metadata));
    if (row.headline) content.append(element('span', 'watch-signal', row.headline));
    const evidence = element('span', 'watch-confidence', row.confidence ? row.confidence + ' confidence' : 'Confidence unreported');
    content.append(evidence);
    action.append(score, content);
    item.append(action);
    list.append(item);
  }
  queue.append(list);
  return queue;
}

function agentActivity(cases, onCase) {
  const activity = section('Latest agent activity');
  const steps = cases.flatMap(row => records(row.steps).map(step => ({row, step})))
    .filter(({step}) => Number.isFinite(timeOf(step.at)))
    .sort((a, b) => timeOf(b.step.at) - timeOf(a.step.at) || b.step.step_no - a.step.step_no).slice(0, 6);
  if (!steps.length) {
    activity.append(element('p', 'watch-empty', 'No dated agent steps in this publication.'));
    return activity;
  }
  const list = element('ol', 'watch-list watch-activity');
  for (const {row, step} of steps) {
    const item = element('li');
    const action = element('button', 'watch-case-link', vesselName(row));
    action.type = 'button';
    action.addEventListener('click', () => onCase(row));
    const time = element('time', 'watch-meta', timeLabel(step.at));
    time.dateTime = step.at;
    const label = labels[step.tool] || step.tool?.replaceAll('_', ' ') || 'Investigation step';
    item.append(time, element('strong', 'watch-title', label), action);
    if (step.result) item.append(element('p', 'watch-snippet', step.result));
    list.append(item);
  }
  activity.append(list);
  return activity;
}

export function renderWatchSummary(body, snapshot, onCase, onNews) {
  const cases = records(snapshot.cases);
  const content = element('div', 'watch-summary');
  content.append(renderCounts(snapshot));
  if (onNews) content.append(newsPreview(snapshot, onNews));
  content.append(priorityQueue(cases, onCase), agentActivity(cases, onCase));
  body.replaceChildren(content);
}
