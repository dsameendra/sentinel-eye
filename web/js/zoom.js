// Zoom and pan for a camera picture, shared by grid tiles and the large view.
//
// Input paths (each browser delivers pinch differently):
//   wheel            mouse wheel; Chrome/Edge/Firefox trackpad pinch arrives as wheel + ctrlKey
//   gesture*         Safari (macOS trackpad pinch) has its own non-standard events
//   Pointer Events   mouse drag to pan; touch: one finger pans, two fingers pinch (iOS/Android/touch screens)
// The picture is transformed through CSS variables on the stage (--zs, --zx, --zy), so SD -> HD swaps keep the view.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const TAP_MS = 320, TAP_PX = 30;

export class ZoomPan {
  /**
   * @param stage  element holding the player(s); receives the CSS variables
   * @param hit    transparent element on top that receives the gestures
   * @param opts   { max, dbl (double-tap/click toggles zoom), onChange(state) }
   */
  constructor(stage, hit, opts = {}) {
    this.stage = stage;
    this.hit = hit;
    this.max = opts.max || 8;
    this.dbl = opts.dbl !== false;
    this.onChange = opts.onChange || (() => {});
    this.s = 1; this.x = 0; this.y = 0;
    this.ptrs = new Map();
    this.moved = 0;
    this.pinched = false;
    this.lastTap = null;
    hit.style.touchAction = 'none';   // we handle pan/pinch ourselves: stop the browser scrolling or page-zooming
    this.bound = [
      [hit, 'pointerdown', (e) => this.down(e)],
      [hit, 'pointermove', (e) => this.move(e)],
      [hit, 'pointerup', (e) => this.up(e)],
      [hit, 'pointercancel', (e) => this.up(e, true)],
      [hit, 'wheel', (e) => this.wheel(e), { passive: false }],
      [hit, 'gesturestart', (e) => this.gStart(e), { passive: false }],
      [hit, 'gesturechange', (e) => this.gChange(e), { passive: false }],
      [hit, 'gestureend', (e) => e.preventDefault(), { passive: false }],
      // a drag must not count as a click (in the grid, a click opens the large view)
      [hit.parentElement, 'click', (e) => this.swallowClick(e), true],
    ];
    this.bound.forEach(([t, n, f, o]) => t.addEventListener(n, f, o));
    this.ro = new ResizeObserver(() => { this.clampAll(); this.apply(); });
    this.ro.observe(stage);
  }

  get zoomed() { return this.s > 1.001; }
  get percent() { return Math.round(this.s * 100); }
  get atMax() { return this.s >= this.max - 0.001; }

