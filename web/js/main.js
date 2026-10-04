// App shell: hash router (#/live[/id], #/settings/<tab>), theme, clock.
import { api, authApi, authHooks, signInAgain } from './api.js';
import { AccountView, openAccount } from './account.js';
import { installTvNav } from './tvnav.js';
import { LiveView } from './live.js';
import { PlaybackView } from './playback.js';
import { EventsView } from './events.js';
import { SettingsView } from './settings.js';
import { esc, icon, toast } from './ui.js';
import { tabBarHTML } from './bar.js';
import { layoutIds } from './layouts.js';
import { fetchTzOffset } from './dvrtime.js';

const state = { settings: null, me: null, view: null, kind: null, hash: '#/live' };
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };
const can = (role) => (ROLE_RANK[state.me?.role] ?? -1) >= ROLE_RANK[role];
// Sections that need more than watching live (enforced by the server; this only hides what would 403).
const SECTION_ROLE = { playback: 'operator', events: 'operator', search: 'operator' };
const app = document.getElementById('app');

// Matches --bg in app.css exactly (dark/light) — kept as its own small map rather than reading the CSS
// variable at call time, since the value is needed before layout/paint on the very first call.
function applyTheme(t) {
  // A TV in TV mode follows its own appearance (dark unless chosen otherwise), not the synced theme: a
  // TV browser often reports a light preference, which turned everything around the video light.
  if (getTvMode()) { const tv = getTvTheme(); t = tv === 'auto' ? null : tv; }
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  else document.documentElement.removeAttribute('data-theme');
  syncStatusColor();
}

// The strip behind the status bar (#statusbar, app.css) takes the colour of whatever sits just beneath it —
// a glass bar composited over what's behind it, a solid large-title bar, Focus's black — so the status bar
// always reads as part of the screen below. The OS's own tint (the theme-color meta tag, which iOS's status
// bar and installed-app title bars read, not the page's CSS) is kept the same colour.
const parseColor = (c) => {
  let m = c.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  m = c.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);   // what color-mix() computes to
  if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] === undefined ? 1 : +m[4]];
  return null;
};
/** The colour an element actually shows: its background, composited over its ancestors' until opaque. */
function shownColor(el) {
  const layers = [];
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    const c = parseColor(getComputedStyle(e).backgroundColor);
    if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
  }
  if (!layers.length || layers[layers.length - 1][3] < 1) layers.push(parseColor(getComputedStyle(document.body).backgroundColor) || [0, 0, 0, 1]);
  let [r, g, b] = layers.pop();
  while (layers.length) { const [r2, g2, b2, a] = layers.pop(); r = r2 * a + r * (1 - a); g = g2 * a + g * (1 - a); b = b2 * a + b * (1 - a); }
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}
let statusColor = '';
function syncStatusColor() {
  const sb = document.getElementById('statusbar');
  if (!sb || !parseColor(getComputedStyle(document.body).backgroundColor)?.[3]) return;   // stylesheet not applied yet
  const h = sb.getBoundingClientRect().height;
  // What's just below the strip, ignoring a dialog's backdrop (app.css dims the strip with it instead).
  const below = document.elementsFromPoint(innerWidth / 2, h + 2).find((e) => e !== sb && !e.closest('#modal-root .scrim, #toasts, #notifs'));
  if (below) document.documentElement.style.setProperty('--statusbar-now', shownColor(below));
  const c = shownColor(sb);
  if (c !== statusColor) { statusColor = c; document.querySelector('meta[name=theme-color]')?.setAttribute('content', c); }
}
// Re-check when the screen under it changes: a route, a layer opening or closing, a resize (batched, ~once a frame).
const STATUS_LAYERS = '.topbar, .focus, .replay-overlay, .scrim, .enh2, .xp';
let statusRaf = 0;
const queueStatus = () => { if (!statusRaf) statusRaf = setTimeout(() => { statusRaf = 0; syncStatusColor(); }, 16); };
new MutationObserver((records) => {
  if (records.some((r) => [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1 && (n.matches(STATUS_LAYERS) || n.querySelector?.(STATUS_LAYERS))))) queueStatus();
}).observe(document.body, { childList: true, subtree: true });
addEventListener('load', queueStatus);
addEventListener('resize', queueStatus);
addEventListener('hashchange', () => setTimeout(queueStatus, 50));
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (getTvMode() || !(state.settings?.display.theme === 'dark' || state.settings?.display.theme === 'light')) applyTheme(state.settings?.display.theme);
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
  if (state.settings) applyTheme(state.settings.display.theme);
}
setTvMode(getTvMode());   // apply before first paint of the shell below
const TV_THEME_KEY = 'sentinel-eye-tv-theme';
function getTvTheme() { try { const v = localStorage.getItem(TV_THEME_KEY); return v === 'light' || v === 'auto' ? v : 'dark'; } catch { return 'dark'; } }
function setTvTheme(v) {
  try { localStorage.setItem(TV_THEME_KEY, v); } catch { /* private mode */ }
  applyTheme(state.settings?.display.theme);
}

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

