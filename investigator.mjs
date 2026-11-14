import { readFile } from 'node:fs/promises';
import { within, effectiveDate } from './scripts/import-gaps.mjs';
import { searchOfficial } from './providers.mjs';
import { runModelInvestigation } from './model-agent.mjs';
import { vesselHistory } from './gfw.mjs';

const readData = async name => JSON.parse(await readFile(new URL('./data/' + name, import.meta.url), 'utf8'));
export const { areas, map } = await readData('areas.json');
const documents = await readData('sources.json');
const { events } = await readData('gaps.json');
export const replay = [...events, ...await readData('reports.json')];

const rules = {
  revillagigedo: { from:effectiveDate, through:'2025-12-31', domains:['gob.mx'], ids:['decree'],
    text:'Article 10 of the 2017 decree prohibited fishing throughout Revillagigedo National Park during this case period.' },
  'dogger-bank': { from:'2022-06-13', through:'2023-12-31', domains:['gov.uk'], ids:['uk-law','mmo'],
    text:'The 2022 byelaw restricted bottom-towed gear in the specified area. Transiting vessels had to secure that gear on board.' },
  phoenix: { from:'2015-01-01', through:'2015-12-31', domains:['whc.unesco.org'], ids:['kiribati'],
    text:'Kiribati closed the area to commercial fishing on 1 January 2015. The government report assessed vessels passing through separately.' }
};