  // ---------------------------------------------------------------- geometry
  metrics() {
    const r = this.stage.getBoundingClientRect();
    const p = this.stage.querySelector('cam-player, canvas'); // live tiles use <cam-player>, playback panes a <canvas> — either gives the real letterboxed content box
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height, bw: p ? p.offsetWidth : r.width, bh: p ? p.offsetHeight : r.height };
  }

  clampAll() {
    const m = this.metrics();
    const mx = Math.max(0, (m.bw * this.s - m.w) / 2), my = Math.max(0, (m.bh * this.s - m.h) / 2);
    this.x = clamp(this.x, -mx, mx);
    this.y = clamp(this.y, -my, my);
  }

  apply() {
    const st = this.stage.style;
    st.setProperty('--zs', this.s.toFixed(4));
    st.setProperty('--zx', this.x.toFixed(1) + 'px');
    st.setProperty('--zy', this.y.toFixed(1) + 'px');
    this.hit.classList.toggle('zoomed', this.zoomed);
    this.onChange({ s: this.s, x: this.x, y: this.y });
  }

  animate() {
    this.stage.classList.add('zanim');
    clearTimeout(this.animTimer);
    this.animTimer = setTimeout(() => this.stage.classList.remove('zanim'), 230);
  }

  // ---------------------------------------------------------------- operations
  /** Zoom by `factor`, keeping the picture point under (clientX, clientY) where it is. */
  zoomAt(factor, clientX, clientY, animate = false) {
    const ns = clamp(this.s * factor, 1, this.max);
    if (ns === this.s) return;
    const m = this.metrics();
    const qx = (clientX ?? m.cx) - m.cx, qy = (clientY ?? m.cy) - m.cy;
    const ux = (qx - this.x) / this.s, uy = (qy - this.y) / this.s;   // picture point under the pointer
    if (animate) this.animate();
    this.s = ns;
    this.x = qx - ns * ux;
    this.y = qy - ns * uy;
    if (ns <= 1.001) { this.s = 1; this.x = 0; this.y = 0; }
    this.clampAll();
    this.apply();
  }

  zoomTo(scale, clientX, clientY, animate) { this.zoomAt(scale / this.s, clientX, clientY, animate); }
  zoomBy(factor, animate = true) { this.zoomAt(factor, undefined, undefined, animate); }

  panBy(dx, dy) {
    if (!this.zoomed) return;
    this.x += dx; this.y += dy;
    this.clampAll();
    this.apply();
  }

  reset(animate = true) {
    if (!this.zoomed && !this.x && !this.y) return;
    if (animate) this.animate();
    this.s = 1; this.x = 0; this.y = 0;
    this.apply();
  }

  setState(st) {
    if (!st) return;
    this.s = clamp(st.s || 1, 1, this.max); this.x = st.x || 0; this.y = st.y || 0;
    this.clampAll(); this.apply();
  }

  toggleAt(clientX, clientY) {
    if (this.zoomed) this.reset(true);
    else this.zoomAt(2.5, clientX, clientY, true);
  }

  // ---------------------------------------------------------------- input
  editing() { return !!this.hit.closest('.editing'); }

  wheel(e) {
    if (this.editing()) return;
    e.preventDefault();   // never scroll or page-zoom while the pointer is over a picture
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= 400;
    this.zoomAt(Math.exp(-d * (e.ctrlKey ? 0.012 : 0.002)), e.clientX, e.clientY);
  }

  // Safari trackpad pinch
  gStart(e) { e.preventDefault(); this.gBase = this.s; }
  gChange(e) {
    e.preventDefault();
    if (this.ptrs.size >= 2 || this.editing()) return;   // iOS also sends touch pointers: avoid applying the pinch twice
    this.zoomTo((this.gBase || 1) * e.scale, e.clientX, e.clientY);
  }

  down(e) {
    if (this.editing() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    try { this.hit.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.ptrs.size === 1) { this.moved = 0; this.pinched = false; }
    if (this.ptrs.size === 2) { this.pinched = true; this.prev = this.pinchState(); }
    if (this.zoomed) this.hit.classList.add('panning');
  }

  pinchState() {
    const [a, b] = [...this.ptrs.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  move(e) {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    this.moved += Math.abs(dx) + Math.abs(dy);
    if (this.ptrs.size >= 2 && this.prev) {
      const cur = this.pinchState();
      this.zoomAt(cur.d / this.prev.d, cur.mx, cur.my);
      this.panBy(cur.mx - this.prev.mx, cur.my - this.prev.my);
      this.prev = cur;
    } else if (this.ptrs.size === 1 && this.moved > 3) {
      this.panBy(dx, dy);
    }
  }

  up(e, cancelled) {
    if (!this.ptrs.delete(e.pointerId)) return;
    this.prev = null;
    if (this.ptrs.size === 1) this.moved += 20;           // lifting one of two fingers is never a tap
    if (this.ptrs.size > 0) return;
    this.hit.classList.remove('panning');
    this.swallow = this.moved > 6 || this.pinched;         // a drag/pinch must not become a click
    if (this.swallow) setTimeout(() => { this.swallow = false; }, 0);
    if (cancelled || this.swallow || !this.dbl) return;
    // double tap / double click
    const now = performance.now(), t = this.lastTap;
    if (t && now - t.t < TAP_MS && Math.hypot(e.clientX - t.x, e.clientY - t.y) < TAP_PX) {
      this.lastTap = null;
      this.toggleAt(e.clientX, e.clientY);
    } else this.lastTap = { t: now, x: e.clientX, y: e.clientY };
  }

  swallowClick(e) {
    if (this.swallow) { e.stopImmediatePropagation(); e.preventDefault(); this.swallow = false; }
  }

  destroy() {
    this.bound.forEach(([t, n, f, o]) => t.removeEventListener(n, f, o));
    this.ro.disconnect();
    clearTimeout(this.animTimer);
  }
}
