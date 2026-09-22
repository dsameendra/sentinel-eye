// Playback view: single-camera DVR review. Left panel = camera list, center = video + transport,
// right panel = calendar/time jump, bottom = timeline (coverage + events). docs/playback-spec.md section 7.
import { Timeline } from './timeline.js';
import { esc, icon, toast } from './ui.js';
import { WCPlayer } from './wcplayer.js';

const SPEEDS = ['0.125', '0.25', '0.5', '1', '2', '4', '8', '16'];
const REWIND_MACROS = [5, 10, 30];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad2 = (n) => String(n).padStart(2, '0');

// DVR-local date math via a raw UTC-offset (the DVR gives us an offset, not an IANA zone).
const partsFromEpoch = (epochSec, offMin) => {
  const d = new Date((epochSec + offMin * 60) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(), hh: d.getUTCHours(), mi: d.getUTCMinutes(), ss: d.getUTCSeconds() };
};
const epochFromParts = (y, mo, da, hh, mi, ss, offMin) => Date.UTC(y, mo, da, hh, mi, ss) / 1000 - offMin * 60;

export class PlaybackView {
  /** @param ctx { settings(), go(hash) } */
  constructor(root, ctx, channelId) {
    this.root = root;
    this.ctx = ctx;
    this.playing = false;
    this.currentEpoch = Date.now() / 1000 - 30;
    this.speed = '1';
    this.tzOffsetMin = 330; // Asia/Kolkata default until /api/timeline/tz answers
    this.calView = null;
    this.coverageDays = new Map(); // 'YYYY-MM-DD' -> bool (has any recording)
    this.onKey = (e) => this._key(e);
    document.addEventListener('keydown', this.onKey);
    this._init(channelId);
  }

  async _init(channelId) {
    try {
      const r = await fetch('/api/timeline/tz').then((x) => x.json());
      if (r.ready) this.tzOffsetMin = r.offset_minutes;
    } catch { /* keep the default */ }
    this.build(channelId);
  }

  cams() { return this.ctx.settings().channels.filter((c) => c.enabled); }

  build(channelId) {
    const cams = this.cams();
    if (!cams.length) {
      this.root.innerHTML = `<div class="pb"><div class="center-card"><h2>No cameras</h2><p>Enable a channel in Settings first.</p>
        <a class="btn primary" href="#/settings/channels">Open settings</a></div></div>`;
      return;
    }
    this.cam = cams.find((c) => c.id === channelId) || cams[0];
    const parts = partsFromEpoch(this.currentEpoch, this.tzOffsetMin);
    this.calView = { y: parts.y, mo: parts.mo };

    this.root.innerHTML = `<div class="pb">
      <div class="pb-body">
        <aside class="pb-side pb-side-left">
          <h3>Cameras</h3>
          <div class="cam-list"></div>
        </aside>
        <div class="pb-center">
          <div class="pb-topline">
            <span class="pill pb-status"><span class="dot wait"></span><span class="txt">connecting…</span></span>
            <span class="pb-time"></span>
            <span class="spacer"></span>
            <span class="pill pb-source" title="Where the video is coming from">DVR playback session</span>
          </div>
          <div class="pb-stage"><canvas class="pb-canvas"></canvas>
            <div class="pb-veil"><div class="spin"></div><div class="msg">Loading…</div></div></div>
          <div class="pb-transport">
            <button class="btn icon" data-a="back30" title="Back 30 s (Shift+3)">30<span class="u">s</span></button>
            <button class="btn icon" data-a="back10" title="Back 10 s (Shift+2)">10<span class="u">s</span></button>
            <button class="btn icon" data-a="back5" title="Back 5 s (Shift+1)">5<span class="u">s</span></button>
            <button class="btn icon" data-a="stepback" title="Previous frame (,)">${icon('left')}</button>
            <button class="btn icon primary" data-a="playpause" title="Play / pause (Space)">${icon('play')}</button>
            <button class="btn icon" data-a="stepfwd" title="Next frame (.)">${icon('right')}</button>
            <select class="pb-speed" aria-label="Speed"></select>
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

    this._renderCamList();
    const speedSel = this.root.querySelector('.pb-speed');
    speedSel.innerHTML = SPEEDS.map((s) => `<option value="${s}" ${s === '1' ? 'selected' : ''}>${s.startsWith('0.') ? '1/' + Math.round(1 / parseFloat(s)) : s}×</option>`).join('');
    speedSel.addEventListener('change', () => this.setSpeed(speedSel.value));

    this.canvas = this.root.querySelector('.pb-canvas');
    this.veil = this.root.querySelector('.pb-veil');
    this.statusEl = this.root.querySelector('.pb-status');
    this.timeEl = this.root.querySelector('.pb-time');

    this.player = new WCPlayer(this.canvas, {
      onFrame: (t) => this._onFrame(t),
      onState: (s) => this._onState(s),
      onError: (m) => { toast(m, 'bad', 6000); this._onState('error', m); },
      onQueued: (info) => this._onState('queued', `Recorder busy: ${info.busy}/${info.limit} playback sessions in use`),
    });
    if (!this.player.supported) {
      this.veil.innerHTML = `<div class="msg"><b>This browser can't play DVR recordings.</b><br>Chrome, Edge or Safari 16.4+ is needed (WebCodecs).</div>`;
      return;
    }

