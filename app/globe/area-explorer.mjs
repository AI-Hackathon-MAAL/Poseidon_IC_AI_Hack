const indexUrl = new URL('../../data/mpa_index.json', import.meta.url);
const defaults = () => ({identified: '', minRisk: 0, eventType: ''});
const events = [
  ['gap', 'Tracking gap'], ['fishing', 'Apparent fishing'], ['encounter', 'Encounter'],
  ['loitering', 'Loitering'], ['port_visit', 'Port visit']
];
const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const utc = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function disclosure(title) {
  const node = el('details', null, 'area-disclosure');
  node.append(el('summary', title));
  return node;
}

function labelledSelect(title, choices, value, onChange) {
  const label = el('label', title);
  const select = el('select');
  select.setAttribute('aria-label', title);
  for (const [key, name] of choices) select.add(new Option(name, key));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  label.append(select);
  return label;
}

function copyAreaId(id) {
  const button = el('button', 'Copy area ID', 'area-copy');
  button.type = 'button';
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(id);
      button.textContent = 'ID copied';
    } catch {
      // The ID remains selectable even on hosts without clipboard permission.
      button.replaceWith(el('code', id));
    }
  });
  return button;
}

function appendSourceLinks(container, sources) {
  for (const source of sources || []) {
    let href;
    try { href = new URL(source.url); } catch { continue; }
    if (!['http:', 'https:'].includes(href.protocol)) continue;
    const link = el('a', source.title || href.hostname);
    link.href = href.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    container.append(link);
  }
}

function addWatchDetails(container, area) {
  const metrics = el('dl', null, 'area-metrics');
  for (const [key, label] of [
    ['n_cases','Cases'], ['n_events','Events'], ['n_gap','Tracking gaps'],
    ['n_fishing','Apparent fishing'], ['n_unidentified','Unidentified'], ['n_flagged_for_review','Flagged']
  ]) {
    const cell = el('div');
    cell.append(el('dt',label), el('dd',area[key] ?? '—'));
    metrics.append(cell);
  }
  container.append(metrics);
  const distribution = el('div',null,'area-distribution');
  const risk = el('p',null,'area-risk-label');
  const levels = [['n_high','High'], ['n_medium','Medium'], ['n_low','Low']];
  for (const [key, label] of levels) {
    const value = area[key];
    if (!Number.isFinite(value) || value < 0) continue;
    risk.append(el('span',value + ' ' + label.toLowerCase()));
    if (value > 0) {
      const segment = el('i',null,'area-risk-' + label.toLowerCase());
      segment.style.flexGrow = value;
      distribution.append(segment);
    }
  }
  distribution.setAttribute('aria-hidden','true');
  if (distribution.childElementCount) container.append(distribution);
  if (risk.childElementCount) container.append(risk);
  const investigated = Date.parse(area.last_investigated_at);
  if (Number.isFinite(investigated)) container.append(el('p','Last investigated ' + utc.format(investigated) + ' UTC','area-note'));
  const rules = disclosure('Rules and sources');
  rules.append(el('p', area.rules_summary || 'This publication includes no rules summary.'));
  appendSourceLinks(rules,area.rules_sources);
  const context = disclosure('Regional context');
  context.append(el('p',area.news_summary || 'This publication includes no regional summary.'));
  appendSourceLinks(context,area.news_sources);
  container.append(rules,context);
}

function loadedWindows(snapshot, id) {
  const rows = snapshot.cases.filter(record => String(record.mpa_id) === id && record.window_start && record.window_end);
  const sources = rows.length ? rows : (snapshot.runs || []).filter(run =>
    Array.isArray(run.mpa_ids) && run.mpa_ids.some(value => String(value) === id) && run.window_start && run.window_end);
  return [...new Set(sources.map(row => row.window_start.slice(0,10) + ' – ' + row.window_end.slice(0,10)))].sort();
}

