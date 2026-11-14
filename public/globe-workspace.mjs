import {snapshotCatalog} from './snapshot-workspace.mjs';
import {queryCases, queueStats, contextPoints} from './case-query.mjs';
import {loadPublishedExport, exportRevision} from './published-export.mjs';
import {renderVesselPhoto} from './vessel-photo.mjs';

const statusNames = {complete: 'Completed', queued: 'Queued', incomplete: 'Incomplete'};
const shortArea = name => (name || '').replace(/\s*[-–]\s*Reserva Marina$/i, '');
const samePoint = (a, b) => a && b && a.caseId === b.caseId && a.eventId === b.eventId &&
  a.role === b.role && a.lat === b.lat && a.lon === b.lon;
const positionLabel = (lat, lon) => [
  Math.abs(lat).toFixed(3) + (lat < 0 ? '°S' : '°N'),
  Math.abs(lon).toFixed(3) + (lon < 0 ? '°W' : '°E')
].join(', ');

export function startWorkspace({$, make, date, safeLink, renderReport}) {
  let catalog, revision, loading = false;
  let visible = [], positions = [], selected = null, point = null, choices = [];
  let caseIndex = new Map(), areaIndex = new Map();
  const dossier = document.querySelector('.case-dossier');
  const picker = $('point-picker');
  const refreshButton = $('refresh-export');
  const briefDialog = $('brief-dialog');
  const shortDate = value => date(value).split(' · ')[0];
  const latestObserved = record => record.endDate || record.date || '';

  $('case-feed').classList.add('current-queue');
  $('case-feed').setAttribute('aria-label', 'Case explorer');
  $('queue-title').textContent = 'Case explorer';
  $('old-provenance').hidden = true;
  document.querySelectorAll('[data-export-ui]').forEach(el => { el.hidden = false; });
  $('about-workflow').textContent = 'Choose an observation on the globe to see its recorded time and location. For investigated cases, open the agent’s published report to see its evidence, sources and decisions.';
  $('brief-title').textContent = 'Agent report';
  $('date-toggle').firstElementChild.textContent = 'Filters';
  $('date-from').value = $('date-to').value = '';
  $('mode-filter').hidden = false;
  $('open-brief').hidden = $('focus-area').hidden = true;
  document.querySelector('.map-key').hidden = true;

  function message(text) {
    $('refresh-notice').textContent = text;
    $('refresh-notice').hidden = !text;
  }
  function areaName(record) {
    return areaIndex.get(record.areaId)?.name || record.snapshotCase.mpa_name || record.areaId;
  }
  function showMap(focus = false, overview = false) {
    const area = areaIndex.get($('area').value);
    window.SoundingsMap?.render($('map'), {
      area, map: null, caseId: selected?.id, caseTitle: selected?.vessel,
      points: selected?.mapPoints || [], contextPoints: positions, focusPoint: point,
      focusArea: focus, overview, onSelectCase: selectPoint
    });
    $('map-title').textContent = area?.name || 'All protected areas';
    $('map-caption').textContent = positions.length
      ? positions.length.toLocaleString() + ' recorded positions · Grouped by proximity'
      : 'No recorded positions in this selection';
    $('footer-area').textContent = area?.name || 'All protected areas';
  }
  function setActive() {
    for (const el of $('cases').children) {
      if (!el.dataset.id) continue;
      const active = selected?.id === el.dataset.id;
      el.classList.toggle('active', active);
      el.setAttribute('aria-pressed', String(active));
    }
  }
  function clearSelection() {
    selected = point = null;
    choices = [];
    dossier.classList.remove('point-detail');
    dossier.classList.add('overview-state');
    $('case-title').textContent = positions.length ? 'Explore the observations' : 'No observations on the map';
    $('case-meta').textContent = positions.length
      ? 'Circle numbers count nearby recorded positions. Select one to zoom in.'
      : visible.length ? 'Select a case in the explorer to see its details.' : 'Change the filters to see more cases.';
    $('case-kind').textContent = '';
    $('case-facts').replaceChildren();
    picker.parentElement.hidden = $('clear-point').hidden = true;
    $('investigate').disabled = true;
    renderVesselPhoto($('point-photo'), null);
    setActive();
    showMap(false, true);
  }
  function fact(label, value) {
    if (value == null || value === '') return;
    const node = make('div', null, 'case-fact');
    node.append(make('span', label), document.createTextNode(String(value)));
    $('case-facts').append(node);
  }
  function showDetail() {
    const raw = selected.snapshotCase;
    dossier.classList.remove('overview-state');
    dossier.classList.add('point-detail');
    $('case-kind').textContent = [shortArea(areaName(selected)), selected.vesselType === 'gear' ? 'Fishing gear' : '', statusNames[raw.status]].filter(Boolean).join(' · ');
    $('case-title').textContent = selected.vessel;
    $('case-meta').textContent = point?.label || selected.title;
    $('case-facts').replaceChildren();
    if (point) {
      fact('Observed (UTC)', point.markerTime ? date(point.markerTime) : 'Time unavailable');
      fact('Position', positionLabel(point.lat, point.lon));
      if (point.eventType === 'gap' && Number.isFinite(point.durationHours)) fact('Reporting gap', point.durationHours + ' h');
    } else fact('Record period', shortDate(selected.date));
    if (raw.mmsi && !selected.vessel.includes(String(raw.mmsi))) fact('MMSI', raw.mmsi);
    picker.replaceChildren();
    if (choices.length > 1) choices.forEach((p, i) => {
      const opt = make('option', [caseIndex.get(p.caseId)?.vessel, p.label, p.markerTime && date(p.markerTime)].filter(Boolean).join(' · '));
      opt.value = String(i);
      opt.selected = Boolean(samePoint(p, point));
      picker.append(opt);
    });
    picker.parentElement.hidden = choices.length < 2;
    $('clear-point').hidden = false;
    const hasReport = raw.status !== 'queued' && Boolean(raw.brief_markdown?.trim());
    $('investigate').disabled = !hasReport;
    $('investigate-label').textContent = hasReport ? 'View agent report' : raw.status === 'queued' ? 'Queued for investigation' : 'Report unavailable';
    $('investigate').lastElementChild.hidden = !hasReport;
    renderVesselPhoto($('point-photo'), selected);
    setActive();
  }
  function selectPoint(id, nextPoint, nearby, scroll = true) {
    const record = caseIndex.get(id);
    if (!record) return;
    selected = record;
    point = nextPoint || null;
    choices = nearby || [];
    showDetail();
    showMap(true);
    if (scroll && window.matchMedia('(max-width:720px)').matches) dossier.scrollIntoView({behavior:'instant', block:'nearest'});
  }
  function caseRow(record) {
    const raw = record.snapshotCase;
    const button = make('button', null, 'case');
    button.type = 'button';
    button.dataset.id = record.id;
    const top = make('span', null, 'case-row-top');
    const level = raw.risk_level || 'unknown';
    const risk = make('span', level === 'unknown' ? 'Unscored' : level.charAt(0).toUpperCase() + level.slice(1), 'case-risk');
    risk.dataset.level = level;
    risk.title = record.priority || 'Review priority unavailable';
    top.append(make('strong', record.vessel, 'case-vessel'), risk);
    const byline = [shortArea(areaName(record)), record.date && shortDate(record.date), statusNames[raw.status]].filter(Boolean).join(' · ');
    button.append(top, make('span', (record.vesselType === 'gear' ? 'Fishing gear · ' : '') + record.title, 'case-signal'), make('span', byline, 'case-byline'));
    button.addEventListener('click', () => {
      const related = positions.filter(p => p.caseId === record.id);
      const last = related.reduce((latest, p) => !latest || (p.markerTime || '') > (latest.markerTime || '') ? p : latest, null);
      selectPoint(record.id, last, related);
    });
    return button;
  }
  function renderQueue() {
    if (!catalog) return;
    const from = $('date-from').value, through = $('date-to').value;
    $('filter-error').textContent = from && through && from > through ? 'Choose an end date on or after the start date.' : '';
    visible = queryCases(catalog, {from, through, areaId: $('area').value, search: $('case-search').value,
      status: $('case-status').value, mode: $('case-mode').value});
    if ($('case-sort').value === 'name') visible.sort((a,b) => a.vessel.localeCompare(b.vessel));
    if ($('case-sort').value === 'recent') visible.sort((a,b) => latestObserved(b).localeCompare(latestObserved(a)));
    positions = contextPoints(visible);
    $('queue-result').textContent = visible.length + (visible.length === 1 ? ' case' : ' cases') + ' shown';
    $('cases').replaceChildren(...visible.map(caseRow));
    if (!visible.length) $('cases').append(make('p', 'No cases match these filters.', 'queue-empty'));
    const restored = selected && visible.find(row => row.id === selected.id);
    if (restored) {
      selected = restored;
      choices = positions.filter(p => choices.some(previous => samePoint(p, previous)));
      point = positions.find(p => samePoint(p, point)) || null;
      showDetail();
      showMap();
    } else clearSelection();
  }
  function install(next) {
    const priorArea = $('area').value;
    catalog = next;
    areaIndex = new Map(next.areas.map(item => [item.id, item]));
    caseIndex = new Map(next.cases.map(record => [record.id, record]));
    const total = queueStats(next.cases);
    $('total-cases').textContent = total.cases;
    $('total-events').textContent = total.events;
    $('total-complete').textContent = total.complete;
    $('case-count').textContent = next.areas.length + (next.areas.length === 1 ? ' area' : ' areas');
    $('snapshot-date').textContent = next.snapshot.generated_at ? 'Published ' + shortDate(next.snapshot.generated_at) : '';
    $('snapshot-date').title = date(next.snapshot.generated_at);
    $('data-mode').textContent = next.origin;
    $('footer-provenance').textContent = next.origin + ' · Human review required';
    const all = make('option','All protected areas');
    all.value = '';
    $('area').replaceChildren(all);
    const counts = new Map();
    for (const row of next.cases) counts.set(row.areaId, (counts.get(row.areaId) || 0) + 1);
    for (const area of next.areas) {
      const option = make('option', area.name + ' (' + (counts.get(area.id) || 0) + ')');
      option.value = area.id;
      $('area').append(option);
    }
    $('area').value = areaIndex.has(priorArea) ? priorArea : '';
    renderQueue();
  }
  function showDataset() {
    if (!catalog) return;
    const data = catalog.snapshot, body = $('export-detail');
    body.replaceChildren();
    function section(title) {
      const el = make('section',null,'export-section');
      el.append(make('h3',title));
      body.append(el);
      return el;
    }
    const freshness = section('Publication');
    freshness.append(make('p', 'Published ' + date(data.generated_at)));
    const last = positionsByTime(catalog.cases);
    if (last) freshness.append(make('p', 'Latest observation in this export: ' + date(last)));
    if (data.attribution) freshness.append(make('p',data.attribution));
    for (const region of data.mpas) {
      const el = section(region.mpa_name || String(region.mpa_id));
      const st = queueStats(catalog.cases.filter(r => r.areaId === String(region.mpa_id)));
      el.append(make('p', st.cases + ' cases · ' + st.events + ' events · ' + st.complete + ' completed · ' + st.queued + ' queued'));
      if (region.rules_summary) el.append(make('p',region.rules_summary));
      for (const source of region.rules_sources || []) el.append(safeLink(source.title || 'Source', source.url), make('br'));
    }
    if (data.news.length) {
      const el = section('Regional news');
      const list = make('ul',null,'export-rows');
      for (const article of data.news) {
        const row = make('li');
        row.append(safeLink(article.title || 'Article', article.url), make('br'), make('small', [article.mpa_name, article.provider, article.fetched_at && shortDate(article.fetched_at)].filter(Boolean).join(' · ')));
        list.append(row);
      }
      el.append(list);
    }
    if (data.runs.length) {
      const el = section('Published investigations');
      for (const run of data.runs) el.append(make('p', [run.mode, run.window_start && shortDate(run.window_start), run.window_end && shortDate(run.window_end)].filter(Boolean).join(' · ') + ' · ' + (run.n_investigated ?? '—') + ' investigated'));
    }
    if (data.disclaimer) body.append(make('p', data.disclaimer));
    $('export-dialog').showModal();
  }
  function positionsByTime(records) {
    let latest = '';
    for (const r of records) for (const p of r.mapPoints) if (p.markerTime && (!latest || Date.parse(p.markerTime) > Date.parse(latest))) latest = p.markerTime;
    return latest;
  }
  async function refresh(manual = false) {
    if (loading || (!manual && (document.hidden || briefDialog.open || $('export-dialog').open))) return;
    loading = true;
    refreshButton.disabled = true;
    try {
      const {data, source} = await loadPublishedExport(fetch, {signal: AbortSignal.timeout(40000)});
      const nextRevision = source + ':' + exportRevision(data);
      const changed = revision !== nextRevision;
      if (changed) { install(snapshotCatalog(data, source)); revision = nextRevision; }
      message(manual ? changed ? 'New publication loaded.' : 'Latest publication is displayed.' : '');
    } catch {
      if (catalog) message('Refresh unavailable. Showing the last loaded publication.');
      else {
        $('data-mode').textContent = 'Export unavailable';
        $('case-title').textContent = 'Export unavailable';
        $('case-meta').textContent = 'Refresh to check for published results.';
        $('cases').replaceChildren(make('p','The published results could not be loaded.', 'queue-empty'));
      }
    } finally { loading = false; refreshButton.disabled = false; }
  }
  $('area').addEventListener('change',renderQueue);
  $('case-search').addEventListener('input',renderQueue);
  for (const id of ['case-sort','date-from','date-to','case-mode','case-status']) $(id).addEventListener('change',renderQueue);
  picker.addEventListener('change', () => {
    const next = choices[Number(picker.value)];
    if (next) selectPoint(next.caseId, next, choices, false);
  });
  $('clear-point').addEventListener('click', clearSelection);
  $('investigate').addEventListener('click', () => {
    if (!selected?.snapshotCase.brief_markdown || selected.snapshotCase.status === 'queued') return;
    renderReport(selected, catalog);
    renderVesselPhoto($('report-photo'), selected);
    briefDialog.showModal();
  });
  $('view-export').addEventListener('click', showDataset);
  $('close-export').addEventListener('click', () => $('export-dialog').close());
  refreshButton.addEventListener('click', () => refresh(true));
  refresh(true).then(() => { if (catalog) message(''); });
  document.addEventListener('visibilitychange', () => {if (!document.hidden) refresh();});
  window.setInterval(() => refresh(), 60000);
}
