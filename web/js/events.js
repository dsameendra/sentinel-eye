// Events: filters the unified event index (app/db.py `events`, fed by DVR log backfill + the live
// alertStream — see docs/playback-spec.md section 8) by camera, kind and a DVR-local date range, shows a
// thumbnail per event (captured from its midpoint, on demand — app/thumbnails.py), and jumps a result
// straight into Playback at that instant. Motion/line/tamper spans arrive already stitched into start/end
// windows by app/events.py, so no further run-collapsing is needed here.
import { esc, icon, toast, confirmDialog } from './ui.js';
import { fetchTzOffset } from './dvrtime.js';
import { DateTimePicker } from './datepicker.js';
import { api } from './api.js';

const KIND_LABEL = { motion: 'Motion', line: 'Line cross', tamper: 'Tamper', videoloss: 'Video loss', bookmark: 'Bookmark' };
const RESULT_CAP = 500; // no server-side pagination yet — a capped result set with a "narrow your search" hint is the honest MVP
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
    this.channel = 'all';
    this.kind = 'all';
    this.preset = '24h';
    this.customFrom = Date.now() / 1000 - 86400;
    this.customTo = Date.now() / 1000;
    this.results = null; // null = not searched yet
    this.loading = false;
    this._io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { this._loadThumb(e.target); this._io.unobserve(e.target); }
    }, { root: null, rootMargin: '200px' });
    this._init();
  }

  cams() { return this.ctx.settings().channels.filter((c) => c.enabled); }
  camById(ch) { return this.cams().find((c) => c.channel === ch); }

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
    const cams = this.cams();
    this.root.innerHTML = `<div class="events-view">
      <aside class="events-side">
        <h3>Filters</h3>
        <div class="field"><label for="ev-cam">Camera</label>
          <select id="ev-cam"><option value="all">All cameras</option>${cams.map((c) => `<option value="${c.id}">${esc(c.name || 'Camera ' + c.channel)}</option>`).join('')}</select></div>
        <div class="field"><label for="ev-kind">Event type</label>
          <select id="ev-kind"><option value="all">All types</option>${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>Range</label>
          <div class="events-presets">${PRESETS.map(([v, l]) => `<button data-preset="${v}" aria-pressed="${this.preset === v}">${l}</button>`).join('')}</div></div>
        <div class="events-custom" id="ev-custom" ${this.preset === 'custom' ? '' : 'hidden'}>
          <div class="dtp-host" id="ev-from-host"></div>
          <div class="dtp-host" id="ev-to-host"></div>
        </div>
        <button class="btn primary" data-a="search" style="width:100%;justify-content:center;margin-top:6px">${icon('search')} Apply filters</button>
      </aside>
      <main class="events-main"><div class="events-results"></div></main>
    </div>`;
    this.res = this.root.querySelector('.events-results');
    this.root.querySelector('#ev-cam').addEventListener('change', (e) => { this.channel = e.target.value; this.search(); });
    this.root.querySelector('#ev-kind').addEventListener('change', (e) => { this.kind = e.target.value; this.search(); });
    this.root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      this.preset = b.dataset.preset;
      this.root.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      this.root.querySelector('#ev-custom').hidden = this.preset !== 'custom';
      if (this.preset !== 'custom') this.search();
    }));
    this.root.querySelector('[data-a=search]').addEventListener('click', () => this.search());

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
    this.loading = true;
    this.renderResults();
    const [fromEpoch, toEpoch] = this._range();
    const params = new URLSearchParams({
      start_utc: new Date(fromEpoch * 1000).toISOString(),
      end_utc: new Date(toEpoch * 1000).toISOString(),
      limit: String(RESULT_CAP),
    });
    if (this.kind !== 'all') params.set('kind', this.kind);
    if (this.channel !== 'all') {
      const cam = this.cams().find((c) => c.id === this.channel);
      if (cam) params.set('channel', String(cam.channel));
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
    if (this.loading) { this.res.innerHTML = `<div class="center-card"><div class="spin"></div><p>Searching…</p></div>`; return; }
    if (this.results === null) { this.res.innerHTML = ''; return; }
    if (!this.results.length) {
      this.res.innerHTML = `<div class="center-card"><h2>No events found</h2><p>Try a different camera, type, or a wider date range.</p></div>`;
      return;
    }
    const cards = this.results.map((ev) => {
      const cam = this.camById(ev.channel);
      const start = new Date(ev.start_utc), end = new Date(ev.end_utc);
      const durSec = Math.max(0, (end - start) / 1000);
      const dur = durSec < 1 ? '' : durSec < 60 ? `${Math.round(durSec)}s` : `${Math.round(durSec / 60)}m`;
      const dateStr = start.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
      // DVR-local wall clock: shift by the offset, then read UTC fields (avoids re-deriving parts by hand here)
      const localStart = new Date(start.getTime() + this.tzOffsetMin * 60000);
      const timeStr = `${String(localStart.getUTCHours()).padStart(2, '0')}:${String(localStart.getUTCMinutes()).padStart(2, '0')}:${String(localStart.getUTCSeconds()).padStart(2, '0')}`;
      let attrs = null;
      if (ev.kind === 'bookmark' && ev.attrs_json) { try { attrs = JSON.parse(ev.attrs_json); } catch { /* malformed, skip */ } }
      return `<div class="ev-card" data-id="${ev.id}">
        <div class="ev-thumb"><img data-ev-id="${ev.id}" alt="" loading="lazy"><div class="ev-thumb-fallback">${icon('video')}</div></div>
        <div class="ev-card-body">
          <div class="ev-card-top"><span class="ev-badge ${ev.kind}">${KIND_LABEL[ev.kind] || ev.kind}</span><span class="ev-card-date">${dateStr} · ${timeStr}${dur ? ` (${dur})` : ''}</span></div>
          <div class="ev-card-cam">${esc(cam ? cam.name || 'Camera ' + cam.channel : `Channel ${ev.channel}`)}</div>
          ${attrs?.title ? `<div class="ev-card-title">${esc(attrs.title)}</div>` : ''}
          <div class="ev-card-actions">
            ${attrs?.bookmark_id ? `<button class="btn icon ghost sm" data-a="delbm" data-bmid="${attrs.bookmark_id}" title="Delete bookmark" aria-label="Delete bookmark">${icon('trash')}</button>` : ''}
            <span class="spacer"></span>
            <button class="btn sm" data-a="open" ${cam ? '' : 'disabled title="This camera is not enabled"'}>${icon('video')} Open in playback</button>
          </div>
        </div>
      </div>`;
    }).join('');
    const capNote = this.results.length >= RESULT_CAP
      ? `<p class="hint" style="padding:10px 4px">Showing the first ${RESULT_CAP} results — narrow the date range, camera or type to see more.</p>` : '';
    this.res.innerHTML = `<div class="events-grid">${cards}</div>${capNote}`;
    this.res.querySelectorAll('.ev-card').forEach((card, i) => {
      card.querySelector('[data-a=open]')?.addEventListener('click', () => this.openInPlayback(this.results[i]));
      card.querySelector('[data-a=delbm]')?.addEventListener('click', (e) => this.deleteBookmark(+e.currentTarget.dataset.bmid));
      this._io.observe(card.querySelector('img'));
    });
  }

  _loadThumb(imgEl) {
    const id = imgEl.dataset.evId;
    imgEl.addEventListener('load', () => imgEl.closest('.ev-thumb')?.classList.add('loaded'));
    imgEl.addEventListener('error', () => imgEl.closest('.ev-thumb')?.classList.add('failed'));
    imgEl.src = `/api/timeline/events/${id}/thumbnail`;
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
