const $ = id => document.getElementById(id);
let catalog;
let selected;
let running = false;
let selectionVersion = 0;
const make = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function safeLink(title, url) {
  const link = make('a', title);
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') {
      link.href = parsed.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  } catch {}
  return link;
}
function date(value) {
  if (!value) return 'Date unavailable';
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return String(value);
  const day = parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  });
  if (!String(value).includes('T')) return day;
  return `${day} · ${parsed.toISOString().slice(11, 19)} UTC`;
}
function casePeriod(record) {
  return record.kind === 'Annual estimate' ? record.date.slice(0,4) + ' · annual estimate' : date(record.date);
}
function mapData() {
  if (Array.isArray(catalog.maps)) return catalog.maps.find(map => map.areaId === $('area').value);
  if (catalog.maps && typeof catalog.maps === 'object') return catalog.maps[$('area').value];
  return catalog.map?.areaId === $('area').value ? catalog.map : null;
}
function drawMap(points = []) {
  const map = mapData();
  const area = catalog.areas.find(area => area.id === $('area').value);
  if (window.SoundingsMap) {
    window.SoundingsMap.render($('map'), {
      area, map: map || null, points,
      caseId: selected?.id, caseTitle: selected?.title
    });
  } else {
    $('map').replaceChildren(make('p', 'Map unavailable. The case evidence remains available below.', 'queue-empty'));
  }
  $('map-caption').textContent = points.length
    ? 'Recorded positions · Route during the gap unknown'
    : map ? 'Protected-area context · Select a measured event for positions'
    : 'Regional context · Source report has no track-level coordinates';
  const source = safeLink(map?.source ? 'Boundary source ↗' : '', map?.source?.url);
  source.id = 'boundary-source';
  $('boundary-source').replaceWith(source);
  document.querySelector('.map-key').hidden = !map?.bounds;
}
function renderFacts(record) {
  $('case-facts').replaceChildren();
  const elapsedHours = (Date.parse(record.end) - Date.parse(record.start)) / 3600000;
  const gapDuration = Number.isFinite(elapsedHours) && elapsedHours >= 0
    ? elapsedHours.toFixed(2) + ' hours'
    : Number.isFinite(record.datasetHours) ? record.datasetHours.toFixed(2) + ' hours (archive)' : null;
  const facts = [
    ['Vessel', record.vessel],
    ['Record period', record.kind === 'Annual estimate' ? record.date.slice(0,4) : date(record.date).split(' · ')[0]],
    ['Reporting gap', gapDuration],
    ['Recorded positions', record.mapPoints?.length ? String(record.mapPoints.length) : null]
  ];
  for (const [label, value] of facts) {
    if (!value) continue;
    const fact = make('div', null, 'case-fact');
    fact.append(make('span', label), document.createTextNode(value));
    $('case-facts').append(fact);
  }
}
function resetBrief(record) {
  $('priority').textContent = record ? 'Awaiting review' : 'No case selected';
  $('priority').removeAttribute('data-state');
  $('brief').className = 'brief-empty';
  $('brief').replaceChildren();
  const glyph = make('div', null, 'brief-glyph');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.append(make('span'), make('span'), make('span'));
  $('brief').append(glyph, make('p', 'Evidence-led investigation', 'eyebrow'),
    make('h3', record ? 'What happened in these waters?' : 'Choose an observation.'),
    make('p', record ? 'Run the agent to check the record, verify dated sources and identify the next review action.' : 'Select another area or expand the date range to find a case.'));
  if (record) {
    const checklist = make('div', null, 'brief-checklist');
    for (const text of ['Check the event', 'Verify the context', 'Identify what to review']) {
      const row = make('span', '◇');
      row.append(make('b', text));
      checklist.append(row);
    }
    $('brief').append(checklist);
  }
}
function selectCase(record) {
  if (running) return;
  selected = record;
  document.querySelectorAll('.case').forEach(button => {
    const active = button.dataset.id === String(record.id);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('case-title').textContent = record.title || record.vessel;
  $('case-kind').textContent = (record.synthetic ? 'Simulated control · ' : '') + (record.kind || 'Historical record');
  $('case-meta').textContent = [record.vessel, casePeriod(record), typeof record.location === 'string' ? record.location : null].filter(Boolean).join(' · ');
  $('investigate').disabled = false;
  $('investigate').textContent = 'Investigate ↗';
  $('status').className = 'status';
  $('status').textContent = '';
  $('timeline').replaceChildren(make('p', 'Run the agent to check the event, vessel history and dated sources.', 'activity-empty'));
  $('activity-state').textContent = 'Awaiting investigation';
  resetBrief(record);
  renderFacts(record);
  drawMap(record.mapPoints || []);
  const version = ++selectionVersion;
  fetch('/api/briefs/' + encodeURIComponent(record.id)).then(async response => {
    if (!response.ok) return;
    const saved = await response.json();
    if (version !== selectionVersion || running || selected?.id !== saved.id) return;
    renderBrief(saved);
    $('status').textContent = 'Saved brief · ' + date(saved.generatedAt);
    $('investigate').textContent = 'Investigate again ↗';
  }).catch(() => {});
}
function renderQueue() {
  const area = catalog.areas.find(area => area.id === $('area').value);
  $('map-title').textContent = area?.name || 'Protected waters';
  $('area-summary').textContent = area?.summary || '';
  $('footer-area').textContent = area?.name?.toUpperCase() || 'SOUNDINGS';
  const from = $('date-from').value;
  const through = $('date-to').value;
  const invalidRange = Boolean(from && through && from > through);
  $('filter-error').textContent = invalidRange ? 'Choose an end date on or after the start date.' : '';
  const cases = catalog.cases.filter(record => {
    if (invalidRange || record.areaId !== $('area').value) return false;
    const start = String(record.date || '').slice(0, 10);
    const end = String(record.endDate || record.date || '').slice(0, 10);
    return (!from || end >= from) && (!through || start <= through);
  });
  $('cases').replaceChildren();
  $('case-count').textContent = String(cases.length);
  for (const record of cases) {
    const button = make('button', null, 'case');
    button.type = 'button';
    button.dataset.id = String(record.id);
    button.append(make('span', record.synthetic ? 'Simulated control' : record.kind || 'Historical event', 'type'), make('strong', record.title || record.vessel), make('span', record.vessel, 'case-vessel'), make('small', casePeriod(record)));
    if (record.priority != null) button.append(make('span', record.priority, 'queue-priority'));
    button.addEventListener('click', () => selectCase(record));
    $('cases').append(button);
  }
  if (cases.length) selectCase(cases[0]);else {
    selected = null;
    $('investigate').disabled = true;
    $('cases').append(make('p', 'No cases overlap this date range. Adjust the dates to explore the archive.', 'queue-empty'));
    $('case-title').textContent = 'No candidate events';
    $('case-kind').textContent = 'Historical records';
    $('case-meta').textContent = 'Select another area or expand the date range.';
    $('status').textContent = '';
    $('timeline').replaceChildren();
    resetBrief(null);
    $('activity-state').textContent = 'No candidate selected';
    $('case-facts').replaceChildren();
    drawMap();
  }
}
function renderBrief(brief) {
  $('brief').className = 'brief-body';
  $('brief').replaceChildren();
  $('priority').textContent = String(brief.priority || 'Review');
  $('priority').dataset.state = 'ready';
  $('activity-state').textContent = 'Review ready';
  if (brief.synthetic) $('brief').append(make('p', 'Simulated control case.', 'tag'));
  $('brief').append(make('p', brief.summary));
  const overview = make('div', null, 'evidence-overview');
  for (const [label, value] of [['Observations', brief.observations?.length || 0], ['Sources', brief.sources?.length || 0]]) {
    const metric = make('div');
    metric.append(make('strong', String(value)), make('span', label));
    overview.append(metric);
  }
  $('brief').append(overview);
  const actions = make('div', null, 'brief-actions');
  const download = make('button', 'Download brief ↓', 'text-button');
  download.type = 'button';
  download.addEventListener('click', () => downloadBrief(brief));
  actions.append(download);
  $('brief').append(actions);
  $('brief').append(make('h3', 'Recorded observations'));
  const observations = make('ol');
  for (const observation of brief.observations || []) {
    const item = make('li');
    item.append(make('span', date(observation.date), 'observation-date'), make('span', observation.text));
    const citations = make('span', null, 'claim-sources');
    for (const sourceId of observation.sourceIds || []) {
      const sourceIndex = (brief.sources || []).findIndex(source => source.id === sourceId);
      if (sourceIndex < 0) continue;
      const source = brief.sources[sourceIndex];
      const citation = safeLink(`[${sourceIndex + 1}]`, source.url);
      citation.title = source.title;
      citation.setAttribute('aria-label', `Source ${sourceIndex + 1}, ${source.title}`);
      citations.append(citation);
    }
    item.append(citations);
    observations.append(item);
  }
  $('brief').append(observations, make('h3', 'What remains unknown'));
  const unknowns = make('ul');
  for (const unknown of brief.unknowns || []) unknowns.append(make('li', unknown));
  $('brief').append(unknowns, make('h3', 'Next step'), make('p', brief.nextStep, 'next-step'), make('h3', 'Source record'));
  const sources = make('ol', null, 'sources');
  for (const source of brief.sources || []) {
    const item = make('li');
    item.append(safeLink(source.title, source.url));
    sources.append(item);
  }
  $('brief').append(sources);
  const runtime = make('details', null, 'runtime');
  runtime.append(make('summary', 'Data & investigation provenance'));
  runtime.append(make('div', 'Investigator · ' + (brief.agent?.mode === 'model' ? 'Databricks model' : 'Rules-based replay')),
    make('div', 'Candidate data · ' + brief.candidateOrigin));
  runtime.append(make('div', `Search · ${brief.search?.mode || 'unavailable'}${brief.search?.detail ? ' — ' + brief.search.detail : ''}`), make('div', `Brief storage · ${brief.storage?.mode || 'unavailable'}${brief.storage?.detail ? ' — ' + brief.storage.detail : ''}`));
  $('brief').append(runtime);
  $('timeline').replaceChildren();
  for (const step of brief.steps || []) {
    const row = make('div', null, 'step');
    const content = make('div');
    content.append(make('strong', step.name), make('p', step.detail));
    row.append(content);
    $('timeline').append(row);
  }
  drawMap(brief.mapPoints || []);
}
$('investigate').addEventListener('click', async () => {
  if (!selected || running) return;
  running = true;
  selectionVersion++;
  $('investigate').disabled = true;
  $('area').disabled = true;
  $('date-from').disabled = true;
  $('date-to').disabled = true;
  $('investigate').textContent = 'Investigating…';
  $('status').className = 'status';
  $('status').textContent = 'Checking the event, its sources and the applicable rule…';
  $('activity-state').textContent = 'Agent running';
  document.querySelector('.desk').classList.add('running');
  const pendingStep = make('div', null, 'step working');
  const pendingContent = make('div');
  pendingContent.append(make('strong', 'Investigating selected case'), make('p', 'Reviewing the event, vessel history and source evidence.'));
  pendingStep.append(pendingContent);
  $('timeline').replaceChildren(pendingStep);
  try {
    const response = await fetch('/api/investigate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        caseId: selected.id
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Investigation could not be completed.');
    renderBrief(result);
    $('status').textContent = 'Investigation complete. Review the source record and next step.';
  } catch (error) {
    $('status').className = 'status error';
    $('status').textContent = error.message || 'Unable to investigate. Please try again.';
    $('activity-state').textContent = 'Retry available';
    $('timeline').replaceChildren(make('p', 'The investigation could not complete. Run it again to retry.', 'activity-empty'));
  } finally {
    running = false;
    document.querySelector('.desk').classList.remove('running');
    $('investigate').disabled = false;
    $('area').disabled = false;
    $('date-from').disabled = false;
    $('date-to').disabled = false;
    $('investigate').textContent = 'Investigate again ↗';
  }
});
$('area').addEventListener('change', renderQueue);
$('date-from').addEventListener('change', renderQueue);
$('date-to').addEventListener('change', renderQueue);
async function initialize() {
  try {
    const response = await fetch('/api/catalog');
    if (!response.ok) throw new Error('Unable to load the case catalog. Refresh to try again.');
    catalog = await response.json();
    $('data-mode').textContent = catalog.origin === 'Databricks' ? 'Databricks records' : 'Published archive';
    $('area').replaceChildren();
    for (const area of catalog.areas) {
      const option = make('option', area.name);
      option.value = area.id;
      $('area').append(option);
    }
    renderQueue();
  } catch (error) {
    $('status').className = 'status error';
    $('status').textContent = error.message;
    $('area').replaceChildren(make('option', 'Catalog unavailable'));
    $('area').disabled = true;
    $('data-mode').textContent = 'Archive unavailable';
    $('cases').replaceChildren(make('p', 'Case catalog unavailable. Refresh the page to reconnect.', 'queue-empty'));
  }
}
initialize();

function downloadBrief(brief) {
  const rows = [selected?.title || 'Soundings investigation brief', '', brief.summary, '', 'RECORDED OBSERVATIONS'];
  const sources = brief.sources || [];
  const sourceNumbers = new Map(sources.map((source, index) => [source.id, index + 1]));
  for (const observation of brief.observations || []) {
    const citations = (observation.sourceIds || []).filter(id => sourceNumbers.has(id)).map(id => '[' + sourceNumbers.get(id) + ']');
    rows.push([date(observation.date) + ' — ' + observation.text, ...citations].join(' '));
  }
  rows.push('', 'WHAT REMAINS UNKNOWN', ...(brief.unknowns || []), '', 'NEXT STEP', brief.nextStep || '', '', 'SOURCES');
  for (const [index, source] of sources.entries()) rows.push('[' + (index + 1) + '] ' + source.title + ' — ' + source.url);
  rows.push('', 'Generated ' + date(brief.generatedAt), 'Soundings · Historical observations · Human review required');
  const blob = new Blob([rows.join('\n')], {type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const link = make('a');
  link.href = url;
  link.download = 'soundings-' + String(brief.id).replace(/[^a-zA-Z0-9_-]/g, '') + '.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('date-toggle').addEventListener('click', () => {
  const expanded = $('date-toggle').getAttribute('aria-expanded') === 'true';
  $('date-toggle').setAttribute('aria-expanded', String(!expanded));
  $('date-filters').hidden = expanded;
  $('date-toggle').lastElementChild.textContent = expanded ? '+' : '−';
});
$('help').addEventListener('click', () => $('about-dialog').showModal());
$('close-help').addEventListener('click', () => $('about-dialog').close());
