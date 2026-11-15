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
async function loadBackendStatus() {
  const box = $('backend-status-box');
  if (!box) return;
  box.replaceChildren(make('div', 'Checking agent runtime…'));
  try {
    const res = await fetch('/api/status', {cache: 'no-store'});
    const s = await res.json();
    box.replaceChildren(
      make('div', `Agent runtime · ${s.mode === 'live_cloud' ? 'Live cloud APIs' : 'Hybrid snapshot mode'}`),
      make('div', `Integrations · GFW ${s.gfw_live ? 'live' : 'snapshot'} · Linkup ${s.linkup_live ? 'live' : 'cached'} · Databricks ${s.databricks_live ? s.databricks_endpoint || 'live' : 'local fallback'}`),
      make('div', `Dataset · ${s.n_mpas} areas · ${s.n_cases} cases (${s.n_complete} completed, ${s.n_llm_briefs} LLM briefs)`)
    );
    if (s.databricks_live) {
      const syncBtn = make('button', 'Sync snapshot from Databricks ↻', 'text-button');
      syncBtn.type = 'button';
      syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing from Databricks…';
        try {
          const r = await fetch('/api/sync-databricks', {method: 'POST'});
          const body = await r.json();
          if (!r.ok) throw new Error(body.error || 'Sync failed');
          syncBtn.textContent = 'Synced from Databricks ✓';
          $('refresh-export')?.click();
        } catch (err) {
          syncBtn.textContent = err?.message || 'Databricks sync failed';
        } finally {
          syncBtn.disabled = false;
        }
      });
      const wrap = make('div');
      wrap.append(syncBtn);
      box.append(wrap);
    }
  } catch {
    box.replaceChildren(make('div', 'Agent runtime status unavailable.'));
  }
}
$('help').addEventListener('click', () => {
  $('about-dialog').showModal();
  loadBackendStatus();
});
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
function renderReport(record, catalog) {
  stopReplay();
  renderSnapshotBrief(record, catalog);
  replay.hidden = !timeline.querySelector('.step');
  progress.textContent = '';
}
import('./workspace.mjs').then(({startWorkspace}) => {
  startWorkspace({$, make, date, safeLink, renderReport});
}).catch(() => {
  $('data-mode').textContent = 'Workspace unavailable';
  $('case-title').textContent = 'Unable to open the investigation workspace';
  $('cases').replaceChildren(make('p', 'Reload the page to try again.', 'queue-empty'));
});
