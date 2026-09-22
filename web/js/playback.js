// Playback view: DVR review, 1-4 cameras at once (the DVR's hard playback-session limit — spec 2.2/7.2).
// Left panel = camera picker (checkboxes once >1 pane), center = video pane(s) + shared transport,
// right panel = calendar/time jump, bottom = timeline for the primary (first-picked) camera.
import { Timeline } from './timeline.js';
import { bookmarkDialog, esc, icon, toast } from './ui.js';
import { WCPlayer } from './wcplayer.js';
import { partsFromEpoch, epochFromParts, fetchTzOffset } from './dvrtime.js';
import { api } from './api.js';

const SPEEDS = ['0.125', '0.25', '0.5', '1', '2', '4', '8', '16'];
const REWIND_MACROS = [5, 10, 30];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MAX_PANES = 4; // the DVR allows at most 4 simultaneous playback sessions, full stop (spec 2.2)
const pad2 = (n) => String(n).padStart(2, '0');

export class PlaybackView {
  /** @param ctx { settings(), go(hash) }
   *  @param startEpoch optional deep-link target time (unix seconds), e.g. from a search result */
  constructor(root, ctx, channelId, startEpoch) {
    this.root = root;
    this.ctx = ctx;
    this.playing = false;
    this.currentEpoch = startEpoch ? +startEpoch : Date.now() / 1000 - 30;
    this.speed = '1';
    this.tzOffsetMin = 330; // Asia/Kolkata default until /api/timeline/tz answers
    this.calView = null;
    this.coverageDays = new Map(); // 'YYYY-MM-DD' -> bool (has any recording), for the primary camera
    this.panes = [];               // [{cam, el, canvas, veil, statusEl, player}], panes[0] is primary
    this.onKey = (e) => this._key(e);
    document.addEventListener('keydown', this.onKey);
    this._init(channelId);
  }

  async _init(channelId) {
    this.tzOffsetMin = await fetchTzOffset(this.tzOffsetMin);
    this.build(channelId);
  }

  cams() { return this.ctx.settings().channels.filter((c) => c.enabled); }
  get primary() { return this.panes[0]?.cam; }

