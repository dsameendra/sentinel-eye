// One camera view. Holds a live player, upgrades/downgrades between the SD (sub) and HD (main)
// stream without a black gap (the new stream loads hidden and is swapped in once it plays),
// watches for stalls and reconnects, and reports stats.
import { createPlayer } from './player.js';
import { ZoomPan } from './zoom.js';
import { esc, icon, openPopover } from './ui.js';
import { Enhancer, PRESETS as ENHANCE_PRESETS } from './enhance.js';
import { enhancePanelHTML, wireEnhancePanel } from './enhancePanel.js';

// H.265 plays natively in Chrome/Edge/Safari. If a browser claims support but fails to decode (or lacks it),
// we remember that and use the server-converted H.264 stream instead.
const HEVC_FLAG = 'sentinel.hevcBroken';
const hevcMime = 'video/mp4; codecs="hvc1.1.6.L153.B0"';
export const hevcUsable = () => {
  try {
    if (localStorage.getItem(HEVC_FLAG)) return false;
    const MS = window.ManagedMediaSource || window.MediaSource;
    return !!MS && MS.isTypeSupported(hevcMime);
  } catch { return false; }
};
const markHevcBroken = () => { try { localStorage.setItem(HEVC_FLAG, '1'); } catch { /* private mode */ } };

export const streamName = (cam, kind, display) =>
  kind === 'sub' ? `${cam.id}_sub`
    : display.main_codec === 'h264' || !hevcUsable() ? `${cam.id}_main_h264` : `${cam.id}_main`;

const UPGRADE_TIMEOUT = 30000;   // main streams can take a few seconds (keyframe interval ~5 s)
const STALL_RECONNECT = 12000;
const BADGE_LABEL = { motion: 'Motion', line: 'Line cross', tamper: 'Tamper', videoloss: 'Video loss' };

export class Tile {
  /**
   * @param cam      channel settings object
   * @param opts     { kind: 'sub'|'main', display, chrome: bool, onFocus, onUpdate, onKindFail }
   */
  constructor(cam, opts) {
    this.cam = cam;
    this.opts = opts;
    this.kind = opts.kind;
    this.cur = null;
    this.pend = null;
    this.state = 'wait';       // wait | live | off
    this.stats = { w: 0, h: 0, fps: 0, mode: '' };
    this.el = document.createElement('div');
    this.el.className = 'tile';
    this.el.dataset.id = cam.id;
    this.el.innerHTML = `<div class="stage"><canvas class="enh-canvas" hidden></canvas></div>
      <div class="veil"><div class="spin"></div><div class="msg">Connecting…</div></div>
      ${opts.chrome ? `<div class="hit"></div>
      <div class="ov top"><span class="grip">${icon('move')} drag</span><span class="dot wait"></span><span class="name">${esc(cam.name || 'Camera ' + cam.channel)}</span><span class="grow"></span><span class="loadhd" hidden><span class="tag">Loading HD…</span></span><span class="tag kind">SD</span></div>
      <div class="ov bottom"><span class="stat"></span></div>
      <button class="zoomtag" hidden title="Reset zoom" aria-label="Reset zoom">Reset</button>
      <div class="tile-actions">
        <button data-a="zout" title="Zoom out" aria-label="Zoom out">${icon('minus')}</button>
        <button data-a="zin" title="Zoom in (or scroll / pinch on the picture)" aria-label="Zoom in">${icon('plus')}</button>
        <button class="txt" data-a="quality" title="Switch between SD and HD">HD</button>
        <button data-a="snap" title="Save snapshot" aria-label="Save snapshot">${icon('camera')}</button>
        <button data-a="replay" title="Instant replay (last 10s)" aria-label="Instant replay">${icon('rewind')}</button>
        <button data-a="bookmark" title="Bookmark this moment" aria-label="Bookmark this moment">${icon('flag')}</button>
        <div class="menu-wrap enh-wrap">
          <button data-a="enhance" title="Live enhancement (brightness/contrast/sharpen)" aria-label="Live enhancement" aria-haspopup="true">${icon('wand')}</button>
        </div>
        <button data-a="focus" title="Open large view" aria-label="Open large view">${icon('expand')}</button>
      </div>
      <div class="ev-badges"></div>` : ''}`;
    this.stage = this.el.querySelector('.stage');
    this.veil = this.el.querySelector('.veil');
    this.enhCanvas = this.el.querySelector('.enh-canvas');
    this.enhancer = null;
    // Settings > Enhancement > "Live filters" default preset (opts.display is the full display-settings
    // object, already threaded through from live.js) — was always hardcoded "off".
    this.enhParams = { ...(ENHANCE_PRESETS[opts.display?.enhance_default_preset] || ENHANCE_PRESETS.off) };
    if (opts.chrome) {
      this.el.querySelector('.hit').addEventListener('click', () => opts.onFocus?.(this));
      this.el.querySelector('[data-a=quality]').addEventListener('click', (e) => { e.stopPropagation(); this.setKind(this.kind === 'main' ? 'sub' : 'main'); });
      this.el.querySelector('[data-a=snap]').addEventListener('click', (e) => { e.stopPropagation(); this.snapshot(); });
      this.el.querySelector('[data-a=replay]').addEventListener('click', (e) => { e.stopPropagation(); opts.onReplay?.(this); });
      this.el.querySelector('[data-a=bookmark]').addEventListener('click', (e) => { e.stopPropagation(); opts.onBookmark?.(this); });
      this.el.querySelector('[data-a=enhance]').addEventListener('click', (e) => { e.stopPropagation(); this._toggleEnhanceMenu(); });
      this.el.querySelector('[data-a=focus]').addEventListener('click', (e) => { e.stopPropagation(); opts.onFocus?.(this); });
      this.enableZoom(this.el.querySelector('.hit'), { dbl: false });   // a click opens the large view, so no double-click zoom here
      this.el.querySelector('[data-a=zin]').addEventListener('click', (e) => { e.stopPropagation(); this.zoom.zoomBy(1.6); });
      this.el.querySelector('[data-a=zout]').addEventListener('click', (e) => { e.stopPropagation(); this.zoom.zoomBy(1 / 1.6); });
      this.el.querySelector('.zoomtag').addEventListener('click', (e) => { e.stopPropagation(); this.zoom.reset(); });
    }
    // Always start with the SD stream (it is already flowing, so the picture is instant) and swap to HD when it is ready.
    this.cur = this._spawn('sub', false);
    if (opts.kind === 'main') { this.kind = 'sub'; this.setKind('main'); }
    this._applyEnhParams(); // starts the enhancer immediately if the default preset above isn't "off"
    this._paint();
    this.timer = setInterval(() => this._tick(), 500);
  }

