// The one top bar every screen uses (redesign v2) — replaces the old global header + per-view sub-bars.
// Matches the design boards: Live is home (brand mark + title + its own controls + the global cluster on the
// right); every other screen leads with a back chevron to Live and carries its own context controls. Each
// view renders its own bar inside its own root (so a fullscreened view keeps it — Playback floats its bar
// over the video in fullscreen), then calls wireBar() once.
import { authApi, getJSON } from './api.js';
import { avatarInner as personAvatar } from './avatar.js';
import { closePopover, esc, icon, openPopover, toast } from './ui.js';

/**
 * @param o.lead     'brand' (Live, home) or 'back'
 * @param o.title    screen title (plain text, escaped here)
 * @param o.sub      optional subtitle line under the title (HTML — callers escape their own data)
 * @param o.after    HTML right after the title block (e.g. Live's camera-count pill)
 * @param o.context  HTML for the left-hand context controls (layout picker, date stepper, search field…)
 * @param o.actions  HTML for the right-hand controls
 * @param o.size     'headline' (default, 16px) or 'title' (24px — Settings/Events/Account per the boards)
 */
let navigationContext;
export function configureNavigation(ctx) { navigationContext = ctx; }
const destinations = [['live','grid4','Live'],['playback','calendar','Playback'],['events','walk','Events'],['settings','gear','Settings']];
export function destinationHTML(ctx, className = 'app-destinations') {
  const selected = location.hash.split('/')[1] || 'live';
  const visible = destinations.filter(([id]) => !ctx.tvMode?.() || ctx.can('operator') || id === 'live' || id === 'settings');
  return `<nav class="${className}" aria-label="Main">${visible.map(([id,ic,label]) => `<a class="app-dest" href="#/${id}" data-tab="${id}" ${id === selected || id === 'events' && selected === 'search' ? 'aria-current="page"' : ''} ${['playback','events'].includes(id) && !ctx.can('operator') ? 'data-locked="true"' : ''}>${icon(ic)}<span>${label}</span></a>`).join('')}</nav>`;
}

export function barHTML(o) {
  const global = navigationContext && o.title !== 'Export clip';
  const actions = o.actions || '';
  const lead = o.lead === 'back'
    ? `<button class="btn icon ghost bar-back" data-bar="back" title="Back to Live" aria-label="Back to Live">${icon('left')}</button>`
    : '<a class="bar-brand" href="#/live" aria-label="Sentinel Eye — Live"><span class="brand-mark"></span></a>';
  return `<header class="topbar appbar${o.size === 'title' ? ' big' : ''}${o.cls ? ' ' + o.cls : ''}">
    ${lead}
    <div class="bar-title"><h1>${esc(o.title)}</h1>${o.sub ? `<div class="bar-sub">${o.sub}</div>` : ''}</div>
    ${o.after || ''}
    ${o.context ? `<div class="bar-ctx">${o.context}</div>` : ''}
    <span class="spacer"></span>
    ${actions ? `<div class="bar-actions bar-page-actions">${actions}</div>` : ''}
    ${global ? destinationHTML(navigationContext) : ''}
    ${global ? `<div class="bar-actions bar-global-actions">${globalActionsHTML(navigationContext)}</div>` : ''}
  </header>`;
}

/** Back chevron goes home (Live). Global cluster buttons are wired by wireGlobal(). */
export function wireBar(root, ctx, { back = '#/live' } = {}) {
  wireGlobal(root, ctx);
  const backButton = root.querySelector('[data-bar=back]');
  const backLabel = back === 'history' ? 'Back' : back === '#/settings' ? 'Back to Settings' : 'Back to Live';
  if (backButton) { backButton.title = backLabel; backButton.setAttribute('aria-label', backLabel); }
  // back: a hash, or 'history' — return to wherever the user came from (Account is reached from several
  // places), falling back to Live on a fresh tab with nothing behind it.
  root.querySelector('[data-bar=back]')?.addEventListener('click', () => {
    const prev = ctx.prevHash?.();
    ctx.go(typeof back === 'function' ? back() : back !== 'history' ? back : prev && prev !== location.hash ? prev : '#/live');
  });
}

