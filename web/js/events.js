// Events: filters the unified event index (app/db.py `events`, fed by DVR log backfill + the live
// alertStream — see docs/SPEC.md section 8) by camera, kind and a DVR-local date range, shows a
// thumbnail per event (captured from its midpoint, on demand — app/thumbnails.py), and jumps a result
// straight into Playback at that instant. Motion/line/tamper spans arrive already stitched into start/end
// windows by app/events.py, so no further run-collapsing is needed here.
import { esc, icon, toast, confirmDialog } from './ui.js';
import { fetchTzOffset } from './dvrtime.js';
import { DateTimePicker } from './datepicker.js';
import { api } from './api.js';
import { openEventPreview } from './eventPreview.js';

const KIND_LABEL = { motion: 'Motion', line: 'Line cross', tamper: 'Tamper', videoloss: 'Video loss', bookmark: 'Bookmark' };
const RESULT_CAP = 500; // no server-side pagination yet — a capped result set with a "narrow your search" hint is the honest MVP
// Each thumbnail can cost a real DVR playback session (app/thumbnails.py serializes them server-side to at
// most 1 of the 4 slots, but that still queues behind whatever's already generating) — cap how many this
// page ever has in flight at once, rather than trusting the browser's own per-origin connection limit
// (~6), which found out to be nowhere near enough of a bound when scrolling a page of hundreds of cards.
const THUMB_CONCURRENCY = 2;
const PRESETS = [
  ['today', 'Today'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['custom', 'Custom range'],
];

export class EventsView {
  /** @param ctx { settings(), go(hash) } */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.tzOffsetMin = 330;
    this.selectedCams = new Set(this.cams().map((c) => c.id)); // every enabled camera, to start — matches the previous "all cameras" default
    this.kind = 'all';
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

  // ------------------------------------------------------------- camera filter (same pattern as Playback's own picker)
  // Always at least one camera selected — an empty result set from "nothing to search" reads as a bug, not
  // a real "no events" answer, so it's simply not an option. The select-all button doubles as "clear
  // selection" once everything's already checked, since a true clear-to-zero isn't allowed either.
  _renderCamList() {
    const list = this.root.querySelector('.cam-list');
    if (!list) return;
    const cams = this.cams();
    const allOn = cams.length > 0 && this.selectedCams.size === cams.length;
    const soleSelected = this.selectedCams.size === 1 ? [...this.selectedCams][0] : null;
    const selectAllBtn = this.root.querySelector('[data-a=selectall]');
    if (selectAllBtn) {
      selectAllBtn.innerHTML = allOn ? `${icon('close')} Clear selection` : `${icon('check')} Select all`;
      selectAllBtn.onclick = () => {
        this.selectedCams = new Set(allOn ? (cams[0] ? [cams[0].id] : []) : cams.map((c) => c.id));
        this._renderCamList();
        this.search();
      };
    }
    list.innerHTML = cams.map((c) => {
      const on = this.selectedCams.has(c.id);
      const lastOne = on && c.id === soleSelected;
      return `<label class="cam-item ${on ? 'on' : ''}" data-id="${c.id}" ${lastOne ? 'title="At least one camera must stay selected"' : ''}>
        <input type="checkbox" ${on ? 'checked' : ''} ${lastOne ? 'disabled' : ''}>
        <span class="dot ${on ? 'live' : ''}"></span><span class="name">${esc(c.name || 'Camera ' + c.channel)}</span></label>`;
    }).join('');
    list.querySelectorAll('.cam-item input').forEach((cb) => cb.addEventListener('change', () => {
      const id = cb.closest('.cam-item').dataset.id;
      if (cb.checked) this.selectedCams.add(id); else this.selectedCams.delete(id);
      this._renderCamList();
      this.search();
    }));
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
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return [d.getTime() / 1000, now];
    }
    return [now - 86400, now]; // 24h default
  }

  // ------------------------------------------------------------- rendering
  build() {
    this.root.innerHTML = `<div class="events-view">
      <aside class="pb-side pb-side-left">
        <h3>Cameras</h3>
        <button class="btn sm" data-a="selectall" style="width:100%;justify-content:center"></button>
        <div class="cam-list"></div>
      </aside>
      <main class="events-main"><div class="events-results"></div></main>
      <aside class="pb-side pb-side-right">
        <h3>Filters</h3>
        <div class="field"><label for="ev-kind">Event type</label>
          <select id="ev-kind"><option value="all">All types</option>${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>Range</label>
          <div class="events-presets">${PRESETS.map(([v, l]) => `<button data-preset="${v}" aria-pressed="${this.preset === v}">${l}</button>`).join('')}</div></div>
        <div class="events-custom" id="ev-custom" ${this.preset === 'custom' ? '' : 'hidden'}>
          <div class="dtp-host" id="ev-from-host"></div>
          <div class="dtp-host" id="ev-to-host"></div>
        </div>
        <button class="btn primary" data-a="search" style="width:100%;justify-content:center;margin-top:6px">${icon('search')} Apply filters</button>
        <h3>View</h3>
        <div class="toggle-row">
          <label class="switch"><input type="checkbox" id="ev-thumbs" ${this.showThumbs ? 'checked' : ''}><span></span></label>
          <label for="ev-thumbs">Show thumbnails</label>
        </div>
      </aside>
    </div>`;
    this.res = this.root.querySelector('.events-results');
    this._renderCamList();
    this.root.querySelector('#ev-kind').addEventListener('change', (e) => { this.kind = e.target.value; this.search(); });
    this.root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      this.preset = b.dataset.preset;
      this.root.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      this.root.querySelector('#ev-custom').hidden = this.preset !== 'custom';
      if (this.preset !== 'custom') this.search();
    }));
    this.root.querySelector('[data-a=search]').addEventListener('click', () => this.search());
    this.root.querySelector('#ev-thumbs').addEventListener('change', (e) => {
      this.showThumbs = e.target.checked;
      try { localStorage.setItem('sentinel.eventsThumbs', this.showThumbs ? '1' : '0'); } catch { /* private mode */ }
      this.renderResults();
    });

    this.fromPicker = new DateTimePicker(this.root.querySelector('#ev-from-host'), {
      epoch: this.customFrom, tzOffsetMin: this.tzOffsetMin, label: 'From',
      onChange: (e) => { this.customFrom = e; },
    });
    this.toPicker = new DateTimePicker(this.root.querySelector('#ev-to-host'), {
      epoch: this.customTo, tzOffsetMin: this.tzOffsetMin, label: 'To',
      onChange: (e) => { this.customTo = e; },
    });
    this.renderResults();
  }

  async search() {
    // Every camera unchecked isn't "no filter", it's "show nothing" — matches what the checkboxes
    // themselves imply, and skips a query that would otherwise silently ignore the (empty) selection.
    if (this.selectedCams.size === 0) { this.results = []; this.loading = false; this.renderResults(); return; }
    this.loading = true;
    this.renderResults();
    const [fromEpoch, toEpoch] = this._range();
    const params = new URLSearchParams({
      start_utc: new Date(fromEpoch * 1000).toISOString(),
      end_utc: new Date(toEpoch * 1000).toISOString(),
      limit: String(RESULT_CAP),
    });
    if (this.kind !== 'all') params.set('kind', this.kind);
    const allCams = this.cams();
    if (this.selectedCams.size < allCams.length) {
      for (const c of allCams) if (this.selectedCams.has(c.id)) params.append('channel', String(c.channel));
    }
    try {
      const r = await fetch(`/api/timeline/events?${params}`);
      if (!r.ok) throw new Error(`Search failed (${r.status})`);
      const rows = await r.json();
      rows.sort((a, b) => b.start_utc.localeCompare(a.start_utc)); // newest first
      this.results = rows;
    } catch (e) {
      this.results = [];
      toast(e.message || 'Search failed', 'bad');
    }
    this.loading = false;
    this.renderResults();
  }

  renderResults() {
    if (!this.res) return;
    this._io.disconnect();
    this._thumbQueue = []; // any queued images belonged to the previous result set — the DOM is about to be replaced
    if (this.loading) { this.res.innerHTML = `<div class="center-card"><div class="spin"></div><p>Searching…</p></div>`; return; }
    if (this.results === null) { this.res.innerHTML = ''; return; }
    if (!this.results.length) {
      this.res.innerHTML = `<div class="center-card"><div class="cc-icon muted">${icon('search')}</div><h2>No events found</h2><p>Try a different camera, type, or a wider date range.</p></div>`;
      return;
    }
    const items = this.results.map((ev) => {
      const cam = this.camById(ev.channel);
      const start = new Date(ev.start_utc), end = new Date(ev.end_utc);
      const durSec = Math.max(0, (end - start) / 1000);
      const dur = durSec < 1 ? '' : durSec < 60 ? `${Math.round(durSec)}s` : `${Math.round(durSec / 60)}m`;
      // DVR-local wall clock: shift by the offset, then read UTC fields (avoids re-deriving parts by hand
      // here) — date AND time must both come from this shifted value, or an event between local midnight
      // and the UTC offset (e.g. 00:00-05:30 at UTC+5:30) shows the wrong day (caught by review, not by
      // testing: every screenshot taken so far happened to be mid-afternoon local, where they agree).
      const localStart = new Date(start.getTime() + this.tzOffsetMin * 60000);
      const dateStr = localStart.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
      const timeStr = `${String(localStart.getUTCHours()).padStart(2, '0')}:${String(localStart.getUTCMinutes()).padStart(2, '0')}:${String(localStart.getUTCSeconds()).padStart(2, '0')}`;
      let attrs = null;
      if (ev.kind === 'bookmark' && ev.attrs_json) { try { attrs = JSON.parse(ev.attrs_json); } catch { /* malformed, skip */ } }
      const camName = esc(cam ? cam.name || 'Camera ' + cam.channel : `Channel ${ev.channel}`);
      const previewBtn = `<button class="btn sm primary" data-a="preview" ${cam ? '' : 'disabled title="This camera is not enabled"'}>${icon('play')} Preview</button>`;
      const openBtn = `<button class="btn sm" data-a="open" ${cam ? '' : 'disabled title="This camera is not enabled"'}>${icon('video')} Open</button>`;
      const delBtn = attrs?.bookmark_id ? `<button class="btn icon ghost sm" data-a="delbm" data-bmid="${attrs.bookmark_id}" title="Delete bookmark" aria-label="Delete bookmark">${icon('trash')}</button>` : '';
      if (this.showThumbs) {
        return `<div class="ev-card" data-id="${ev.id}">
          <div class="ev-thumb" data-a="preview" title="Preview"><img data-ev-id="${ev.id}" alt="" loading="lazy"><div class="ev-thumb-fallback">${icon('video')}</div></div>
          <div class="ev-card-body">
            <div class="ev-card-top"><span class="ev-badge ${ev.kind}">${KIND_LABEL[ev.kind] || ev.kind}</span><span class="ev-card-date">${dateStr} · ${timeStr}${dur ? ` (${dur})` : ''}</span></div>
            <div class="ev-card-cam">${camName}</div>
            ${attrs?.title ? `<div class="ev-card-title">${esc(attrs.title)}</div>` : ''}
            <div class="ev-card-actions">${delBtn}<span class="spacer"></span>${openBtn}${previewBtn}</div>
          </div>
        </div>`;
      }
      // List view: same data, no thumbnail — skips the per-event /thumbnail fetch entirely, which is the
      // point (each one can cost a real DVR playback session — see THUMB_CONCURRENCY's own comment above).
      return `<div class="ev-row" data-id="${ev.id}">
        <span class="ev-badge ${ev.kind}">${KIND_LABEL[ev.kind] || ev.kind}</span>
        <span class="ev-row-cam">${camName}</span>
        <span class="ev-row-date">${dateStr} · ${timeStr}${dur ? ` (${dur})` : ''}</span>
        <span class="ev-row-title">${attrs?.title ? esc(attrs.title) : ''}</span>
        <span class="spacer"></span>
        ${delBtn}${openBtn}${previewBtn}
      </div>`;
    }).join('');
    const capNote = this.results.length >= RESULT_CAP
      ? `<p class="hint" style="padding:10px 4px">Showing the first ${RESULT_CAP} results — narrow the date range, camera or type to see more.</p>` : '';
    this.res.innerHTML = `<div class="${this.showThumbs ? 'events-grid' : 'events-list'}">${items}</div>${capNote}`;
    this.res.querySelectorAll(this.showThumbs ? '.ev-card' : '.ev-row').forEach((row, i) => {
      row.querySelector('[data-a=open]')?.addEventListener('click', () => this.openInPlayback(this.results[i]));
      row.querySelectorAll('[data-a=preview]').forEach((el) => el.addEventListener('click', () => this.openPreview(this.results[i])));
      row.querySelector('[data-a=delbm]')?.addEventListener('click', (e) => this.deleteBookmark(+e.currentTarget.dataset.bmid));
      if (this.showThumbs) this._io.observe(row.querySelector('img'));
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
    this._io.disconnect();
    this.root.innerHTML = '';
  }
}
