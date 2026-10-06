// Small UI helpers: escaping, icons, toasts, dialogs.
// Kept in this existing public entry module so anonymous clients work with older running servers.
// Preserve focusability for browsers without native inert (older TV engines).
export function disableInteraction(node) {
  const had = node.hasAttribute('inert');
  const aria = node.getAttribute('aria-hidden');
  const saved = [];
  if (!('inert' in node)) {
    node.querySelectorAll('a[href],button,input,select,textarea,[tabindex]').forEach(el => {
      saved.push([el, el.getAttribute('tabindex')]); el.tabIndex = -1;
    });
  }
  node.setAttribute('inert', '');
  node.setAttribute('aria-hidden', 'true');
  return () => {
    if (!had) node.removeAttribute('inert');
    aria === null ? node.removeAttribute('aria-hidden') : node.setAttribute('aria-hidden', aria);
    for (const [el, value] of saved) value === null ? el.removeAttribute('tabindex') : el.setAttribute('tabindex', value);
  };
}

// Shared viewport geometry. Rendering and streams remain owned by the current view.
const root = document.documentElement;
let frame = 0;
const bars = new Set();
const observer = new ResizeObserver(queue);
const inactive = new Map();
let currentLayer = null, restoreFocus = null;
export function compactLayout() {
  const touch = navigator.maxTouchPoints > 0 || matchMedia('(any-pointer: coarse)').matches || navigator.standalone === true;
  return innerWidth <= 640 || touch && innerHeight <= 540 && innerWidth > innerHeight && innerWidth <= 1100;
}
export function scopeLayers() {
  const layer = document.body._openPopover || document.querySelector('#modal-root > *') || document.querySelector('.ev-side.open')
    || [...document.querySelectorAll('.replay-overlay,.focus,.immersive')].at(-1);
  const next = new Set();
  if (layer) for (let node = layer; node?.parentElement && node !== document.body; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      // The filter sheet's backdrop remains clickable; a dialog over the sheet owns it instead.
      const backdrop = layer.matches('.ev-side.open') && sibling.matches('.ev-scrim');
      if (sibling !== node && !backdrop && !sibling.matches('#statusbar,#toasts,#notifs,script,style,link')) next.add(sibling);
    }
  }
  for (const [node, restore] of inactive) if (!next.has(node)) { restore(); inactive.delete(node); }
  if (layer !== currentLayer) {
    if (!currentLayer) restoreFocus = document.activeElement;
    currentLayer = layer;
    if (layer && !layer.contains(document.activeElement)) layer.querySelector('button:not([disabled]),input:not([disabled]),[tabindex="0"],a[href]')?.focus({ preventScroll: true });
    if (!layer && restoreFocus?.isConnected && !restoreFocus.closest('[inert]')) restoreFocus.focus({ preventScroll: true });
  }
  for (const node of next) if (!inactive.has(node)) inactive.set(node, disableInteraction(node));
}
function queue() { if (!frame) frame = requestAnimationFrame(update); }
function update() {
  frame = 0;
  const vv = window.visualViewport;
  const width = innerWidth, height = innerHeight;
  const compact = compactLayout();
  root.classList.toggle('compact-ui', compact);
  root.classList.toggle('short-ui', height <= 540);
  const keyboard = !!document.activeElement?.matches('input:not([type=range]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable]')
    && !!vv && height - vv.height > 140;
  root.classList.toggle('keyboard-open', keyboard);
  root.style.setProperty('--visual-height', `${vv?.height || height}px`);
  root.style.setProperty('--visual-top', `${vv?.offsetTop || 0}px`);
  const layers = [...document.querySelectorAll('.focus,.replay-overlay,.enh2,.xp,.immersive')];
  root.classList.toggle('viewer-open', !!layers.length || !!document.fullscreenElement);
  root.classList.toggle('cover-open', !!document.querySelector('.enh2,.xp,#modal-root > *'));
  const nav = document.querySelector('.tabbar');
  const shellBottom = document.getElementById('app')?.getBoundingClientRect().bottom ?? height;
  const footprint = nav && getComputedStyle(nav).display !== 'none' ? Math.max(0, shellBottom - nav.getBoundingClientRect().top + 8) : 0;
  root.style.setProperty('--nav-footprint', `${footprint}px`);
  scopeLayers();
  // Label existing table cells for compact cards without cloning inputs or replacing their bindings.
  document.querySelectorAll('table.tbl').forEach(table => {
    const headings = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    table.querySelectorAll('tbody tr:not(.adv)').forEach(row => [...row.children].forEach((cell, i) => {
      cell.dataset.label = headings[i] || cell.querySelector('input')?.getAttribute('aria-label') || 'Actions';
    }));
  });
  document.querySelectorAll('.topbar,.tabbar,.savebar').forEach(el => {
    if (!bars.has(el)) { bars.add(el); observer.observe(el); }
  });
  for (const el of bars) if (!el.isConnected) { observer.unobserve(el); bars.delete(el); }
  document.dispatchEvent(new Event('layoutchange'));
}
addEventListener('resize', queue);
matchMedia('(any-pointer: coarse)').addEventListener('change', queue);
window.visualViewport?.addEventListener('resize', queue);
window.visualViewport?.addEventListener('scroll', queue);
document.addEventListener('focusin', queue); document.addEventListener('focusout', queue);
document.addEventListener('viewerchange', queue);
new MutationObserver(records => {
  if (records.some(r => r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].some(n =>
    n.nodeType === 1 && (n.matches('.topbar,.tabbar,.savebar,.focus,.replay-overlay,.enh2,.xp,.scrim')
      || n.querySelector('.topbar,.tabbar,.savebar,.focus,.replay-overlay,.enh2,.xp,.scrim')))
    || r.type === 'attributes' && r.target.matches('.ev-side,.immersive,.focus,.replay-overlay,.menu')) ) queue();
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
new MutationObserver(queue).observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
queue();
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || !currentLayer) return;
  const list = [...currentLayer.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea,[tabindex="0"]')]
    .filter(el => el.getClientRects().length && !el.closest('[inert],[hidden]'));
  if (!list.length) return;
  if (e.shiftKey && document.activeElement === list[0]) { e.preventDefault(); list.at(-1).focus(); }
  else if (!e.shiftKey && document.activeElement === list.at(-1)) { e.preventDefault(); list[0].focus(); }
}, true);