// ------------------------------------------------------------------------------------------------- global
// The right-hand cluster on Live (the boards' search / notifications / settings / avatar, plus one calendar
// icon for Playback — the only destination the Live board's bar didn't give its own way in). Review
// screens a viewer account can't open are shown locked with an explanation, never hidden (States board:
// "shown, not hidden, so nobody wonders why a tab is missing").
const BELL_SEEN_KEY = 'sentinel-eye-bell-seen';
const KIND_LABEL = { motion: 'Motion', line: 'Line cross', intrusion: 'Intrusion', tamper: 'Tamper', videoloss: 'Video loss', bookmark: 'Bookmark' };
const KIND_DOT = { motion: 'var(--ev-motion)', line: 'var(--ev-line)', intrusion: 'var(--ev-line)', tamper: 'var(--tamper)', videoloss: 'var(--ev-videoloss)', bookmark: 'var(--ev-bookmark)' };

export function globalActionsHTML(ctx) {
  return `${ctx.can('operator') ? `<button class="btn icon ghost gbtn" data-g="bell" title="Notifications" aria-label="Notifications" aria-haspopup="true">${icon('bell')}<span class="bell-dot" hidden></span></button>` : ''}
    <button class="avatar" data-g="me" aria-haspopup="menu" aria-label="Account">${avatarInner(ctx)}</button>`;
}

function avatarInner(ctx) {
  const me = ctx.me();
  if (me?.via === 'session' && me.user) {
    const u = me.user;
    if (u.kind === 'device') return icon('tv');
    return personAvatar(u);
  }
  return icon('user');
}

export function wireGlobal(root, ctx) {
  if (root._globalWired === root.querySelector('[data-g=me]')) return;
  root._globalWired = root.querySelector('[data-g=me]');
  const locked = (what) => toast(`${what} needs an Operator or Admin account — ask an admin to change your role.`, 'bad', 5000);
  root.querySelector('[data-g=playback]')?.addEventListener('click', () => (ctx.can('operator') ? ctx.go('#/playback') : locked('Playback')));
  root.querySelector('[data-g=events]')?.addEventListener('click', () => (ctx.can('operator') ? ctx.go('#/events') : locked('Events')));
  const bell = root.querySelector('[data-g=bell]');
  if (bell) bell.addEventListener('click', () => openBell(bell, ctx));
  root.querySelector('[data-g=me]')?.addEventListener('click', (e) => openMe(e.currentTarget, ctx));
}

/** Lights the bell's dot when the event index has anything newer than the last time it was opened —
 * called by Live on its own event poll (it already fetches recent rows for the tile badges). */
export function markBell(root, rows) {
  const dot = root?.querySelector('.bell-dot');
  if (!dot || !rows?.length) return;
  let seen = 0;
  try { seen = +localStorage.getItem(BELL_SEEN_KEY) || 0; } catch { /* private mode */ }
  const newest = Math.max(...rows.map((r) => Date.parse(r.start_utc) || 0));
  dot.hidden = !(newest > seen);
}