  /** Attach zoom/pan gestures to `hit` (a transparent element over the picture). Re-callable: a tile
   * that's handed between the grid and the large view gets a new hit target each time (a different
   * double-click policy too), so any previous controller is torn down first rather than leaked. */
  enableZoom(hit, { dbl = true } = {}) {
    const prevState = this.zoom ? { s: this.zoom.s, x: this.zoom.x, y: this.zoom.y } : null;
    this.zoom?.destroy();
    this.zoom = new ZoomPan(this.stage, hit, { dbl, onChange: (st) => { this._paintZoom(); this.opts.onZoom?.(this.cam.id, st); } });
    if (this.opts.zoomInit) this.zoom.setState(this.opts.zoomInit);
    else if (prevState && prevState.s > 1.001) this.zoom.setState(prevState);   // carry zoom across grid<->focus
  }

  _paintZoom() {
    const z = this.zoom;
    if (!z) return;
    const tag = this.el.querySelector('.zoomtag');
    if (tag) { tag.hidden = !z.zoomed; tag.textContent = `${z.s.toFixed(1)}× · Reset`; }
    const zin = this.el.querySelector('[data-a=zin]'), zout = this.el.querySelector('[data-a=zout]');
    if (zin) zin.disabled = z.atMax;
    if (zout) zout.disabled = !z.zoomed;
    this.opts.onUpdate?.(this);
  }

  _spawn(kind, hidden) {
    const stream = streamName(this.cam, kind, this.opts.display);
    const p = createPlayer(stream);
    if (hidden) p.classList.add('pending');
    p.onstatechange = () => this._paint();
    this.stage.append(p);
    return { player: p, kind, stream, born: performance.now(), lastT: -1, lastMove: performance.now(), ready: false, lastReconnect: performance.now() };
  }

  /** Switch stream quality. The old stream keeps playing until the new one is ready. */
  setKind(kind) {
    if (kind === this.kind && !this.pend) return;
    if (this.pend) { this.pend.player.dispose(); this.pend = null; }
    this.kind = kind;
    if (this.cur && this.cur.kind === kind) { this._paint(); return; }
    this.pend = this._spawn(kind, true);
    this._paint();
  }

  /** Picture shape for a stream: the channel's setting, or (auto) 16:9 when the frame is a squeezed 2:1 SD frame. */
  _shape(v) {
    const a = this.cam.aspect || 'auto';
    if (a === '16:9') return 16 / 9;
    if (a === '4:3') return 4 / 3;
    if (!v.videoWidth) return null;
    const r = v.videoWidth / v.videoHeight;
    return a === 'auto' && Math.abs(r - 2) < 0.06 ? 16 / 9 : r;
  }

  _applyShape(s) {
    const v = s.player.video;
    const ar = v && this._shape(v);
    if (ar && s.ar !== ar) { s.ar = ar; s.player.style.setProperty('--ar', ar.toFixed(4)); }
  }