  build(channelId) {
    const cams = this.cams();
    if (!cams.length) {
      this.root.innerHTML = `<div class="pb"><div class="center-card"><h2>No cameras</h2><p>Enable a channel in Settings first.</p>
        <a class="btn primary" href="#/settings/channels">Open settings</a></div></div>`;
      return;
    }
    const first = cams.find((c) => c.id === channelId) || cams[0];
    const parts = partsFromEpoch(this.currentEpoch, this.tzOffsetMin);
    this.calView = { y: parts.y, mo: parts.mo };

    this.root.innerHTML = `<div class="pb">
      <div class="pb-body">
        <aside class="pb-side pb-side-left">
          <h3>Cameras</h3>
          <div class="cam-list"></div>
          <p class="hint">Pick up to ${MAX_PANES} — the recorder can only play that many at once.</p>
        </aside>
        <div class="pb-center">
          <div class="pb-topline">
            <span class="pill pb-status"><span class="dot wait"></span><span class="txt">connecting…</span></span>
            <span class="pb-time"></span>
            <span class="spacer"></span>
            <span class="pill pb-pool" title="The recorder's shared playback-session budget"></span>
          </div>
          <div class="pb-stage"></div>
          <div class="pb-transport">
            <button class="btn icon" data-a="back30" title="Back 30 s (Shift+3)">30<span class="u">s</span></button>
            <button class="btn icon" data-a="back10" title="Back 10 s (Shift+2)">10<span class="u">s</span></button>
            <button class="btn icon" data-a="back5" title="Back 5 s (Shift+1)">5<span class="u">s</span></button>
            <button class="btn icon" data-a="stepback" title="Previous frame (,)">${icon('left')}</button>
            <button class="btn icon primary" data-a="playpause" title="Play / pause (Space)">${icon('play')}</button>
            <button class="btn icon" data-a="stepfwd" title="Next frame (.)">${icon('right')}</button>
            <select class="pb-speed" aria-label="Speed"></select>
            <button class="btn icon" data-a="bookmark" title="Bookmark this moment (B)">${icon('flag')}</button>
            <span class="spacer"></span>
            <button class="btn sm" data-a="now">Jump to now</button>
          </div>
        </div>
        <aside class="pb-side pb-side-right">
          <h3>Jump to date &amp; time</h3>
          <div class="pb-cal"></div>
          <div class="time-inputs">
            <div class="time-field"><input type="number" min="0" max="23" class="t-hh"><label>hh</label></div>
            <span class="time-sep">:</span>
            <div class="time-field"><input type="number" min="0" max="59" class="t-mm"><label>mm</label></div>
            <span class="time-sep">:</span>
            <div class="time-field"><input type="number" min="0" max="59" class="t-ss"><label>ss</label></div>
          </div>
          <p class="hint">Pick a day, then a time — it jumps straight there.</p>
        </aside>
      </div>
      <div class="pb-timeline"></div>
    </div>`;

    const speedSel = this.root.querySelector('.pb-speed');
    speedSel.innerHTML = SPEEDS.map((s) => `<option value="${s}" ${s === '1' ? 'selected' : ''}>${s.startsWith('0.') ? '1/' + Math.round(1 / parseFloat(s)) : s}×</option>`).join('');
    speedSel.addEventListener('change', () => this.setSpeed(speedSel.value));

    this.statusEl = this.root.querySelector('.pb-status');
    this.timeEl = this.root.querySelector('.pb-time');
    this.poolEl = this.root.querySelector('.pb-pool');
    this.stage = this.root.querySelector('.pb-stage');

    if (!('VideoDecoder' in window)) {
      this.stage.innerHTML = `<div class="pb-veil" style="position:static;height:100%"><div class="msg"><b>This browser can't play DVR recordings.</b><br>Chrome, Edge or Safari 16.4+ is needed (WebCodecs).</div></div>`;
      return;
    }

    this.timeline = new Timeline(this.root.querySelector('.pb-timeline'), {
      channel: first.channel, tz: 'Asia/Kolkata',
      onSeek: (iso) => this.seekTo(new Date(iso).getTime() / 1000),
    });

    this.root.querySelector('[data-a=playpause]').addEventListener('click', () => this.togglePlay());
    this.root.querySelector('[data-a=stepfwd]').addEventListener('click', () => this.stepFrame(1));
    this.root.querySelector('[data-a=stepback]').addEventListener('click', () => this.stepFrame(-1));
    this.root.querySelector('[data-a=now]').addEventListener('click', () => this.seekTo(Date.now() / 1000 - 5, true));
    this.root.querySelector('[data-a=bookmark]').addEventListener('click', () => this.bookmarkHere());
    for (const s of REWIND_MACROS) this.root.querySelector(`[data-a=back${s}]`).addEventListener('click', () => this.seekTo(this.currentEpoch - s));

    this._bindTimeInputs();
    this._renderCamList();
    this._setSelection([first.id]);
    this._pollPool();
  }

  // ---------------------------------------------------------------- camera panel (multi-select, max 4)
  _renderCamList() {
    const list = this.root.querySelector('.cam-list');
    const cams = this.cams();
    const selected = new Set(this.panes.map((p) => p.cam.id));
    list.innerHTML = cams.map((c) => {
      const on = selected.has(c.id);
      const disable = !on && selected.size >= MAX_PANES;
      return `<label class="cam-item ${on ? 'on' : ''}" data-id="${c.id}">
        <input type="checkbox" ${on ? 'checked' : ''} ${disable ? 'disabled' : ''}>
        <span class="dot ${on ? 'live' : ''}"></span><span class="name">${esc(c.name || 'Camera ' + c.channel)}</span></label>`;
    }).join('');
    list.querySelectorAll('.cam-item input').forEach((cb) => cb.addEventListener('change', () => {
      const id = cb.closest('.cam-item').dataset.id;
      let ids = this.panes.map((p) => p.cam.id);
      if (cb.checked) { if (ids.length < MAX_PANES) ids.push(id); }
      else { ids = ids.filter((x) => x !== id); if (!ids.length) ids = [id]; } // never end up with zero panes
      this._setSelection(ids);
    }));
  }

