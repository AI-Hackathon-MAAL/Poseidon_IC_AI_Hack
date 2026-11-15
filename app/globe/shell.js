const $ = id => document.getElementById(id);
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
  if (!value) return '—';
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

$('date-toggle').addEventListener('click', () => {
  const expanded = $('date-toggle').getAttribute('aria-expanded') === 'true';
  $('date-toggle').setAttribute('aria-expanded', String(!expanded));
  $('date-filters').hidden = expanded;
  $('date-toggle').lastElementChild.textContent = expanded ? '+' : '−';
});
$('help').addEventListener('click', () => $('about-dialog').showModal());
$('close-help').addEventListener('click', () => $('about-dialog').close());
$('close-brief').addEventListener('click', () => $('brief-dialog').close());
$('open-cases').addEventListener('click', () => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('case-feed').scrollIntoView({behavior: reduced ? 'instant' : 'smooth', block:'nearest'});
  $('case-search').focus({preventScroll:true});
});
document.addEventListener('keydown', event => {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey ||
      document.querySelector('dialog[open]') || event.target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  $('case-search').focus();
});
const timeline = $('timeline');
const replay = make('button', 'Replay agent trace', 'text-button');
replay.type = 'button';
replay.hidden = true;
replay.setAttribute('aria-controls', 'timeline');
const progress = make('span', '', 'trace-progress');
progress.setAttribute('role', 'status');
timeline.before(replay, progress);
let replayTimer;
function stopReplay() {
  clearInterval(replayTimer);
  replay.disabled = false;
}
replay.addEventListener('click', () => {
  const steps = Array.from(timeline.querySelectorAll('.step'));
  if (!steps.length) return;
  stopReplay();
  replay.disabled = true;
  steps.forEach(step => { step.hidden = true; });
  let shown = 0;
  function reveal() {
    steps[shown++].hidden = false;
    progress.textContent = 'Step ' + shown + ' of ' + steps.length;
    if (shown === steps.length) stopReplay();
  }
  replayTimer = setInterval(reveal, 700);
  reveal();
});
$('brief-dialog').addEventListener('close', stopReplay);
async function loadReportRenderer() {
  const {renderAgentReport} = await import('./agent-report.mjs');
  return (record, catalog) => {
    stopReplay();
    renderAgentReport(record, catalog, {date});
    replay.hidden = !timeline.querySelector('.step');
    progress.textContent = '';
  };
}
import('./workspace.mjs').then(({startWorkspace}) => {
  startWorkspace({$, make, date, safeLink, loadReportRenderer});
}).catch(() => {
  $('data-mode').textContent = 'Workspace unavailable';
  $('case-title').textContent = 'Unable to open the investigation workspace';
  $('cases').replaceChildren(make('p', 'Reload the page to try again.', 'queue-empty'));
});