export function mountAreaExplorer({host, searchHost, onArea, onFilter}) {
  const input = document.getElementById('case-search');
  let snapshot, areaId = '', filters = defaults(), directory, loading;
  let watched = new Map();
  searchHost.classList.add('area-matches');
  searchHost.hidden = host.hidden = true;

  function setFilter(key,value) {
    filters[key] = value;
    onFilter({...filters});
  }

  function renderArea() {
    host.replaceChildren();
    const area = watched.get(areaId);
    host.hidden = !area;
    if (!area) return;
    const overview = disclosure('Area details');
    overview.classList.add('area-overview');
    const scroll = el('div',null,'area-scroll');
    scroll.append(el('h3',area.mpa_name || areaId));
    addWatchDetails(scroll,area);
    const query = el('div',null,'area-controls');
    query.append(labelledSelect('Event', [['','All events'], ...events], filters.eventType, value => setFilter('eventType',value)));
    const riskLabel = el('label','Minimum risk');
    const minRisk = el('input');
    minRisk.type = 'number';
    minRisk.min = '0';
    minRisk.max = '100';
    minRisk.step = '1';
    minRisk.value = String(filters.minRisk);
    minRisk.addEventListener('change', () => {
      const risk = Math.min(100, Math.max(0, Math.round(minRisk.valueAsNumber || 0)));
      minRisk.value = String(risk);
      setFilter('minRisk',risk);
    });
    riskLabel.append(minRisk);
    query.append(riskLabel, labelledSelect('Vessel identity', [['','All identities'],['identified','Identified'],['unidentified','Unidentified']], filters.identified, value => setFilter('identified',value)));
    scroll.append(query);
    for (const window of loadedWindows(snapshot,areaId)) scroll.append(el('p','Loaded window · ' + window,'area-note'));
    const note = el('p','To investigate a different period, run Poseidon for this area.','area-note');
    note.append(el('code','mpa_ids = ' + areaId),copyAreaId(areaId));
    scroll.append(note);
    overview.append(scroll);
    host.append(overview);
  }

  function choose(record) {
    searchHost.replaceChildren();
    if (watched.has(record.id)) {
      input.value = '';
      searchHost.hidden = true;
      onArea(record.id);
      return;
    }
    const card = el('div',null,'area-unwatched');
    card.setAttribute('role','status');
    card.append(el('strong',record.name),el('p','Not investigated yet. To watch this area, run the Poseidon notebook with the following ID.'),el('code','mpa_ids = ' + record.id),copyAreaId(record.id));
    searchHost.append(card);
  }

  function showMatches() {
    searchHost.replaceChildren();
    const query = fold(input.value);
    searchHost.hidden = true;
    if (!query) return;
    const entries = [...watched.values()].map(area => ({id:String(area.mpa_id),name:area.mpa_name || String(area.mpa_id)}));
    const terms = query.split(/\s+/);
    const matches = [];
    function consider(entry) {
      const text = entry.key || fold(entry.name + ' ' + entry.id);
      if (terms.every(term => text.includes(term))) matches.push(entry);
    }
    for (const entry of entries) consider(entry);
    if (directory) {
      for (const entry of directory) {
        if (matches.length >= 8) break;
        if (!watched.has(entry.id)) consider(entry);
      }
    }
    if (!matches.length) return;
    searchHost.hidden = false;
    searchHost.append(el('span','Protected areas','area-search-caption'));
    for (const record of matches.slice(0,8)) {
      const button = el('button',null,'area-choice');
      button.type = 'button';
      button.append(el('span',record.name),el('small',watched.has(record.id) ? 'Open area ↗' : 'Index only'));
      button.addEventListener('click',() => choose(record));
      searchHost.append(button);
    }
  }

  function loadIndex() {
    if (loading || directory) return;
    loading = fetch(indexUrl).then(async response => {
      if (!response.ok) return [];
      const result = await response.json();
      return Array.isArray(result) ? result.filter(item => item?.id != null && typeof item.name === 'string')
        .map(item => ({id:String(item.id), name:item.name, key:fold(item.name + ' ' + item.id)})) : [];
    }).catch(() => []).then(result => {
      directory = result;
      if (document.activeElement === input) showMatches();
    });
  }
  input.addEventListener('input',() => { showMatches(); if (input.value.trim()) loadIndex(); });
  input.addEventListener('keydown',event => {
    if (event.key === 'ArrowDown' && !searchHost.hidden) {
      const first = searchHost.querySelector('button');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  searchHost.addEventListener('keydown',event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      searchHost.hidden = true;
      input.focus();
    }
  });
  return {
    update(nextSnapshot,activeAreaId) {
      const nextId = activeAreaId == null ? '' : String(activeAreaId);
      if (snapshot === nextSnapshot && areaId === nextId) return;
      if (snapshot !== nextSnapshot) watched = new Map((nextSnapshot.mpas || []).map(area => [String(area.mpa_id),area]));
      if (areaId !== nextId) filters = defaults();
      snapshot = nextSnapshot;
      areaId = nextId;
      renderArea();
      showMatches();
    },
    getFilters: () => ({...filters})
  };
}