  _setSelection(ids) {
    // Incremental: only tear down panes for cameras that were actually deselected, only create panes for
    // ones newly added. A full rebuild here would close and reopen every session on every checkbox click,
    // starving whichever pane's session request lands last against the DVR's 4-slot limit — reproduced and
    // confirmed directly (a 4th pane stalled indefinitely while three others kept reconnecting in a loop).
    const cams = this.cams();
    const primaryChanged = this.panes[0] && this.panes[0].cam.id !== ids[0];
    const keep = new Map(this.panes.map((p) => [p.cam.id, p]));
    for (const [id, pane] of keep) if (!ids.includes(id)) { pane.player.destroy(); keep.delete(id); }
    this.panes = ids.map((id) => keep.get(id) || this._makePane(cams.find((c) => c.id === id))).filter(Boolean);
    this._layoutPanes();
    this._renderCamList();
    this.timeline?.setChannel(this.primary.channel);
    if (primaryChanged) this._loadCalendarMonth();
    // Keep the current position in the URL (not just the camera) so a deep link from search survives a
    // refresh. This is the view syncing its own address as state changes, not a navigation, so replace
    // rather than push — otherwise every camera toggle fills history with entries that all render this
    // same view, and Back becomes a several-times-in-a-row no-op.
    this.ctx.replace(`#/playback/${this.primary.id}/${Math.round(this.currentEpoch)}`);
    // (re)connect only the panes that don't already have a live session at the current position
    const iso = new Date(this.currentEpoch * 1000).toISOString();
    for (const pane of this.panes) {
      if (pane.player.ws?.readyState === WebSocket.OPEN || pane.player.ws?.readyState === WebSocket.CONNECTING) continue;
      this.playing = true;
      pane.player.connect(pane.cam.id, iso, this.speed);
    }
    this._paintPlayIcon();
  }

  _makePane(cam) {
    if (!cam) return null;
    const el = document.createElement('div');
    el.className = 'pb-pane';
    el.innerHTML = `<div class="pb-pane-label">${esc(cam.name || 'Camera ' + cam.channel)}</div>
      <canvas></canvas>
      <div class="pb-veil"><div class="spin"></div><div class="msg">Loading…</div></div>`;
    const canvas = el.querySelector('canvas');
    const veil = el.querySelector('.pb-veil');
    const pane = { cam, el, canvas, veil };
    pane.player = new WCPlayer(canvas, {
      onFrame: (t) => this._onFrame(pane, t),
      onState: (s, m) => this._onPaneState(pane, s, m),
      onError: (m) => { this._onPaneState(pane, 'error', m); if (pane === this.panes[0]) toast(`${cam.name || 'Camera'}: ${m}`, 'bad', 6000); },
      onQueued: (info) => this._onPaneState(pane, 'queued', `Recorder busy: ${info.busy}/${info.limit} sessions in use`),
    });
    return pane;
  }

  _teardownPanes() {
    for (const p of this.panes) p.player.destroy();
    this.panes = [];
  }

  _layoutPanes() {
    this.stage.innerHTML = '';
    const n = this.panes.length;
    this.stage.className = 'pb-stage' + (n > 1 ? ' multi' : '');
    this.stage.style.gridTemplateColumns = n <= 1 ? '1fr' : n === 2 ? 'repeat(2, 1fr)' : n === 3 ? 'repeat(2, 1fr)' : 'repeat(2, 1fr)';
    this.stage.style.gridTemplateRows = n <= 2 ? '1fr' : 'repeat(2, 1fr)';
    for (const p of this.panes) this.stage.append(p.el);
  }