  _advancing(s, now) {
    const v = s.player.video;
    if (!v) return false;
    const t = v.currentTime;
    if (t !== s.lastT) { s.lastT = t; s.lastMove = now; }
    return v.readyState >= 2 && t > 0 && now - s.lastMove < 2500;
  }

  /** A passthrough H.265 stream whose <video> reports a decode error: switch to the H.264 stream. */
  _checkHevc(slot, isPending) {
    if (!slot || slot.kind !== 'main' || !slot.stream.endsWith('_main') || !slot.player.video?.error) return false;
    markHevcBroken();
    slot.player.dispose();
    const fresh = this._spawn('main', isPending);
    if (isPending) this.pend = fresh; else this.cur = fresh;
    if (!this._toldHevc) { this._toldHevc = true; this.opts.onHevcFallback?.(this); }
    return true;
  }

  /** Count presented frames (getVideoPlaybackQuality is unreliable for WebRTC). */
  _countFrames(s) {
    const v = s.player.video;
    if (s.counting || !v?.requestVideoFrameCallback) return;
    s.counting = true; s.frames = 0;
    const loop = () => { if (s.player.disposed) return; s.frames++; v.requestVideoFrameCallback(loop); };
    v.requestVideoFrameCallback(loop);
  }

  _tick() {
    const now = performance.now();
    this._applyShape(this.cur);
    if (this.pend) this._applyShape(this.pend);
    this._checkHevc(this.cur, false);
    this._checkHevc(this.pend, true);
    if (this.pend) {
      if (this._advancing(this.pend, now)) {
        this.cur.player.dispose();
        this.pend.player.classList.remove('pending');
        this.cur = this.pend;
        this.pend = null;
        this.cur.lastMove = now;
      } else if (now - this.pend.born > UPGRADE_TIMEOUT) {
        const failed = this.pend.kind;
        this.pend.player.dispose();
        this.pend = null;
        this.kind = this.cur.kind;
        this.opts.onKindFail?.(this, failed);
      }
    }
    const s = this.cur;
    const live = this._advancing(s, now);
    let state = live ? 'live' : now - s.lastMove > 6000 && now - s.born > 8000 ? 'off' : 'wait';
    if (!live && now - s.lastMove > STALL_RECONNECT && now - s.lastReconnect > STALL_RECONNECT) {
      s.lastReconnect = now;
      s.player.reconnect();
    }
    // stats once a second
    if (live) this._countFrames(s);
    if (live && (!this._sAt || now - this._sAt >= 1000)) {
      const v = s.player.video;
      if (this._sAt && this._sSlot === s) this.stats.fps = Math.max(0, ((s.frames || 0) - this._sFrames) / ((now - this._sAt) / 1000));
      this._sFrames = s.frames || 0;
      this._sSlot = s;
      this._sAt = now;
      this.stats.w = v.videoWidth; this.stats.h = v.videoHeight; this.stats.mode = s.player.info.mode;
    }
    if (state !== this.state || live) { this.state = state; this._paint(); }
  }

  _paint() {
    const s = this.cur;
    if (!s) return;
    const el = this.el;
    const dot = el.querySelector('.dot');
    if (dot) dot.className = `dot ${this.state === 'live' ? 'live' : this.state === 'off' ? 'off' : 'wait'}`;
    if (this.state === 'live') this.veil.hidden = true;
    else {
      this.veil.hidden = false;
      const err = s.player.info.error;
      this.veil.innerHTML = this.state === 'off'
        ? `<div class="msg"><b>No signal</b><br>${esc(err || 'The camera is not responding. Retrying…')}</div>`
        : `<div class="spin"></div><div class="msg">${esc(err ? err : 'Connecting…')}</div>`;
    }
    const tag = el.querySelector('.kind');
    if (tag) { tag.textContent = s.kind === 'main' ? 'HD' : 'SD'; tag.classList.toggle('hd', s.kind === 'main'); }
    const q = el.querySelector('[data-a=quality]');
    if (q) { q.textContent = this.kind === 'main' ? 'HD' : 'SD'; q.title = this.kind === 'main' ? 'Playing HD, click for SD' : 'Playing SD, click for HD'; }
    const lh = el.querySelector('.loadhd');
    if (lh) { lh.hidden = !this.pend; if (this.pend) lh.firstChild.textContent = this.pend.kind === 'main' ? 'Loading HD…' : 'Loading SD…'; }
    const st = el.querySelector('.stat');
    if (st) st.textContent = this.summary();
    this._syncEnhanceSource();
    this.opts.onUpdate?.(this);
  }