// The Fullscreen API paints only the fullscreened element's own subtree (plus the "top layer") — #modal-
// root and #toasts are both direct children of <body> (web/index.html), siblings of #app, so the moment
// Playback or Live's focus view goes fullscreen (fullscreening a div inside #app, not <body> itself), any
// dialog or toast opened while fullscreen is active silently stops rendering, even though it opens fine and
// its own event listeners keep working — confirmed directly, not assumed (the bookmark dialog and the wand
// popover both still "worked" with nothing visible). Fixed once, centrally, by moving both containers into
// whichever element is currently fullscreened, and back to <body> when fullscreen ends — every call site
// (bookmarkDialog, confirmDialog, toast, openPopover below) just does getElementById and doesn't care where
// in the document that container currently lives.
document.addEventListener('fullscreenchange', () => {
  const target = document.fullscreenElement || document.body;
  const modalRoot = document.getElementById('modal-root'), toasts = document.getElementById('toasts');
  if (modalRoot) target.appendChild(modalRoot);
  if (toasts) target.appendChild(toasts);
});

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const P = {
  live: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  left: '<polyline points="15 18 9 12 15 6"/>', right: '<polyline points="9 18 15 12 9 6"/>',
  up: '<polyline points="18 15 12 9 6 15"/>', down: '<polyline points="6 9 12 15 18 9"/>',
  move: '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  plug: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
  video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>', pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  rewind: '<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 8 8 8"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M16 7l3 3M18.5 4.5l2 2"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 1-1h13.5a1 1 0 0 1 .8 1.6l-3.6 4.8 3.6 4.8a1 1 0 0 1-.8 1.6H5"/>',
  wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h.01M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
  crop: '<path d="M6.13 2 6 18a2 2 0 0 0 2 2h14"/><path d="M2 6.13 18 6a2 2 0 0 1 2 2v14"/>',
  flashlight: '<path d="M18 6c0 2-2 3-2 5v11a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V11c0-2-2-3-2-5a6 6 0 0 1 12 0Z"/><line x1="6" y1="6" x2="18" y2="6"/><line x1="12" y1="12" x2="12" y2="12"/>',
  calendar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/>',
  // Redesign v2 — taken from the design boards' own SVGs (24x24, line, 1.6 stroke via svg.i).
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 4-2 5-2 7h16c0-2-2-3-2-7Z"/><path d="M9.5 19a2.5 2.5 0 0 0 5 0"/>',
  // Centred on the 24-unit grid (the old one sat ~1px right of centre and read small next to its neighbours).
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  // A bracketed span of time — "pick a range to export" (crop meant the wrong thing on a timeline).
  // A figure in motion (motion events).
  // A walking pedestrian — Events (things that happened in front of a camera) and motion alerts.
  walk: '<circle cx="13" cy="4" r="1.75"/><path d="M7 21l3-4"/><path d="M16 21l-2-4-3-3 1-6"/><path d="M6 12l2-3 4-1 3 3 3 1"/>',
  motion: '<circle cx="13" cy="4" r="1.75"/><path d="M7 21l3-4"/><path d="M16 21l-2-4-3-3 1-6"/><path d="M6 12l2-3 4-1 3 3 3 1"/>',
  // Two arrows pointing in — leave full screen.
  collapse: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
  // A remote's direction pad — "the arrows".
  dpad: '<path d="m9 6 3-3 3 3"/><path d="m9 18 3 3 3-3"/><path d="m6 9-3 3 3 3"/><path d="m18 9 3 3-3 3"/><circle cx="12" cy="12" r="2"/>',
  excl: '<path d="M12 6.5v7"/><path d="M12 17.5h.01"/>',
  range: '<path d="M7 4H4v16h3"/><path d="M17 4h3v16h-3"/><path d="M9 12h6"/>',
  bookmark: '<path d="M19 21V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v16l7-4 7 4Z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  back2: '<path d="M11 19l-8-7 8-7v14Z"/><path d="M21 19l-8-7 8-7v14Z"/>',
  fwd2: '<path d="M13 19l8-7-8-7v14Z"/><path d="M3 19l8-7-8-7v14Z"/>',
  sparkle: '<path d="m12 3 1.9 4.9L19 10l-5.1 2.1L12 17l-1.9-4.9L5 10l5.1-2.1L12 3Z"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  overview: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="12" cy="12" r="3.4"/>',
  grid4: '<rect x="3" y="3" width="18" height="18" rx="4"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/>',
  heart: '<path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9Z"/>',
  offline: '<circle cx="12" cy="12" r="9"/><line x1="6" y1="6" x2="18" y2="18"/>',
  mic: '<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0M12 19v3"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  checkcircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  laptop: '<rect x="4" y="3" width="16" height="14" rx="2"/><line x1="4" y1="20" x2="20" y2="20"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2.4"/><line x1="11" y1="18.3" x2="13" y2="18.3"/>',
  tv: '<rect x="2" y="3" width="20" height="13" rx="1.6"/><path d="M9 20.5h6M12 16.5v4"/>',
  pencil: '<path d="M17.2 3.6a2.1 2.1 0 0 1 3 3L8.3 18.5l-4.3 1.2 1.2-4.3Z"/><path d="m15 5.8 3 3"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  clips: '<path d="M4 6h16M4 12h10M4 18h7"/>',
};
export const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;