const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? '' : 's'} ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hour${Math.round(s / 3600) === 1 ? '' : 's'} ago`;
  return `${Math.round(s / 86400)} day${Math.round(s / 86400) === 1 ? '' : 's'} ago`;
};

async function openBell(btn, ctx) {
  const menu = openPopover(btn, '<div class="notif"><div class="notif-head">Notifications</div><div class="notif-body"><div class="notif-empty"><span class="spin sm"></span></div></div><a class="notif-all" href="#/events">See all in Events</a></div>', { className: 'notif-pop' });
  if (!menu) return;
  try { localStorage.setItem(BELL_SEEN_KEY, String(Date.now())); } catch { /* private mode */ }
  btn.querySelector('.bell-dot').hidden = true;
  menu.querySelector('.notif-all').addEventListener('click', closePopover);
  const body = menu.querySelector('.notif-body');
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = (await getJSON(`/api/timeline/events?start_utc=${encodeURIComponent(since)}&limit=200`))
      .sort((a, b) => Date.parse(b.start_utc) - Date.parse(a.start_utc)).slice(0, 6);
    const cams = Object.fromEntries(ctx.settings().channels.map((c) => [c.channel, c]));
    if (!rows.length) { body.innerHTML = '<div class="notif-empty">Nothing in the last 24 hours.</div>'; return; }
    body.innerHTML = rows.map((r) => {
      const cam = cams[r.channel];
      const name = cam ? (cam.name || `Camera ${cam.channel}`) : `Channel ${r.channel}`;
      const t = Date.parse(r.start_utc);
      return `<button class="nitem" ${cam ? `data-cam="${esc(cam.id)}" data-t="${Math.round(t / 1000)}"` : 'disabled'}>
        <span class="dot" style="background:${KIND_DOT[r.kind] || 'var(--faint)'}"></span>
        <span><b>${esc(KIND_LABEL[r.kind] || r.kind)} · ${esc(name)}</b><small>${ago(t)}</small></span></button>`;
    }).join('');
    body.querySelectorAll('.nitem[data-cam]').forEach((b) => b.addEventListener('click', () => {
      closePopover();
      ctx.go(`#/playback/${b.dataset.cam}/${b.dataset.t}`);
    }));
  } catch (e) {
    body.innerHTML = `<div class="notif-empty">${esc(e.message || "Couldn't load recent events")}</div>`;
  }
}

function openMe(btn, ctx) {
  const me = ctx.me() || {};
  const u = me.user;
  let html;
  if (!me.auth_enabled) {
    html = `<div class="head"><b>Sign-in is off</b>Anyone who can reach this address has full access.</div>
      ${ctx.can('admin') ? `<a href="#/settings/security" role="menuitem">${icon('shield')} Turn on sign-in</a>` : ''}`;
  } else if (me.via === 'bypass') {
    html = `<div class="head"><b>Local network</b>Opened without signing in — this network is trusted.</div>
      <a href="/login?next=${encodeURIComponent(location.pathname + location.hash)}" role="menuitem">${icon('user')} Sign in</a>`;
  } else if (me.via === 'session' && u) {
    const person = u.kind === 'person';
    const name = person ? u.username : (u.label || 'This device');
    html = `<div class="head"><b>${esc(name)}</b>${esc(u.role[0].toUpperCase() + u.role.slice(1))}${person && u.has_totp ? ' · 2FA on' : ''}</div>
      ${person ? `<a href="#/account" role="menuitem">${icon('user')} Your account</a>` : ''}
      ${person && u.role === 'admin' ? `<a href="/pair" role="menuitem">${icon('tv')} Pair a TV or screen</a><a href="#/settings/security" role="menuitem">${icon('shield')} Users &amp; security</a>` : ''}
      <button data-m="logout" role="menuitem">${icon('logout')} Sign out${person ? '' : ' this device'}</button>`;
  } else {
    return;
  }
  const menu = openPopover(btn, `<div class="acct-menu" role="menu">${html}</div>`, { className: 'acct-pop' });
  menu?.querySelectorAll('a').forEach((a) => a.addEventListener('click', closePopover));
  menu?.querySelector('[data-m=logout]')?.addEventListener('click', async () => {
    closePopover();
    try { await authApi.logout(); } finally { location.assign('/login'); }
  });
}

// --------------------------------------------------------------------------------------------- tab bar
// Phones only (CSS shows it ≤640px): the Mobile board's glass bottom tab bar. Lives in the shell, outside
// every view, so it survives view swaps; main.js's route() keeps aria-current in sync.
export function tabBarHTML(ctx) {
  const op = ctx.can('operator');
  const tab = (n, ic, label, lockedTab) => `<a class="tab${lockedTab ? ' locked' : ''}" data-tab="${n}" href="#/${n}">${icon(ic)}<span>${label}</span></a>`;
  return `<nav class="tabbar" aria-label="Main">${tab('live', 'grid4', 'Live')}${tab('playback', 'calendar', 'Playback', !op)}${tab('events', 'walk', 'Events', !op)}${tab('settings', 'gear', 'Settings')}</nav>`;
}