  // ---------------------------------------------------------------- L0 live enhancement (WebGL, client-side)
  // Popover is appended to <body> (openPopover) rather than nested under the tile — a grid tile clips its
  // own overflow (needed for the video picture), which was cutting the dropdown off/garbling it when it
  // was positioned relative to a button inside the tile. Presets are quick-fill starting points; every
  // slider underneath stays individually adjustable and stacks with the rest (docs/playback-spec.md's L0
  // section) — there's no longer a single "which preset is active" state, just the current parameter mix.
  _toggleEnhanceMenu() {
    const btn = this.el.querySelector('[data-a=enhance]');
    const menu = openPopover(btn, enhancePanelHTML({}), { className: 'enh-menu enh2-panel' });
    if (!menu) return;
    wireEnhancePanel(menu, {
      getParams: () => this.enhParams,
      onPreset: (name) => this.applyEnhancePreset(name),
      onParam: (key, value) => this.applyEnhParam(key, value),
    });
  }

  applyEnhancePreset(name) {
    this.enhParams = { ...(ENHANCE_PRESETS[name] || ENHANCE_PRESETS.off) };
    this._applyEnhParams();
  }

  applyEnhParam(key, value) {
    this.enhParams = { ...this.enhParams, [key]: value };
    this._applyEnhParams();
  }

  _applyEnhParams() {
    const btn = this.el.querySelector('[data-a=enhance]');
    const off = Object.entries(ENHANCE_PRESETS.off).every(([k, v]) => k === 'label' || this.enhParams[k] === v);
    btn?.setAttribute('aria-pressed', String(!off));
    if (off) {
      this.enhancer?.stop();
      this.enhCanvas.hidden = true;
      return;
    }
    if (!this.enhancer) {
      this.enhancer = new Enhancer(this.cur?.player.video, this.enhCanvas);
      if (!this.enhancer.supported) { this.enhancer = null; this.enhParams = { ...ENHANCE_PRESETS.off }; btn?.setAttribute('aria-pressed', 'false'); return; }
    }
    this.enhancer.setParams(this.enhParams);
    this.enhCanvas.hidden = false;
    this.enhancer.start();
  }

  /** Keep the enhancer reading from whichever player is actually visible — it changes across an SD<->HD
   * swap — and keep the enhanced canvas's on-screen shape matching it (--ar is set on the cam-player
   * element itself, a sibling of the canvas, so it doesn't cascade down and has to be copied across). */
  _syncEnhanceSource() {
    if (!this.cur) return;
    const ar = this.cur.player.style.getPropertyValue('--ar');
    if (ar) this.enhCanvas.style.setProperty('--ar', ar);
    if (!this.enhancer) return;
    const v = this.cur.player.video;
    if (v && this.enhancer.source !== v) this.enhancer.source = v;
  }

  summary() {
    const s = this.stats;
    if (!s.w) return '';
    return [`${s.w}×${s.h}`, s.fps ? `${Math.round(s.fps)} fps` : '', s.mode].filter(Boolean).join(' · ');
  }

  /** Show/update the live-event badges (from a poll of recent DVR alarm events) for this tile.
   * @param kinds Set of event kinds currently active/recent for this camera's channel, or falsy for none. */
  setBadges(kinds) {
    const el = this.el.querySelector('.ev-badges');
    if (!el) return;
    if (!kinds || !kinds.size) { if (el.childElementCount) el.innerHTML = ''; return; }
    el.innerHTML = [...kinds].map((k) => `<span class="ev-badge ${k}">${BADGE_LABEL[k] || k}</span>`).join('');
  }

  /** Captures whichever picture is actually on screen — the L0-enhanced frame if enhancement is on, the
   * original otherwise. That's "your choice" (spec 11.5): toggle enhancement, then snapshot. */
  snapshot() {
    const enhanced = !this.enhCanvas.hidden;
    const v = this.cur?.player.video;
    if (enhanced) {
      if (!this.enhCanvas.width) return false;
    } else if (!v || !v.videoWidth) return false;
    const c = document.createElement('canvas');
    c.width = enhanced ? this.enhCanvas.width : v.videoWidth;
    c.height = enhanced ? this.enhCanvas.height : v.videoHeight;
    c.getContext('2d').drawImage(enhanced ? this.enhCanvas : v, 0, 0);
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = `${(this.cam.name || 'camera').replace(/[^\w-]+/g, '_')}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${enhanced ? '_ENHANCED' : ''}.jpg`;
    c.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/jpeg', this.opts.display?.snapshot_quality ?? 0.92); // Settings > Display > Interaction — was hardcoded
    return true;
  }

  dispose() {
    clearInterval(this.timer);
    this.zoom?.destroy();
    this.enhancer?.destroy();
    this.cur?.player.dispose();
    this.pend?.player.dispose();
    this.cur = this.pend = null;
    this.el.remove();
  }
}