/** @param opts.dot a colour for an event dot instead of the icon; opts.onClick makes the pill a button. */
export function toast(msg, kind = 'ok', ms = 4200, opts = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `${opts.dot ? `<span class="toast-dot" style="background:${opts.dot}"></span>` : icon(kind === 'ok' ? 'check' : 'excl')}<div>${esc(msg)}</div>`;
  host.prepend(t);   // newest on top, nearest the edge it drops from
  while (host.children.length > 3) host.lastElementChild.remove();
  const leave = () => { t.classList.add('out'); setTimeout(() => t.remove(), 320); };
  setTimeout(leave, ms);
  t.addEventListener('click', () => { leave(); opts.onClick?.(); });
  if (opts.onClick) t.classList.add('tappable');
}

/** Event notifications (a different job from toast(): something happened on a camera, worth a look) —
 * glass banners stacked under the top-right of the bar (top centre on a phone), each with a kind-coloured
 * glyph, title, body and, when there is one, a thumbnail of the picture at that moment. Tap to open;
 * hovering holds it; at most three. */
export function notify({ title, body = '', glyph = 'bell', color = 'var(--accent)', thumb = null, onClick = null, ms = 6500 }) {
  let host = document.getElementById('notifs');
  if (!host) { host = document.createElement('div'); host.id = 'notifs'; host.setAttribute('aria-live', 'polite'); }
  (document.fullscreenElement || document.body).append(host);
  const n = document.createElement('div');
  n.className = `notif-banner${onClick ? ' tappable' : ''}`;
  n.setAttribute('role', 'status');
  n.style.setProperty('--n-color', color);
  n.innerHTML = `<span class="nb-glyph">${icon(glyph)}</span>
    <div class="nb-text"><b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}</div>
    ${thumb ? `<img class="nb-thumb" src="${thumb}" alt="">` : ''}
    <button class="nb-close" aria-label="Dismiss">${icon('close')}</button>`;
  host.prepend(n);
  while (host.children.length > 3) host.lastElementChild.remove();
  let timer = 0;
  const leave = () => { clearTimeout(timer); n.classList.add('out'); setTimeout(() => n.remove(), 320); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(leave, ms); };
  n.addEventListener('mouseenter', () => clearTimeout(timer));
  n.addEventListener('mouseleave', arm);
  n.querySelector('.nb-close').addEventListener('click', (e) => { e.stopPropagation(); leave(); });
  n.addEventListener('click', () => { leave(); onClick?.(); });
  arm();
  return n;
}

