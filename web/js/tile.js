// One camera view. Holds a live player, upgrades/downgrades between the SD (sub) and HD (main)
// stream without a black gap (the new stream loads hidden and is swapped in once it plays),
// watches for stalls and reconnects, and reports stats.
import { createPlayer } from './player.js';
import { esc, icon } from './ui.js';

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
    this.el.innerHTML = `<div class="stage"></div>
      <div class="veil"><div class="spin"></div><div class="msg">Connecting…</div></div>
      ${opts.chrome ? `<div class="hit"></div>
      <div class="ov top"><span class="grip">${icon('move')} drag</span><span class="dot wait"></span><span class="name">${esc(cam.name || 'Camera ' + cam.channel)}</span><span class="grow"></span><span class="loadhd" hidden><span class="tag">Loading HD…</span></span><span class="tag kind">SD</span></div>
      <div class="ov bottom"><span class="stat"></span></div>
      <div class="tile-actions">
        <button class="txt" data-a="quality" title="Switch between SD and HD">HD</button>
        <button data-a="snap" title="Save snapshot" aria-label="Save snapshot">${icon('camera')}</button>
        <button data-a="focus" title="Open large view" aria-label="Open large view">${icon('expand')}</button>
      </div>` : ''}`;
    this.stage = this.el.querySelector('.stage');
    this.veil = this.el.querySelector('.veil');
    if (opts.chrome) {
      this.el.querySelector('.hit').addEventListener('click', () => opts.onFocus?.(this));
      this.el.querySelector('[data-a=quality]').addEventListener('click', (e) => { e.stopPropagation(); this.setKind(this.kind === 'main' ? 'sub' : 'main'); });
      this.el.querySelector('[data-a=snap]').addEventListener('click', (e) => { e.stopPropagation(); this.snapshot(); });
      this.el.querySelector('[data-a=focus]').addEventListener('click', (e) => { e.stopPropagation(); opts.onFocus?.(this); });
    }
    this.cur = this._spawn(this.kind, false);
    this._paint();
    this.timer = setInterval(() => this._tick(), 500);
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
    this.opts.onUpdate?.(this);
  }

  summary() {
    const s = this.stats;
    if (!s.w) return '';
    return [`${s.w}×${s.h}`, s.fps ? `${Math.round(s.fps)} fps` : '', s.mode].filter(Boolean).join(' · ');
  }

  snapshot() {
    const v = this.cur?.player.video;
    if (!v || !v.videoWidth) return false;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = `${(this.cam.name || 'camera').replace(/[^\w-]+/g, '_')}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
    c.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/jpeg', 0.92);
    return true;
  }

  dispose() {
    clearInterval(this.timer);
    this.cur?.player.dispose();
    this.pend?.player.dispose();
    this.cur = this.pend = null;
    this.el.remove();
  }
}
