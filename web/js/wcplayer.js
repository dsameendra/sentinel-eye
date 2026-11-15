// WebCodecs-based DVR playback player. Connects to /api/playback/ws, decodes H.265 or H.264 Annex-B access
// units with WebCodecs VideoDecoder (H.265 verified directly against this DVR's footage — see docs/SPEC.md
// section 2.6/7.2; the codec comes from the server's "playing" message, and H.264's codec string from the SPS
// in the first keyframe — codecs.js), and paints decoded frames to a <canvas>. Frame times are the recorded
// times the server labelled them with; a session starts at the keyframe before the requested instant, so the
// first frames can be earlier than asked (`displayFrom` says where the request was). No <video> element: WebCodecs frames are
// painted directly, which is what lets us do exact frame-stepping and report a real decoded-frame clock.
//
// Frame stepping: keeps a rolling ring buffer of already-decoded frames (spec 7.5's "decode the preceding
// GOP into memory and walk it") rather than opening a fresh DVR session per step. The original one-shot-
// reconnect approach (each step tore the session down and reopened it — real DVR RTSP setup latency per
// frame, 1-3+ seconds) is replaced: pausing keeps the connection open and keeps decoding into the buffer
// in the background, so stepping forward is just advancing into frames that have already arrived, and
// stepping backward walks frames already sitting in memory. Both are near-instant within the buffered
// window (~450 frames, ~30s at this DVR's ~15fps). Only stepping backward past the buffer's oldest frame
// falls back to the slower one-shot DVR fetch — rare in a normal review session, not the common case.

import { signInAgain } from './api.js';
import { decoderConfig } from './codecs.js';

const wsUrl = (channel, startIso, speed) => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/playback/ws?channel=${encodeURIComponent(channel)}&start=${encodeURIComponent(startIso)}&speed=${encodeURIComponent(speed)}`;
};

const BUFFER_CAP = 450; // ~30s at ~15fps — generous for stepping, bounded so memory doesn't grow unbounded
const clampInt = (v, a, b) => Math.min(b, Math.max(a, v));

// Why WebCodecs is missing, for the user. Browsers only expose VideoDecoder in a secure context (HTTPS or
// localhost), so plain http://<lan-ip> hides it even in a current Chrome/Edge/Safari.
export function unsupportedReason() {
  if (!window.isSecureContext) {
    return `Playback needs HTTPS or localhost — the browser disables WebCodecs on plain http://${location.host}. ` +
      'Open it through an HTTPS proxy/tunnel, or an SSH tunnel to http://localhost.';
  }
  return 'This browser lacks WebCodecs — Chrome, Edge or Safari 16.4+ is needed.';
}