/** Keeps Tab/Shift+Tab cycling within an open dialog instead of walking onto whatever's behind the scrim
 * (the topbar nav, tile controls) — found by audit, not assumed: neither confirmDialog nor bookmarkDialog
 * trapped focus even though both already set an initial focus target. */
function trapTab(e, container) {
  if (e.key !== 'Tab' || !container) return;
  const focusable = [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  root?._dispose?.();
}
export function modalRoot() {
  closePopover(); closeModal();
  return document.getElementById('modal-root');
}
export function confirmDialog({ title, body, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const root = modalRoot();
    root.innerHTML = `<div class="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3><p>${esc(body)}</p>
      <div class="row"><button class="btn" data-x="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-x="1">${esc(ok)}</button></div></div></div>`;
    const done = (v) => { root._dispose = null; root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(v); };
    root._dispose = () => { root._dispose = null; done(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } else trapTab(e, root.querySelector('.dialog')); };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) done(false); });
    root.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => done(b.dataset.x === '1')));
    root.querySelector('[data-x="1"]').focus();
  });
}

/** Small "bookmark this moment" dialog: title, note, severity. Resolves {title, note, severity} or null on cancel. */
export function bookmarkDialog({ subtitle = '' } = {}) {
  return new Promise((resolve) => {
    const root = modalRoot();
    root.innerHTML = `<div class="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-label="Add bookmark">
      <h3>${icon('flag')} Add bookmark</h3>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
      <div class="form" style="grid-template-columns:1fr">
        <div class="field"><label for="bm-title">Title</label><input id="bm-title" type="text" placeholder="What's happening" maxlength="120"></div>
        <div class="field"><label for="bm-note">Note (optional)</label><textarea id="bm-note" rows="3" maxlength="2000"></textarea></div>
        <div class="field"><span class="lbl" id="bm-sev-l">Severity</span><div class="seg bm-sev" role="radiogroup" aria-labelledby="bm-sev-l">
          ${[['info', 'Info'], ['warning', 'Warning'], ['critical', 'Critical']].map(([v, l], i) =>
            `<button type="button" role="radio" data-sev="${v}" aria-checked="${i === 0}" aria-pressed="${i === 0}"><span class="sev-dot ${v}"></span>${l}</button>`).join('')}
        </div></div>
      </div>
      <div class="row dialog-actions"><button class="btn" data-x="0">Cancel</button><button class="btn primary" data-x="1">${icon('flag')} Save bookmark</button></div></div></div>`;
    const done = (v) => { root._dispose = null; root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(v); };
    root._dispose = () => { root._dispose = null; done(null); };
    const submit = () => done({
      title: root.querySelector('#bm-title').value.trim(),
      note: root.querySelector('#bm-note').value.trim(),
      severity: root.querySelector('.bm-sev [aria-checked="true"]').dataset.sev,
    });
    root.querySelectorAll('.bm-sev button').forEach((b) => b.addEventListener('click', () => {
      root.querySelectorAll('.bm-sev button').forEach((x) => { const on = x === b; x.setAttribute('aria-checked', String(on)); x.setAttribute('aria-pressed', String(on)); });
    }));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && e.target.id === 'bm-title') submit();
      else trapTab(e, root.querySelector('.dialog'));
    };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) done(null); });
    root.querySelector('[data-x="0"]').addEventListener('click', () => done(null));
    root.querySelector('[data-x="1"]').addEventListener('click', submit);
    root.querySelector('#bm-title').focus();
  });
}

