// Events: filters the unified event index (app/db.py `events`, fed by DVR log backfill + the live
// alertStream — see docs/SPEC.md section 8) by camera, kind and a DVR-local date range, shows a
// thumbnail per event (captured from its midpoint, on demand — app/thumbnails.py), and jumps a result
// straight into Playback at that instant. Motion/line/tamper spans arrive already stitched into start/end
// windows by app/events.py, so no further run-collapsing is needed here.
import { barHTML, wireBar } from './bar.js';
import { closePopover, confirmDialog, esc, icon, openPopover, toast } from './ui.js';
import { fetchTzOffset } from './dvrtime.js';
import { DateTimePicker } from './datepicker.js';
import { api, getJSON } from './api.js';
import { openEventPreview } from './eventPreview.js';

const KIND_LABEL = { motion: 'Motion', line: 'Line cross', tamper: 'Tamper', videoloss: 'Video loss', bookmark: 'Bookmark' };
const RESULT_CAP = 500; // no server-side pagination yet — a capped result set with a "narrow your search" hint is the honest MVP
// Each thumbnail can cost a real DVR playback session (app/thumbnails.py serializes them server-side to at
// most 1 of the 4 slots, but that still queues behind whatever's already generating) — cap how many this
// page ever has in flight at once, rather than trusting the browser's own per-origin connection limit
// (~6), which found out to be nowhere near enough of a bound when scrolling a page of hundreds of cards.
const THUMB_CONCURRENCY = 2;
const KINDS = Object.keys(KIND_LABEL);
const PRESETS = [['today', 'Today'], ['24h', '24h'], ['7d', '7d'], ['custom', 'Custom']];

