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
  $('map').replaceChildren();
  if (!map?.bounds) {
    const empty = make('p', 'Verified boundary geometry is unavailable for this area. Open the case sources for geographic context.', 'muted');
    empty.style.padding = '30px';
    $('map').append(empty);
    $('boundary-source').removeAttribute('href');
    $('boundary-source').textContent = '';
    $('map-caption').textContent = 'Source-led case review';
    return;
  }
  const original = map.bounds;
  const longs = points.map(p => Number(p.lon)).filter(Number.isFinite);
  const lats = points.map(p => Number(p.lat)).filter(Number.isFinite);
  const west = Math.min(original[0], ...longs),
    south = Math.min(original[1], ...lats),
    east = Math.max(original[2], ...longs),
    north = Math.max(original[3], ...lats);
  const padX = Math.max(.5, (east - west) * .13),
    padY = Math.max(.35, (north - south) * .2);
  const bounds = [west - padX, south - padY, east + padX, north + padY];
  const project = (lon, lat) => [(lon - bounds[0]) / (bounds[2] - bounds[0]) * 640 + 20, 300 - (lat - bounds[1]) / (bounds[3] - bounds[1]) * 280];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 680 320');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Protected area boundary and reported observations. Points show observations only. No route is drawn during reporting gaps.');
  function shape(tag, attrs, text) {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (text) el.textContent = text;
    svg.append(el);
    return el;
  }
  for (let i = 0; i <= 6; i++) {
    const x = 20 + i * 106.66;
    shape('line', {
      x1: x,
      y1: 18,
      x2: x,
      y2: 300,
      stroke: '#bad0c4',
      'stroke-width': '.6'
    });
    const value = bounds[0] + i / 6 * (bounds[2] - bounds[0]);
    shape('text', {
      x,
      y: 313,
      fill: '#57766c',
      'font-size': '9',
      'text-anchor': 'middle'
    }, `${Math.abs(value).toFixed(1)}°${value < 0 ? 'W' : 'E'}`);
  }
  for (let i = 0; i <= 4; i++) {
    const y = 20 + i * 70;
    shape('line', {
      x1: 20,
      y1: y,
      x2: 660,
      y2: y,
      stroke: '#bad0c4',
      'stroke-width': '.6'
    });
  }
  const [left, top] = project(original[0], original[3]);
  const [right, bottom] = project(original[2], original[1]);
  shape('rect', {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    fill: '#c5dbcb',
    'fill-opacity': '.55',
    stroke: '#367a68',
    'stroke-dasharray': '5 4',
    'stroke-width': '1.5'
  });
  shape('text', {
    x: left + 12,
    y: top + 19,
    fill: '#367a68',
    'font-size': '9',
    'letter-spacing': '1.2'
  }, 'PROTECTED AREA');
  for (const island of map.islands || []) {
    const [x, y] = project(island.lon, island.lat);
    shape('circle', {
      cx: x,
      cy: y,
      r: 3.5,
      fill: '#6c8670'
    });
    shape('text', {
      x: x + 8,
      y: y - 5,
      fill: '#32534b',
      'font-family': 'Georgia,serif',
      'font-size': '12'
    }, island.name);
  }
  points.forEach((point, index) => {
    if (!Number.isFinite(Number(point.lon)) || !Number.isFinite(Number(point.lat))) return;
    const [x, y] = project(Number(point.lon), Number(point.lat));
    shape('circle', {
      cx: x,
      cy: y,
      r: 10,
      fill: '#fff9eb',
      stroke: '#a65430',
      'stroke-width': '1.5'
    });
    shape('text', {
      x,
      y: y + 3.5,
      fill: '#8c4428',
      'font-size': '10',
      'text-anchor': 'middle'
    }, String(index + 1));
    const label = shape('text', {
      x: Math.max(25, Math.min(540, x + 14)),
      y: y + 20,
      fill: '#8c4428',
      'font-size': '9'
    }, point.label || 'Reported position');
    const title = document.createElementNS(ns, 'title');
    title.textContent = point.label || 'Reported position';
    label.append(title);
  });
  shape('text', {
    x: 637,
    y: 35,
    fill: '#367a68',
    'font-size': '11'
  }, 'N ↑');
  $('map').append(svg);
  $('map-caption').textContent = points.length ? 'Observed endpoints · intervening route unknown' : 'Geographic context · no inferred vessel route';
  const link = safeLink('Boundary source ↗', map.source?.url);
  $('boundary-source').replaceWith(Object.assign(link, {
    id: 'boundary-source'
  }));
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
  $('status').textContent = '';
  $('timeline').replaceChildren();
  $('priority').textContent = 'Awaiting review';
  $('brief').className = 'brief-empty';
  $('brief').replaceChildren(make('div', '✧', 'compass'), make('h3', 'Ready to review the evidence.'), make('p', 'Run the investigation to examine the record, check sources and prepare the next step.'));
  drawMap();
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
    button.append(make('span', record.synthetic ? 'Simulated control' : record.kind || 'Historical event', 'type'), make('strong', record.title || record.vessel), make('small', casePeriod(record)));
    if (record.priority != null) button.append(make('span', `Review priority · ${record.priority}`, 'queue-priority'));
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
    $('priority').textContent = 'Awaiting review';
    $('brief').className = 'brief-empty';
    $('brief').replaceChildren(make('h3', 'Choose a historical event.'), make('p', 'The investigation brief will appear here after reviewing a case.'));
    drawMap();
  }
}
function renderBrief(brief) {
  $('brief').className = 'brief-body';
  $('brief').replaceChildren();
  $('priority').textContent = String(brief.priority || 'Review');
  if (brief.synthetic) $('brief').append(make('p', 'Simulated control case.', 'tag'));
  $('brief').append(make('p', brief.summary));
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
  const runtime = make('div', null, 'runtime');
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
  } finally {
    running = false;
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
  }
}
initialize();
