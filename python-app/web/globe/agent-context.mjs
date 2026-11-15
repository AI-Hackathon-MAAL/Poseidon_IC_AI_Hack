// Evidence from the notebook. No ranking, identity resolution or web search takes place in the browser.
const node = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text != null) item.textContent = text;
  if (className) item.className = className;
  return item;
};
const list = value => Array.isArray(value) ? value : [];
const measured = value => Number.isFinite(value);
const panel = title => {
  const details = node('details', null, 'runtime');
  details.append(node('summary', title));
  return details;
};
const counts = pairs => pairs.filter(([value]) => measured(value)).map(([value,label]) => value + ' ' + label).join(' · ');
const row = (container, label, value) => {
  if (value != null && value !== '') container.append(node('div', label + ' · ' + value));
};
const historyTypes = {gap:'Tracking gaps', fishing:'Apparent fishing', encounter:'Apparent encounters', loitering:'Apparent loitering', port_visit:'Port visits'};
const decisions = {investigate:'Investigate', skip_unchanged:'Kept earlier investigation', queued:'Queued'};

export function appendRunContext(body, snapshot) {
  const run = snapshot.latest_run;
  if (!run) return;
  const section = node('section', null, 'export-section');
  section.append(node('h3', 'Latest agent run'));
  const place = list(run.mpa_names).join(', ');
  const mode = {history:'Historical window',live:'Monitoring window'}[run.mode];
  if (place || mode) section.append(node('p', [mode, place].filter(Boolean).join(' · ')));
  if (run.objective) section.append(node('p', run.objective));
  const outcome = counts([[run.n_investigated,'investigated'],[run.n_skipped_unchanged,'unchanged'],[run.n_queued,'queued'],[run.n_incomplete,'incomplete']]);
  if (outcome) section.append(node('p', outcome));
  const model = run.llm_endpoint === 'sample-scripted-model' ? 'scripted model decisions' : 'model decisions';
  const choices = counts([[run.llm_decisions,model],[run.policy_decisions,'policy decisions']]);
  if (choices) section.append(node('p', choices));
  const triage = list(run.triage);
  if (triage.length) {
    const audit = panel('Triage decisions · ' + triage.length), items = node('ol', null, 'export-rows');
    for (const entry of triage) {
      const item = node('li');
      item.append(node('strong', entry.vessel || entry.case_id || 'Unidentified vessel'));
      item.append(node('div', [decisions[entry.decision] || entry.decision, entry.reason].filter(Boolean).join(' · ')));
      items.append(item);
    }
    audit.append(items);
    section.append(audit);
  }
  for (const note of list(run.notes)) if (typeof note === 'string') section.append(node('p', note));
  // Place alongside publication time, before the potentially long area rule text.
  const publication = body.querySelector('.export-section');
  if (publication) publication.after(section);
  else body.append(section);
}

export function appendCaseContext(body, record) {
  const evidence = record.evidence || {};
  const identity = evidence.resolve_identity;
  const registry = panel('Vessel identity');
  const fromList = collection => list(collection).filter(x => typeof x === 'string').join(', ');
  for (const [label,value] of [
    ['MMSI',record.mmsi],['IMO',record.imo],['Call sign',record.callsign],
    ['Flag',record.flag || fromList(identity?.flags)],['Owner',record.owner || fromList(identity?.owners)],
    ['Recorded names',fromList(identity?.names)],['Vessel type',record.vessel_type],['Gear types',fromList(identity?.gear_types)]
  ]) row(registry,label,value || '—');
  if (registry.childElementCount > 1) body.append(registry);

  if (record.change || measured(record.previous_risk_score)) {
    const memory = panel('Investigation history');
    const changes = {new:'First investigation',updated:'Reopened after new evidence',retry:'Retried an earlier investigation',forced:'Manually requested reinvestigation',unchanged:'No change since the previous investigation'};
    row(memory,'Case history',changes[record.change] || record.change);
    if (measured(record.previous_risk_score)) row(memory,'Previous review score',record.previous_risk_score + '/100');
    if (measured(record.risk_score)) row(memory,'Published review score',record.risk_score + '/100');
    body.append(memory);
  }
  const history = evidence.vessel_history;
  if (!history) return;
  const past = panel('Vessel activity · 12-month check');
  row(past, 'Period checked', [history.period_start,history.period_end].filter(Boolean).join(' to '));
  for (const [key,label] of Object.entries(historyTypes)) {
    const count = history.counts?.[key];
    row(past,label,measured(count) ? count : 'Not reported');
  }
  if (list(history.partial_errors).length) past.append(node('p','Some activity checks were unavailable. Missing counts are unknown.'));
  body.append(past);
}
