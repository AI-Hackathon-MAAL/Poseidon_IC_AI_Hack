const dayFormat = new Intl.DateTimeFormat('en-GB', {day:'numeric', month:'short', year:'numeric', timeZone:'UTC'});
const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const fold = value => clean(value).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
const entries = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [];
const copy = value => clean(value).replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]*(?:\)|$)/gi, '$1')
  .replace(/\*\*([^*]+)\*\*/g,'$1').replace(/\*([^*]+)\*/g,'$1');

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function articleURL(raw) {
  try {
    const url = new URL(raw);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url;
  } catch { /* A published record can have no usable link. */ }
  return null;
}

function publication(snapshot, scope) {
  const areaNames = new Map(entries(snapshot.mpas).map(r => [String(r.mpa_id), clean(r.mpa_name)]));
  const rows = entries(scope === 'area' ? snapshot.news : snapshot.global_news).map(r => {
    const url = articleURL(r.url);
    const time = Date.parse(r.fetched_at);
    const areaId = String(r.mpa_id ?? '');
    const location = scope === 'area' ? clean(r.mpa_name) || areaNames.get(areaId) : clean(r.place_name);
    const mapped = r.place_type !== 'none' && Number.isFinite(r.lat) && Math.abs(r.lat) <= 90 &&
      Number.isFinite(r.lon) && Math.abs(r.lon) <= 180;
    const provider = clean(r.provider);
    return {
      key: url?.href || clean(r.news_id) || r,
      title: clean(r.title) || 'Untitled article', url, domain: url?.hostname.replace(/^www\./i, '') || '',
      snippet: copy(r.snippet), time: Number.isFinite(time) ? time : -Infinity,
      place: location || '', locationKey: scope === 'area' ? areaId || location : location,
      mapped, level: r.place_type, provider: provider.toLowerCase() === 'linkup' ? 'Linkup' : provider
    };
  }).sort((a,b) => b.time - a.time);
  // A regional search can return the same article for several reserves. Keep
  // each association so filtering by any of those reserves finds the source.
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.key)) grouped.set(row.key, {row, matches:[]});
    grouped.get(row.key).matches.push(row);
  }
  return [...grouped.values()];
}

function articleHeading(row) {
  const title = el(row.url ? 'a' : 'span', 'news-headline', row.title);
  if (row.url) {
    title.href = row.url.href;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
  }
  return title;
}

function card(article, scope) {
  const {row, matches} = article;
  const item = el('li','news-story');
  const line = el('div','news-byline');
  line.append(el('span','news-outlet',row.domain || 'Source unavailable'));
  if (Number.isFinite(row.time)) {
    const date = new Date(row.time), time = el('time','',date.toISOString().slice(11,16) + 'Z');
    time.dateTime = date.toISOString();
    time.title = 'Retrieved ' + date.toUTCString();
    line.append(time);
  }
  item.append(line, articleHeading(row));
  if (row.snippet) item.append(el('p','news-excerpt',row.snippet));
  const places = [...new Set(matches.map(r => r.place).filter(Boolean))];
  const place = places.join(' · ') || (scope === 'area' ? 'Area unspecified' : 'Location unspecified');
  const metadata = el('div','news-tags');
  metadata.append(el('span','news-place',place));
  if (scope === 'global' && row.mapped && row.level === 'country') metadata.append(el('span','','Country-level'));
  if (row.provider) metadata.append(el('span','','via ' + row.provider));
  item.append(metadata);
  return item;
}

function matchesLocation(row, selection) {
  if (!selection) return true;
  if (selection === 'mapped') return row.mapped;
  if (selection === 'unmapped') return !row.mapped;
  return selection === 'place:' + row.locationKey;
}

