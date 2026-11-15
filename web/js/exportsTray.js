// Exports panel: a button in the top bar's global cluster (operators and up) that shows every export the
// server still knows about — waiting in the queue, running, finished, failed — from any page, and after a
// reload or from another browser. The server runs exports one at a time in request order (app/export.py), so
// a long batch keeps going after the tab that started it is closed; this is where you find it again, cancel
// it, or download it.
//
// One poller for the whole app, however many bars exist (each view renders its own): every 2 s while
// something is queued or running, every 30 s otherwise, and not at all while the tab is hidden. The button is
// hidden when there is nothing to show.
import { api, getJSON } from './api.js';
import { esc, icon, openPopover, toast } from './ui.js';
import { knownTzOffset } from './dvrtime.js';
import { ACTIVE, camerasText, rangeText as rangeTextAt, sortJobs, statusText } from './exportjobs.js';

const FAST_MS = 2000, SLOW_MS = 30000;

let jobs = [];
let seen = null;            // id -> state at the last poll (null until the first one, so old jobs don't toast)
let timer = 0;
let started = false;
let menu = null;            // the open popover's content element, if any

export function exportsButtonHTML() {
  return `<button class="btn icon ghost gbtn xj-btn" data-g="exports" title="Exports" aria-label="Exports" aria-haspopup="true" hidden>${icon('download')}<span class="xj-count" hidden></span></button>`;
}

export function wireExports(root) {
  const btn = root.querySelector('[data-g=exports]');
  if (!btn) return;
  btn.addEventListener('click', () => openTray(btn));
  paintButtons();
  if (!started) {
    started = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    window.addEventListener('se-exports-changed', () => poll());
    poll();
  }
}

const active = () => jobs.filter((j) => ACTIVE.has(j.state));

async function poll() {
  clearTimeout(timer);
  if (document.hidden) return;
  try {
    jobs = await getJSON('/api/export');
    announce();
    paintButtons();
    if (menu?.isConnected) paintTray(); else menu = null;
  } catch { /* signed out, or a blip: the next poll retries */ }
  timer = setTimeout(poll, active().length ? FAST_MS : SLOW_MS);
}

/** A toast when an export this browser saw waiting or running finishes — you may be on another page by now. */
function announce() {
  const now = Object.fromEntries(jobs.map((j) => [j.id, j.state]));
  if (seen) {
    for (const j of jobs) {
      if (!ACTIVE.has(seen[j.id]) || ACTIVE.has(j.state)) continue;
      if (j.state === 'done') toast(`Export ready — ${what(j)}`, 'ok', 7000, { onClick: () => download(j) });
      else if (j.state === 'error') toast(`Export failed — ${what(j)}`, 'bad', 7000);
    }
  }
  seen = now;
}

function paintButtons() {
  const n = active().length;
  document.querySelectorAll('[data-g=exports]').forEach((b) => {
    b.hidden = jobs.length === 0;
    b.classList.toggle('busy', n > 0);
    b.title = n ? `Exports — ${n} in progress` : 'Exports';
    b.setAttribute('aria-label', b.title);
    const c = b.querySelector('.xj-count');
    c.hidden = n === 0;
    c.textContent = n ? String(n) : '';
  });
}

const what = (j) => camerasText(j);
const rangeText = (j) => rangeTextAt(j, knownTzOffset());

// -------------------------------------------------------------------------------------------------- panel
function download(j) {
  const a = document.createElement('a');
  a.href = `/api/export/${encodeURIComponent(j.id)}/download`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openTray(btn) {
  const el = openPopover(btn, '<div class="notif xj"><div class="notif-head">Exports</div><div class="notif-body xj-body" aria-live="polite"></div><div class="xj-foot">Exports run one at a time and are kept for 2 hours.</div></div>', { className: 'notif-pop xj-pop', onClose: () => { menu = null; } });
  if (!el) return;
  menu = el;
  el.addEventListener('click', onTrayClick);
  paintTray();
  poll();
}

async function onTrayClick(e) {
  const b = e.target.closest('[data-xj]');
  if (!b) return;
  const j = jobs.find((x) => x.id === b.dataset.id);
  if (!j) return;
  if (b.dataset.xj === 'download') { download(j); return; }
  if (b.dataset.xj === 'cancel') {
    b.disabled = true;
    try { await api.cancelExport(j.id); } catch (err) { toast(err.message || "Couldn't cancel that export", 'bad'); }
    poll();
  }
}

function paintTray() {
  const body = menu?.querySelector('.xj-body');
  if (!body) return;
  if (!jobs.length) { body.innerHTML = '<div class="notif-empty">No exports yet. Make one from Playback.</div>'; return; }
  const now = Date.now();
  body.innerHTML = sortJobs(jobs).map((j) => {
    const live = ACTIVE.has(j.state);
    const tone = j.state === 'done' ? 'ok' : (j.state === 'error' || j.state === 'interrupted') ? 'bad' : live ? 'live' : 'off';
    const bar = j.state === 'running'
      ? `<div class="xj-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Number.isFinite(j.percent) ? j.percent : 0}" aria-label="Export progress"><i style="width:${Number.isFinite(j.percent) ? j.percent : 0}%"></i></div>` : '';
    const id = esc(j.id);
    const act = j.state === 'done' && Date.parse(j.expires_utc) > now
      ? `<button class="btn sm" data-xj="download" data-id="${id}">${icon('download')} Download</button>`
      : (j.state === 'queued' || j.state === 'running')
        ? `<button class="btn sm ghost" data-xj="cancel" data-id="${id}">Cancel</button>` : '';
    return `<div class="xj-item ${tone}">
      <span class="dot ${tone === 'ok' ? 'armed' : tone === 'live' ? 'wait' : tone === 'bad' ? 'off' : ''}"></span>
      <div class="xj-main"><b>${esc(camerasText(j))}</b><small>${esc(rangeText(j))}${j.operator ? ` · ${esc(j.operator)}` : ''}</small>
        <small class="xj-state">${esc(statusText(j, now))}</small>${bar}</div>
      ${act ? `<div class="xj-act">${act}</div>` : ''}</div>`;
  }).join('');
}
