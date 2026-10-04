// Zoom HUD (Focus board, now everywhere a picture zooms — Focus, grid tiles, Playback panes): a minimap
// of the whole picture with the part on screen outlined, and a − / 100% / + cluster (the percentage
// resets). Click or drag on the minimap to pan straight there. Shown only while zoomed in.
import { icon } from './ui.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class ZoomHud {
  /**
   * @param host  element the HUD positions itself in (position: relative/absolute)
   * @param getZoom () => the ZoomPan to drive (a getter: a tile can rebuild its ZoomPan)
   * @param opts  { compact: smaller, for grid tiles; className: extra classes (e.g. Focus's auto-hide) }
   */
  constructor(host, getZoom, opts = {}) {
    this.getZoom = getZoom;
    this.el = document.createElement('div');
    this.el.className = `zhud${opts.compact ? ' compact' : ''}${opts.className ? ' ' + opts.className : ''}`;
    this.el.hidden = true;
    this.el.innerHTML = `<div class="zmap" title="Click or drag to move around the picture"><canvas></canvas><div class="zmap-view"></div></div>
      <div class="zctl" role="group" aria-label="Zoom">
        <button data-z="out" title="Zoom out" aria-label="Zoom out">${icon('minus')}</button>
        <button data-z="reset" class="pct" title="Back to 100%">100%</button>
        <button data-z="in" title="Zoom in" aria-label="Zoom in">${icon('plus')}</button></div>`;
    host.append(this.el);
    this.map = this.el.querySelector('.zmap');
    this.view = this.el.querySelector('.zmap-view');
    this.canvas = this.el.querySelector('canvas');
    // Nothing here may reach the picture underneath (a click there opens Focus / toggles chrome).
    ['pointerdown', 'click', 'dblclick', 'wheel'].forEach((ev) => this.el.addEventListener(ev, (e) => e.stopPropagation(), ev === 'wheel' ? { passive: true } : undefined));
    this.el.querySelector('[data-z=in]').addEventListener('click', () => this.getZoom()?.zoomBy(1.6));
    this.el.querySelector('[data-z=out]').addEventListener('click', () => this.getZoom()?.zoomBy(1 / 1.6));
    this.el.querySelector('[data-z=reset]').addEventListener('click', () => this.getZoom()?.reset());
    this.map.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.map.setPointerCapture(e.pointerId);
      this._panTo(e);
      const move = (ev) => this._panTo(ev);
      const up = () => { this.map.removeEventListener('pointermove', move); this.map.removeEventListener('pointerup', up); this.map.removeEventListener('pointercancel', up); };
      this.map.addEventListener('pointermove', move); this.map.addEventListener('pointerup', up); this.map.addEventListener('pointercancel', up);
    });
  }

  /** Centre the view on the minimap point under the pointer. */
  _panTo(e) {
    const z = this.getZoom();
    if (!z?.zoomed) return;
    const r = this.map.getBoundingClientRect();
    const fx = clamp((e.clientX - r.left) / r.width, 0, 1), fy = clamp((e.clientY - r.top) / r.height, 0, 1);
    const m = z.metrics();
    // The stage centre shows picture point u = -offset / scale (picture coords from its centre); put the
    // clicked point there.
    z.x = -z.s * (fx - 0.5) * m.bw;
    z.y = -z.s * (fy - 0.5) * m.bh;
    z.clampAll(); z.apply();
  }

  update() {
    const z = this.getZoom();
    const on = !!z?.zoomed;
    this.el.hidden = !on;
    if (!on) { clearInterval(this.thumbTimer); this.thumbTimer = 0; return; }
    this.el.querySelector('.pct').textContent = `${z.percent}%`;
    this.el.querySelector('[data-z=in]').disabled = z.atMax;
    const m = z.metrics();
    // Same geometry as the stage transform: what part of the picture is inside the stage right now.
    const l = clamp(((-m.w / 2 - z.x) / z.s + m.bw / 2) / m.bw, 0, 1), t = clamp(((-m.h / 2 - z.y) / z.s + m.bh / 2) / m.bh, 0, 1);
    const w = Math.min(1 - l, m.w / z.s / m.bw), h = Math.min(1 - t, m.h / z.s / m.bh);
    Object.assign(this.view.style, { left: `${l * 100}%`, top: `${t * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
    this.map.style.setProperty('--ar', (m.bw / m.bh).toFixed(4));
    if (!this.thumbTimer) { this._thumb(); this.thumbTimer = setInterval(() => this._thumb(), 1000); }
  }

  /** A small live picture in the minimap: the stage's own video or canvas, redrawn once a second. */
  _thumb() {
    const z = this.getZoom();
    const src = z?.stage.querySelector('cam-player:not(.pending) video, video, canvas:not(.enh-canvas):not(.enh2-filter)');
    const sw = src?.videoWidth || src?.width, sh = src?.videoHeight || src?.height;
    if (!sw || !sh) return;
    const W = 160, H = Math.round(W * sh / sw);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    try { this.canvas.getContext('2d').drawImage(src, 0, 0, W, H); } catch { /* not drawable yet */ }
  }

  destroy() { clearInterval(this.thumbTimer); this.el.remove(); }
}
