// Multi-scale timeline: coverage + event lanes, wheel/pinch zoom anchored at the cursor, drag to pan,
// click to seek. Renders to a <canvas>; data (coverage spans, events) is fetched per visible day and cached.
//
// Events are shown for every camera currently passed in (setChannels), one lane per camera, not just the
// first one picked — Playback used to bind the timeline to a single "primary" channel, so with more than
// one camera selected you'd only ever see one of them's events and had to deselect the others to check.
// Coverage (the recorded-footage bar) stays tied to the primary (first) channel only: it drives seeking
// and jump-to-date, which only make sense against one camera's actual recording at a time.
import { esc } from './ui.js';
import { partsFromEpoch } from './dvrtime.js';
import { getJSON } from './api.js';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MIN_PX_PER_SEC = 1440 / (24 * 3600);   // whole day fits ~1440px
const MAX_PX_PER_SEC = 200;                   // ~5ms/px at max zoom (frame-level)
// Fallback values only — real paint colours come from the --ev-*/--cam-* custom properties (app.css),
// read via getComputedStyle in draw() the same way --line/--muted/--accent already are just below. Kept
// here only so a missing stylesheet degrades instead of throwing (same defensive pattern as line/text/
// accent's own `|| '#333'`-style fallbacks).
const KIND_COLOR_FALLBACK = { motion: '#ff9f0a', line: '#0a84ff', intrusion: '#0a84ff', tamper: '#bf5af2', videoloss: '#8e8e93', bookmark: '#e5e5ea' };
const KIND_LABEL = { motion: 'Motion', line: 'Line cross', intrusion: 'Intrusion', tamper: 'Tamper', videoloss: 'Video loss', bookmark: 'Bookmark' };

