function renderSnapshotBrief(record, catalog) {
  const data = record.snapshotCase;
  const snapshot = catalog.snapshot;
  const rows = value => Array.isArray(value) ? value.filter(Boolean) : [];
  const belongsToCase = item => !item.case_id || item.case_id === data.case_id;
  const events = rows(Array.isArray(record.events) ? record.events : data.events).filter(belongsToCase);
  const sources = rows(data.sources);
  const stepNumbers = new Set();
  const steps = rows(data.steps).filter(step => {
    if (!belongsToCase(step) || (step.run_id && step.run_id !== data.run_id)) return false;
    if (step.step_no == null) return true;
    if (stepNumbers.has(step.step_no)) return false;
    stepNumbers.add(step.step_no);
    return true;
  }).sort((first, second) => first.step_no - second.step_no);
  const run = [snapshot.latest_run, ...rows(snapshot.runs)].find(item => item?.run_id && item.run_id === data.run_id);
  const scripted = catalog.snapshotSource === 'sample' || run?.llm_endpoint === 'sample-scripted-model';
  const modelName = scripted ? 'Scripted model' : 'Model';
  const decisionName = source => ({ llm: modelName, policy: 'Policy', template: 'Template' }[source] || 'Unrecorded');
  const markdown = typeof data.brief_markdown === 'string' ? data.brief_markdown.trim() : '';
  const queued = data.status === 'queued';
  const status = { complete: 'Review ready', incomplete: 'Investigation incomplete', queued: 'Queued for investigation' };
  const body = $('brief');
  body.className = 'brief-body';
  body.replaceChildren();
  $('priority').textContent = data.risk_level ? `${data.risk_level} priority` : 'Priority unavailable';
  $('priority').dataset.state = 'ready';
  $('activity-state').textContent = status[data.status] || 'Status unavailable';
  $('status').className = 'status';
  $('status').textContent = [record.synthetic ? 'Synthetic case' : catalog.origin,
    data.investigated_at && (queued ? 'Queued ' : 'Saved ') + date(data.investigated_at)].filter(Boolean).join(' · ');

  // The trusted citation targets come from the export's numbered source records.
  // Prose and inline Markdown URLs never supply DOM markup or link destinations.
  function appendText(target, value) {
    const text = value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^_(.+)_$/, '$1')
      .replace(/\*\*([^*]+)\*\*|\*([^*]+)\*/g, (_, bold, italic) => bold || italic);
    for (const part of text.split(/(\[\d+\])/)) {
      const match = /^\[(\d+)\]$/.exec(part);
      const source = match && sources.find(item => String(item.n) === match[1]);
      if (source) {
        const citation = safeLink(part, source.url);
        citation.title = source.title || 'Case source';
        citation.setAttribute('aria-label', `Source ${source.n}, ${citation.title}`);
        const wrapper = make('span', null, 'claim-sources');
        wrapper.append(citation);
        target.append(wrapper);
      } else {
        target.append(document.createTextNode(part));
      }
    }
  }

  function appendLines(lines) {
    let list;
    for (const line of lines) {
      const bullet = /^(?:[-*+] |\d+[.)] )(.+)$/.exec(line);
      if (bullet) {
        if (!list) {
          list = make('ul');
          body.append(list);
        }
        const item = make('li');
        const observation = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))\s*(?:[:—–-]\s*)?(.+)$/.exec(bullet[1]);
        if (observation) item.append(make('span', date(observation[1]), 'observation-date'));
        appendText(item, observation ? observation[2] : bullet[1]);
        list.append(item);
      } else if (line) {
        list = null;
        const paragraph = make('p');
        appendText(paragraph, line);
        body.append(paragraph);
      } else {
        list = null;
      }
    }
  }

  const intro = [];
  const sections = [];
  let lines = intro;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{2,6}\s+(.+)$/.exec(line);
    if (heading) {
      lines = [];
      sections.push({ title: heading[1], lines });
    } else if (!/^#\s/.test(line)) {
      lines.push(line.replace(/^\*\*Summary:\*\*\s*/i, ''));
    }
  }
  const isGear = [data.vessel_type, ...rows(data.evidence?.resolve_identity?.ship_types)].some(type => String(type).toLowerCase() === 'gear');
  if (isGear) {
    body.append(make('p', `AIS classification: gear${data.mmsi ? ' · MMSI ' + data.mmsi : ''}. This signal alone does not identify a fishing vessel.`));
  }
  if (events.some(event => event.event_type === 'gap') && markdown) {
    body.append(make('p', 'AIS positions bracket the reporting gap. The route, activity and reason for the missing signal remain unknown.'));
    body.append(make('h3', 'Agent summary'));
  }
  if (intro.some(Boolean)) appendLines(intro);
  else body.append(make('p', data.headline || record.title || 'No case summary was exported.'));

  const overview = make('div', null, 'evidence-overview');
  for (const [label, value] of [['Observations', events.length], ['Sources', sources.length]]) {
    const metric = make('div');
    metric.append(make('strong', String(value)), make('span', label));
    overview.append(metric);
  }
  body.append(overview);

  if (markdown) {
    const actions = make('div', null, 'brief-actions');
    const download = make('button', 'Download brief ↓', 'text-button');
    download.type = 'button';
    download.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([data.brief_markdown], { type: 'text/markdown;charset=utf-8' }));
      const link = make('a');
      link.href = url;
      link.download = `poseidon-${String(data.case_id || 'case').replace(/[^a-zA-Z0-9_-]+/g, '-')}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    actions.append(download);
    body.append(actions);
  } else {
    body.append(make('p', queued ? 'The agent has queued this case. A brief will be available after investigation.'
      : 'This export contains no written brief for this case.'));
  }

  const measured = make('details', null, 'runtime');
  measured.append(make('summary', `Recorded AIS observations · ${events.length}`));
  const identity = [data.mmsi && 'MMSI ' + data.mmsi, data.vessel_type && 'AIS classification · ' + data.vessel_type];
  if (identity.some(Boolean)) measured.append(make('div', identity.filter(Boolean).join(' · ')));
  const names = { gap: 'AIS reporting gap', fishing: 'Apparent fishing', encounter: 'Apparent encounter', loitering: 'Apparent loitering' };
  for (const event of events) {
    const item = make('div');
    const label = names[event.event_type] || event.event_type || 'Observation';
    item.append(make('strong', event.duration_hours == null ? label : `${label} · ${event.duration_hours} h`));
    item.append(make('div', 'Start · ' + date(event.start_time)), make('div', 'End · ' + date(event.end_time)));
    measured.append(item);
  }
  if (!events.length) measured.append(make('div', 'No measured events were attached to this case.'));
  body.append(measured);

  // Some exports place original cited analysis here; newer exports insert the bibliography.
  // Render only the structured source records as links, preserving any separate prose or caveat.
  for (const section of sections) {
    const sourceSection = /^(what public sources say|sources)$/i.test(section.title);
    const content = sourceSection ? section.lines.filter(line =>
      !/^(?:[-*+]\s+\[\d+\]\s+|\d+[.)]\s+)\[.+\]\(.+\)$/.test(line)
      && !/^Search results for analyst verification:\s*$/i.test(line)) : section.lines;
    if (!content.some(Boolean)) continue;
    const standaloneCaveat = /^sources$/i.test(section.title) && content.filter(Boolean).every(line => /^_.*_$/.test(line));
    if (!standaloneCaveat) body.append(make('h3', sourceSection ? 'Public search context' : section.title));
    if (sourceSection && !sources.length && content.some(line => /^No (?:relevant )?public (?:reports|sources)/i.test(line))) {
      body.append(make('p', rows(data.unknowns).find(text => /web search was not configured/i.test(text)) || 'No linked public reports were exported for this case.'));
    } else {
      appendLines(content);
    }
  }
  if (!sections.some(section => /what we don['’]t know|unknowns|what remains unknown/i.test(section.title))) {
    body.append(make('h3', 'What remains unknown'));
    const unknowns = rows(data.unknowns);
    if (unknowns.length) appendLines(unknowns.map(text => '- ' + text));
    else body.append(make('p', 'No uncertainties were listed in the export.'));
  }
  body.append(make('h3', 'Source record'));
  if (sources.length) body.append(make('p', 'Search leads for analyst review. Match identifiers and dates before attributing a report to this vessel.'));
  const sourceList = make('ol', null, 'sources');
  const checkNames = { web_search_vessel: 'Vessel records', web_search_owner: 'Owner records', mpa_rules: 'Protected-area rules', regional_news: 'Area news' };
  for (const source of sources) {
    const item = make('li');
    if (Number.isInteger(source.n)) item.value = source.n;
    item.append(safeLink(source.title || 'Public source', source.url));
    const provider = data.evidence?.[source.kind]?.provider;
    const attribution = [provider === 'linkup' ? 'Linkup' : provider, checkNames[source.kind]].filter(Boolean);
    if (attribution.length) item.append(make('span', attribution.join(' · '), 'observation-date'));
    sourceList.append(item);
  }
  body.append(sources.length ? sourceList : make('p', 'No public sources were attached to this case.'));

  const score = make('details', null, 'runtime');
  score.append(make('summary', data.risk_score == null ? 'Review score unavailable' : `Review score · ${data.risk_score}/100`));
  const reasons = rows(data.reasons);
  for (const reason of reasons) {
    const points = Number.isFinite(reason.points) ? `${reason.points >= 0 ? '+' : ''}${reason.points} · ` : '';
    score.append(make('div', points + (reason.text || 'Reason unavailable')));
  }
  if (!reasons.length) score.append(make('div', 'No scoring reasons were exported.'));
  if (data.confidence) score.append(make('div', `Evidence confidence · ${data.confidence}`));
  body.append(score);

  const news = rows(snapshot.news).filter(item => item.mpa_id != null && String(item.mpa_id) === String(data.mpa_id));
  if (news.length) {
    const panel = make('details', null, 'runtime');
    panel.append(make('summary', `Regional news · ${news.length}`));
    const queries = [...new Set(news.map(item => item.query).filter(Boolean))];
    for (const query of queries) panel.append(make('div', 'Search query · ' + query));
    for (const article of news) {
      const item = make('div');
      const provider = article.provider === 'linkup' ? 'Linkup' : article.provider;
      item.append(safeLink(article.title || 'Regional news item', article.url), make('div',
        [record.synthetic && 'Synthetic', provider, article.fetched_at && 'Retrieved ' + date(article.fetched_at)].filter(Boolean).join(' · ')));
      panel.append(item);
    }
    body.append(panel);
  }

  const provenance = make('details', null, 'runtime');
  provenance.append(make('summary', 'Data & investigation provenance'));
  const labels = [['Candidate data', catalog.origin], ['Run', data.run_id], ['Mode', data.mode],
    ['Window', [data.window_start, data.window_end].filter(Boolean).map(date).join(' – ')],
    ['Decisions', [data.llm_decisions != null && `${data.llm_decisions} by ${modelName.toLowerCase()}`,
      data.policy_decisions != null && `${data.policy_decisions} by policy`].filter(Boolean).join(' · ')],
    ['Brief writer', data.brief_written_by && decisionName(data.brief_written_by)], ['Model endpoint', run?.llm_endpoint],
    ['Run search provider', run?.search_provider && (record.synthetic ? 'Synthetic · ' : '') + run.search_provider]];
  for (const [label, value] of labels) {
    if (value) provenance.append(make('div', label + ' · ' + value));
  }
  body.append(provenance);

  const timeline = $('timeline');
  timeline.replaceChildren();
  for (const step of steps) {
    const row = make('div', null, 'step');
    const content = make('div');
    const toolName = String(step.tool || 'Investigation check').replaceAll('_', ' ');
    content.append(make('strong', toolName[0].toUpperCase() + toolName.slice(1)),
      make('p', [decisionName(step.decided_by), step.ok === false && 'Check failed', step.at && date(step.at)].filter(Boolean).join(' · ')));
    if (step.reason) content.append(make('p', step.reason));
    if (step.result) content.append(make('p', step.result));
    row.append(content);
    timeline.append(row);
  }
  if (!steps.length) timeline.append(make('p', queued ? 'Investigation has not started.' : 'No decision log was exported for this case.', 'activity-empty'));
}
