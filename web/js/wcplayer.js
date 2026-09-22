// WebCodecs-based DVR playback player. Connects to /api/playback/ws, decodes H.265 Annex-B access units
// with WebCodecs VideoDecoder (verified directly against this DVR's footage — see docs/playback-spec.md
// section 2.6/7.2), and paints decoded frames to a <canvas>. No <video> element: WebCodecs frames are
// painted directly, which is what lets us do exact frame-stepping and report a real decoded-frame clock.

const wsUrl = (channel, startIso, speed) => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/playback/ws?channel=${encodeURIComponent(channel)}&start=${encodeURIComponent(startIso)}&speed=${encodeURIComponent(speed)}`;
};

export class WCPlayer {
  /** @param canvas target <canvas> @param opts {onFrame(absTime), onState(state), onError(msg)} */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.ws = null;
    this.decoder = null;
    this.state = 'idle'; // idle | connecting | queued | playing | paused | error
    this.lastFrameTime = null;
    this.frameCount = 0;
    this.pendingKeyOnly = false;
    this._closed = false;
    this._decodeErrors = 0;
  }

  get supported() {
    return 'VideoDecoder' in window;
  }

  connect(channel, startIso, speed = '1') {
    this.disconnectSocket();
    this._setupDecoder();
    this._setState('connecting');
    this.channel = channel;
    this.speed = speed;
    const ws = new WebSocket(wsUrl(channel, startIso, speed));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('message', (ev) => this._onMessage(ev));
    ws.addEventListener('close', () => { if (this.ws === ws && !this._closed) this._setState('paused'); });
    ws.addEventListener('error', () => {});
  }

  _setupDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch { /* already closed */ } }
    this._decodeErrors = 0;
    this.decoder = new VideoDecoder({
      output: (frame) => this._paint(frame),
      error: (e) => { this._decodeErrors++; if (this._decodeErrors > 5) this.opts.onError?.('Video decoding failed: ' + e.message); },
    });
    this.decoder.configure({ codec: 'hvc1.1.6.L153.B0', hardwareAcceleration: 'no-preference' });
  }

  _paint(frame) {
    if (this.pendingKeyOnly) { frame.close(); return; }
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    frame.close();
    this.frameCount++;
    if (this.lastFrameTime != null) this.opts.onFrame?.(this.lastFrameTime, this.frameCount);
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
    this.lastFrameTime = absTime;
    if (this.decoder.state !== 'configured') return;
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: Math.round(absTime * 1e6), data: nal }));
    } catch (e) {
      this._decodeErrors++;
    }
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState?.(s);
  }

  /** Decode forward from `afterEpoch` and paint the first frame strictly after it, then stop.
   * (A real "next frame" step. MVP simplification for reverse is in stepBackward below — each backward
   * step re-fetches a fresh short window from the DVR rather than keeping a live GOP buffer, since only
   * one open session is needed either way; docs/playback-spec.md section 7.5 describes the fuller design.) */
  async stepForward(afterEpoch, channel, speed = '1') {
    return this._oneShot(channel, new Date(afterEpoch * 1000).toISOString(), (t) => t > afterEpoch + 1e-6, false);
  }

  /** Decode a short window ending at `beforeEpoch` and paint the last frame strictly before it. */
  async stepBackward(beforeEpoch, channel) {
    const start = new Date((beforeEpoch - 9) * 1000).toISOString();
    return this._oneShot(channel, start, (t) => t >= beforeEpoch - 1e-6, true);
  }

  _oneShot(channel, startIso, stopCond, wantLast) {
    return new Promise((resolve, reject) => {
      this.disconnectSocket();
      this._setupDecoder();
      const ws = new WebSocket(wsUrl(channel, startIso, '1'));
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let lastGood = null, lastAbs = null, settled = false;
      const finish = (t) => { if (settled) return; settled = true; ws.close(); resolve(t); };
      const dec = new VideoDecoder({
        output: (frame) => {
          const t = this._pendingAbs;
          if (wantLast) {
            if (stopCond(t)) { if (lastGood != null) this._paintRaw(lastGood); frame.close(); finish(lastAbs); }
            else { if (lastGood) lastGood.close(); lastGood = frame; lastAbs = t; }
          } else {
            if (stopCond(t)) { this._paintRaw(frame); finish(t); } else frame.close();
          }
        },
        error: () => {},
      });
      dec.configure({ codec: 'hvc1.1.6.L153.B0', hardwareAcceleration: 'no-preference' });
      this.decoder = dec;
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
        this._pendingAbs = dv.getFloat64(1, false);
        const nal = buf.subarray(9);
        if (dec.state === 'configured') {
          try { dec.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: Math.round(this._pendingAbs * 1e6), data: nal })); } catch { /* skip a bad chunk */ }
        }
      });
      ws.addEventListener('close', () => { if (!settled) { settled = true; resolve(lastAbs); } });
      setTimeout(() => { if (!settled) finish(lastAbs); }, 8000);
    });
  }

  _paintRaw(frame) {
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    frame.close();
  }

  /** Send a control message without reconnecting (seek within the open session, or change speed). */
  seek(iso, scale) {
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
  }
}