    this.timeline = new Timeline(this.root.querySelector('.pb-timeline'), {
      channel: this.cam.channel, tz: 'Asia/Kolkata',
      onSeek: (iso) => this.seekTo(new Date(iso).getTime() / 1000),
    });

    this.root.querySelector('[data-a=playpause]').addEventListener('click', () => this.togglePlay());
    this.root.querySelector('[data-a=stepfwd]').addEventListener('click', () => this.stepFrame(1));
    this.root.querySelector('[data-a=stepback]').addEventListener('click', () => this.stepFrame(-1));
    this.root.querySelector('[data-a=now]').addEventListener('click', () => this.seekTo(Date.now() / 1000 - 5, true));
    for (const s of REWIND_MACROS) this.root.querySelector(`[data-a=back${s}]`).addEventListener('click', () => this.seekTo(this.currentEpoch - s));

    this._bindTimeInputs();
    this._loadCalendarMonth();
    this._renderTime();

    this.play();
  }

  // ---------------------------------------------------------------- camera panel
  _renderCamList() {
    const list = this.root.querySelector('.cam-list');
    const cams = this.cams();
    list.innerHTML = cams.map((c) => `<button class="cam-item" data-id="${c.id}" aria-pressed="${c.id === this.cam.id}">
        <span class="dot ${c.id === this.cam.id ? 'live' : ''}"></span><span class="name">${esc(c.name || 'Camera ' + c.channel)}</span></button>`).join('');
    list.querySelectorAll('.cam-item').forEach((b) => b.addEventListener('click', () => this.switchCamera(b.dataset.id)));
  }

  switchCamera(id) {
    const cam = this.cams().find((c) => c.id === id);
    if (!cam || cam.id === this.cam.id) return;
    this.cam = cam;
    this.root.querySelectorAll('.cam-item').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.id === id));
      b.querySelector('.dot').className = `dot ${b.dataset.id === id ? 'live' : ''}`;
    });
    this.timeline?.setChannel(cam.channel);
    this._loadCalendarMonth();
    this.ctx.go(`#/playback/${cam.id}`);
    this.seekTo(this.currentEpoch, true);
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
      const cov = await fetch(`/api/timeline/coverage?channel=${this.cam.channel}&from_day=${iso(first)}&to_day=${iso(last)}`).then((r) => r.json());
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

  // ---------------------------------------------------------------- playback control
  play() {
    this.playing = true;
    this._paintPlayIcon();
    this.player.connect(this.cam.id, new Date(this.currentEpoch * 1000).toISOString(), this.speed);
  }

  pause() {
    this.playing = false;
    this._paintPlayIcon();
    this.player.disconnectSocket();
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
    if (this.playing || forceReconnect) {
      if (this.player.ws?.readyState === WebSocket.OPEN && !forceReconnect) {
        this.player.seek(new Date(epoch * 1000).toISOString(), this.speed);
      } else {
        this.playing = true;
        this._paintPlayIcon();
        this.player.connect(this.cam.id, new Date(epoch * 1000).toISOString(), this.speed);
      }
    }
  }

  setSpeed(s) {
    this.speed = s;
    if (this.playing && this.player.ws?.readyState === WebSocket.OPEN) this.player.setSpeed(s);
  }

  async stepFrame(dir) {
    this.pause();
    this.veil.hidden = false;
    this.veil.innerHTML = '<div class="spin"></div>';
    try {
      const t = dir > 0 ? await this.player.stepForward(this.currentEpoch, this.cam.id) : await this.player.stepBackward(this.currentEpoch, this.cam.id);
      if (t != null) { this.currentEpoch = t; this._renderTime(); this.timeline?.setPlayhead(t); }
      this.veil.hidden = true;
    } catch (e) {
      toast(String(e.message || e), 'bad');
      this.veil.hidden = true;
    }
  }

  _onFrame(absTime) {
    this.currentEpoch = absTime;
    this._renderTime();
    this.timeline?.setPlayhead(absTime);
    this.veil.hidden = true;
  }

  _onState(s, msg) {
    const dot = this.statusEl.querySelector('.dot');
    const txt = this.statusEl.querySelector('.txt');
    const labels = { connecting: ['wait', 'Connecting…'], queued: ['wait', msg || 'Queued…'], playing: ['live', 'Playing'],
      paused: ['off', 'Paused'], error: ['off', msg || 'Error'], idle: ['off', 'Idle'] };
    const [cls, label] = labels[s] || ['off', s];
    dot.className = `dot ${cls}`;
    txt.textContent = label;
    if (s === 'connecting' || s === 'queued') { this.veil.hidden = false; this.veil.innerHTML = `<div class="spin"></div><div class="msg">${esc(label)}</div>`; }
    if (s === 'error') { this.veil.hidden = false; this.veil.innerHTML = `<div class="msg"><b>No signal</b><br>${esc(msg || '')}</div>`; this.playing = false; this._paintPlayIcon(); }
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
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey);
    this.player?.destroy();
    this.timeline?.destroy();
    this.root.innerHTML = '';
  }
}

function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
function iso(d) { return d.toISOString().slice(0, 10); }