  // ---------------------------------------------------------------- calendar + time panel
  _bindTimeInputs() {
    const hh = this.root.querySelector('.t-hh'), mm = this.root.querySelector('.t-mm'), ss = this.root.querySelector('.t-ss');
    const commit = () => {
      const p = partsFromEpoch(this.currentEpoch, this.tzOffsetMin);
      const H = clampInt(hh.value, 0, 23, p.hh), M = clampInt(mm.value, 0, 59, p.mi), S = clampInt(ss.value, 0, 59, p.ss);
      this.seekTo(epochFromParts(p.y, p.mo, p.da, H, M, S, this.tzOffsetMin));
    };
    for (const inp of [hh, mm, ss]) {
      inp.addEventListener('change', commit);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); inp.blur(); } });
    }
  }

  async _loadCalendarMonth() {
    const { y, mo } = this.calView;
    const first = new Date(Date.UTC(y, mo, 1));
    const last = new Date(Date.UTC(y, mo + 1, 0));
    try {
      const cov = await fetch(`/api/timeline/coverage?channel=${this.primary.channel}&from_day=${iso(first)}&to_day=${iso(last)}`).then((r) => r.json());
      this.coverageDays = new Map(Object.entries(cov).map(([d, spans]) => [d, spans.length > 0]));
    } catch { this.coverageDays = new Map(); }
    this._renderCalendar();
  }

  _renderCalendar() {
    const host = this.root.querySelector('.pb-cal');
    const { y, mo } = this.calView;
    const sel = partsFromEpoch(this.currentEpoch, this.tzOffsetMin);
    const today = partsFromEpoch(Date.now() / 1000, this.tzOffsetMin);
    const firstWeekday = new Date(Date.UTC(y, mo, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push('<span class="cal-day empty"></span>');
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${y}-${pad2(mo + 1)}-${pad2(d)}`;
      const has = this.coverageDays.get(key);
      const isSel = sel.y === y && sel.mo === mo && sel.da === d;
      const isToday = today.y === y && today.mo === mo && today.da === d;
      cells.push(`<button class="cal-day${has ? ' has' : ''}${isSel ? ' sel' : ''}${isToday ? ' today' : ''}" data-day="${d}" ${has ? '' : 'disabled'} title="${has ? 'Recordings available' : 'No recordings'}">${d}</button>`);
    }
    host.innerHTML = `<div class="cal-head">
        <button class="btn sm icon ghost" data-a="prevmonth" aria-label="Previous month">${icon('left')}</button>
        <span class="cal-label">${MONTHS[mo]} ${y}</span>
        <button class="btn sm icon ghost" data-a="nextmonth" aria-label="Next month">${icon('right')}</button>
      </div>
      <div class="cal-week">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>`;
    host.querySelector('[data-a=prevmonth]').addEventListener('click', () => { this._shiftMonth(-1); });
    host.querySelector('[data-a=nextmonth]').addEventListener('click', () => { this._shiftMonth(1); });
    host.querySelectorAll('.cal-day.has').forEach((b) => b.addEventListener('click', () => {
      const day = +b.dataset.day;
      const p = partsFromEpoch(this.currentEpoch, this.tzOffsetMin);
      this.seekTo(epochFromParts(y, mo, day, p.hh, p.mi, p.ss, this.tzOffsetMin));
    }));
  }

  _shiftMonth(delta) {
    let { y, mo } = this.calView;
    mo += delta;
    if (mo < 0) { mo = 11; y--; } else if (mo > 11) { mo = 0; y++; }
    this.calView = { y, mo };
    this._loadCalendarMonth();
  }

  // ---------------------------------------------------------------- playback control (applies to every pane)
  play() {
    this.playing = true;
    this._paintPlayIcon();
    const iso = new Date(this.currentEpoch * 1000).toISOString();
    for (const p of this.panes) p.player.connect(p.cam.id, iso, this.speed);
  }

  pause() {
    this.playing = false;
    this._paintPlayIcon();
    for (const p of this.panes) p.player.disconnectSocket();
    this._onState('paused');
  }

  togglePlay() { this.playing ? this.pause() : this.play(); }

  seekTo(epoch, forceReconnect = false) {
    this.currentEpoch = epoch;
    this._renderTime();
    this.timeline?.setPlayhead(epoch);
    const p = partsFromEpoch(epoch, this.tzOffsetMin);
    if (p.y !== this.calView.y || p.mo !== this.calView.mo) { this.calView = { y: p.y, mo: p.mo }; this._loadCalendarMonth(); }
    else this._renderCalendar();
    if (!this.playing && !forceReconnect) return;
    const iso = new Date(epoch * 1000).toISOString();
    this.playing = true;
    this._paintPlayIcon();
    for (const pane of this.panes) {
      if (pane.player.ws?.readyState === WebSocket.OPEN && !forceReconnect) pane.player.seek(iso, this.speed);
      else pane.player.connect(pane.cam.id, iso, this.speed);
    }
  }

  setSpeed(s) {
    this.speed = s;
    if (!this.playing) return;
    for (const p of this.panes) if (p.player.ws?.readyState === WebSocket.OPEN) p.player.setSpeed(s);
  }

  async stepFrame(dir) {
    this.pause();
    for (const p of this.panes) { p.veil.hidden = false; p.veil.innerHTML = '<div class="spin"></div>'; }
    try {
      const results = await Promise.all(this.panes.map((p) =>
        (dir > 0 ? p.player.stepForward(this.currentEpoch, p.cam.id) : p.player.stepBackward(this.currentEpoch, p.cam.id))
          .then((t) => { if (t != null) p.veil.hidden = true; return t; })));
      const t = results[0];
      if (t != null) { this.currentEpoch = t; this._renderTime(); this.timeline?.setPlayhead(t); }
    } catch (e) {
      toast(String(e.message || e), 'bad');
    }
    for (const p of this.panes) p.veil.hidden = true;
  }

  // ---------------------------------------------------------------- per-pane state -> shared UI
  _onFrame(pane, absTime) {
    pane.veil.hidden = true;
    if (pane === this.panes[0]) {
      this.currentEpoch = absTime;
      this._renderTime();
      this.timeline?.setPlayhead(absTime);
    }
  }

  _onPaneState(pane, s, msg) {
    const labels = { connecting: ['wait', 'Connecting…'], queued: ['wait', msg || 'Queued…'], playing: ['live', 'Playing'],
      paused: ['off', 'Paused'], error: ['off', msg || 'Error'], idle: ['off', 'Idle'] };
    const [cls, label] = labels[s] || ['off', s];
    if (s === 'connecting' || s === 'queued') { pane.veil.hidden = false; pane.veil.innerHTML = `<div class="spin"></div><div class="msg">${esc(label)}</div>`; }
    if (s === 'error') pane.veil.innerHTML = `<div class="msg"><b>No signal</b><br>${esc(msg || '')}</div>`;
    if (pane === this.panes[0]) this._onState(s, msg);
  }

  _onState(s, msg) {
    const dot = this.statusEl.querySelector('.dot');
    const txt = this.statusEl.querySelector('.txt');
    const labels = { connecting: ['wait', 'Connecting…'], queued: ['wait', msg || 'Queued…'], playing: ['live', 'Playing'],
      paused: ['off', 'Paused'], error: ['off', msg || 'Error'], idle: ['off', 'Idle'] };
    const [cls, label] = labels[s] || ['off', s];
    dot.className = `dot ${cls}`;
    txt.textContent = label;
    if (s === 'error') { this.playing = false; this._paintPlayIcon(); }
  }

  async _pollPool() {
    if (this._poolTimer) return;
    const tick = async () => {
      try {
        const r = await fetch('/api/playback/pool').then((x) => x.json());
        this.poolEl.textContent = `${r.busy}/${r.limit} recorder sessions`;
        this.poolEl.classList.toggle('warn', r.busy >= r.limit);
      } catch { /* transient */ }
    };
    tick();
    this._poolTimer = setInterval(tick, 4000);
  }

  _renderTime() {
    const p = partsFromEpoch(this.currentEpoch, this.tzOffsetMin);
    this.timeEl.textContent = `${p.y}-${pad2(p.mo + 1)}-${pad2(p.da)}  ${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`;
    const hh = this.root.querySelector('.t-hh'), mm = this.root.querySelector('.t-mm'), ss = this.root.querySelector('.t-ss');
    if (hh && document.activeElement !== hh) hh.value = pad2(p.hh);
    if (mm && document.activeElement !== mm) mm.value = pad2(p.mi);
    if (ss && document.activeElement !== ss) ss.value = pad2(p.ss);
    this.root.querySelectorAll('.cal-day.sel').forEach((el) => el.classList.remove('sel'));
    const cell = this.root.querySelector(`.cal-day[data-day="${p.da}"]`);
    if (cell && this.calView.y === p.y && this.calView.mo === p.mo) cell.classList.add('sel');
  }

  _paintPlayIcon() {
    this.root.querySelector('[data-a=playpause]').innerHTML = icon(this.playing ? 'pause' : 'play');
  }

  _key(e) {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
    else if (e.key === '.') this.stepFrame(1);
    else if (e.key === ',') this.stepFrame(-1);
    else if (e.shiftKey && e.key === '1') this.seekTo(this.currentEpoch - 5);
    else if (e.shiftKey && e.key === '2') this.seekTo(this.currentEpoch - 10);
    else if (e.shiftKey && e.key === '3') this.seekTo(this.currentEpoch - 30);
    else if (e.key === 'b' || e.key === 'B') this.bookmarkHere();
  }

  // ---------------------------------------------------------------- bookmarks (spec section 9)
  async bookmarkHere() {
    if (!this.panes.length) return;
    const subtitle = this.panes.length === 1
      ? `${esc(this.primary.name || 'Camera ' + this.primary.channel)} · ${this.timeEl.textContent}`
      : `${this.panes.length} cameras · ${this.timeEl.textContent}`;
    const r = await bookmarkDialog({ subtitle });
    if (!r) return;
    try {
      await api.createBookmark({
        channels: this.panes.map((p) => p.cam.id),
        time_utc: new Date(this.currentEpoch * 1000).toISOString(),
        ...r,
      });
      toast('Bookmark saved.', 'ok');
      this.timeline?.refresh();
    } catch (e) {
      toast(e.message || 'Could not save the bookmark', 'bad');
    }
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey);
    clearInterval(this._poolTimer);
    this._teardownPanes();
    this.timeline?.destroy();
    this.root.innerHTML = '';
  }
}

function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
function iso(d) { return d.toISOString().slice(0, 10); }