// Keyboard shortcuts reference (redesign v2) — the real bindings from live.js's key() and playback.js's
// _key(), copied here by hand rather than generated from them, so this is a snapshot of what's documented
// (and README.md's own table), not a live introspection of whichever handler happens to be bound. Keep the
// three in sync if a binding changes.
const SHORTCUT_GROUPS = [
  { title: 'Live view — grid', rows: [
    [['1', '–', '9'], 'Open that camera'],
    [['←', '→'], 'Previous / next page'],
    [['E'], 'Arrange mode on / off'],
    [['F'], 'Full screen'],
    [['Esc'], 'Leave arrange mode'],
  ] },
  { title: 'Live view — focus', rows: [
    [['←', '→'], 'Previous / next camera'],
    [['+', '–', '0'], 'Zoom in / out / reset'],
    [['S'], 'Snapshot'],
    [['B'], 'Bookmark this moment'],
    [['H'], 'Switch HD / SD'],
    [['F'], 'Full screen'],
    [['Esc'], 'Reset zoom, then back to the grid'],
  ] },
  { title: 'Instant replay', rows: [
    [['Space'], 'Play / pause'],
    [['Home'], 'Start over'],
    [['Esc'], 'Back to live'],
  ] },
  { title: 'Playback', rows: [
    [['Space'], 'Play / pause'],
    [[',', '.'], 'One frame back / forward'],
    [['Shift', '1', '2', '3'], 'Back 5 s / 10 s / 30 s'],
    [['Shift', '4', '5', '6'], 'Forward 5 s / 10 s / 30 s'],
    [['B'], 'Bookmark this moment'],
    [['F'], 'Full screen'],
  ] },
];

/** The "?" overlay — a read-only reference for Live and Playback shortcuts. No return value; just
 * shows until Escape, an outside click, or the close button. */
export function shortcutsDialog() {
  const root = modalRoot();
  const group = (g) => `<div class="card shortcuts-card"><h3>${esc(g.title)}</h3>${g.rows.map(([keys, label]) =>
    `<div class="shortcuts-row">${keys.map((k) => `<kbd class="key">${esc(k)}</kbd>`).join('')}<span class="shortcuts-label">${esc(label)}</span></div>`).join('')}</div>`;
  root.innerHTML = `<div class="scrim"><div class="dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <div class="row" style="justify-content:space-between;margin-bottom:4px"><h3 style="margin:0">${icon('layout')} Keyboard shortcuts</h3><button class="btn icon ghost" data-x="1" aria-label="Close">${icon('close')}</button></div>
    <p>Works on any Live or Playback screen.</p>
    <div class="shortcuts-grid">${SHORTCUT_GROUPS.map(group).join('')}</div>
    <p class="hint" style="margin:10px 0 0">On the Overview (Channel-zero), B bookmarks every camera at once.</p>
  </div></div>`;
  const done = () => { root._dispose = null; root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); };
  root._dispose = () => { root._dispose = null; done(); };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === '?') { e.stopPropagation(); done(); } else trapTab(e, root.querySelector('.dialog')); };
  document.addEventListener('keydown', onKey, true);
  root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) done(); });
  root.querySelector('[data-x="1"]').addEventListener('click', done);
  root.querySelector('[data-x="1"]').focus();
}

/** Opens a small popover menu anchored to `anchorEl`, appended to <body> so it's never clipped by an
 * ancestor's `overflow: hidden` (grid tiles, panes, etc. all clip — a menu positioned relative to an
 * element inside one gets cut off or renders garbled, which is what the live tile's enhance dropdown did
 * before this). Positioned in the viewport (not the DOM), clamped so it never runs off-screen, and closes
 * itself on an outside click or Escape. Returns the menu element in case the caller wants it (e.g. to
 * close it early on selection). At most one popover from this helper is open at a time. */