function usable(record) {
  if (!record || !/^[a-zA-Z0-9_-]{1,100}$/.test(record.id ?? '') || !Object.hasOwn(rules,record.areaId)) return false;
  if (![record.vessel,record.title,record.location,record.kind].every(x => typeof x === 'string' && x.length > 0)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return false;
  if (record.evidenceType === 'measured-gap') {
    return record.areaId === 'revillagigedo' && Date.parse(record.end) > Date.parse(record.start) &&
      record.mapPoints?.length === 2 && record.mapPoints.every(p => p && Number.isFinite(p.lon) && Number.isFinite(p.lat));
  }
  return ['reported-gap','transit','gear-review'].includes(record.evidenceType) &&
    Array.isArray(record.observations) && record.observations.length > 0 && record.observations.every(o =>
      typeof o.text === 'string' && typeof o.date === 'string' && Array.isArray(o.sourceIds) && o.sourceIds.length && o.sourceIds.every(id => Object.hasOwn(documents,id)));
}

export function validCatalog(records) {
  return Array.isArray(records) && records.every(usable) &&
    new Set(records.map(r => r.id)).size === records.length;
}

function checkedRule(record) {
  const rule = rules[record.areaId];
  return record.date >= rule.from && (record.endDate || record.date) <= rule.through ? rule : null;
}

function assess(record) {
  switch (record.evidenceType) {
    case 'measured-gap': {
      const points = record.mapPoints;
      const hours = ((Date.parse(record.end) - Date.parse(record.start)) / 3600000).toFixed(2);
      const states = points.map(p => within(p.lon,p.lat) ? 'inside' : 'outside');
      const observations = points.map((p,i) => ({
        date:i === 0 ? record.start : record.end,
        text:`${p.label} at ${p.lat.toFixed(4)}°, ${p.lon.toFixed(4)}°, ${states[i]} the published perimeter.`,
        sourceIds:['archive','decree']
      }));
      const intersects = states.includes('inside');
      return {
        observations, priority:intersects ? 'Review gap' : 'Location unresolved',
        summary:`The two recorded AIS positions are ${hours} hours apart. The first was ${states[0]} the park and the second was ${states[1]}.`,
        unknowns:['The route, activity and cause of the signal loss during the interval are unknown.'],
        nextStep:'Compare dated independent monitoring records for this interval before drawing conclusions about activity.'
      };
    }
    case 'reported-gap':
      return { observations:record.observations, priority:'Review referral',
        summary:'Park officials documented a signal loss near Clarión. Their report supports investigating the observation.',
        unknowns:['Exact endpoint coordinates and the vessel’s activity while unobserved are unavailable in this replay. A referral alone does not establish a violation.'],
        nextStep:'Request the underlying dated tracking observations and the outcome of the authority’s referral.' };
    case 'gear-review':
      return { observations:record.observations, priority:'Check gear',
        summary:'The annual estimate warrants checking whether restricted gear was deployed.',
        unknowns:['The estimate does not identify the gear in the water on any individual trip.'],
        nextStep:'Request dated gear-use or inspection records before classifying an individual operation.' };
    case 'transit':
      return { observations:record.observations, priority:'No follow-up indicated',
        summary:'The government classified these observations as transit. The record offers no evidence of fishing on this occasion.',
        unknowns:['This dated assessment covers the five reported vessels on this day only.'],
        nextStep:'Retain the dated transit assessment and close this lead unless new independent evidence emerges.' };
  }
}

export function listItem(record) {
  const { id, areaId, title, vessel, date, endDate, kind, location } = record;
  const item = { id, areaId, title, vessel, date, endDate, kind, location, synthetic:false, priority:assess(record).priority };
  if (record.evidenceType !== 'measured-gap') return { ...item, mapPoints: [] };
  const { start, end, datasetHours, mapPoints } = record;
  return { ...item, start, end, datasetHours, mapPoints: mapPoints.map(({ lon, lat, label }) => ({ lon, lat, label })) };
}

// The queue prioritises evidence reproducibility, not the probability of an offence.
export function rankCases(records) {
  const order = {'measured-gap':0, 'reported-gap':1, 'gear-review':2, transit:3};
  return [...records].sort((a,b) => order[a.evidenceType] - order[b.evidenceType] ||
    a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export async function investigate(record, records, { search = searchOfficial, model = runModelInvestigation, lookupHistory = vesselHistory, origin = 'Published replay' } = {}) {
  const steps = [{name:'Load candidate', detail:origin + ' · ' + record.id}];
  const findings = assess(record);
  const observations = [...findings.observations];
  const rule = checkedRule(record);
  if (rule) observations.push({date:record.date,text:rule.text,sourceIds:rule.ids});
  else {
    findings.priority = 'Rule unverified';
    findings.unknowns.push('The case dates are outside the verified rule window.');
  }
  steps.push({name:'Check event and dated rule',detail:rule ? 'Matched the event period to a dated primary source.' : 'No verified rule for these dates.'});
  const history = records.filter(r => r.id !== record.id && r.vessel === record.vessel &&
    r.areaId === record.areaId && (r.endDate || r.date) < record.date);
  if (history.length) {
    const prior = history.sort((a,b) => b.date.localeCompare(a.date))[0];
    observations.push({date:prior.date,text:'Earlier record for this vessel in the loaded data: ' + prior.title + '. This is a separate incident.',
      sourceIds:prior.observations?.[0]?.sourceIds || ['archive']});
  }
  steps.push({name:'Check available vessel history',detail:history.length ? `Found ${history.length} earlier record(s) for this vessel in the loaded cases.` : 'No earlier matching record in this limited case collection.'});
  const area = areas.find(a => a.id === record.areaId);
  const request = {
    ...record, searchDomains:rules[record.areaId].domains,
    searchQuery:`${area.name} ${record.vessel} ${record.date} ${findings.nextStep} Find only dated regulator or primary-source documents. Distinguish incidents and rule effective dates.`
  };
  let searchPromise;
  const getSearch = () => searchPromise ??= search(request);
  let liveHistoryPromise;
  const getHistory = () => liveHistoryPromise ??= lookupHistory(record);
  const agent = await model(record, {
    getEvent:() => ({ id:record.id, date:record.date, observations:findings.observations, unknowns:findings.unknowns }),
    getHistory:async () => ({earlierCases:history.map(r => ({date:r.date,title:r.title})), identityAndEvents:await getHistory()}),
    getRule:() => rule ? { text:rule.text, sources:rule.ids.map(id => documents[id]) } : {text:'No dated rule verified.'},
    searchSources:getSearch
  }, {allowedNextSteps:[findings.nextStep,'Ask an analyst to check the original source documents before proceeding.']});
  if (agent.mode === 'model' && agent.selectedNextStep) findings.nextStep = agent.selectedNextStep;
  const [found, liveHistory] = await Promise.all([getSearch(),getHistory()]);
  observations.push(...liveHistory.observations);
  const knownSources = new Map([...Object.entries(documents).map(([id,s]) => [id,{id,...s}]), ...liveHistory.sources.map(s => [s.id,s])]);
  const sources = [...new Set(observations.flatMap(o => o.sourceIds))].map(id => knownSources.get(id));
  steps.push({name:'Verify vessel identity',detail:liveHistory.detail});
  if (record.evidenceType === 'measured-gap') sources.push({id:'study',...documents.study});
  for (const item of found.sources || []) {
    if (!sources.some(s => s.url === item.url)) sources.push({id:'web-' + sources.length,...item});
  }
  steps.push({name:'Check independent sources',detail:found.detail});
  steps.push(...agent.steps);
  steps.push({name:'Prepare analyst brief',detail:findings.priority + ' · ' + findings.nextStep});
  return { ...listItem(record), ...findings, observations, steps, sources, mapPoints:record.mapPoints || [],
    candidateOrigin:origin, agent:{mode:agent.mode, detail:agent.detail, usedTools:agent.usedTools || []},
    search:{mode:found.mode, detail:found.detail}, generatedAt:new Date().toISOString() };
}
