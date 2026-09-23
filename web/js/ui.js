// Small UI helpers: escaping, icons, toasts, dialogs.
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
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 1-1h13.5a1 1 0 0 1 .8 1.6l-3.6 4.8 3.6 4.8a1 1 0 0 1-.8 1.6H5"/>',
  wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h.01M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
  crop: '<path d="M6.13 2 6 18a2 2 0 0 0 2 2h14"/><path d="M2 6.13 18 6a2 2 0 0 1 2 2v14"/>',
  flashlight: '<path d="M18 6c0 2-2 3-2 5v11a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V11c0-2-2-3-2-5a6 6 0 0 1 12 0Z"/><line x1="6" y1="6" x2="18" y2="6"/><line x1="12" y1="12" x2="12" y2="12"/>',
};
export const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;

export function toast(msg, kind = 'ok', ms = 4200) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `${icon(kind === 'ok' ? 'check' : 'alert')}<div>${esc(msg)}</div>`;
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

export function confirmDialog({ title, body, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3><p>${esc(body)}</p>
      <div class="row"><button class="btn" data-x="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-x="1">${esc(ok)}</button></div></div></div>`;
    const done = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) done(false); });
    root.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => done(b.dataset.x === '1')));
    root.querySelector('[data-x="1"]').focus();
  });
}

/** Small "bookmark this moment" dialog: title, note, severity. Resolves {title, note, severity} or null on cancel. */
export function bookmarkDialog({ subtitle = '' } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-label="Add bookmark">
      <h3>${icon('flag')} Add bookmark</h3>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
      <div class="form" style="grid-template-columns:1fr">
        <div class="field"><label for="bm-title">Title</label><input id="bm-title" type="text" placeholder="What's happening" maxlength="120"></div>
        <div class="field"><label for="bm-note">Note (optional)</label><textarea id="bm-note" rows="3" maxlength="2000" style="resize:vertical;padding:8px;border-radius:8px;border:1px solid var(--line-2);background:var(--bg);font:inherit;color:inherit"></textarea></div>
        <div class="field"><label for="bm-sev">Severity</label><select id="bm-sev">
          <option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option>
        </select></div>
      </div>
      <div class="row"><button class="btn" data-x="0">Cancel</button><button class="btn primary" data-x="1">${icon('flag')} Save bookmark</button></div></div></div>`;
    const done = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const submit = () => done({
      title: root.querySelector('#bm-title').value.trim(),
      note: root.querySelector('#bm-note').value.trim(),
      severity: root.querySelector('#bm-sev').value,
    });
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } else if (e.key === 'Enter' && e.target.id === 'bm-title') submit(); };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) done(null); });
    root.querySelector('[data-x="0"]').addEventListener('click', () => done(null));
    root.querySelector('[data-x="1"]').addEventListener('click', submit);
    root.querySelector('#bm-title').focus();
  });
}

/** Opens a small popover menu anchored to `anchorEl`, appended to <body> so it's never clipped by an
 * ancestor's `overflow: hidden` (grid tiles, panes, etc. all clip — a menu positioned relative to an
 * element inside one gets cut off or renders garbled, which is what the live tile's enhance dropdown did
 * before this). Positioned in the viewport (not the DOM), clamped so it never runs off-screen, and closes
 * itself on an outside click or Escape. Returns the menu element in case the caller wants it (e.g. to
 * close it early on selection). At most one popover from this helper is open at a time. */
export function openPopover(anchorEl, innerHTML, { className = '', align = 'right' } = {}) {
  const already = document.body._openPopover;
  closePopover();
  if (already?._anchor === anchorEl) return null; // second click on the same button: treat as toggle-close
  const menu = document.createElement('div');
  menu.className = `menu popover-portal ${className}`;
  menu.innerHTML = innerHTML;
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = align === 'left' ? r.left : r.right - mw;
  left = Math.min(Math.max(left, 8), window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6); // no room below — open above instead
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== anchorEl) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => { document.addEventListener('click', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
  menu._cleanup = () => { document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey, true); };
  menu._anchor = anchorEl;
  document.body._openPopover = menu;
  return menu;
}

/** Closes the popover opened by openPopover, if any. */
export function closePopover() {
  const menu = document.body._openPopover;
  if (!menu) return;
  menu._cleanup?.();
  menu.remove();
  document.body._openPopover = null;
}

/** Debounce helper. */
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
