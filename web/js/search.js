// Event search: filters the unified event index (app/db.py `events`, fed by DVR log backfill + the live
// alertStream — see docs/playback-spec.md section 8) by camera, kind and a DVR-local date range, and jumps
// a result straight into Playback at that instant. Motion/line/tamper spans arrive already stitched into
// start/end windows by app/events.py, so no further run-collapsing is needed here.
import { esc, icon, toast, confirmDialog } from './ui.js';
import { partsFromEpoch, epochFromParts, fetchTzOffset } from './dvrtime.js';
import { api } from './api.js';

const KIND_LABEL = { motion: 'Motion', line: 'Line cross', tamper: 'Tamper', videoloss: 'Video loss', bookmark: 'Bookmark' };
const RESULT_CAP = 500; // no server-side pagination yet — a capped result set with a "narrow your search" hint is the honest MVP
const PRESETS = [
  ['today', 'Today'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
];

export class SearchView {
  /** @param ctx { settings(), go(hash) } */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.tzOffsetMin = 330;
    this.channel = 'all';
    this.kind = 'all';
    this.preset = '24h';
    this.results = null; // null = not searched yet
    this.loading = false;
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
    const today = partsFromEpoch(now, this.tzOffsetMin);
    const startOfToday = epochFromParts(today.y, today.mo, today.da, 0, 0, 0, this.tzOffsetMin);
    if (this.preset === 'today') return [startOfToday, now];
    if (this.preset === '7d') return [now - 7 * 86400, now];
    return [now - 86400, now]; // 24h default
  }

  // ------------------------------------------------------------- rendering
  build() {
    const cams = this.cams();
    this.root.innerHTML = `<div class="search-view">
      <div class="search-bar">
        <div class="field"><label for="s-cam">Camera</label>
          <select id="s-cam"><option value="all">All cameras</option>${cams.map((c) => `<option value="${c.id}">${esc(c.name || 'Camera ' + c.channel)}</option>`).join('')}</select></div>
        <div class="field"><label for="s-kind">Event type</label>
          <select id="s-kind"><option value="all">All types</option>${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>Range</label>
          <div class="seg" role="group" aria-label="Date range">${PRESETS.map(([v, l]) => `<button data-preset="${v}" aria-pressed="${this.preset === v}">${l}</button>`).join('')}</div></div>
        <span class="spacer"></span>
        <button class="btn primary" data-a="search">${icon('search')} Search</button>
      </div>
      <div class="search-results"></div>
    </div>`;
    this.res = this.root.querySelector('.search-results');
    this.root.querySelector('#s-cam').addEventListener('change', (e) => { this.channel = e.target.value; this.search(); });
    this.root.querySelector('#s-kind').addEventListener('change', (e) => { this.kind = e.target.value; this.search(); });
    this.root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      this.preset = b.dataset.preset;
      this.root.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      this.search();
    }));
    this.root.querySelector('[data-a=search]').addEventListener('click', () => this.search());
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
    if (this.loading) { this.res.innerHTML = `<div class="center-card"><div class="spin"></div><p>Searching…</p></div>`; return; }
    if (this.results === null) { this.res.innerHTML = ''; return; }
    if (!this.results.length) {
      this.res.innerHTML = `<div class="center-card"><h2>No events found</h2><p>Try a different camera, type, or a wider date range.</p></div>`;
      return;
    }
    const rows = this.results.map((ev) => {
      const cam = this.camById(ev.channel);
      const start = partsFromEpoch(new Date(ev.start_utc).getTime() / 1000, this.tzOffsetMin);
      const end = partsFromEpoch(new Date(ev.end_utc).getTime() / 1000, this.tzOffsetMin);
      const durSec = Math.max(0, (new Date(ev.end_utc) - new Date(ev.start_utc)) / 1000);
      const dur = durSec < 1 ? '' : durSec < 60 ? `${Math.round(durSec)}s` : `${Math.round(durSec / 60)}m`;
      const p2 = (n) => String(n).padStart(2, '0');
      const dateStr = `${start.y}-${p2(start.mo + 1)}-${p2(start.da)}`;
      const timeStr = `${p2(start.hh)}:${p2(start.mi)}:${p2(start.ss)}`;
      const endTimeStr = `${p2(end.hh)}:${p2(end.mi)}:${p2(end.ss)}`;
      let attrs = null;
      if (ev.kind === 'bookmark' && ev.attrs_json) { try { attrs = JSON.parse(ev.attrs_json); } catch { /* malformed, skip */ } }
      return `<div class="search-row" data-id="${ev.id}">
        <span class="ev-badge ${ev.kind}">${KIND_LABEL[ev.kind] || ev.kind}</span>
        <span class="sr-cam">${esc(cam ? cam.name || 'Camera ' + cam.channel : `Channel ${ev.channel}`)}</span>
        ${attrs?.title ? `<span class="sr-title">${esc(attrs.title)}</span>` : ''}
        <span class="sr-time">${dateStr} · ${timeStr}${dur ? ` – ${endTimeStr} (${dur})` : ''}</span>
        <span class="spacer"></span>
        ${attrs?.bookmark_id ? `<button class="btn icon ghost" data-a="delbm" data-bmid="${attrs.bookmark_id}" title="Delete bookmark" aria-label="Delete bookmark">${icon('trash')}</button>` : ''}
        <button class="btn" data-a="open" ${cam ? '' : 'disabled title="This camera is not enabled"'}>${icon('video')} Open in playback</button>
      </div>`;
    }).join('');
    const capNote = this.results.length >= RESULT_CAP
      ? `<p class="hint" style="padding:10px 4px">Showing the first ${RESULT_CAP} results — narrow the date range, camera or type to see more.</p>` : '';
    this.res.innerHTML = `<div class="search-list">${rows}</div>${capNote}`;
    this.res.querySelectorAll('.search-row').forEach((row, i) => {
      row.querySelector('[data-a=open]')?.addEventListener('click', () => this.openInPlayback(this.results[i]));
      row.querySelector('[data-a=delbm]')?.addEventListener('click', (e) => this.deleteBookmark(+e.currentTarget.dataset.bmid));
    });
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
    this.root.innerHTML = '';
  }
}
