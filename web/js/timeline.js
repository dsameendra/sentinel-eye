// Multi-scale timeline: coverage + event lanes, wheel/pinch zoom anchored at the cursor, drag to pan,
// click to seek. Renders to a <canvas>; data (coverage spans, events) is fetched per visible day and cached.
import { esc } from './ui.js';

const MIN_PX_PER_SEC = 1440 / (24 * 3600);   // whole day fits ~1440px
const MAX_PX_PER_SEC = 200;                   // ~5ms/px at max zoom (frame-level)
const KIND_COLOR = { motion: '#eab308', line: '#f87171', intrusion: '#f87171', tamper: '#f87171', videoloss: '#6b7280', bookmark: '#22d3ee' };
const KIND_LABEL = { motion: 'Motion', line: 'Line cross', intrusion: 'Intrusion', tamper: 'Tamper', videoloss: 'Video loss', bookmark: 'Bookmark' };

const dayStr = (d) => d.toISOString().slice(0, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Timeline {
  /** @param el host element @param opts {channel (DVR channel number), onSeek(isoTime), tz} */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.el.innerHTML = '<canvas></canvas><div class="tl-tip" hidden></div>';
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.tip = el.querySelector('.tl-tip');
    this.hovered = null;
    this.center = Date.now() / 1000;   // epoch seconds at the horizontal center
    this.pxPerSec = 1440 / (24 * 3600);
    this.cursorTime = null;
    this.coverage = new Map();   // day -> spans
    this.events = [];
    this._loadedRange = null;
    this.selectMode = false;   // when true, drag draws a range instead of panning (spec 10: select-to-export)
    this.selection = null;     // [startEpoch, endEpoch] while dragging or just after
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(el);
    this._bind();
    this.reload();
  }

  /** Turns select-to-export drag mode on/off. While on, dragging the timeline draws a range instead of
   * panning; releasing calls opts.onRangeSelect(startEpoch, endEpoch) once and turns select mode back off. */
  setSelectMode(on) {
    this.selectMode = on;
    this.selection = null;
    this.canvas.style.cursor = on ? 'crosshair' : '';
    this.draw();
  }

  // ---------------------------------------------------------------- data
  async reload() {
    const halfSpan = (this.canvas.clientWidth || 800) / this.pxPerSec / 2;
    const from = new Date((this.center - halfSpan - 86400) * 1000);
    const to = new Date((this.center + halfSpan + 86400) * 1000);
    const key = `${dayStr(from)}:${dayStr(to)}`;
    if (this._loadedRange === key) { this.draw(); return; }
    this._loadedRange = key;
    const [cov, evs] = await Promise.all([
      fetch(`/api/timeline/coverage?channel=${this.opts.channel}&from_day=${dayStr(from)}&to_day=${dayStr(to)}`).then((r) => r.json()),
      fetch(`/api/timeline/events?channel=${this.opts.channel}&start_utc=${from.toISOString()}&end_utc=${to.toISOString()}&limit=3000`).then((r) => r.json()),
    ]);
    this.coverage = new Map(Object.entries(cov));
    this.events = evs;
    this.draw();
  }

  setChannel(channel) {
    this.opts.channel = channel;
    this._loadedRange = null;
    this.reload();
  }

  /** Force a refetch of the current range even though it's already cached (e.g. right after adding a
   * bookmark, so its flag appears without waiting for a pan/zoom to invalidate the cache). */
  refresh() {
    this._loadedRange = null;
    this.reload();
  }

  goTo(epochSec, animate = false) {
    this.center = epochSec;
    this.reload();
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
      drag = { x: e.clientX, center: this.center, moved: 0 };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      this.cursorTime = timeAt(e.clientX);
      if (drag && this.selectMode) {
        const t = timeAt(e.clientX);
        this.selection = [Math.min(drag.startTime, t), Math.max(drag.startTime, t)];
        this.draw();
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
      if (drag && drag.moved < 4) {
        const t = timeAt(e.clientX);
        this.opts.onSeek?.(new Date(t * 1000).toISOString());
      }
      drag = null;
      this._hideTip(); // pointerleave doesn't fire during a captured drag — release must clear it explicitly
    });
    c.addEventListener('pointerleave', () => { this.cursorTime = null; this.draw(); this._hideTip(); });
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
    const line = style.getPropertyValue('--line').trim() || '#333';
    const text = style.getPropertyValue('--muted').trim() || '#888';
    const accent = style.getPropertyValue('--accent').trim() || '#34d399';

    const t0 = this.center - w / 2 / this.pxPerSec;
    const covY = 6, covH = 16, evY = 28, evH = 14, gridY = h - 20;

    // coverage lane
    for (const [day, spans] of this.coverage) {
      for (const [s, e] of spans) {
        const x1 = (new Date(s).getTime() / 1000 - t0) * this.pxPerSec;
        const x2 = (new Date(e).getTime() / 1000 - t0) * this.pxPerSec;
        if (x2 < 0 || x1 > w) continue;
        ctx.fillStyle = accent + '55';
        ctx.fillRect(x1, covY, Math.max(1, x2 - x1), covH);
      }
    }
    // events lane
    for (const ev of this.events) {
      const x1 = (new Date(ev.start_utc).getTime() / 1000 - t0) * this.pxPerSec;
      const x2 = (new Date(ev.end_utc).getTime() / 1000 - t0) * this.pxPerSec;
      if (x2 < -2 || x1 > w + 2) continue;
      if (ev.kind === 'bookmark') {
        // a small flag above the lane rather than a bar — bookmarks are an instant, not a span
        ctx.fillStyle = KIND_COLOR.bookmark;
        ctx.beginPath(); ctx.moveTo(x1, evY - 12); ctx.lineTo(x1 + 9, evY - 8); ctx.lineTo(x1, evY - 4); ctx.closePath(); ctx.fill();
        ctx.fillRect(x1 - 1, evY - 12, 2, evH + 12);
        continue;
      }
      ctx.fillStyle = KIND_COLOR[ev.kind] || '#60a5fa';
      ctx.fillRect(x1, evY, Math.max(2, x2 - x1), evH);
    }
    // time grid + labels
    const spanSec = w / this.pxPerSec;
    const step = niceStep(spanSec / 8);
    ctx.strokeStyle = line; ctx.fillStyle = text; ctx.font = '11px system-ui'; ctx.textBaseline = 'top';
    const first = Math.floor(t0 / step) * step;
    for (let t = first; t < t0 + spanSec + step; t += step) {
      const x = (t - t0) * this.pxPerSec;
      ctx.beginPath(); ctx.moveTo(x, gridY); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(fmtTick(t, step, this.opts.tz), x + 3, gridY + 3);
    }
    // now marker
    const nowX = (Date.now() / 1000 - t0) * this.pxPerSec;
    if (nowX >= 0 && nowX <= w) { ctx.strokeStyle = '#f87171'; ctx.beginPath(); ctx.moveTo(nowX, 0); ctx.lineTo(nowX, h); ctx.stroke(); }
    // cursor
    if (this.cursorTime != null) {
      const x = (this.cursorTime - t0) * this.pxPerSec;
      ctx.strokeStyle = text; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    // in-progress or just-finished range selection
    if (this.selection) {
      const [a, b] = this.selection;
      const x1 = (a - t0) * this.pxPerSec, x2 = (b - t0) * this.pxPerSec;
      ctx.fillStyle = accent + '33';
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), h);
      ctx.strokeStyle = accent;
      ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, h); ctx.moveTo(x2, 0); ctx.lineTo(x2, h); ctx.stroke();
    }
    // playhead
    if (this.playhead != null) {
      const x = (this.playhead - t0) * this.pxPerSec;
      if (x >= -5 && x <= w + 5) {
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = accent; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }
  }

  setPlayhead(epochSec) { this.playhead = epochSec; this.draw(); }

  // ---------------------------------------------------------------- hover tooltip (kind + start/end)
  /** Finds the event under (clientX, clientY), matching the same geometry draw() uses for the events lane,
   * so the hit area always agrees with what's actually drawn (including the bookmark flag's shape). */
  _hitTest(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const evY = 28, evH = 14;
    if (y < evY - 14 || y > evY + evH + 3) return null; // outside the events lane (generous for the bookmark flag above it)
    const t0 = this.center - r.width / 2 / this.pxPerSec;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      const x1 = (new Date(ev.start_utc).getTime() / 1000 - t0) * this.pxPerSec;
      const x2 = (new Date(ev.end_utc).getTime() / 1000 - t0) * this.pxPerSec;
      const isBookmark = ev.kind === 'bookmark';
      const left = isBookmark ? x1 - 3 : x1 - 1, right = isBookmark ? x1 + 10 : Math.max(x1 + 2, x2) + 1;
      if (x >= left && x <= right) return ev;
    }
    return null;
  }

  _updateTip(e) {
    const ev = this._hitTest(e.clientX, e.clientY);
    this.hovered = ev;
    if (!ev) { this._hideTip(); return; }
    const fmt = (iso) => new Date(iso).toLocaleString(undefined, { timeZone: this.opts.tz, hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const durSec = Math.max(0, (new Date(ev.end_utc) - new Date(ev.start_utc)) / 1000);
    const when = durSec < 1 ? fmt(ev.start_utc) : `${fmt(ev.start_utc)} → ${fmt(ev.end_utc)}`;
    this.tip.innerHTML = `<b>${esc(KIND_LABEL[ev.kind] || ev.kind)}</b><span>${esc(when)}</span>`;
    this.tip.hidden = false;
    const hostRect = this.el.getBoundingClientRect();
    let left = e.clientX - hostRect.left + 12;
    const tw = this.tip.offsetWidth || 160;
    if (left + tw > hostRect.width - 8) left = e.clientX - hostRect.left - tw - 12;
    this.tip.style.left = `${Math.max(4, left)}px`;
    this.tip.style.top = `${Math.max(2, 28 - 34)}px`;
    this.canvas.style.cursor = 'pointer';
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

function fmtTick(epochSec, step, tz) {
  const d = new Date(epochSec * 1000);
  const opts = { timeZone: tz, hour12: false };
  if (step >= 3600) return d.toLocaleString('en-GB', { ...opts, month: 'short', day: 'numeric', hour: step >= 86400 ? undefined : '2-digit' });
  if (step >= 60) return d.toLocaleTimeString('en-GB', { ...opts, hour: '2-digit', minute: '2-digit' });
  return d.toLocaleTimeString('en-GB', { ...opts, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
