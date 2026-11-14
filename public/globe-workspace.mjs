import {snapshotCatalog} from './snapshot-workspace.mjs';
import {queryCases, queueStats, contextPoints, groupVessels} from './case-query.mjs';
import {loadPublishedExport, exportRevision} from './published-export.mjs';
import {renderVesselPhoto} from './vessel-photo.mjs';

const statusNames = {complete: 'Completed', queued: 'Queued', incomplete: 'Incomplete'};
const shortArea = name => (name || '').replace(/\s*[-–]\s*Reserva Marina$/i, '');
const samePoint = (a, b) => a && b && a.caseId === b.caseId && a.eventId === b.eventId &&
  a.role === b.role && a.lat === b.lat && a.lon === b.lon && a.markerTime === b.markerTime;
const count = (n, singular, plural = singular + 's') => n + ' ' + (n === 1 ? singular : plural);
const hasReport = record => record?.snapshotCase.status !== 'queued' && Boolean(record?.snapshotCase.brief_markdown?.trim());
const positionLabel = (lat, lon) => [
  Math.abs(lat).toFixed(3) + (lat < 0 ? '°S' : '°N'),
  Math.abs(lon).toFixed(3) + (lon < 0 ? '°W' : '°E')
].join(', ');

export function startWorkspace({$, make, date, safeLink, renderReport}) {
  let catalog, revision, loading = false;
  let groups = [], anchors = [], vessel = null, selected = null, point = null;
  let groupIndex = new Map(), areaIndex = new Map();
  const dossier = document.querySelector('.case-dossier');
  const picker = $('point-picker');
  const casePicker = $('investigation-picker');
  const refreshButton = $('refresh-export');
  const briefDialog = $('brief-dialog');
  const shortDate = value => date(value).split(' · ')[0];
  const dateLabels = new Map();
  function displayDate(value) {
    if (!dateLabels.has(value)) dateLabels.set(value, date(value));
    return dateLabels.get(value);
  }

  $('case-feed').classList.add('current-queue');
  $('case-feed').setAttribute('aria-label', 'Vessel explorer');
  $('queue-title').textContent = 'Vessel explorer';
  $('open-cases').firstChild.textContent = 'Explore vessels ';
  $('old-provenance').hidden = true;
  document.querySelectorAll('[data-export-ui]').forEach(el => { el.hidden = false; });
  $('about-workflow').textContent = 'Each ship marker shows its latest recorded position in the selection. Select a vessel to explore its recorded positions and open the agent’s published investigation for the relevant protected area.';
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
  function showMap(focus = false, overview = false, fitHistory = false) {
    const area = areaIndex.get($('area').value);
    window.SoundingsMap?.render($('map'), {
      area, map: null, vesselMode: true, caseId: vessel?.vesselKey, activeVesselKey: vessel?.vesselKey,
      caseTitle: vessel?.vesselName, points: vessel?.points || [], historyPoints: vessel?.points || [],
      contextPoints: anchors, vesselAnchor: vessel?.anchor, focusPoint: point, focusArea: focus, overview, fitHistory,
      onSelectVessel: selectVessel, onSelectObservation: selectObservation, onOverview: () => clearSelection(true)
    });
    $('map-title').textContent = area?.name || 'All protected areas';
    const mappedType = anchors.some(p => p.vesselType === 'gear') ? 'tracked object' : 'vessel';
    $('map-caption').textContent = vessel ? vessel.vesselName + ' · ' + count(vessel.points.length, 'recorded position') :
      count(anchors.length, mappedType) + ' · Latest recorded positions';
    $('footer-area').textContent = area?.name || 'All protected areas';
  }
  function setActive() {
    for (const el of $('cases').children) {
      if (!el.dataset.id) continue;
      const active = vessel?.vesselKey === el.dataset.id;
      el.classList.toggle('active', active);
      el.setAttribute('aria-pressed', String(active));
    }
  }
  function clearSelection(overview = false) {
    vessel = selected = point = null;
    dossier.classList.remove('point-detail');
    dossier.classList.add('overview-state');
    $('case-title').textContent = groups.length ? 'Select a vessel' : 'No matching vessels';
    $('case-meta').textContent = groups.length ? 'Open a ship on the map or in the explorer to see its history and investigation.' : 'Adjust the filters to see more vessels.';
    $('case-kind').textContent = '';
    $('case-facts').replaceChildren();
    picker.parentElement.hidden = casePicker.parentElement.hidden = $('clear-point').hidden = true;
    $('investigate').disabled = true;
    renderVesselPhoto($('point-photo'), null);
    setActive();
    showMap(false, overview);
  }
  function fact(label, value) {
    if (value == null || value === '') return;
    const node = make('div', null, 'case-fact');
    node.append(make('span', label), document.createTextNode(String(value)));
    $('case-facts').append(node);
  }
  function option(label, value) {
    const el = make('option', label);
    el.value = String(value);
    return el;
  }
  function setPickers() {
    picker.replaceChildren(...vessel.points.map((p, index) => option(
      [samePoint(p, vessel.anchor) ? 'Latest' : '', p.markerTime && displayDate(p.markerTime), p.label].filter(Boolean).join(' · '), index)));
    casePicker.replaceChildren(...vessel.cases.map(record => option(
      [shortArea(areaName(record)), hasReport(record) ? 'Report available' : statusNames[record.snapshotCase.status]].filter(Boolean).join(' · '), record.id)));
    picker.parentElement.hidden = vessel.points.length < 2;
    casePicker.parentElement.hidden = vessel.cases.length < 2;
  }
  function showDetail() {
    const raw = selected.snapshotCase;
    dossier.classList.remove('overview-state');
    dossier.classList.add('point-detail');
    $('case-kind').textContent = [vessel.isGear ? 'Tracked fishing gear' : vessel.vesselType?.replaceAll('_', ' '), shortArea(areaName(selected))].filter(Boolean).join(' · ');
    $('case-title').textContent = vessel.vesselName;
    $('case-meta').textContent = point
      ? (samePoint(point, vessel.anchor) ? 'Last observed' : 'Recorded position') + ' · ' + (point.markerTime ? displayDate(point.markerTime) : 'Time unavailable')
      : 'No dated position available for this selection.';
    $('case-facts').replaceChildren();
    if (point) {
      fact('Position', positionLabel(point.lat, point.lon));
      fact('Observation', point.label);
      if (point.eventType === 'gap' && Number.isFinite(point.durationHours)) fact('Reporting gap', point.durationHours + ' h');
    }
    if (raw.mmsi && !vessel.vesselName.includes(String(raw.mmsi))) fact('MMSI', raw.mmsi);
    picker.selectedIndex = point ? vessel.points.findIndex(p => samePoint(p, point)) : -1;
    casePicker.value = selected.id;
    $('clear-point').hidden = false;
    $('investigate').disabled = !hasReport(selected);
    $('investigate-label').textContent = hasReport(selected) ? 'View agent report' : raw.status === 'queued' ? 'Queued for investigation' : 'Report unavailable';
    $('investigate').lastElementChild.hidden = !hasReport(selected);
  }
  function selectVessel(key) {
    const next = groupIndex.get(key);
    if (!next) return;
    vessel = next;
    point = vessel.anchor;
    selected = vessel.cases.find(row => row.id === point?.caseId) || vessel.cases[0];
    setPickers();
    showDetail();
    renderVesselPhoto($('point-photo'), selected);
    setActive();
    showMap(false, false, true);
  }
  function selectObservation(next) {
    if (!next || !vessel || next.vesselKey !== vessel.vesselKey) return;
    const match = vessel.points.find(p => samePoint(p, next));
    if (!match || samePoint(match, point)) return;
    point = match;
    const owningCase = vessel.cases.find(row => row.id === point.caseId);
    if (owningCase && selected !== owningCase) {
      selected = owningCase;
      renderVesselPhoto($('point-photo'), selected);
    }
    showDetail();
    showMap(true);
  }
  function vesselRow(group) {
    const record = group.cases[0];
    const raw = record.snapshotCase;
    const button = make('button', null, 'case');
    button.type = 'button';
    button.dataset.id = group.vesselKey;
    const top = make('span', null, 'case-row-top');
    const level = raw.risk_level || 'unknown';
    const risk = make('span', level === 'unknown' ? 'Unscored' : level.charAt(0).toUpperCase() + level.slice(1), 'case-risk');
    risk.dataset.level = level;
    risk.title = record.priority || 'Review priority unavailable';
    top.append(make('strong', group.vesselName, 'case-vessel'), risk);
    const areas = [...new Set(group.cases.map(row => shortArea(areaName(row))))].join(' / ');
    const byline = [areas, group.anchor && displayDate(group.anchor.markerTime).split(' · ')[0]].filter(Boolean).join(' · ');
    const report = group.cases.some(hasReport) ? 'Report available' : statusNames[raw.status];
    const summary = [group.isGear ? 'Fishing gear' : '', count(group.points.length, 'position'), report].filter(Boolean).join(' · ');
    button.append(top, make('span', summary, 'case-signal'), make('span', byline, 'case-byline'));
    button.addEventListener('click', () => {
      selectVessel(group.vesselKey);
      if (window.matchMedia('(max-width:720px)').matches) {
        dossier.scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest'});
      }
    });
    return button;
  }
  function renderQueue({resetView = false} = {}) {
    if (!catalog) return;
    const from = $('date-from').value, through = $('date-to').value;
    $('filter-error').textContent = from && through && from > through ? 'Choose an end date on or after the start date.' : '';
    const visible = queryCases(catalog, {from, through, areaId: $('area').value, search: $('case-search').value,
      status: $('case-status').value, mode: $('case-mode').value});
    const positions = contextPoints(visible).filter(p => {
      if (!from && !through) return true;
      const day = p.markerTime?.slice(0, 10);
      return day && (!from || day >= from) && (!through || day <= through);
    });
    groups = groupVessels(visible, positions, catalog.cases).filter(group => !group.isGear || $('show-gear').checked);
    if ($('case-sort').value === 'name') groups.sort((a,b) => a.vesselName.localeCompare(b.vesselName));
    if ($('case-sort').value === 'recent') groups.sort((a,b) => (Date.parse(b.anchor?.markerTime) || 0) - (Date.parse(a.anchor?.markerTime) || 0));
    groupIndex = new Map(groups.map(group => [group.vesselKey, group]));
    anchors = groups.flatMap(group => group.anchor ? [group.anchor] : []);
    const gear = groups.filter(g => g.isGear).length;
    const ships = count(groups.length - gear, 'vessel');
    $('queue-result').textContent = [ships, gear && count(gear, 'gear transmitter')].filter(Boolean).join(' · ');
    $('total-cases').textContent = groups.length - gear;
    $('total-events').textContent = groups.reduce((n, g) => n + g.points.length, 0);
    $('total-complete').textContent = groups.reduce((n, g) => n + g.cases.filter(hasReport).length, 0);
    $('cases').replaceChildren(...groups.map(vesselRow));
    if (!groups.length) $('cases').append(make('p', 'No vessels match these filters.', 'queue-empty'));
    const restored = vessel && groupIndex.get(vessel.vesselKey);
    if (restored) {
      vessel = restored;
      const previousCase = vessel.cases.find(row => row.id === selected?.id);
      const previousPoint = vessel.points.find(p => samePoint(p, point));
      point = previousPoint || (previousCase && vessel.points.find(p => p.caseId === previousCase.id)) || vessel.anchor;
      selected = vessel.cases.find(row => row.id === point?.caseId) || previousCase || vessel.cases[0];
      setPickers();
      showDetail();
      renderVesselPhoto($('point-photo'), selected);
      setActive();
      showMap(!previousPoint && Boolean(point));
    } else clearSelection(resetView || Boolean(vessel));
  }
  function install(next) {
    const priorArea = $('area').value;
    catalog = next;
    dateLabels.clear();
    areaIndex = new Map(next.areas.map(item => [item.id, item]));
    $('case-count').textContent = count(next.areas.length, 'area');
    $('snapshot-date').textContent = next.snapshot.generated_at ? 'Published ' + shortDate(next.snapshot.generated_at) : '';
    $('snapshot-date').title = date(next.snapshot.generated_at);
    $('data-mode').textContent = next.origin;
    $('footer-provenance').textContent = next.origin + ' · Human review required';
    const all = option('All protected areas', '');
    $('area').replaceChildren(all, ...next.areas.map(area => option(area.name, area.id)));
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
  $('area').addEventListener('change', () => renderQueue({resetView:true}));
  $('case-search').addEventListener('input',renderQueue);
  for (const id of ['case-sort','date-from','date-to','case-mode','case-status','show-gear']) $(id).addEventListener('change',renderQueue);
  picker.addEventListener('change', () => {
    selectObservation(vessel?.points[picker.selectedIndex]);
  });
  casePicker.addEventListener('change', () => {
    const next = vessel?.cases.find(row => row.id === casePicker.value);
    if (!next) return;
    selected = next;
    point = vessel.points.find(p => p.caseId === next.id) || null;
    showDetail();
    renderVesselPhoto($('point-photo'), selected);
    showMap(Boolean(point));
  });
  $('clear-point').addEventListener('click', () => {
    clearSelection(true);
    if ($('map').getBoundingClientRect().bottom < 140) {
      $('map').scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block:'start'});
    }
    $('map').querySelector('.mar-stage')?.focus({preventScroll:true});
  });
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