export class WCPlayer {
  /** @param canvas target <canvas> @param opts {onFrame(absTime), onState(state), onError(msg)} */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.ws = null;
    this.decoder = null;
    this.state = 'idle'; // idle | connecting | queued | playing | paused | error
    this.frameCount = 0;
    this.pendingKeyOnly = false;
    this._closed = false;
    this._decodeErrors = 0;
    this.buffer = [];       // ring buffer of {frame: VideoFrame, absTime}, oldest -> newest
    this.bufIndex = -1;     // index of the frame currently on screen
    this.following = true;  // true = auto-advance/paint every new decoded frame (normal play); false = held at bufIndex (paused/stepping), still decoding into the buffer in the background
    this._pendingTimes = []; // FIFO of absTime per queued decode() call, matched to decoder output order
    this.codec = 'hevc';    // from the server's "playing" message; an older server never says, and only served H.265
    this.displayFrom = null; // the requested instant of the current segment (frames before it are keyframe pre-roll)
    this.segment = null;    // the server's latest "playing"/"segment" message: time_source, approx, bound_s, …
    this._decoderConfig = null;
  }

  get supported() {
    return 'VideoDecoder' in window;
  }

  connect(channel, startIso, speed = '1') {
    this.disconnectSocket();
    this._clearBuffer();
    this._setupDecoder();
    this._setState('connecting');
    this.channel = channel;
    this.speed = speed;
    this.following = true;
    const ws = new WebSocket(wsUrl(channel, startIso, speed));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('message', (ev) => this._onMessage(ev));
    ws.addEventListener('close', (e) => {
      if (e.code === 4401) { signInAgain(); return; }   // signed out: see player.js
      if (e.code === 4403 && !this._closed) this.opts.onError?.("Your account can't review recordings");
      if (this.ws === ws && !this._closed) this._setState('paused');
    });
    ws.addEventListener('error', () => {});
  }

  /** Hold the picture at the current frame — unlike the old behaviour, this does NOT disconnect: the
   * session stays open and keeps decoding into the buffer in the background, so stepping forward right
   * after pausing has frames already waiting instead of needing a fresh DVR round trip. */
  pauseHere() {
    this._playout = 0;
    this.following = false;
    this._setState('paused');
  }

  /** Resume following the live decode: jumps to the newest buffered frame (catches up instantly rather
   * than visibly replaying whatever arrived while paused) and reconnects only if the session had actually
   * been closed (e.g. after a seek elsewhere). */
  resumeFollow() {
    this._landAt = null;
    this._playout = 0;
    this.following = true;
    if (this.buffer.length) {
      this.bufIndex = this.buffer.length - 1;
      this._paintIndex(this.bufIndex);
    }
    if (this.ws?.readyState === WebSocket.OPEN) this._setState('playing');
  }

  /** Play on from the frame on screen at the stream's own pace, out of what's already buffered (frames kept
   * arriving while paused), rather than jumping to the newest one — Instant replay's play after a pause or a
   * skip. Hands back to following the incoming stream if it ever catches up with it. */
  playFromHere() {
    this._landAt = null;
    if (this.bufIndex < 0 || this.bufIndex >= this.buffer.length - 1) { this.resumeFollow(); return; }
    const id = this._playout = this._playoutSeq = (this._playoutSeq || 0) + 1;   // never reused, so an older loop always stops
    const t0 = performance.now(), a0 = this.buffer[this.bufIndex].absTime, rate = Number(this.speed) || 1;
    this.following = false;
    this._setState('playing');
    const tick = () => {
      if (this._playout !== id || this._closed) return;
      const target = a0 + ((performance.now() - t0) / 1000) * rate;
      let i = Math.max(0, this.bufIndex);
      while (i < this.buffer.length - 1 && this.buffer[i + 1].absTime <= target) i++;
      if (i !== this.bufIndex) { this.bufIndex = i; this._paintIndex(i); this.opts.onFrame?.(this.buffer[i].absTime, this.frameCount); }
      if (i >= this.buffer.length - 1) { this._playout = 0; this.following = true; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Show the buffered frame at `absTime` (epoch seconds) if the buffer reaches that far; false if it doesn't
   * (the caller then asks the recorder with seek()). Leaves the player paused there. */
  showTime(absTime) {
    const b = this.buffer;
    if (!b.length || absTime < b[0].absTime - 0.25 || absTime > b[b.length - 1].absTime + 0.25) return false;
    let i = 0;
    while (i < b.length - 1 && b[i + 1].absTime <= absTime) i++;
    this._playout = 0;
    this.following = false;
    this.bufIndex = i;
    this._paintIndex(i);
    this.opts.onFrame?.(b[i].absTime, this.frameCount);
    return true;
  }

  _clearBuffer() {
    for (const { frame } of this.buffer) { try { frame.close(); } catch { /* already closed */ } }
    this.buffer = [];
    this.bufIndex = -1;
    this._pendingTimes = [];
    this._landAt = null;
  }

  /** While paused: jump to the frame at `absTime` as soon as it has been decoded into the buffer (a paused seek
   * holds the session's first frame — the keyframe before the requested instant — until the requested one
   * arrives, rather than playing the pre-roll while the UI says paused). */
  landAt(absTime) {
    this._landAt = absTime;
    const b = this.buffer;
    if (b.length && b[b.length - 1].absTime >= absTime - 0.05) { this._landAt = null; this.showTime(absTime); }
  }

  _setupDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch { /* already closed */ } }
    this._decodeErrors = 0;
    this.decoder = new VideoDecoder({
      output: (frame) => this._onDecodedFrame(frame),
      error: (e) => { this._decodeErrors++; if (this._decodeErrors > 5) this.opts.onError?.('Video decoding failed: ' + e.message); },
    });
    // Configured on the first keyframe (_submit): H.264's codec string comes from its SPS, and
    // isConfigSupported is asynchronous — chunks arriving meanwhile wait in _cfgQueue instead of being dropped
    // (dropping them lost the opening keyframe, and nothing showed until the next one, up to ~50 s later).
    this._cfg = 'new';
    this._cfgQueue = [];
  }

  /** Decode one access unit, configuring the decoder first if this is the first keyframe. */
  _submit(isKey, absTime, nal) {
    if (this._cfg === 'ready') { this._decodeNow(isKey, absTime, nal); return; }
    if (this._cfg === 'failed') return;
    if (this._cfg === 'new') {
      if (!isKey) return;   // nothing decodes before a keyframe
      this._cfg = 'pending';
      this._cfgQueue.push([isKey, absTime, nal]);
      this._configure(nal);
      return;
    }
    this._cfgQueue.push([isKey, absTime, nal]);
  }

  async _configure(keyNal) {
    const dec = this.decoder;
    const name = this.codec === 'h264' ? 'H.264' : 'H.265';
    const fail = (why) => {
      if (dec !== this.decoder) return;
      this._cfg = 'failed';
      this._cfgQueue = [];
      this._setState('error');
      this.opts.onError?.(why);
    };
    const config = decoderConfig(this.codec, keyNal);
    if (!config) { fail(`This camera's ${name} recording couldn't be read (no codec settings in its first frame).`); return; }
    try {
      const r = typeof VideoDecoder.isConfigSupported === 'function' ? await VideoDecoder.isConfigSupported(config) : { supported: true };
      if (dec !== this.decoder || dec.state === 'closed') return;   // replaced (reconnect/destroy) while checking
      if (!r.supported) { fail(`This browser can't decode this camera's ${name} recordings (${config.codec}).`); return; }
      dec.configure(config);
    } catch (e) {
      fail(`This browser can't decode this camera's ${name} recordings (${config.codec}): ${e.message || e}`);
      return;
    }
    this._decoderConfig = config;
    this._cfg = 'ready';
    const q = this._cfgQueue;
    this._cfgQueue = [];
    for (const [k, t, n] of q) this._decodeNow(k, t, n);
  }

  _decodeNow(isKey, absTime, nal) {
    try {
      this._pendingTimes.push(absTime);
      this.decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: Math.round(absTime * 1e6), data: nal }));
    } catch (e) {
      this._pendingTimes.pop();
      this._decodeErrors++;
    }
  }

  /** The server's per-segment metadata ("playing" once, then "segment" after each seek). */
  _applySegment(msg) {
    if (msg.codec === 'hevc' || msg.codec === 'h264') {
      if (msg.codec !== this.codec && this._cfg !== 'new') { this.codec = msg.codec; this._setupDecoder(); }
      this.codec = msg.codec;
    }
    this.displayFrom = typeof msg.display_from === 'number' ? msg.display_from : null;
    this.segment = msg;
    this.opts.onSegment?.(msg);
  }

  _onDecodedFrame(frame) {
    const absTime = this._pendingTimes.length ? this._pendingTimes.shift() : null;
    if (this.pendingKeyOnly) { frame.close(); return; }
    this.buffer.push({ frame, absTime });
    if (this.buffer.length > BUFFER_CAP) {
      const evicted = this.buffer.shift();
      try { evicted.frame.close(); } catch { /* already closed */ }
      if (this.bufIndex > 0) this.bufIndex--;
    }
    if (this.following) {
      this.bufIndex = this.buffer.length - 1;
      this.frameCount++;
      // Every frame is decoded (each depends on the one before), but painted at most once per screen
      // refresh: at 16x the recorder sends ~375 frames a second, and drawing (and re-labelling the UI for)
      // each one was what made fast playback stutter.
      if (!this._raf) {
        this._raf = requestAnimationFrame(() => {
          this._raf = 0;
          if (!this.following || this.bufIndex < 0) return;
          this._paintIndex(this.bufIndex);
          const t = this.buffer[this.bufIndex]?.absTime;
          if (t != null) this.opts.onFrame?.(t, this.frameCount);
        });
      }
    }
    // else: paused — the frame just sits buffered ahead of bufIndex until a step or resume reaches it
    else if (this._landAt != null && absTime != null && absTime >= this._landAt - 0.05) {
      const t = this._landAt;
      this._landAt = null;
      this.showTime(t);
    }
  }

  /** Up to `n` consecutive frames centred on the current paused position (oldest -> newest), for the AI
   * frame enhancer (docs/SPEC.md section 7.8) — copies of what's already decoded in memory, no new DVR
   * session. They're VideoFrame clones (cheap: they share the decoded picture), so nothing is encoded until
   * the enhancer actually sends the ones you chose; the caller owns them and must close() them. Odd counts
   * centre exactly on bufIndex; clamps to whatever's buffered near either edge. */
  grabFrames(n = 11) {
    if (!this.buffer.length) return [];
    const half = Math.floor(n / 2);
    let start = clampInt(this.bufIndex - half, 0, this.buffer.length - 1);
    const end = clampInt(start + n - 1, 0, this.buffer.length - 1);
    start = clampInt(end - n + 1, 0, this.buffer.length - 1);
    const out = [];
    for (let i = start; i <= end; i++) out.push(this.buffer[i].frame.clone());
    out.pausedIndex = this.bufIndex - start; // which of these is the frame on screen (not always the middle at a buffer edge)
    return out;
  }

  _paintIndex(i) {
    const entry = this.buffer[i];
    if (!entry) return;
    const { frame } = entry;
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); // drawImage reads the frame, doesn't consume it — it can stay in the buffer for backward stepping
  }

  _onMessage(ev) {
    if (typeof ev.data === 'string') {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'playing') { this._applySegment(msg); this._setState('playing'); }
      else if (msg.type === 'segment') this._applySegment(msg);
      else if (msg.type === 'queued') { this._setState('queued'); this.opts.onQueued?.(msg); }
      else if (msg.type === 'error') { this._setState('error'); this.opts.onError?.(msg.message); }
      return;
    }
    const buf = new Uint8Array(ev.data);
    const isKey = buf[0] === 1;
    const dv = new DataView(ev.data);
    const absTime = dv.getFloat64(1, false);
    const nal = buf.subarray(9);
    if (!this.decoder || this.decoder.state === 'closed') return;
    this._submit(isKey, absTime, nal);
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState?.(s);
  }

  /** Next frame. Instant if it's already buffered (arrived while paused, or from having just played
   * through this point); otherwise waits briefly for one more frame to arrive on the still-open
   * connection — never a fresh DVR session, unlike the old implementation. */
  async stepForward() {
    this._landAt = null;
    this._playout = 0;
    this.following = false;
    if (this.bufIndex < this.buffer.length - 1) {
      this.bufIndex++;
      this._paintIndex(this.bufIndex);
      return this.buffer[this.bufIndex].absTime;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null; // no live session to wait on — caller falls back
    const startLen = this.buffer.length;
    return new Promise((resolve) => {
      const deadline = performance.now() + 3000;
      const check = () => {
        if (this.buffer.length > startLen) {
          this.bufIndex = startLen; // the first frame that arrived after we asked
          this._paintIndex(this.bufIndex);
          resolve(this.buffer[this.bufIndex].absTime);
        } else if (performance.now() > deadline) {
          resolve(null);
        } else {
          setTimeout(check, 15);
        }
      };
      check();
    });
  }

  /** Previous frame. Instant when still within the buffered window (the common case); falls back to a
   * one-shot DVR fetch only once stepping back past the oldest frame still held in memory. */
  async stepBackward(beforeEpoch, channel) {
    this._landAt = null;
    this._playout = 0;
    this.following = false;
    if (this.bufIndex > 0) {
      this.bufIndex--;
      this._paintIndex(this.bufIndex);
      return this.buffer[this.bufIndex].absTime;
    }
    return this._fetchPriorGop(beforeEpoch, channel);
  }

  /** Fallback for stepping back past the buffer: fetches a short window ending at `beforeEpoch` into a
   * *new* buffer window (so subsequent backward steps from there are instant too), replacing the current
   * one, and positions at its last frame. */
  _fetchPriorGop(beforeEpoch, channel) {
    this._setState('connecting'); // the one step-backward case that's genuinely slow — let the pane's veil show it
    return new Promise((resolve, reject) => {
      // Asking for just before the target is enough: the recorder starts at the keyframe before whatever is
      // asked (measured 14-50 s apart on this recorder, not the ~9 s once assumed here), so the window from
      // that keyframe up to the target is exactly what arrives first. At 4x or more, so a long keyframe interval
      // arrives in seconds; this pane's own session (closed just below) leaves at least its own speed free.
      const start = new Date((beforeEpoch - 1) * 1000).toISOString();
      const speed = String(Math.max(4, Number(this.speed) || 1));
      this.disconnectSocket();
      const newBuf = [];
      const times = [];
      const dec = new VideoDecoder({
        output: (frame) => {
          newBuf.push({ frame, absTime: times.length ? times.shift() : null });
          // A keyframe interval here is up to ~a minute of 1080p frames: keep the newest BUFFER_CAP (the ones
          // just before the target), like the main buffer, instead of holding gigabytes of decoded pictures.
          if (newBuf.length > BUFFER_CAP) { try { newBuf.shift().frame.close(); } catch { /* already closed */ } }
        },
        error: () => {},
      });
      let cfg = this._decoderConfig;   // the stream's own config from the main session, when it had one
      if (cfg) dec.configure(cfg);
      let settled = false, reached = false;
      const ws = new WebSocket(wsUrl(channel, start, speed));
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.decoder = dec;
      const finish = () => {
        if (settled) return;
        settled = true;
        ws.close();
        this._clearBuffer();
        this.buffer = newBuf.filter((f) => f.absTime != null && f.absTime < beforeEpoch - 1e-6);
        for (const f of newBuf) if (!this.buffer.includes(f)) { try { f.frame.close(); } catch { /* already closed */ } }
        if (!this.buffer.length) { resolve(null); return; }
        this.bufIndex = this.buffer.length - 1;
        this._paintIndex(this.bufIndex);
        this._setupDecoder(); // fresh decoder for whatever comes next (seek/resume/further steps)
        this._setState('paused');
        resolve(this.buffer[this.bufIndex].absTime);
      };
      ws.addEventListener('message', (ev) => {
        if (settled) return;
        if (typeof ev.data === 'string') {
          let msg; try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.type === 'error') { settled = true; reject(new Error(msg.message)); ws.close(); }
          return;
        }
        const buf = new Uint8Array(ev.data);
        const isKey = buf[0] === 1;
        const dv = new DataView(ev.data);
        const abs = dv.getFloat64(1, false);
        const nal = buf.subarray(9);
        if (abs >= beforeEpoch - 1e-6) { // reached the target — let the decoder emit what it holds, then stop
          if (!reached) { reached = true; (dec.state === 'configured' ? dec.flush() : Promise.resolve()).catch(() => {}).finally(finish); }
          return;
        }
        if (!cfg && isKey) { cfg = decoderConfig(this.codec, nal); if (cfg) { try { dec.configure(cfg); } catch { cfg = null; } } }
        if (dec.state === 'configured') {
          try { times.push(abs); dec.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: Math.round(abs * 1e6), data: nal })); } catch { times.pop(); /* skip a bad chunk */ }
        }
      });
      ws.addEventListener('close', () => finish());
      // Up to a 60 s keyframe interval at `speed`, plus connecting.
      setTimeout(finish, 8000 + (60 / Number(speed)) * 1000);
    });
  }

  /** Send a control message without reconnecting (seek within the open session, or change speed). */
  seek(iso, scale) {
    this._playout = 0;
    this._clearBuffer();
    this.following = true;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'seek', t: iso, scale }));
  }

  setSpeed(scale) {
    this.speed = scale;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'speed', scale }));
  }

  disconnectSocket() {
    if (this.ws) { try { this.ws.close(); } catch { /* already closing */ } this.ws = null; }
  }

  destroy() {
    this._closed = true;
    this._playout = 0;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this.disconnectSocket();
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch { /* already closed */ } }
    this._clearBuffer();
  }
}