const dayStr = (d) => d.toISOString().slice(0, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Board geometry: ruler labels on top, then the lane area. One camera = one tall lane (coverage + event
// ticks share it); every extra camera adds its own short tick row underneath, keyed by its lane colour.
const RULER_H = 18, LANE_TOP = 26, COV_H = 26, LANE_H = 14, LANE_GAP = 6, SNAP_PX = 10;
const CAM_COLORS_FALLBACK = ['#60a5fa', '#f472b6', '#34d399', '#fb923c'];   // per-camera lane accent (left edge + label), up to MAX_PANES=4

export class Timeline {
  /** @param el host element @param opts {channels: [{channel, name}] (primary first — drives coverage/seek), onSeek(isoTime), tzOffsetMin: DVR UTC offset in minutes} */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.opts.channels = this.opts.channels || (opts.channel != null ? [{ channel: opts.channel, name: '' }] : []);
    this.el.innerHTML = '<canvas></canvas><div class="tl-tip" hidden></div><button class="tl-jumpph" type="button" hidden></button>';
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.tip = el.querySelector('.tl-tip');
    this.jumpBtn = el.querySelector('.tl-jumpph');
    // Jump-to-playhead: shown only when the playhead (where playback actually is) has scrolled out of the
    // timeline's current view — e.g. after zooming/panning the timeline to look at something else, or
    // after playback has been running long enough to walk off the visible window. Points the way back.
    this.jumpBtn.addEventListener('click', () => { if (this.playhead != null) this.goTo(this.playhead); });
    this.hovered = null;
    this.center = Date.now() / 1000;   // epoch seconds at the horizontal center
    this.pxPerSec = 1 / 18;   // ~8 h across a desktop-width panel (the board's 12:00–20:00 view)
    this.cursorTime = null;
    this.coverage = new Map();   // day -> spans (primary channel only)
    this.events = [];            // events for every channel in opts.channels, each row carries its own .channel
    this._loadedRange = null;
    this.selectMode = false;   // when true, drag draws a range instead of panning (spec 10: select-to-export)
    this.selection = null;     // [startEpoch, endEpoch] while dragging or just after
    this.clips = [];           // [[startEpoch, endEpoch], …] — the multi-cut clipper's pending clip list (spec 10/15)
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(el);
    this._bind();
    this._sizeForLanes();
    this.reload();
  }


  /** [top, height] of camera lane i — lane 0 is the tall coverage lane, the rest short tick rows below. */
  _laneBox(i) {
    if (i === 0) return [LANE_TOP, COV_H];
    return [LANE_TOP + COV_H + LANE_GAP + (i - 1) * (LANE_H + LANE_GAP), LANE_H];
  }

  /** Index of a channel's lane (0 = primary/top), or -1 if it's not currently shown. */
  _laneIndex(channel) { return this.opts.channels.findIndex((c) => c.channel === channel); }

  /** Grows the timeline's height to fit one lane per camera (shrinks back to the CSS default for 0-1
   * cameras, so the single-camera case — by far the common one — renders pixel-identical to before). */
  _sizeForLanes() {
    const n = Math.max(1, this.opts.channels.length);
    this.el.style.height = `${LANE_TOP + COV_H + 30 + (n - 1) * (LANE_H + LANE_GAP)}px`;
  }

  /** Turns select-to-export drag mode on/off. While on, dragging the timeline draws a range instead of
   * panning; releasing calls opts.onRangeSelect(startEpoch, endEpoch) once and turns select mode back off. */
  setSelectMode(on) {
    this.selectMode = on;
    this.selection = null;
    this.canvas.style.cursor = on ? 'crosshair' : '';
    this.draw();
  }

  /** The multi-cut clipper's pending ranges (spec 10/15), drawn as cyan brackets so they stay visible —
   * and distinguishable from the ephemeral in-progress `selection` — while more clips are picked. */
  setClips(clips) {
    this.clips = clips || [];
    this.draw();
  }

  /** Clears the just-finished drag highlight once its range has been handed to onRangeSelect — otherwise
   * it lingers on screen looking like an active selection when nothing is actually pending anymore. */
  clearSelection() {
    this.selection = null;
    this.draw();
  }

  // ---------------------------------------------------------------- data
  async reload() {
    const chans = this.opts.channels;
    if (!chans.length) { this.coverage = new Map(); this.events = []; this.draw(); return; }
    const halfSpan = (this.canvas.clientWidth || 800) / this.pxPerSec / 2;
    const from = new Date((this.center - halfSpan - 86400) * 1000);
    const to = new Date((this.center + halfSpan + 86400) * 1000);
    const key = `${chans.map((c) => c.channel).join(',')}@${dayStr(from)}:${dayStr(to)}`;
    if (this._loadedRange === key) { this.draw(); return; }
    this._loadedRange = key;
    const evParams = chans.map((c) => `channel=${c.channel}`).join('&');
    const [cov, evs] = await Promise.all([
      getJSON(`/api/timeline/coverage?channel=${chans[0].channel}&from_day=${dayStr(from)}&to_day=${dayStr(to)}`),
      getJSON(`/api/timeline/events?${evParams}&start_utc=${from.toISOString()}&end_utc=${to.toISOString()}&limit=3000`),
    ]);
    // A slower request that started before a since-superseded setChannels() call could still resolve after
    // it — apply the result only if it's still what's currently wanted, or a quick primary swap could
    // flash the old camera's events back in after the new ones already loaded.
    if (this._loadedRange !== key) return;
    this.coverage = new Map(Object.entries(cov));
    this.events = evs;
    this.draw();
  }

  /** @param channels [{channel, name}], primary (drives coverage/seek) first. Cameras keep the same lane
   * whenever possible isn't attempted — lane order always mirrors the passed-in order (Playback's pane
   * order), so a lane can move if the pane order changes, which matches what's on screen above it. */
  setChannels(channels) {
    this.opts.channels = channels;
    this._loadedRange = null;
    this._sizeForLanes();
    this.reload();
  }

  /** Force a refetch of the current range even though it's already cached (e.g. right after adding a
   * bookmark, so its flag appears without waiting for a pan/zoom to invalidate the cache). */
  refresh() {
    this._loadedRange = null;
    this.reload();
  }

  goTo(epochSec, animate = false) {
    // Centre on the moment, but never leave the right half of the lane empty future: near "now" the live
    // edge sits just inside the right end (board), so the past fills the view.
    const half = (this.canvas.clientWidth || 800) / 2 / this.pxPerSec;
    const edge = Date.now() / 1000 + half * 0.06;
    this.center = Math.min(epochSec, edge - half);
    if (epochSec > this.center + half * 0.94) this.center = epochSec;
    this.reload();
  }

  /** Zoom around the centre (the panel's −/+ buttons). */
  zoomBy(factor) {
    this.pxPerSec = clamp(this.pxPerSec * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
    this.reload();
  }

  /** Visible [start, end] in epoch seconds. */
  viewRange() {
    const w = this.canvas.clientWidth || 800;
    return [this.center - w / 2 / this.pxPerSec, this.center + w / 2 / this.pxPerSec];
  }

  /** Nearest event start within SNAP_PX of time `t`, else `t` itself (board: "snaps to the nearest event"). */
  _snap(t) {
    let best = t, bestPx = SNAP_PX;
    for (const ev of this.events) {
      if (this._laneIndex(ev.channel) < 0) continue;
      const s = new Date(ev.start_utc).getTime() / 1000;
      const px = Math.abs(s - t) * this.pxPerSec;
      if (px < bestPx) { bestPx = px; best = s; }
    }
    return best;
  }

  // ---------------------------------------------------------------- input
  _bind() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    let drag = null;
    const timeAt = (clientX) => {
      const r = c.getBoundingClientRect();
      return this.center + (clientX - r.left - c.clientWidth / 2) / this.pxPerSec;
    };
    c.addEventListener('pointerdown', (e) => {
      // setPointerCapture means pointerleave won't fire again once a drag starts — if the tooltip was
      // showing at the moment of press, it would otherwise stay pinned over the timeline for the whole
      // drag (and after, if the pointer leaves the canvas without another move inside it first).
      this._hideTip();
      if (this.selectMode) {
        drag = { startTime: timeAt(e.clientX) };
        this.selection = [drag.startTime, drag.startTime];
        c.setPointerCapture(e.pointerId);
        return;
      }
      const y = e.clientY - c.getBoundingClientRect().top;
      // Board: drag anywhere on the lane to scrub; the ruler above it is the handle for panning the view.
      drag = { x: e.clientX, center: this.center, moved: 0, scrub: y >= LANE_TOP - 4 };
      if (drag.scrub) { this.scrubTime = timeAt(e.clientX); this.draw(); }
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      this.cursorTime = timeAt(e.clientX);
      if (drag && this.selectMode) {
        const t = timeAt(e.clientX);
        this.selection = [Math.min(drag.startTime, t), Math.max(drag.startTime, t)];
        this.draw();
      } else if (drag && drag.scrub) {
        drag.moved += Math.abs(e.clientX - drag.x);
        this.scrubTime = timeAt(e.clientX);
        this.draw();
        this._hideTip();
      } else if (drag) {
        const dx = e.clientX - drag.x;
        drag.moved += Math.abs(dx);
        this.center = drag.center - dx / this.pxPerSec;
        this.reload();
        this._hideTip();
      } else {
        this.draw();
        this._updateTip(e);
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (drag && this.selectMode) {
        const [a, b] = this.selection || [];
        this.selectMode = false;
        c.style.cursor = '';
        drag = null;
        if (a != null && b - a > 0.5) this.opts.onRangeSelect?.(a, b);
        else this.selection = null;
        this.draw();
        return;
      }
      if (drag && (drag.scrub || drag.moved < 4)) {
        const t = this._snap(timeAt(e.clientX));
        this.scrubTime = null;
        this.playhead = t;
        this.opts.onSeek?.(new Date(t * 1000).toISOString());
      }
      drag = null;
      this._hideTip(); // pointerleave doesn't fire during a captured drag — release must clear it explicitly
    });
    c.addEventListener('pointerleave', () => { this.cursorTime = null; this.draw(); this._hideTip(); });
    c.addEventListener('pointercancel', () => { drag = null; this.scrubTime = null; this.draw(); });
    c.addEventListener('gesturestart', (e) => { e.preventDefault(); this._gbase = this.pxPerSec; });
    c.addEventListener('gesturechange', (e) => { e.preventDefault(); this._zoomTo(this._gbase * e.scale, e); });
  }

  _wheel(e) {
    e.preventDefault();
    if (e.ctrlKey) { this._zoomTo(this.pxPerSec * Math.exp(-e.deltaY * 0.012), e); return; }
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) { this._zoomTo(this.pxPerSec * Math.exp(-e.deltaY * 0.0025), e); return; }
    this.center += (e.deltaX || e.deltaY) / this.pxPerSec;
    this.reload();
  }

  _zoomTo(px, e) {
    const r = this.canvas.getBoundingClientRect();
    const cursorX = e.clientX - r.left - this.canvas.clientWidth / 2;
    const t = this.center + cursorX / this.pxPerSec;
    this.pxPerSec = clamp(px, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
    this.center = t - cursorX / this.pxPerSec;
    this.reload();
  }

  // ---------------------------------------------------------------- drawing
  scaleLabel() {
    const spanSec = this.canvas.clientWidth / this.pxPerSec;
    if (spanSec > 3 * 3600) return `${(spanSec / 3600).toFixed(0)} h view`;
    if (spanSec > 90) return `${(spanSec / 60).toFixed(0)} min view`;
    return `${spanSec.toFixed(0)} s view`;
  }

  draw() {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 800, h = c.clientHeight || 90;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(document.documentElement);
    const v = (name, fb) => style.getPropertyValue(name).trim() || fb;
    const text = v('--muted', '#a1a1a6');
    const accent = v('--accent', '#0074e8');
    const laneBase = v('--panel-2', '#222226');
    const laneRec = v('--tl-rec', '#2a2a2f');
    const kindColor = {
      motion: v('--ev-motion', KIND_COLOR_FALLBACK.motion), line: v('--ev-line', KIND_COLOR_FALLBACK.line),
      intrusion: v('--ev-line', KIND_COLOR_FALLBACK.intrusion), tamper: v('--tamper', KIND_COLOR_FALLBACK.tamper),
      videoloss: v('--ev-videoloss', KIND_COLOR_FALLBACK.videoloss), bookmark: v('--ev-bookmark', KIND_COLOR_FALLBACK.bookmark),
    };
    const camColors = ['--cam-1', '--cam-2', '--cam-3', '--cam-4'].map((n, i) => v(n, CAM_COLORS_FALLBACK[i]));
    const t0 = this.center - w / 2 / this.pxPerSec;
    const X = (t) => (t - t0) * this.pxPerSec;
    const chans = this.opts.channels;
    const nLanes = Math.max(1, chans.length);
    const lanesBottom = this._laneBox(nLanes - 1)[0] + this._laneBox(nLanes - 1)[1];

    // ruler — labels on top (board), a hairline tick under each
    const spanSec = w / this.pxPerSec;
    const MIN_LABEL_PX = 92;
    const step = niceStep(spanSec / Math.max(3, Math.floor(w / MIN_LABEL_PX)));
    ctx.font = '12px -apple-system, system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.fillStyle = text;
    ctx.strokeStyle = v('--line', 'rgba(255,255,255,.09)');
    for (let t = Math.floor(t0 / step) * step; t < t0 + spanSec + step; t += step) {
      const x = X(t);
      ctx.fillText(fmtTick(t, step, this.opts.tzOffsetMin), x, 0);
      ctx.beginPath(); ctx.moveTo(x + .5, RULER_H - 2); ctx.lineTo(x + .5, RULER_H + 2); ctx.stroke();
    }

    // coverage lane: neutral rounded bar, recorded spans a step lighter, gaps hatched (nothing recorded)
    ctx.save();
    ctx.beginPath(); ctx.roundRect(0, LANE_TOP, w, COV_H, 6); ctx.clip();
    ctx.fillStyle = laneBase; ctx.fillRect(0, LANE_TOP, w, COV_H);
    ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 6;
    for (let x = -COV_H - ((t0 * this.pxPerSec) % 12); x < w + COV_H; x += 12) { ctx.beginPath(); ctx.moveTo(x, LANE_TOP + COV_H); ctx.lineTo(x + COV_H, LANE_TOP); ctx.stroke(); }
    ctx.lineWidth = 1;
    ctx.fillStyle = laneRec;
    for (const [, spans] of this.coverage) for (const [s0, e0] of spans) {
      const x1 = X(new Date(s0).getTime() / 1000), x2 = X(new Date(e0).getTime() / 1000);
      if (x2 < 0 || x1 > w) continue;
      ctx.fillRect(x1, LANE_TOP, Math.max(1, x2 - x1), COV_H);
    }
    ctx.restore();
    // extra camera rows
    for (let i = 1; i < nLanes; i++) {
      const [top, hh] = this._laneBox(i);
      ctx.fillStyle = laneBase; ctx.beginPath(); ctx.roundRect(0, top, w, hh, 4); ctx.fill();
    }
    if (nLanes > 1) for (let i = 0; i < nLanes; i++) {
      const [top, hh] = this._laneBox(i);
      ctx.fillStyle = camColors[i % camColors.length];
      ctx.beginPath(); ctx.roundRect(4, top + hh / 2 - 3, 6, 6, 2); ctx.fill();
    }

    // event ticks (board: thin coloured bars through the lane); spans wider than a tick keep their length
    for (const ev of this.events) {
      const i = this._laneIndex(ev.channel);
      if (i < 0) continue;
      const [top, hh] = this._laneBox(i);
      const x1 = X(new Date(ev.start_utc).getTime() / 1000), x2 = X(new Date(ev.end_utc).getTime() / 1000);
      if (x2 < -3 || x1 > w + 3) continue;
      ctx.fillStyle = kindColor[ev.kind] || accent;
      const y0 = i === 0 ? top - 4 : top, y1 = i === 0 ? (nLanes > 1 ? top + hh + 4 : lanesBottom + 26) : top + hh;
      ctx.globalAlpha = i === 0 && nLanes === 1 ? 1 : .95;
      ctx.beginPath(); ctx.roundRect(x1 - 1, y0, Math.max(3, x2 - x1), y1 - y0, 1.5); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // pending clips (multi-cut list) and the selection being dragged — the board's blue range with handles
    const range = (a, b, strong) => {
      const x1 = X(a), x2 = X(b);
      if (x2 < -6 || x1 > w + 6) return;
      ctx.fillStyle = accent + (strong ? '33' : '22');
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(x1, LANE_TOP - 4, Math.max(2, x2 - x1), COV_H + 8, 6); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = accent;
      for (const x of [x1, x2]) { ctx.beginPath(); ctx.roundRect(x - 5, LANE_TOP + COV_H / 2 - 10, 10, 20, 3); ctx.fill(); }
    };
    for (const [a, b] of this.clips) range(a, b, false);
    if (this.selection) range(this.selection[0], this.selection[1], true);

    // live edge
    const nowX = X(Date.now() / 1000);
    if (nowX >= 0 && nowX <= w) {
      const live = v('--live', '#ff3b30');
      ctx.fillStyle = live; ctx.fillRect(nowX - 1, LANE_TOP - 6, 2, h - LANE_TOP + 6);
      ctx.font = '700 10px -apple-system, system-ui, sans-serif';
      const tw = ctx.measureText('LIVE').width + 14;
      const lx = Math.max(0, Math.min(w - tw, nowX - tw - 4)), ly = lanesBottom + 6;
      ctx.fillStyle = 'rgba(255,59,48,.18)'; ctx.beginPath(); ctx.roundRect(lx, ly, tw, 16, 8); ctx.fill();
      ctx.fillStyle = '#ff6a5f'; ctx.textBaseline = 'middle'; ctx.fillText('LIVE', lx + 7, ly + 8.5); ctx.textBaseline = 'top';
    }

    // hover cursor
    if (this.cursorTime != null && this.scrubTime == null) {
      const x = X(this.cursorTime);
      ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(x, LANE_TOP - 4, 1, lanesBottom - LANE_TOP + 8);
    }

    // playhead (or the scrub preview while dragging): white line + the white chip
    const ph = this.scrubTime ?? this.playhead;
    if (ph != null) {
      const x = X(ph);
      if (x >= -8 && x <= w + 8) {
        ctx.fillStyle = '#fff'; ctx.fillRect(x - 1, LANE_TOP - 6, 2, h - LANE_TOP + 6);
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, .5)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(x - 7, LANE_TOP - 14, 14, 14, 4); ctx.fill();
        ctx.restore();
        this.jumpBtn.hidden = true;
      } else {
        // Off-screen either side — point back to it rather than leaving the user to guess which way to pan.
        this.jumpBtn.hidden = false;
        this.jumpBtn.classList.toggle('left', x < 0);
        this.jumpBtn.classList.toggle('right', x >= 0);
        this.jumpBtn.textContent = x < 0 ? '‹ Playhead' : 'Playhead ›';
        this.jumpBtn.title = 'Jump the timeline back to the playhead';
      }
    } else {
      this.jumpBtn.hidden = true;
    }
    this.opts.onView?.(t0, t0 + spanSec, ph);
  }

  setPlayhead(epochSec) { this.playhead = epochSec; this.draw(); }

  // ---------------------------------------------------------------- hover tooltip (kind + start/end)
  /** Finds the event under (clientX, clientY), matching the same geometry draw() uses for the events lane,
   * so the hit area always agrees with what's actually drawn (including the bookmark flag's shape). */
  _hitTest(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const nLanes = Math.max(1, this.opts.channels.length);
    let laneAtY = -1;
    for (let i = 0; i < nLanes; i++) { const [top, hh] = this._laneBox(i); if (y >= top - 4 && y <= top + hh + 4) laneAtY = i; }
    if (laneAtY < 0) return null;
    const t0 = this.center - r.width / 2 / this.pxPerSec;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (this._laneIndex(ev.channel) !== laneAtY) continue;
      const x1 = (new Date(ev.start_utc).getTime() / 1000 - t0) * this.pxPerSec;
      const x2 = (new Date(ev.end_utc).getTime() / 1000 - t0) * this.pxPerSec;
      if (x >= x1 - 3 && x <= Math.max(x1 + 3, x2) + 3) return ev;
    }
    return null;
  }


  _updateTip(e) {
    const ev = this._hitTest(e.clientX, e.clientY);
    this.hovered = ev;
    const fmt = (epochSec) => fmtInstant(epochSec, this.opts.tzOffsetMin);
    if (ev) {
      const startSec = new Date(ev.start_utc).getTime() / 1000, endSec = new Date(ev.end_utc).getTime() / 1000;
      const durSec = Math.max(0, endSec - startSec);
      const when = durSec < 1 ? fmt(startSec) : `${fmt(startSec)} → ${fmt(endSec)}`;
      const cam = this.opts.channels.length > 1 ? this.opts.channels.find((c) => c.channel === ev.channel)?.name : null;
      const title = cam ? `${KIND_LABEL[ev.kind] || ev.kind} · ${cam}` : (KIND_LABEL[ev.kind] || ev.kind);
      // Bookmarks are the one kind with an operator-given name — show it as its own line rather than
      // making the operator click through to find out what they flagged this moment for.
      let bmTitle = '';
      if (ev.kind === 'bookmark' && ev.attrs_json) {
        try { bmTitle = JSON.parse(ev.attrs_json).title || ''; } catch { /* malformed, skip */ }
      }
      this.tip.innerHTML = `<b>${esc(title)}</b>${bmTitle ? `<span class="tl-tip-name">${esc(bmTitle)}</span>` : ''}<span>${esc(when)}</span>`;
      this.canvas.style.cursor = 'pointer';
    } else {
      // No event under the pointer — still show what time this point on the timeline is, so hovering
      // anywhere (not just a marker) tells you what clicking there would seek to.
      if (this.cursorTime == null) { this._hideTip(); return; }
      this.tip.innerHTML = `<span>${esc(fmt(this.cursorTime))}</span>`;
      this.canvas.style.cursor = 'crosshair';
    }
    this.tip.hidden = false;
    const hostRect = this.el.getBoundingClientRect();
    let left = e.clientX - hostRect.left + 12;
    const tw = this.tip.offsetWidth || 160;
    if (left + tw > hostRect.width - 8) left = e.clientX - hostRect.left - tw - 12;
    this.tip.style.left = `${Math.max(4, left)}px`;
    this.tip.style.top = `${Math.max(2, 28 - 34)}px`;
  }

  _hideTip() {
    this.hovered = null;
    this.tip.hidden = true;
    if (!this.selectMode) this.canvas.style.cursor = '';
  }

  destroy() { this.ro.disconnect(); }
}

function niceStep(target) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400];
  return steps.find((s) => s >= target) || 86400;
}