// Whether the live view is showing channel-zero's full-screen Overview (Settings > Connection) instead of
// the camera grid, on THIS browser — redesign v2: one on/off state and one button (was two: a separate
// "add it to the grid" toggle plus a second "view it alone" toggle). Off by default everywhere except TV
// mode, which always shows it regardless of this flag (see LiveView.chan0Displayed): a phone or laptop
// shouldn't jump into Overview just because someone turned it on for the TV down the hall.
const OVERVIEW_ON_KEY = 'sentinel-eye-overview-on';
function getOverviewOn() { try { return localStorage.getItem(OVERVIEW_ON_KEY) === '1'; } catch { return false; } }
function setOverviewOn(v) { try { localStorage.setItem(OVERVIEW_ON_KEY, v ? '1' : '0'); } catch { /* private mode */ } }

const ctx = {
  settings: () => state.settings,
  me: () => state.me,
  prevHash: () => state.prev,
  can,
  async refreshMe() { state.me = await authApi.me(); return state.me; },
  applyTheme,
  tvMode: getTvMode,
  tvTheme: getTvTheme,
  setTvTheme,
  setTvMode,
  armTvFullscreen,
  consumeTvFullscreen,
  tvQuality: getTvQuality,
  setTvQuality,
  tvLayout: getTvLayout,
  setTvLayout,
  overviewOn: getOverviewOn,
  setOverviewOn,
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
  // No global header (redesign v2): every screen renders its own bar via bar.js, matching the design
  // boards (Live is home with the global cluster; everything else leads with a back chevron). The phone tab
  // bar is the one piece of chrome that outlives view swaps, so it lives here.
  app.innerHTML = `<div id="view" style="flex:1;min-height:0;display:flex;flex-direction:column;position:relative"></div>${tabBarHTML(ctx)}`;
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
  if (state.hash && state.hash !== hash) state.prev = state.hash;
  state.hash = hash;
  const host = document.getElementById('view');
  const navSection = section === 'search' ? 'events' : section;
  document.querySelectorAll('.tabbar .tab').forEach((a) => (a.dataset.tab === navSection ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (section === 'account') {
    if (state.kind !== 'account') { state.view?.destroy(); state.view = new AccountView(host, ctx); state.kind = 'account'; }
    return;
  }

  if (section === 'settings') {
    if (state.kind === 'settings') { state.view.setTab(arg); return; }
    state.view?.destroy();
    state.view = new SettingsView(host, ctx, arg);
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
  installTvNav();   // arrows move focus spatially in TV mode (a remote has no pointer)
  // Who's asking decides what the shell shows, so this comes first. Sign-in off = an admin, as always.
  try { state.me = await authApi.me(); } catch { state.me = { auth_enabled: false, via: 'none', role: 'admin', user: null }; }
  if (state.me.auth_enabled && state.me.via === 'anon') { signInAgain(); return; }   // e.g. a cached shell from the service worker
  authHooks.needs2fa = () => { if (!document.querySelector('#modal-root .dialog')) openAccount(ctx, { force2fa: true }); };
  document.documentElement.classList.toggle('role-viewer', !can('operator'));   // hides review-only buttons (app.css)
  shell();
  if (state.me.limited) { openAccount(ctx, { force2fa: true }); return; }
  if (can('operator')) fetchTzOffset();   // remembered, so Playback and Events never wait on it later
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
  setTimeout(queueStatus, 300);   // the first screen is drawn: match the status-bar strip to it
}

// A backgrounded installed app (iOS home-screen PWA especially — see Tile.resume's own comment) loses its
// live connections well before anything else notices, so the picture can go black for a while and quietly
// self-heal — jarring, and worse than it needs to be, since we already know exactly when you're looking at
// it again. Whichever view is open gets first refusal on handling that; only LiveView does right now.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) state.view?.resume?.();
});

boot();
