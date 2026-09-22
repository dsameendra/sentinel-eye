// Multi-scale timeline: coverage + event lanes, wheel/pinch zoom anchored at the cursor, drag to pan,
// click to seek. Renders to a <canvas>; data (coverage spans, events) is fetched per visible day and cached.
import { api } from './api.js';

const MIN_PX_PER_SEC = 1440 / (24 * 3600);   // whole day fits ~1440px
const MAX_PX_PER_SEC = 200;                   // ~5ms/px at max zoom (frame-level)
const KIND_COLOR = { motion: '#eab308', line: '#f87171', intrusion: '#f87171', tamper: '#f87171', videoloss: '#6b7280' };

const dayStr = (d) => d.toISOString().slice(0, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Timeline {
  /** @param el host element @param opts {channel (DVR channel number), onSeek(isoTime), tz} */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.el.innerHTML = '<canvas></canvas>';
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.center = Date.now() / 1000;   // epoch seconds at the horizontal center
    this.pxPerSec = 1440 / (24 * 3600);
    this.cursorTime = null;
    this.coverage = new Map();   // day -> spans
    this.events = [];
    this._loadedRange = null;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(el);
    this._bind();
    this.reload();
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

  goTo(epochSec, animate = false) {
    this.center = epochSec;
    this.reload();
  }

  // ---------------------------------------------------------------- input
  _bind() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, center: this.center, moved: 0 };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.cursorTime = this.center + (e.clientX - r.left - c.clientWidth / 2) / this.pxPerSec;
      if (drag) {
        const dx = e.clientX - drag.x;
        drag.moved += Math.abs(dx);
        this.center = drag.center - dx / this.pxPerSec;
        this.reload();
      } else this.draw();
    });
    c.addEventListener('pointerup', (e) => {
      if (drag && drag.moved < 4) {
        const r = c.getBoundingClientRect();
        const t = this.center + (e.clientX - r.left - c.clientWidth / 2) / this.pxPerSec;
        this.opts.onSeek?.(new Date(t * 1000).toISOString());
      }
      drag = null;
    });
    c.addEventListener('pointerleave', () => { this.cursorTime = null; this.draw(); });
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
