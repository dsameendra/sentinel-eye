// WebCodecs-based DVR playback player. Connects to /api/playback/ws, decodes H.265 Annex-B access units
// with WebCodecs VideoDecoder (verified directly against this DVR's footage — see docs/SPEC.md
// section 2.6/7.2), and paints decoded frames to a <canvas>. No <video> element: WebCodecs frames are
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

const wsUrl = (channel, startIso, speed) => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/playback/ws?channel=${encodeURIComponent(channel)}&start=${encodeURIComponent(startIso)}&speed=${encodeURIComponent(speed)}`;
};

const BUFFER_CAP = 450; // ~30s at ~15fps — generous for stepping, bounded so memory doesn't grow unbounded
const clampInt = (v, a, b) => Math.min(b, Math.max(a, v));

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
    ws.addEventListener('close', () => { if (this.ws === ws && !this._closed) this._setState('paused'); });
    ws.addEventListener('error', () => {});
  }

  /** Hold the picture at the current frame — unlike the old behaviour, this does NOT disconnect: the
   * session stays open and keeps decoding into the buffer in the background, so stepping forward right
   * after pausing has frames already waiting instead of needing a fresh DVR round trip. */
  pauseHere() {
    this.following = false;
    this._setState('paused');
  }

  /** Resume following the live decode: jumps to the newest buffered frame (catches up instantly rather
   * than visibly replaying whatever arrived while paused) and reconnects only if the session had actually
   * been closed (e.g. after a seek elsewhere). */
  resumeFollow() {
    this.following = true;
    if (this.buffer.length) {
      this.bufIndex = this.buffer.length - 1;
      this._paintIndex(this.bufIndex);
    }
    if (this.ws?.readyState === WebSocket.OPEN) this._setState('playing');
  }

  _clearBuffer() {
    for (const { frame } of this.buffer) { try { frame.close(); } catch { /* already closed */ } }
    this.buffer = [];
    this.bufIndex = -1;
    this._pendingTimes = [];
  }

  _setupDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch { /* already closed */ } }
    this._decodeErrors = 0;
    this.decoder = new VideoDecoder({
      output: (frame) => this._onDecodedFrame(frame),
      error: (e) => { this._decodeErrors++; if (this._decodeErrors > 5) this.opts.onError?.('Video decoding failed: ' + e.message); },
    });
    this.decoder.configure({ codec: 'hvc1.1.6.L153.B0', hardwareAcceleration: 'no-preference' });
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
      this._paintIndex(this.bufIndex);
      this.frameCount++;
      if (absTime != null) this.opts.onFrame?.(absTime, this.frameCount);
    }
    // else: paused — the frame just sits buffered ahead of bufIndex until a step or resume reaches it
  }

  /** Up to `n` consecutive frames centred on the current paused position, as PNG data URLs (oldest ->
   * newest), for the AI frame enhancer (docs/SPEC.md section 7.8) — pulled straight from the decode buffer
   * already sitting in memory, no new DVR session. Odd counts centre exactly on bufIndex; clamps to
   * whatever's actually buffered around it rather than erroring near either edge of the window. */
  grabFrames(n = 5) {
    if (!this.buffer.length) return [];
    const half = Math.floor(n / 2);
    let start = clampInt(this.bufIndex - half, 0, this.buffer.length - 1);
    let end = clampInt(start + n - 1, 0, this.buffer.length - 1);
    start = clampInt(end - n + 1, 0, this.buffer.length - 1);
    const tmp = document.createElement('canvas');
    const tctx = tmp.getContext('2d');
    const out = [];
    for (let i = start; i <= end; i++) {
      const { frame } = this.buffer[i];
      if (tmp.width !== frame.displayWidth || tmp.height !== frame.displayHeight) {
        tmp.width = frame.displayWidth; tmp.height = frame.displayHeight;
      }
      tctx.drawImage(frame, 0, 0, tmp.width, tmp.height);
      out.push(tmp.toDataURL('image/png'));
    }
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
      if (msg.type === 'playing') this._setState('playing');
      else if (msg.type === 'queued') { this._setState('queued'); this.opts.onQueued?.(msg); }
      else if (msg.type === 'error') { this._setState('error'); this.opts.onError?.(msg.message); }
      return;
    }
    const buf = new Uint8Array(ev.data);
    const isKey = buf[0] === 1;
    const dv = new DataView(ev.data);
    const absTime = dv.getFloat64(1, false);
    const nal = buf.subarray(9);
    if (this.decoder.state !== 'configured') return;
    try {
      this._pendingTimes.push(absTime);
      this.decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: Math.round(absTime * 1e6), data: nal }));
    } catch (e) {
      this._pendingTimes.pop();
      this._decodeErrors++;
    }
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
      const start = new Date((beforeEpoch - 9) * 1000).toISOString();
      this.disconnectSocket();
      const newBuf = [];
      const dec = new VideoDecoder({
        output: (frame) => { newBuf.push({ frame, absTime: pendingAbs }); },
        error: () => {},
      });
      dec.configure({ codec: 'hvc1.1.6.L153.B0', hardwareAcceleration: 'no-preference' });
      let pendingAbs = null, settled = false;
      const ws = new WebSocket(wsUrl(channel, start, '1'));
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
        pendingAbs = dv.getFloat64(1, false);
        const nal = buf.subarray(9);
        if (pendingAbs >= beforeEpoch - 1e-6) { finish(); return; } // reached the target — stop, we have enough
        if (dec.state === 'configured') {
          try { dec.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: Math.round(pendingAbs * 1e6), data: nal })); } catch { /* skip a bad chunk */ }
        }
      });
      ws.addEventListener('close', () => finish());
      setTimeout(finish, 8000);
    });
  }

  /** Send a control message without reconnecting (seek within the open session, or change speed). */
  seek(iso, scale) {
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
    this.disconnectSocket();
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch { /* already closed */ } }
    this._clearBuffer();
  }
}
