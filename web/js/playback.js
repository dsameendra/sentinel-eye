// Playback view: single-camera DVR review. Timeline (coverage + events) + WebCodecs player + transport
// controls. docs/playback-spec.md section 7 (M1 scope: one camera; multi-camera sync is M2).
import { Timeline } from './timeline.js';
import { esc, icon, toast } from './ui.js';
import { WCPlayer } from './wcplayer.js';

const SPEEDS = ['0.125', '0.25', '0.5', '1', '2', '4', '8', '16'];
const REWIND_MACROS = [5, 10, 30];

export class PlaybackView {
  /** @param ctx { settings(), go(hash) } */
  constructor(root, ctx, channelId) {
    this.root = root;
    this.ctx = ctx;
    this.playing = false;
    this.currentEpoch = Date.now() / 1000 - 30;
    this.speed = '1';
    this.onKey = (e) => this._key(e);
    document.addEventListener('keydown', this.onKey);
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
    this.root.innerHTML = `<div class="pb">
      <div class="pb-bar">
        <select class="cam-pick" aria-label="Camera"></select>
        <input type="datetime-local" class="pb-datetime" step="1" aria-label="Jump to date and time">
        <button class="btn sm" data-a="jump">Go</button>
        <span class="spacer"></span>
        <span class="pill pb-status"><span class="dot wait"></span><span class="txt">connecting…</span></span>
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
        <span class="pb-time"></span>
      </div>
      <div class="pb-timeline"></div>
    </div>`;
    const pick = this.root.querySelector('.cam-pick');
    pick.innerHTML = cams.map((c) => `<option value="${c.id}" ${c.id === this.cam.id ? 'selected' : ''}>${esc(c.name || 'Camera ' + c.channel)}</option>`).join('');
    pick.addEventListener('change', () => this.switchCamera(pick.value));
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
    for (const s of REWIND_MACROS) this.root.querySelector(`[data-a=back${s}]`).addEventListener('click', () => this.seekTo(this.currentEpoch - s));
    this.root.querySelector('[data-a=jump]').addEventListener('click', () => this._jumpFromInput());
    this.root.querySelector('.pb-datetime').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._jumpFromInput(); });

    this.play();
  }

  _jumpFromInput() {
    const v = this.root.querySelector('.pb-datetime').value;
    if (!v) return;
    this.seekTo(new Date(v).getTime() / 1000);
  }

  switchCamera(id) {
    const cam = this.cams().find((c) => c.id === id);
    if (!cam) return;
    this.cam = cam;
    this.timeline?.setChannel(cam.channel);
    this.ctx.go(`#/playback/${cam.id}`);
    this.seekTo(this.currentEpoch, true);
  }

  play() {
    this.playing = true;
    this._paintPlayIcon();
    this.player.connect(this.cam.id, new Date(this.currentEpoch * 1000).toISOString(), this.speed);
  }

  pause() {
    this.playing = false;
    this._paintPlayIcon();
    this.player.disconnectSocket();
    // the player's own 'ws closed' handler can't tell an intentional pause from a dropped connection
    // (by the time the async close event fires, this.ws has already been nulled for the reconnect case) —
    // so the view sets the status directly here for the deliberate action.
    this._onState('paused');
  }

  togglePlay() { this.playing ? this.pause() : this.play(); }

  seekTo(epoch, forceReconnect = false) {
    this.currentEpoch = epoch;
    this._renderTime();
    this.timeline?.setPlayhead(epoch);
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
    const d = new Date(this.currentEpoch * 1000);
    this.timeEl.textContent = d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
    const inp = this.root.querySelector('.pb-datetime');
    if (inp && document.activeElement !== inp) {
      const local = new Date(this.currentEpoch * 1000 - new Date().getTimezoneOffset() * 0); // browser shows its own local tz in the input; fine for a jump target
      inp.value = new Date(this.currentEpoch * 1000).toISOString().slice(0, 19);
    }
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