// Manual DVR-local formatting (shift-then-read-UTC-fields, same trick as dvrtime.js/events.js) rather than
// Intl's `timeZone` option: the DVR only ever gives us a raw UTC-minute offset, never a real IANA zone name
// (see dvrtime.js's own header comment) — handing that offset to `toLocaleString({timeZone: ...})` needs a
// zone STRING, so this used to pass a hardcoded 'Asia/Kolkata' that only ever matched this deployment's
// current offset by coincidence. Any DVR on a different UTC offset would have the timeline's own tick
// labels and hover times silently drawn in the wrong zone while every other DVR-local read-out in the app
// (the date/time picker, event list, etc.) used the real fetched offset — exactly the kind of "looks right,
// isn't" desync this pass is trying to eliminate everywhere at once, not just in the seek path.
function fmtTick(epochSec, step, tzOffsetMin) {
  const p = partsFromEpoch(epochSec, tzOffsetMin);
  const hh = String(p.hh).padStart(2, '0'), mi = String(p.mi).padStart(2, '0'), ss = String(p.ss).padStart(2, '0');
  if (step >= 3600) {
    // Board ruler: plain "13:00" — the date only where a day actually begins (or at day-scale zoom).
    const datePart = `${p.da} ${MONTH_ABBR[p.mo]}`;
    return step >= 86400 || p.hh === 0 ? datePart : `${hh}:00`;
  }
  if (step >= 60) return `${hh}:${mi}`;
  return `${hh}:${mi}:${ss}`;
}

function fmtInstant(epochSec, tzOffsetMin) {
  const p = partsFromEpoch(epochSec, tzOffsetMin);
  const hh = String(p.hh).padStart(2, '0'), mi = String(p.mi).padStart(2, '0'), ss = String(p.ss).padStart(2, '0');
  return `${p.da} ${MONTH_ABBR[p.mo]}, ${hh}:${mi}:${ss}`;
}
