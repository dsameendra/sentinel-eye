// App shell: top bar, hash router (#/live[/id], #/settings/<tab>), theme, clock.
import { api, authApi, authHooks, signInAgain } from './api.js';
import { openAccount } from './account.js';
import { LiveView } from './live.js';
import { PlaybackView } from './playback.js';
import { EventsView } from './events.js';
import { SettingsView } from './settings.js';
import { closePopover, esc, icon, openPopover, toast } from './ui.js';
import { layoutIds } from './layouts.js';

const state = { settings: null, me: null, view: null, kind: null, hash: '#/live' };
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };
const can = (role) => (ROLE_RANK[state.me?.role] ?? -1) >= ROLE_RANK[role];
// Sections that need more than watching live (enforced by the server; this only hides what would 403).
const SECTION_ROLE = { playback: 'operator', events: 'operator', search: 'operator' };
const app = document.getElementById('app');

// Matches --bg in app.css exactly (dark/light) — kept as its own small map rather than reading the CSS
// variable at call time, since the value is needed before layout/paint on the very first call.
const THEME_BG = { dark: '#0b0e13', light: '#f3f5f8' };
function applyTheme(t) {
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  else document.documentElement.removeAttribute('data-theme');
  // Installed-app chrome (iOS status bar tint, Android/desktop PWA title bar) reads this meta tag, not the
  // page's own CSS — manifest.json's theme_color only covers the OS's default-theme guess before this JS
  // runs, and can't follow "auto" or an explicit override at all, so this keeps it in sync with whichever
  // theme is actually showing, the same way any other themed chrome in this app already does.
  const effective = (t === 'dark' || t === 'light') ? t : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', THEME_BG[effective]);
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (!(state.settings?.display.theme === 'dark' || state.settings?.display.theme === 'light')) applyTheme(null);
});

