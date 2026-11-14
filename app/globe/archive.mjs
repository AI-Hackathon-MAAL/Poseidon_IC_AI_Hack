const body = document.getElementById('archive');
function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
async function file(name) {
  const response = await fetch(new URL('../../data/' + name + '.json', import.meta.url));
  if (!response.ok) throw new Error('Archive unavailable.');
  return response.json();
}
function renderRecord(record, area, sources) {
  const card = document.createElement('details');
  const heading = element('summary', record.title);
  heading.append(element('small', [record.vessel, record.date, record.kind].filter(Boolean).join(' · ')));
  card.append(heading);
  const used = new Set(area.sourceIds || []);
  if (record.start && record.end) {
    const hours = (Date.parse(record.end) - Date.parse(record.start)) / 3600000;
    card.append(element('p', 'Reporting gap · ' + hours.toFixed(2) + ' hours. Activity between the two observations remains unknown.'));
    for (const [index, point] of record.mapPoints.entries()) {
      const at = index === 0 ? record.start : record.end;
      card.append(element('p', [point.label, at.replace('T', ' ').replace('Z', ' UTC'), point.lat.toFixed(4) + '°, ' + point.lon.toFixed(4) + '°'].join(' · ')));
    }
  }
  for (const observation of record.observations || []) {
    card.append(element('p', observation.date + ' · ' + observation.text));
    for (const id of observation.sourceIds || []) used.add(id);
  }
  const links = document.createElement('ul');
  for (const id of used) {
    const source = sources[id];
    if (!source || !/^https:\/\//i.test(source.url)) continue;
    const item = document.createElement('li');
    const anchor = element('a', source.title);
    anchor.href = source.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    item.append(anchor);
    links.append(item);
  }
  card.append(links);
  return card;
}
try {
  const [regions, gaps, reports, sources] = await Promise.all(['areas', 'gaps', 'reports', 'sources'].map(file));
  const records = [...gaps.events, ...reports];
  body.replaceChildren();
  for (const area of regions.areas) {
    const section = document.createElement('section');
    section.append(element('h2', area.name), element('p', area.summary));
    for (const record of records.filter(row => row.areaId === area.id)) section.append(renderRecord(record, area, sources));
    body.append(section);
  }
} catch {
  body.textContent = 'The historical records could not be loaded. Reload this page to try again.';
}