export function renderNewsFeed(body, snapshot, {scope:initialScope = 'global', areaId = ''} = {}) {
  const feeds = {global:publication(snapshot,'global'), area:publication(snapshot,'area')};
  let scope = initialScope === 'area' ? 'area' : 'global';
  const wrap = el('section','news-feed');
  const scopeBar = el('div','news-scopes');
  scopeBar.setAttribute('role','group'); scopeBar.setAttribute('aria-label','News coverage');
  const buttons = {};
  for (const key of ['global','area']) {
    const button = el('button','news-scope',key === 'global' ? 'Global' : 'By area');
    button.type = 'button';
    button.append(el('span','news-scope-count',feeds[key].length));
    button.addEventListener('click',() => {
      if (scope === key) return;
      scope = key;
      setScope();
    });
    buttons[key] = button; scopeBar.append(button);
  }
  const filters = el('div','news-filters');
  const queryLabel = el('label','news-field','Search news');
  const query = el('input'); query.type = 'search'; query.placeholder = 'Headline, source or keyword';
  queryLabel.append(query);
  const geoLabel = el('label','news-field'), geoTitle = el('span'), geo = el('select');
  geoLabel.append(geoTitle,geo); filters.append(queryLabel,geoLabel);
  const resultsBar = el('div','news-results-bar'), count = el('span','news-result-count'), clear = el('button','news-clear','Clear filters');
  clear.type = 'button'; count.setAttribute('role','status'); count.setAttribute('aria-live','polite');
  resultsBar.append(count,clear);
  const results = el('div','news-results');
  wrap.append(scopeBar,filters,resultsBar,results); body.replaceChildren(wrap);
  function setScope(preferred = '') {
    for (const [key, button] of Object.entries(buttons)) button.setAttribute('aria-pressed',String(scope === key));
    geoTitle.textContent = scope === 'area' ? 'Protected area' : 'Location';
    geo.replaceChildren(new Option(scope === 'area' ? 'All protected areas' : 'All locations',''));
    if (scope === 'global') {
      geo.add(new Option('On the map','mapped')); geo.add(new Option('Without map coordinates','unmapped'));
    }
    const places = new Map();
    for (const article of feeds[scope]) for (const row of article.matches) {
      if (row.locationKey && row.place) places.set('place:' + row.locationKey,row.place);
    }
    if (scope === 'area') for (const area of entries(snapshot.mpas)) {
      if (area.mpa_id != null && clean(area.mpa_name)) places.set('place:' + area.mpa_id,clean(area.mpa_name));
    }
    const list = el('optgroup');
    list.label = scope === 'area' ? 'Protected areas' : 'Named locations';
    for (const [key,name] of [...places].sort((a,b)=>a[1].localeCompare(b[1]))) list.append(new Option(name,key));
    if (places.size) geo.append(list);
    if (preferred && places.has(preferred)) geo.value = preferred;
    updateResults();
  }
  function updateResults() {
    const terms = fold(query.value).split(' ').filter(Boolean);
    const articles = [];
    for (const article of feeds[scope]) {
      const matches = article.matches.filter(row => matchesLocation(row,geo.value));
      if (!matches.length) continue;
      const text = fold(matches.map(r=>[r.title,r.snippet,r.place,r.provider,r.domain].join(' ')).join(' '));
      if (terms.every(term=>text.includes(term))) articles.push({row:matches[0],matches});
    }
    articles.sort((a,b)=>b.row.time-a.row.time);
    const active = Boolean(geo.value || query.value);
    const total = feeds[scope].length;
    count.textContent = (active ? articles.length + ' of ' + total : total) + (total === 1 ? ' article' : ' articles');
    clear.hidden = !active;
    const fragment = document.createDocumentFragment();
    let lastDay, list;
    for (const article of articles) {
      const day = Number.isFinite(article.row.time) ? dayFormat.format(article.row.time) : '';
      if (day !== lastDay) {
        lastDay = day;
        const block = el('section','news-day');
        block.append(el('h3','',day ? 'Retrieved ' + day + ' UTC' : 'Retrieval date unavailable'));
        list = el('ul','news-stories');
        block.append(list); fragment.append(block);
      }
      list.append(card(article,scope));
    }
    if (!articles.length) fragment.append(el('p','news-empty',active ? 'No articles match these filters.' :
      scope === 'area' ? 'No protected-area news in this export.' : 'No global news in this export.'));
    results.replaceChildren(fragment);
  }
  query.addEventListener('input',updateResults); geo.addEventListener('change',updateResults);
  clear.addEventListener('click',()=>{ query.value = ''; geo.value = ''; updateResults(); query.focus(); });
  setScope(scope === 'area' && areaId ? 'place:' + areaId : '');
}

export function newsPreview(snapshot, onNews) {
  const preview = el('section','watch-section');
  const heading = el('div','news-preview-heading');
  heading.append(el('h3','','Latest global news'));
  const browse = el('button','news-clear','Browse news →');
  browse.type = 'button'; browse.addEventListener('click',onNews); heading.append(browse); preview.append(heading);
  const articles = publication(snapshot,'global').slice(0,2);
  const list = el('ul','news-preview');
  for (const {row} of articles) {
    const item = el('li');
    item.append(el('span','news-outlet',row.domain || 'Source unavailable'),articleHeading(row)); list.append(item);
  }
  preview.append(articles.length ? list : el('p','watch-empty','No global news in this export.'));
  return preview;
}