// TV mode: a big-text, remote-friendly UI mode for browsing on a smart TV's browser (Tizen etc). Kept as a
// per-browser localStorage flag rather than part of the synced Settings — this server is watched from
// several physically different screens at once (a laptop AND a TV in the same house, per the feature
// request), and a TV-sized UI is a property of the screen you're looking at, not something that should
// change what a laptop sees the moment someone flips it on for the TV in the other room.
const TV_MODE_KEY = 'sentinel-eye-tv-mode';
function getTvMode() { try { return localStorage.getItem(TV_MODE_KEY) === '1'; } catch { return false; } }
function setTvMode(on) {
  try { localStorage.setItem(TV_MODE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  document.documentElement.classList.toggle('tv-mode', on);
}
setTvMode(getTvMode());   // apply before first paint of the shell below

// TV mode's own quality choice (grid + large view) — separate from the synced Settings > Display > quality
// picker for the same reason TV mode itself is local: SD-by-default is right for the TV's own decoder, not
// something a laptop watching the same server should inherit the instant someone flips TV mode on down the
// hall. Still the same Auto/SD/HD choice, just remembered per-browser, and it defaults to SD.
const TV_QUALITY_KEY = 'sentinel-eye-tv-quality';
function getTvQuality() { try { const v = localStorage.getItem(TV_QUALITY_KEY); return v === 'main' || v === 'auto' ? v : 'sub'; } catch { return 'sub'; } }
function setTvQuality(v) { try { localStorage.setItem(TV_QUALITY_KEY, v); } catch { /* private mode */ } }

// TV mode's own grid layout — same reasoning as tvQuality, but for memory rather than bandwidth: a TV's
// browser typically has far less RAM than a phone or laptop, and decoding a full wall of tiles at once
// (even at SD) is a real crash risk there, not just a lag one. Defaults to the single biggest, cheapest
// tile (1x1) rather than whatever grid the synced Settings > Display layout happens to be; picking a
// bigger one from the TV itself remembers that choice per-browser instead of reverting every visit.
const TV_LAYOUT_KEY = 'sentinel-eye-tv-layout';
function getTvLayout() { try { const v = localStorage.getItem(TV_LAYOUT_KEY); return layoutIds.includes(v) ? v : '1x1'; } catch { return '1x1'; } }
function setTvLayout(v) { try { localStorage.setItem(TV_LAYOUT_KEY, v); } catch { /* private mode */ } }

// One-shot signal from Settings' "go to TV mode now" confirm flow to the LiveView it's about to build:
// auto-request full screen this one time. A plain in-memory flag, not localStorage — it must NOT survive
// past the very next LiveView it reaches (a later plain visit/reload must never auto-fullscreen unasked).
let pendingTvFullscreen = false;
const armTvFullscreen = () => { pendingTvFullscreen = true; };
const consumeTvFullscreen = () => { const v = pendingTvFullscreen; pendingTvFullscreen = false; return v; };

// Whether channel-zero (Settings > Connection) shows in the live grid on THIS browser — off by default
// everywhere except TV mode, which always shows it regardless of this flag (see LiveView.chan0Displayed):
// a phone or laptop shouldn't gain an extra tile just because someone turned it on for the TV down the hall.
const CHAN0_VISIBLE_KEY = 'sentinel-eye-chan0-visible';
function getChan0Visible() { try { return localStorage.getItem(CHAN0_VISIBLE_KEY) === '1'; } catch { return false; } }
function setChan0Visible(v) { try { localStorage.setItem(CHAN0_VISIBLE_KEY, v ? '1' : '0'); } catch { /* private mode */ } }

const ctx = {
  settings: () => state.settings,
  me: () => state.me,
  can,
  async refreshMe() { state.me = await authApi.me(); paintWho(); return state.me; },
  applyTheme,
  tvMode: getTvMode,
  setTvMode,
  armTvFullscreen,
  consumeTvFullscreen,
  tvQuality: getTvQuality,
  setTvQuality,
  tvLayout: getTvLayout,
  setTvLayout,
  chan0Visible: getChan0Visible,
  setChan0Visible,
  go: (h) => { location.hash = h; },
  // For a view syncing its OWN url as its state changes (e.g. playback keeping the current position in the
  // hash) rather than navigating: replaces instead of pushing, so it doesn't fill browser history with
  // entries that all render the same view and make Back a no-op several times in a row.
  replace: (h) => { state.hash = h; history.replaceState(null, '', h); },
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
      <nav class="nav" aria-label="Main"><a href="#/live" data-n="live">${icon('live')}<span>Live</span></a>${can('operator') ? `<a href="#/playback" data-n="playback">${icon('video')}<span>Playback</span></a><a href="#/events" data-n="events">${icon('search')}<span>Events</span></a>` : ''}<a href="#/settings" data-n="settings">${icon('settings')}<span>Settings</span></a></nav>
      <div class="spacer"></div>
      <div class="tools"><span class="clock" id="clock"></span><span id="who"></span></div></header>
    <div id="view" style="flex:1;min-height:0;display:flex;flex-direction:column;position:relative"></div>`;
  const tick = () => {
    const c = document.getElementById('clock');
    if (!c) return;
    const now = new Date();
    const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const time = now.toLocaleTimeString([], { hour12: false });
    c.textContent = `${date} · ${time}`;
  };
  tick(); setInterval(tick, 1000);
}

/** Topbar account chip: who you are and the account menu, when sign-in is on. */
function paintWho() {
  const el = document.getElementById('who');
  const me = state.me;
  if (!el || !me?.auth_enabled) { if (el) el.innerHTML = ''; return; }
  if (me.via === 'bypass') {
    el.innerHTML = `<a class="who lan" href="/login?next=${encodeURIComponent(location.pathname + location.hash)}" title="Opened without signing in because you're on a trusted network">${icon('user')}<span>Local network</span><span class="role">· Sign in</span></a>`;
    return;
  }
  if (me.via !== 'session') { el.innerHTML = ''; return; }
  const u = me.user;
  const name = u.kind === 'device' ? (u.label || 'This device') : u.username;
  el.innerHTML = `<button class="who" aria-haspopup="menu">${icon(u.kind === 'device' ? 'monitor' : 'user')}<span>${esc(name)}</span><span class="role">${esc(u.role)}</span></button>`;
  el.querySelector('button').addEventListener('click', (e) => {
    const person = u.kind === 'person';
    const menu = openPopover(e.currentTarget, `<div class="acct-menu" role="menu">
      <div class="head"><b>${esc(name)}</b>${esc(u.role)}${person && u.has_totp ? ' · 2FA on' : ''}</div>
      ${person ? `<button data-m="account" role="menuitem">${icon('user')} Your account</button>` : ''}
      ${person && u.role === 'admin' ? `<a href="/pair" role="menuitem">${icon('monitor')} Pair a TV or screen</a><a href="#/settings/security" role="menuitem">${icon('shield')} Users &amp; security</a>` : ''}
      <button data-m="logout" role="menuitem">${icon('logout')} Sign out${person ? '' : ' this device'}</button></div>`, { className: 'acct-pop' });
    menu?.querySelector('[data-m=account]')?.addEventListener('click', () => { closePopover(); openAccount(ctx); });
    menu?.querySelectorAll('a').forEach((a) => a.addEventListener('click', closePopover));
    menu?.querySelector('[data-m=logout]').addEventListener('click', async () => {
      closePopover();
      try { await authApi.logout(); } finally { location.assign('/login'); }
    });
  });
}

async function route() {
  const hash = location.hash || '#/live';
  const [, section = 'live', arg, arg2] = hash.split('/');
  if (SECTION_ROLE[section] && !can(SECTION_ROLE[section])) {
    toast("Your account can watch live only; ask an admin for more access", 'bad');
    history.replaceState(null, '', '#/live');
    return route();
  }
  // leaving settings with unsaved edits?
  if (state.kind === 'settings' && section !== 'settings' && state.view?.beforeLeave && !(await state.view.beforeLeave())) {
    history.replaceState(null, '', state.hash);
    return;
  }
  state.hash = hash;
  const host = document.getElementById('view');
  const navSection = section === 'search' ? 'events' : section;
  document.querySelectorAll('.nav a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.n === navSection));
  document.querySelectorAll('.nav a[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));

  if (section === 'settings') {
    if (state.kind === 'settings') { state.view.setTab(arg || 'connection'); return; }
    state.view?.destroy();
    state.view = new SettingsView(host, ctx, arg || 'connection');
    state.kind = 'settings';
    return;
  }
  if (section === 'playback') {
    // the view updates the URL itself when the camera selection changes (ctx.go below); once we're already
    // in playback, that's a notification, not a request to rebuild — rebuilding would tear down live panes
    // mid-switch. A real navigation into playback from elsewhere in the app still builds fresh.
    if (state.kind === 'playback') return;
    state.view?.destroy();
    state.view = new PlaybackView(host, ctx, arg || null, arg2 || null);
    state.kind = 'playback';
    return;
  }
  if (section === 'events' || section === 'search') {   // 'search' kept as an alias for old links/bookmarks
    if (state.kind !== 'events') { state.view?.destroy(); state.view = new EventsView(host, ctx); state.kind = 'events'; }
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
  // Who's asking decides what the shell shows, so this comes first. Sign-in off = an admin, as always.
  try { state.me = await authApi.me(); } catch { state.me = { auth_enabled: false, via: 'none', role: 'admin', user: null }; }
  if (state.me.auth_enabled && state.me.via === 'anon') { signInAgain(); return; }   // e.g. a cached shell from the service worker
  authHooks.needs2fa = () => { if (!document.querySelector('#modal-root .dialog')) openAccount(ctx, { force2fa: true }); };
  document.documentElement.classList.toggle('role-viewer', !can('operator'));   // hides review-only buttons (app.css)
  shell();
  paintWho();
  if (state.me.limited) { openAccount(ctx, { force2fa: true }); return; }
  // Registered from the app shell (not inline in index.html) so it only ever runs after the real app has
  // loaded — irrelevant to whether the settings fetch below succeeds, so it doesn't block or gate on it.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    state.settings = await api.settings();
  } catch (e) {
    const view = document.getElementById('view');
    view.innerHTML = `<div class="center-card"><div class="cc-icon danger">${icon('alert')}</div><h2>Can't reach the server</h2><p>${esc(e.message)}</p><button class="btn primary" data-a="retry">Retry</button></div>`;
    view.querySelector('[data-a=retry]').addEventListener('click', () => location.reload());
    return;
  }
  applyTheme(state.settings.display.theme);
  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/live';
  route();
}

// A backgrounded installed app (iOS home-screen PWA especially — see Tile.resume's own comment) loses its
// live connections well before anything else notices, so the picture can go black for a while and quietly
// self-heal — jarring, and worse than it needs to be, since we already know exactly when you're looking at
// it again. Whichever view is open gets first refusal on handling that; only LiveView does right now.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) state.view?.resume?.();
});

boot();