/** @param onClose called once when the popover goes away, however it's dismissed. */
export function openPopover(anchorEl, innerHTML, { className = '', align = 'right', onClose = null } = {}) {
  const already = document.body._openPopover;
  closePopover();
  if (already?._anchor === anchorEl) return null; // second click on the same button: treat as toggle-close
  const menu = document.createElement('div');
  menu.className = `menu popover-portal ${className}`;
  menu.innerHTML = innerHTML;
  // The Fullscreen API only paints the fullscreened element's own subtree (plus the "top layer") — a node
  // appended to <body> while e.g. Playback or Live's focus view is fullscreened silently never renders,
  // even though it opens and its listeners work fine. Confirmed directly: the wand popover's click handler
  // ran, the menu existed in the DOM, it just wasn't visible. Mount into the fullscreened element itself
  // when there is one.
  (document.fullscreenElement || document.body).appendChild(menu);
  // Anchored to its button for as long as it's open — re-placed whenever its size changes (a group
  // expanding or collapsing inside it), never left floating where it first opened. It opens below the
  // button, or above when there's more room there, and its height is capped to the room it has, so a tall
  // panel scrolls inside itself instead of running off the screen.
  let side = null;
  const place = () => {
    const edge = className.includes('cal-popover') && innerWidth <= 360 ? 0 : 12;
    menu.style.maxWidth = `calc(100vw - var(--safe-left,0px) - var(--safe-right,0px) - ${edge * 2}px)`;
    const r = anchorEl.getBoundingClientRect();
    const pwa = document.documentElement.classList.contains('ios-pwa');
    const header = anchorEl.closest('.topbar, .focus-bar') || document.fullscreenElement?.querySelector('.topbar, .focus-bar');
    const topEdge = pwa ? Math.max(8, document.getElementById('statusbar')?.getBoundingClientRect().height || 0,
      header ? parseFloat(getComputedStyle(header).paddingTop) || 0 : 0) : 8;
    const view = window.visualViewport;
    const bottomEdge = view ? Math.min(innerHeight, view.offsetTop + view.height) : innerHeight;
    const below = bottomEdge - r.bottom - 14, above = r.top - topEdge - 6;
    menu.style.maxHeight = '';
    const natural = menu.scrollHeight;
    if (pwa || !side) side = natural <= below || below >= above ? 'below' : 'above';
    const room = Math.max(0, side === 'below' ? below : above);
    menu.style.maxHeight = `${room}px`;
    const mw = menu.offsetWidth, mh = Math.min(natural, room);
    let left = align === 'left' ? r.left : r.right - mw;
    const safeStyle = getComputedStyle(document.documentElement);
    const leftEdge = Math.max(edge, parseFloat(safeStyle.getPropertyValue('--safe-left')) || 0);
    const rightEdge = Math.max(edge, parseFloat(safeStyle.getPropertyValue('--safe-right')) || 0);
    left = Math.min(Math.max(left, leftEdge), window.innerWidth - mw - rightEdge);
    menu.style.left = `${left}px`;
    const top = side === 'below' ? r.bottom + 6 : r.top - mh - 6;
    menu.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - mh - 8))}px`;
  };
  place();
  let raf = 0;
  const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); });
  [...menu.children].forEach((c) => ro.observe(c));
  ro.observe(menu);
  const onResize = () => place();
  window.addEventListener('resize', onResize);
  const viewport = window.visualViewport;
  viewport?.addEventListener('resize', onResize);
  viewport?.addEventListener('scroll', onResize);
  const onDoc = (e) => { if (!menu.contains(e.target) && !anchorEl.contains(e.target)) { e.preventDefault(); e.stopPropagation(); closePopover(); } };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePopover(); anchorEl.focus({ preventScroll: true }); } else if (e.key === 'Tab') trapTab(e, menu); };
  const install = setTimeout(() => { if (!menu.isConnected) return; document.addEventListener('click', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
  menu._cleanup = () => { clearTimeout(install); cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', onResize); viewport?.removeEventListener('resize', onResize); viewport?.removeEventListener('scroll', onResize); document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey, true); };
  menu._anchor = anchorEl;
  menu._onClose = onClose;
  document.body._openPopover = menu;
  scopeLayers();
  return menu;
}

/** Closes the popover opened by openPopover, if any. */
export function closePopover() {
  const menu = document.body._openPopover;
  if (!menu) return;
  menu._cleanup?.();
  menu.remove();
  document.body._openPopover = null;
  menu._onClose?.();
  scopeLayers();
}

/** Debounce helper. */
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