export class EventsView {
  /** @param ctx { settings(), go(hash) } */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.tzOffsetMin = 330;
    this.selectedCams = new Set(this.cams().map((c) => c.id)); // every enabled camera, to start — matches the previous "all cameras" default
    this.kinds = new Set(KINDS); // every type on to start; the chips narrow it
    this.query = '';               // the bar's search field — filters the loaded results as you type
    this._seq = 0;
    this.preset = '24h';
    this.customFrom = Date.now() / 1000 - 86400;
    this.customTo = Date.now() / 1000;
    this.results = null; // null = not searched yet
    this.loading = false;
    // Persisted across visits (matches the localStorage pattern tile.js already uses for the HEVC flag) —
    // a preference like "I review events as a list" is meant to stick, not reset every time this page opens.
    try { this.showThumbs = localStorage.getItem('sentinel.eventsThumbs') !== '0'; } catch { this.showThumbs = true; }
    this._thumbQueue = [];
    this._thumbActive = 0;
    this._io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { this._queueThumb(e.target); this._io.unobserve(e.target); }
    }, { root: null, rootMargin: '200px' });
    this._init();
  }

  // Same order the operator arranged on Live/Settings (display.order) — see playback.js's identical fix
  // for why this can't just be the enabled subset in raw backend order.
  cams() {
    const by = Object.fromEntries(this.ctx.settings().channels.filter((c) => c.enabled).map((c) => [c.id, c]));
    return this.ctx.settings().display.order.map((id) => by[id]).filter(Boolean);
  }
  camById(ch) { return this.cams().find((c) => c.channel === ch); }

  // ------------------------------------------------------------- sidebar (Events board)
  // Cameras as plain checkboxes, event types as multi-select chips. Both always keep at least one choice
  // on — an empty result from "search nothing" reads as a bug, not a real "no events" answer.
  _renderSide() {
    const cams = this.cams();
    const allOn = cams.length > 0 && this.selectedCams.size === cams.length;
    const sole = this.selectedCams.size === 1 ? [...this.selectedCams][0] : null;
    const camsEl = this.root.querySelector('.ev-cams');
    camsEl.innerHTML = cams.map((c) => {
      const on = this.selectedCams.has(c.id);
      const last = on && c.id === sole;
      return `<label class="ev-check" ${last ? 'title="At least one camera stays selected"' : ''}><input type="checkbox" data-cam="${esc(c.id)}" ${on ? 'checked' : ''} ${last ? 'disabled' : ''}><span>${esc(c.name || 'Camera ' + c.channel)}</span></label>`;
    }).join('');
    const all = this.root.querySelector('[data-a=allcams]');
    all.hidden = allOn || cams.length < 2;
    camsEl.querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) this.selectedCams.add(cb.dataset.cam); else this.selectedCams.delete(cb.dataset.cam);
      this._renderSide();
      this.search();
    }));
    const kindsEl = this.root.querySelector('.ev-kinds');
    kindsEl.innerHTML = Object.entries(KIND_LABEL).map(([k, l]) => {
      const on = this.kinds.has(k);
      return `<button class="ev-kind ${k}" data-kind="${k}" aria-pressed="${on}" ${on && this.kinds.size === 1 ? 'disabled title="At least one type stays selected"' : ''}>${l}</button>`;
    }).join('');
    kindsEl.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.kind;
      if (this.kinds.has(k)) this.kinds.delete(k); else this.kinds.add(k);
      this._renderSide();
      this.search();
    }));
    const n = this.root.querySelector('.ev-filter-n');
    const narrowed = (allOn ? 0 : 1) + (this.kinds.size === KINDS.length ? 0 : 1);
    if (n) { n.textContent = narrowed ? String(narrowed) : ''; }
  }

  async _init() {
    this.tzOffsetMin = await fetchTzOffset(this.tzOffsetMin);
    this.build();
    this.search();
  }

  // ------------------------------------------------------------- range from preset
  _range() {
    const now = Date.now() / 1000;
    if (this.preset === 'custom') return [this.customFrom, this.customTo];
    if (this.preset === '7d') return [now - 7 * 86400, now];
    if (this.preset === 'today') {
      // DVR-local midnight, same clock every timestamp on this page is shown in.
      const off = this.tzOffsetMin * 60;
      return [Math.floor((now + off) / 86400) * 86400 - off, now];
    }
    return [now - 86400, now]; // 24h default
  }

  // ------------------------------------------------------------- rendering
  build() {
    const seg = `<div class="seg ev-range" role="group" aria-label="Time range">${PRESETS.map(([v, l]) => `<button data-preset="${v}" aria-pressed="${this.preset === v}">${l}</button>`).join('')}</div>`;
    this.root.innerHTML = `${barHTML({
      lead: 'back', title: 'Events', size: 'title', cls: 'ev-bar',
      context: `<label class="ev-search">${icon('search')}<input type="search" placeholder="Search events…" aria-label="Search events" autocomplete="off" spellcheck="false"></label>`,
      actions: `${seg}<button class="btn glass-btn ev-filters-btn" data-a="filters" aria-expanded="false">${icon('layout')} Filters <span class="ev-filter-n"></span></button>`,
    })}<div class="events-view">
      <aside class="ev-side" aria-label="Filters">
        <div class="ev-sheet-head"><b>Filters</b><button class="btn sm ghost" data-a="closefilters">Done</button></div>
        <section class="ev-sec ev-sec-range"><h3>Range</h3>${seg}</section>
        <section class="ev-sec"><h3>Cameras <button class="ev-link" data-a="allcams" hidden>Select all</button></h3><div class="ev-cams"></div></section>
        <section class="ev-sec"><h3>Event type</h3><div class="ev-kinds"></div></section>
        <section class="ev-sec"><h3>View</h3>
          <label class="ev-switch"><span class="switch"><input type="checkbox" id="ev-thumbs" ${this.showThumbs ? 'checked' : ''}><span></span></span>Show thumbnails</label>
          <p class="ev-cap">Off trades the image for a denser list — handy over a slow connection, or when you just need timestamps.</p></section>
      </aside>
      <div class="ev-scrim" hidden></div>
      <main class="events-main"><div class="events-results"></div></main>
    </div>`;
    this.res = this.root.querySelector('.events-results');
    this._renderSide();
    this.root.querySelector('[data-a=allcams]').addEventListener('click', () => { this.selectedCams = new Set(this.cams().map((c) => c.id)); this._renderSide(); this.search(); });
    this.root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.preset === 'custom') { this._openCustom(b); return; }
      this._setPreset(b.dataset.preset);
      this.search();
    }));
    const q = this.root.querySelector('.ev-search input');
    let t = 0;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { this.query = q.value.trim().toLowerCase(); this.renderResults(); }, 120); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape' && q.value) { e.stopPropagation(); q.value = ''; this.query = ''; this.renderResults(); } });
    this._onKey = (e) => {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && !document.getElementById('modal-root')?.firstChild) { e.preventDefault(); q.focus(); }
    };
    document.addEventListener('keydown', this._onKey);
    this.root.querySelector('#ev-thumbs').addEventListener('change', (e) => {
      this.showThumbs = e.target.checked;
      try { localStorage.setItem('sentinel.eventsThumbs', this.showThumbs ? '1' : '0'); } catch { /* private mode */ }
      this.renderResults();
    });
    // Narrow windows: the sidebar becomes a sheet behind the bar's Filters button.
    const side = this.root.querySelector('.ev-side'), scrim = this.root.querySelector('.ev-scrim'), fbtn = this.root.querySelector('[data-a=filters]');
    const sheet = (open) => { side.classList.toggle('open', open); scrim.hidden = !open; fbtn.setAttribute('aria-expanded', String(open)); };
    fbtn.addEventListener('click', () => sheet(!side.classList.contains('open')));
    scrim.addEventListener('click', () => sheet(false));
    this.root.querySelector('[data-a=closefilters]').addEventListener('click', () => sheet(false));
    wireBar(this.root, this.ctx);
    this.renderResults();
  }

  _setPreset(p) {
    this.preset = p;
    this.root.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.preset === p)));
  }

  /** Custom range: From/To pickers in a popover; nothing searches until Apply. */
  _openCustom(anchor) {
    const menu = openPopover(anchor, `<div class="ev-custom">
      <div class="dtp-host" id="ev-from-host"></div><div class="dtp-host" id="ev-to-host"></div>
      <div class="ev-custom-foot"><span class="hint" id="ev-custom-err"></span><button class="btn primary" data-a="apply">Show events</button></div></div>`, { className: 'ev-custom-pop', align: 'right' });
    if (!menu) return;
    let from = this.customFrom, to = this.customTo;
    new DateTimePicker(menu.querySelector('#ev-from-host'), { epoch: from, tzOffsetMin: this.tzOffsetMin, label: 'From', onChange: (e) => { from = e; } });
    new DateTimePicker(menu.querySelector('#ev-to-host'), { epoch: to, tzOffsetMin: this.tzOffsetMin, label: 'To', onChange: (e) => { to = e; } });
    menu.querySelector('[data-a=apply]').addEventListener('click', () => {
      if (to <= from) { menu.querySelector('#ev-custom-err').textContent = 'The end has to be after the start.'; return; }
      this.customFrom = from; this.customTo = to;
      closePopover();
      this._setPreset('custom');
      this.search();
    });
  }

  async search() {
    if (this.selectedCams.size === 0 || this.kinds.size === 0) { this.results = []; this.loading = false; this.renderResults(); return; }
    this.loading = true;
    this.renderResults();
    const [fromEpoch, toEpoch] = this._range();
    const base = new URLSearchParams({
      start_utc: new Date(fromEpoch * 1000).toISOString(),
      end_utc: new Date(toEpoch * 1000).toISOString(),
      limit: String(RESULT_CAP),
    });
    const allCams = this.cams();
    if (this.selectedCams.size < allCams.length) {
      for (const c of allCams) if (this.selectedCams.has(c.id)) base.append('channel', String(c.channel));
    }
    // Every type → one query. A subset → one query per type, merged: filtering a single capped query
    // client-side could silently drop the rarer kinds behind hundreds of motion rows.
    const kinds = this.kinds.size === KINDS.length ? [''] : [...this.kinds];
    const seq = ++this._seq;
    try {
      const parts = await Promise.all(kinds.map((k) => {
        const p = new URLSearchParams(base);
        if (k) p.set('kind', k);
        return getJSON(`/api/timeline/events?${p}`);
      }));
      if (seq !== this._seq) return; // a newer search has started; its results win
      const rows = parts.flat();
      rows.sort((a, b) => b.start_utc.localeCompare(a.start_utc)); // newest first
      this.capped = parts.some((r) => r.length >= RESULT_CAP);
      this.results = rows;
    } catch (e) {
      if (seq !== this._seq) return;
      this.results = [];
      toast(e.message || 'Search failed', 'bad');
    }
    this.loading = false;
    this.renderResults();
  }

  /** DVR-local "Today · 23:50:28" / "Yesterday · …" / "Oct 1 · …". */
  _when(iso) {
    const off = this.tzOffsetMin * 60000;
    const t = new Date(new Date(iso).getTime() + off);
    const dayOf = (ms) => Math.floor(ms / 86400000);
    const d = dayOf(Date.now() + off) - dayOf(t.getTime());
    const day = d === 0 ? 'Today' : d === 1 ? 'Yesterday' : t.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
    const p = (n) => String(n).padStart(2, '0');
    return `${day} · ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
  }

  renderResults() {
    if (!this.res) return;
    this._io.disconnect();
    this._thumbQueue = []; // any queued images belonged to the previous result set — the DOM is about to be replaced
    if (this.loading) { this.res.innerHTML = `<div class="ev-empty"><span class="spin"></span><p>Searching…</p></div>`; return; }
    if (this.results === null) { this.res.innerHTML = ''; return; }
    const rows = this.results.map((ev) => {
      const cam = this.camById(ev.channel);
      let attrs = null;
      if (ev.kind === 'bookmark' && ev.attrs_json) { try { attrs = JSON.parse(ev.attrs_json); } catch { /* malformed, skip */ } }
      const camName = cam ? cam.name || 'Camera ' + cam.channel : `Channel ${ev.channel}`;
      const when = this._when(ev.start_utc);
      const durSec = Math.max(0, (new Date(ev.end_utc) - new Date(ev.start_utc)) / 1000);
      const dur = durSec < 1 ? '' : durSec < 60 ? `${Math.round(durSec)} s` : `${Math.round(durSec / 60)} min`;
      return { ev, cam, attrs, camName, when, dur, hay: `${camName} ${KIND_LABEL[ev.kind] || ev.kind} ${attrs?.title || ''} ${attrs?.notes || ''} ${when}`.toLowerCase() };
    }).filter((r) => !this.query || this.query.split(/\s+/).every((w) => r.hay.includes(w)));
    if (!rows.length) {
      const searching = !!this.query && this.results.length;
      this.res.innerHTML = `<div class="ev-empty"><div class="ev-empty-ico">${icon('search')}</div><h2>${searching ? 'No matches' : 'No events'}</h2>
        <p>${searching ? `Nothing here matches “${esc(this.query)}”.` : 'Nothing in this range for these cameras and types. Try a wider range, or turn more of them on.'}</p></div>`;
      return;
    }
    const pill = (k) => `<span class="ev-badge ${k}">${k === 'bookmark' ? icon('bookmark') : ''}${KIND_LABEL[k] || esc(k)}</span>`;
    const actions = (r) => `
      ${r.attrs?.bookmark_id ? `<button class="ev-act" data-a="delbm" data-bmid="${r.attrs.bookmark_id}" title="Delete bookmark" aria-label="Delete bookmark">${icon('trash')}</button>` : ''}
      <button class="ev-act" data-a="open" ${r.cam ? '' : 'disabled title="This camera is not enabled"'} title="Open in Playback" aria-label="Open in Playback">${icon('calendar')}</button>`;
    const items = rows.map((r, i) => this.showThumbs
      ? `<article class="ev-card" data-i="${i}" tabindex="0" aria-label="${esc(`${KIND_LABEL[r.ev.kind] || r.ev.kind}, ${r.camName}, ${r.when}`)}">
          <div class="ev-thumb"><img data-ev-id="${r.ev.id}" alt="" loading="lazy">${pill(r.ev.kind)}${r.dur ? `<span class="ev-dur">${r.dur}</span>` : ''}<div class="ev-acts">${actions(r)}</div></div>
          <div class="ev-card-body"><b>${esc(r.camName)}</b><span>${esc(r.when)}</span>${r.attrs?.title ? `<span class="ev-title">${esc(r.attrs.title)}</span>` : ''}</div>
        </article>`
      : `<article class="ev-row" data-i="${i}" tabindex="0">${pill(r.ev.kind)}<b>${esc(r.camName)}</b><span class="ev-row-when">${esc(r.when)}${r.dur ? ` · ${r.dur}` : ''}</span>
          <span class="ev-title">${r.attrs?.title ? esc(r.attrs.title) : ''}</span><span class="ev-acts">${actions(r)}</span></article>`).join('');
    const capNote = this.capped
      ? `<p class="ev-cap-note">Showing the first ${RESULT_CAP} of each type — narrow the range, cameras or types to see the rest.</p>` : '';
    this.res.innerHTML = `<div class="${this.showThumbs ? 'events-grid' : 'events-list'}">${items}</div>${capNote}`;
    this.res.querySelectorAll('[data-i]').forEach((el) => {
      const r = rows[+el.dataset.i];
      el.addEventListener('click', (e) => {
        const act = e.target.closest('[data-a]');
        if (act?.dataset.a === 'open') { e.stopPropagation(); this.openInPlayback(r.ev); return; }
        if (act?.dataset.a === 'delbm') { e.stopPropagation(); this.deleteBookmark(+act.dataset.bmid); return; }
        this.openPreview(r.ev);
      });
      el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); this.openPreview(r.ev); } });
      const img = el.querySelector('img');
      if (img) this._io.observe(img);
    });
  }

  openPreview(ev) {
    openEventPreview({ ev, cam: this.camById(ev.channel), onOpenPlayback: () => this.openInPlayback(ev) });
  }

  _queueThumb(imgEl) {
    this._thumbQueue.push(imgEl);
    this._pumpThumbs();
  }

  _pumpThumbs() {
    while (this._thumbActive < THUMB_CONCURRENCY && this._thumbQueue.length) {
      const imgEl = this._thumbQueue.shift();
      if (!imgEl.isConnected) continue; // the results list was re-rendered before this one's turn came up
      this._thumbActive++;
      const done = () => { this._thumbActive--; this._pumpThumbs(); };
      imgEl.addEventListener('load', () => { imgEl.closest('.ev-thumb')?.classList.add('loaded'); done(); });
      imgEl.addEventListener('error', () => { imgEl.closest('.ev-thumb')?.classList.add('failed'); done(); });
      imgEl.src = `/api/timeline/events/${imgEl.dataset.evId}/thumbnail`;
    }
  }

  async deleteBookmark(id) {
    const ok = await confirmDialog({ title: 'Delete bookmark?', body: 'This removes the bookmark and its marker from the timeline. This can\'t be undone.', ok: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deleteBookmark(id);
      toast('Bookmark deleted.', 'ok');
      this.search();
    } catch (e) {
      toast(e.message || 'Could not delete the bookmark', 'bad');
    }
  }

  openInPlayback(ev) {
    const cam = this.camById(ev.channel);
    if (!cam) return;
    const epoch = Math.max(0, new Date(ev.start_utc).getTime() / 1000 - 3); // a few seconds of lead-in
    this.ctx.go(`#/playback/${cam.id}/${epoch}`);
  }

  destroy() {
    document.removeEventListener('keydown', this._onKey);
    this._io.disconnect();
    this.root.innerHTML = '';
  }
}
