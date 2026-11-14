import {snapshotCatalog} from '../../public/snapshot-workspace.mjs';
import {queryCases, queueStats, contextPoints, groupVessels} from '../../public/case-query.mjs';
import {loadWorkspaceSnapshot, exportRevision} from './snapshot-loader.mjs';
import {appendRunContext, appendCaseContext} from './agent-context.mjs';
import {renderVesselPhoto} from '../../public/vessel-photo.mjs';
import {mountAreaExplorer} from './area-explorer.mjs';
import {renderWatchSummary} from './watch-summary.mjs';

const statusNames = {complete: 'Completed', queued: 'Awaiting investigation', incomplete: 'Incomplete'};
const shortArea = name => (name || '').replace(/\s*[-–]\s*Reserva Marina$/i, '');
const samePoint = (a, b) => a && b && a.caseId === b.caseId && a.eventId === b.eventId &&
  a.role === b.role && a.lat === b.lat && a.lon === b.lon && a.markerTime === b.markerTime;
const count = (n, singular, plural = singular + 's') => n + ' ' + (n === 1 ? singular : plural);
const hasReport = record => record?.snapshotCase.status !== 'queued' && Boolean(record?.snapshotCase.brief_markdown?.trim());
const positionLabel = (lat, lon) => [
  Math.abs(lat).toFixed(3) + (lat < 0 ? '°S' : '°N'),
  Math.abs(lon).toFixed(3) + (lon < 0 ? '°W' : '°E')
].join(', ');
const numberFormat = new Intl.NumberFormat('en-GB', {maximumFractionDigits: 2});
function measurement(value, unit) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? numberFormat.format(number) + ' ' + unit : null;
}

