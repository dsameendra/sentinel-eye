// App shell: top bar, hash router (#/live[/id], #/settings/<tab>), theme, clock.
import { api } from './api.js';
import { LiveView } from './live.js';
import { SettingsView } from './settings.js';
import { esc, icon, toast } from './ui.js';

const state = { settings: null, view: null, kind: null, hash: '#/live' };
const app = document.getElementById('app');

function applyTheme(t) {
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  else document.documentElement.removeAttribute('data-theme');
}

const ctx = {
  settings: () => state.settings,
  applyTheme,
  go: (h) => { location.hash = h; },
  saveDisplay: (d) => api.saveDisplay(d),
  async saveAll(draft) {
    const saved = await api.saveSettings(draft);
    state.settings = saved;
    applyTheme(saved.display.theme);
    return saved;
  },
};

function shell() {
  app.innerHTML = `<header class="topbar">
      <div class="brand"><div class="brand-mark"></div><span>Sentinel Eye</span></div>
      <nav class="nav" aria-label="Main"><a href="#/live" data-n="live">${icon('live')}<span>Live</span></a><a href="#/settings" data-n="settings">${icon('settings')}<span>Settings</span></a></nav>
      <div class="spacer"></div>
      <div class="tools"><span class="clock" id="clock"></span></div></header>
    <div id="view" style="flex:1;min-height:0;display:flex;flex-direction:column;position:relative"></div>`;
  const tick = () => { const c = document.getElementById('clock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour12: false }); };
  tick(); setInterval(tick, 1000);
}

async function route() {
  const hash = location.hash || '#/live';
  const [, section = 'live', arg] = hash.split('/');
  // leaving settings with unsaved edits?
  if (state.kind === 'settings' && section !== 'settings' && state.view?.beforeLeave && !(await state.view.beforeLeave())) {
    history.replaceState(null, '', state.hash);
    return;
  }
  state.hash = hash;
  const host = document.getElementById('view');
  document.querySelectorAll('.nav a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.n === section));
  document.querySelectorAll('.nav a[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));

  if (section === 'settings') {
    if (state.kind === 'settings') { state.view.setTab(arg || 'connection'); return; }
    state.view?.destroy();
    state.view = new SettingsView(host, ctx, arg || 'connection');
    state.kind = 'settings';
    return;
  }
  if (state.kind !== 'live') {
    state.view?.destroy();
    state.view = new LiveView(host, ctx);
    state.kind = 'live';
  }
  state.view.route(arg || null);
}

async function boot() {
  shell();
  try {
    state.settings = await api.settings();
  } catch (e) {
    document.getElementById('view').innerHTML = `<div class="center-card"><h2>Can't reach the server</h2><p>${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Retry</button></div>`;
    return;
  }
  applyTheme(state.settings.display.theme);
  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/live';
  route();
}

boot();