export function startWorkspace({$, make, date, safeLink, renderReport}) {
  let catalog, revision, loading = false;
  let groups = [], anchors = [], areaEvents = [], datedPositions = [], vessel = null, selected = null, point = null;
  let groupIndex = new Map(), areaIndex = new Map();
  const dossier = document.querySelector('.case-dossier');
  const picker = $('point-picker');
  const slider = $('observation-slider');
  const casePicker = $('investigation-picker');
  const refreshButton = $('refresh-export');
  const briefDialog = $('brief-dialog');
  const watchDialog = $('watch-dialog');
  const areaTools = mountAreaExplorer({host:$('area-explorer'), searchHost:$('area-search-results'),
    onArea: id => goArea(id), onFilter: () => renderQueue()});
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
  $('about-workflow').textContent = 'The explorer includes all vessels in the publication and labels fishing gear separately. Choose an area to narrow the fleet, or select a ship to inspect its recorded positions and the agent’s published report. The map uses the latest dated observation available for each contact.';
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
  function goArea(id) {
    const key = String(id ?? '');
    if (!catalog || (key && !areaIndex.has(key))) return;
    $('area').value = key;
    vessel = selected = point = null;
    areaTools.update(catalog.snapshot, key);
    renderQueue({resetView:true});
  }
  function upOneLevel() {
    if (vessel) goArea(selected?.areaId || $('area').value);
    else if ($('area').value) goArea('');
  }
  function breadcrumbs() {
    const bar = $('drill-path');
    bar.replaceChildren();
    const id = selected?.areaId || $('area').value;
    bar.hidden = !id && !vessel;
    if (bar.hidden) return;
    const add = (label, click) => {
      if (bar.children.length) { const sep = make('span','›'); sep.setAttribute('aria-hidden','true'); bar.append(sep); }
      const crumb = make(click ? 'button' : 'span',label);
      if (click) { crumb.type='button'; crumb.addEventListener('click',click); }
      else crumb.setAttribute('aria-current','location');
      bar.append(crumb);
    };
    add('Globe',()=>goArea(''));
    if (id) add(shortArea(areaIndex.get(id)?.name || id),vessel ? ()=>goArea(id) : null);
    if (vessel) add(vessel.vesselName);
  }
  function showMap(focus = false, overview = false, fitHistory = false) {
    const regionId = selected?.areaId || $('area').value;
    const area = areaIndex.get(regionId);
    breadcrumbs();
    window.SoundingsMap?.render($('map'), {
      area, map: null, vesselMode: true, caseId: vessel?.vesselKey, activeVesselKey: vessel?.vesselKey,
      caseTitle: vessel?.vesselName, points: vessel?.points || [], historyPoints: vessel?.points || [],
      contextPoints: anchors, vesselAnchor: point || vessel?.anchor, latestObservation: vessel?.anchor, focusPoint: point, focusArea: focus, overview, fitHistory,
      regions: catalog.snapshot.mpas, globalNews: catalog.snapshot.global_news || [], activeRegionId: regionId,
      areaEvents: selected ? selected.events.filter(eventMatches) : areaEvents,
      onSelectRegion: goArea, onSelectVessel: selectVessel, onSelectObservation: selectObservation, onOverview: () => goArea('')
    });
    $('map-title').textContent = area?.name || 'All protected areas';
    $('map-caption').textContent = vessel ? vessel.vesselName + ' · ' + count(vessel.points.length, 'recorded position') :
      (area ? shortArea(area.name) + ' · ' : '') + 'Latest available observations';
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
    $('case-title').textContent = groups.length ? 'Select a vessel' : 'No matching contacts';
    $('case-meta').textContent = groups.length ? 'Choose a ship to see its recorded positions and investigation.' : 'Adjust the filters to see more contacts.';
    $('case-kind').textContent = '';
    $('case-facts').replaceChildren();
    datedPositions = [];
    $('observation-timeline').hidden = true;
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
    datedPositions = vessel.points.filter(p => Number.isFinite(Date.parse(p.markerTime))).reverse();
    slider.max = String(Math.max(1, datedPositions.length - 1));
    slider.disabled = datedPositions.length < 2;
    $('first-observation').textContent = datedPositions.length > 1 ? 'First · ' + shortDate(datedPositions[0].markerTime) : '';
    $('last-observation').textContent = datedPositions.length > 1 ? 'Latest · ' + shortDate(datedPositions.at(-1).markerTime) : '';
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
    fact('Position history',count(vessel.points.length, 'recorded position'));
    if (point) {
      fact('Position', positionLabel(point.lat, point.lon));
      fact('Observation', point.label);
      const event = selected.events.find(item => item.event_id === point.eventId && item.event_type === point.eventType);
      if (event) {
        fact(event.event_type === 'gap' ? 'Reporting gap' : 'Event duration', measurement(event.duration_hours, 'h'));
        const detail = event.details || {};
        if (event.event_type === 'gap') {
          fact('Between gap endpoints', measurement(detail.gap_distance_km, 'km'));
          fact('Implied speed', measurement(detail.gap_implied_speed_knots, 'kn'));
        }
        if (event.event_type === 'encounter') fact('Encounter partner', detail.partner_vessel_name);
        fact('Distance from shore', measurement(detail.distance_from_shore_km, 'km'));
      }
    }
    if (raw.mmsi && !vessel.vesselName.includes(String(raw.mmsi))) fact('MMSI', raw.mmsi);
    picker.selectedIndex = point ? vessel.points.findIndex(p => samePoint(p, point)) : -1;
    const timeIndex = datedPositions.indexOf(point);
    $('observation-timeline').hidden = timeIndex < 0;
    if (timeIndex >= 0) {
      const utc = displayDate(point.markerTime);
      slider.value = String(timeIndex);
      slider.setAttribute('aria-valuetext', utc + ' · observation ' + (timeIndex + 1) + ' of ' + datedPositions.length);
      $('observation-time').textContent = utc;
    }
    casePicker.value = selected.id;
    $('clear-point').hidden = false;
    $('clear-point').textContent = '← Back to area';
    $('investigate').disabled = !hasReport(selected);
    $('investigate-label').textContent = hasReport(selected) ? 'View agent report' : raw.status === 'queued' ? statusNames.queued : 'Report unavailable';
    $('investigate').lastElementChild.hidden = !hasReport(selected);
  }
  function selectVessel(key, preferredCase) {
    const next = groupIndex.get(key);
    if (!next) return;
    vessel = next;
    const requested = typeof preferredCase === 'string' && vessel.cases.find(row=>row.id===preferredCase);
    point = requested ? vessel.points.find(p=>p.caseId===requested.id) || null : vessel.anchor;
    selected = requested || vessel.cases.find(row => row.id === point?.caseId) || vessel.cases[0];
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
  const score = record => Number.isFinite(record.snapshotCase?.risk_score) ? record.snapshotCase.risk_score : -1;
  // Prefer a published assessment when a ship is still queued in a second area.
  const priorityCase = group => {
    const assessed = group.cases.filter(record => record.snapshotCase.status !== 'queued');
    return (assessed.length ? assessed : group.cases).reduce((best,next)=>score(next)>score(best)?next:best);
  };
  function vesselRow(group) {
    const record = priorityCase(group);
    const raw = record.snapshotCase;
    const button = make('button', null, 'case');
    button.type = 'button';
    button.dataset.id = group.vesselKey;
    button.dataset.status = raw.status || 'unknown';
    const top = make('span', null, 'case-row-top');
    const queued = raw.status === 'queued';
    const level = queued ? 'queued' : raw.risk_level || 'unknown';
    const riskLabel = queued ? 'Queued' : level === 'unknown' ? 'Unscored' : level.charAt(0).toUpperCase() + level.slice(1);
    const risk = make('span', riskLabel, 'case-risk');
    risk.dataset.level = level;
    risk.title = queued ? statusNames.queued : record.priority || 'Review priority unavailable';
    top.append(make('strong', group.vesselName, 'case-vessel'), risk);
    const areas = [...new Set(group.cases.map(row => shortArea(areaName(row))))].join(' / ');
    const byline = [areas, group.anchor && displayDate(group.anchor.markerTime).split(' · ')[0]].filter(Boolean).join(' · ');
    const report = group.cases.some(hasReport) ? 'Report available' : statusNames[raw.status];
    const identity = group.isGear ? 'Fishing gear' : raw.vessel_identified === false ? 'Unidentified vessel' : raw.flag || '';
    const summary = [identity, report, !group.anchor && 'No mapped position'].filter(Boolean).join(' · ');
    button.append(top, make('span', summary, 'case-signal'), make('span', byline, 'case-byline'));
    button.addEventListener('click', () => {
      selectVessel(group.vesselKey);
      if (window.matchMedia('(max-width:720px)').matches) {
        dossier.scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest'});
      }
    });
    return button;
  }
  function eventMatches(event) {
    const from = $('date-from').value, thru = $('date-to').value;
    const type = areaTools.getFilters().eventType;
    if (type && event.event_type !== type) return false;
    if (!from && !thru) return true;
    const first = (event.start_time || event.end_time || '').slice(0,10);
    const last = (event.end_time || event.start_time || '').slice(0,10);
    return Boolean(first) && (!from || last >= from) && (!thru || first <= thru);
  }
  function renderQueue({resetView = false} = {}) {
    if (!catalog) return;
    const from = $('date-from').value, through = $('date-to').value;
    $('filter-error').textContent = from && through && from > through ? 'Choose an end date on or after the start date.' : '';
    const {minRisk, identified, eventType} = areaTools.getFilters();
    const visible = queryCases(catalog, {from, through, areaId: $('area').value, search: $('case-search').value,
      status: $('case-status').value, mode: $('case-mode').value}).filter(r => {
      const raw = r.snapshotCase;
      if (minRisk > 0 && !(score(r) >= minRisk)) return false;
      if (identified && raw.vessel_identified !== (identified === 'identified')) return false;
      if (eventType) return r.events.length ? r.events.some(eventMatches) :
        String(raw.event_types || '').split(',').map(s=>s.trim()).includes(eventType);
      return true;
    });
    areaEvents = $('area').value ? visible.flatMap(r=>r.events.filter(eventMatches)) : [];
    const positions = contextPoints(visible).filter(p => {
      if (eventType && p.eventType !== eventType) return false;
      if (!from && !through) return true;
      const day = p.markerTime?.slice(0, 10);
      return day && (!from || day >= from) && (!through || day <= through);
    });
    groups = groupVessels(visible, positions, catalog.cases).filter(group => !group.isGear || $('show-gear').checked);
    const sort = $('case-sort').value;
    if (sort === 'priority' || sort === 'fleet') groups.sort((a,b) =>
      (sort === 'fleet' && Number(a.isGear) - Number(b.isGear)) ||
      score(priorityCase(b)) - score(priorityCase(a)) || a.vesselName.localeCompare(b.vesselName));
    if ($('case-sort').value === 'name') groups.sort((a,b) => a.vesselName.localeCompare(b.vesselName));
    if ($('case-sort').value === 'recent') groups.sort((a,b) => (Date.parse(b.anchor?.markerTime) || 0) - (Date.parse(a.anchor?.markerTime) || 0));
    groupIndex = new Map(groups.map(group => [group.vesselKey, group]));
    anchors = groups.flatMap(group => {
      if (!group.anchor) return [];
      const item = priorityCase(group).snapshotCase;
      return [{...group.anchor, riskLevel:item.status === 'queued' ? 'unknown' : item.risk_level, riskScore:item.risk_score, status:item.status}];
    });
    const gear = groups.filter(g => g.isGear).length;
    const ships = count(groups.length - gear, 'vessel');
    $('queue-result').textContent = [ships, gear && count(gear, 'gear transmitter')].filter(Boolean).join(' · ');
    $('total-cases').textContent = groups.length - gear;
    $('total-gear').textContent = gear;
    $('total-complete').textContent = groups.reduce((n, g) => n + g.cases.filter(hasReport).length, 0);
    $('cases').replaceChildren(...groups.map(vesselRow));
    if (!groups.length) {
      const noLiveRun = $('case-mode').value === 'live' && ![catalog.snapshot.latest_run, ...catalog.snapshot.runs].some(run => run?.mode === 'live');
      const emptyText = noLiveRun ? 'No live runs have been published. Select History to explore the available observations.'
        : !catalog.cases.length ? 'No cases were published for this window.' : 'No vessels match these filters.';
      $('cases').append(make('p', emptyText, 'queue-empty'));
    }
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
    const provenance = [next.snapshot.attribution || 'Global Fishing Watch', next.snapshot.disclaimer || 'Each case is a lead for human review.'].join(' ');
    $('footer-provenance').textContent = provenance;
    for (const dialog of [briefDialog, watchDialog, $('export-dialog'), $('about-dialog')]) {
      let note = dialog.querySelector('.publication-credit');
      if (!note) {
        note = make('p', '', 'publication-credit');
        dialog.append(note);
      }
      note.textContent = provenance;
    }
    const synthetic = next.snapshotSource === 'sample' || next.snapshot.synthetic === true || next.snapshot.data_source === 'sample';
    $('data-mode').textContent = synthetic ? 'SYNTHETIC DATA' : next.origin;
    $('data-mode').classList.toggle('synthetic-label', synthetic);
    const all = option('All protected areas', '');
    $('area').replaceChildren(all, ...next.areas.map(area => option(area.name, area.id)));
    $('area').value = areaIndex.has(priorArea) ? priorArea : '';
    areaTools.update(next.snapshot, $('area').value);
    $('watch-button').disabled = false;
    renderQueue();
  }
  function openWatchCase(raw) {
    if (!raw || !catalog.cases.some(row=>row.id===raw.case_id)) return;
    watchDialog.close();
    // The watch list covers the whole publication, regardless of explorer filters.
    for (const id of ['case-search','date-from','date-to','case-mode','case-status']) $(id).value='';
    if (raw.vessel_type === 'gear') $('show-gear').checked = true;
    areaTools.update(catalog.snapshot, '');
    goArea(raw.mpa_id);
    const group = groups.find(g=>g.cases.some(r=>r.id===raw.case_id));
    if (group) { selectVessel(group.vesselKey, raw.case_id); $('case-title').focus(); }
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
    appendRunContext(body, data);
    $('export-dialog').showModal();
  }
  function positionsByTime(records) {
    let latest = '';
    for (const r of records) for (const p of r.mapPoints) if (p.markerTime && (!latest || Date.parse(p.markerTime) > Date.parse(latest))) latest = p.markerTime;
    return latest;
  }
  async function refresh(manual = false) {
    if (loading || (!manual && (document.hidden || document.querySelector('dialog[open]')))) return;
    loading = true;
    refreshButton.disabled = true;
    try {
      const {data, source} = await loadWorkspaceSnapshot(fetch, {signal: AbortSignal.timeout(40000)});
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
  $('area').addEventListener('change', () => goArea($('area').value));
  $('watch-button').addEventListener('click', () => {
    if (!catalog) return;
    renderWatchSummary($('watch-detail'), catalog.snapshot, openWatchCase);
    watchDialog.showModal();
  });
  $('close-watch').addEventListener('click',()=>watchDialog.close());
  document.addEventListener('keydown',event=>{
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (event.target.closest('input,select,textarea,[contenteditable=true]')) return;
    if (vessel || $('area').value) { event.preventDefault(); upOneLevel(); }
  });
  $('case-search').addEventListener('input',renderQueue);
  for (const id of ['case-sort','date-from','date-to','case-mode','case-status','show-gear']) $(id).addEventListener('change',renderQueue);
  picker.addEventListener('change', () => {
    selectObservation(vessel?.points[picker.selectedIndex]);
  });
  slider.addEventListener('input', () => {
    selectObservation(datedPositions[Number(slider.value)]);
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
    upOneLevel();
    if ($('map').getBoundingClientRect().bottom < 140) {
      $('map').scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block:'start'});
    }
    $('map').querySelector('.mar-stage')?.focus({preventScroll:true});
  });
  $('investigate').addEventListener('click', () => {
    if (!selected?.snapshotCase.brief_markdown || selected.snapshotCase.status === 'queued') return;
    renderReport(selected, catalog);
    appendCaseContext($('brief'), selected.snapshotCase);
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
