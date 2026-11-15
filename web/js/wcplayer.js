// WebCodecs-based DVR playback player. Connects to /api/playback/ws, decodes H.265 or H.264 Annex-B access
// units with WebCodecs VideoDecoder (H.265 verified directly against this DVR's footage — see docs/SPEC.md
// section 2.6/7.2; the codec comes from the server's "playing" message, and H.264's codec string from the SPS
// in the first keyframe — codecs.js), and paints decoded frames to a <canvas>. Frame times are the recorded
// times the server labelled them with; a session starts at the keyframe before the requested instant, so the
// first frames can be earlier than asked (`displayFrom` says where the request was). No <video> element: WebCodecs
// frames are painted directly, which is what lets us do exact frame-stepping and frame-locked panes.
//
// A passive renderer of a clock (masterclock.js): what's on screen is always the newest decoded frame whose
// recorded time is <= the clock's time T. Playback hands every pane one shared MasterClock (`opts.clock`) and
// calls render(T) for each pane on every animation frame — that is what keeps 2-4 cameras on the same instant
// (docs/SPEC.md 7.2). Instant replay and the event preview give no clock: the player then runs one of its own and
// starts it at its first frame, playing the keyframe pre-roll as before.
//
// Memory: what arrives is kept *encoded* (~5 KB a frame on this recorder, ~40 KB a keyframe): a few seconds ahead
// of T to ride out the recorder's bursty delivery, and up to a minute behind it for stepping back. Only a handful
// of frames around T are decoded at any time (decoded 1080p frames are ~3 MB each and hold decoder memory, so
// they are closed as soon as they fall out of that window). Stepping back past the decoded ones re-decodes from
// the keyframe before (spec 7.5's "decode the preceding GOP and walk it"), from memory, not from the recorder.
//
// Back-pressure: once enough is buffered ahead of T the player asks the server to pause the recorder's feed
// ({"type":"hold"}, an RTSP PAUSE kept alive), and to resume it as T catches up; while short of footage it asks
// for the fastest feed the recorder's budget allows ({"type":"speed"}) — a speed change carries on from the next
// frame (PLAY npt=now-), so nothing is replayed. Nothing is dropped anywhere along the way.

import { signInAgain } from './api.js';
import { decoderConfig } from './codecs.js';
import { MasterClock, aheadWall, decodeAhead, feedPlan, frameAt, gapJump, paneState, shouldWait, shownIndex, stepTime, EPS, FEED } from './masterclock.js';

const wsUrl = (channel, startIso, speed) => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/playback/ws?channel=${encodeURIComponent(channel)}&start=${encodeURIComponent(startIso)}&speed=${encodeURIComponent(speed)}`;
};

const KEEP_ENCODED_BEHIND_S = 60;   // encoded footage kept behind T for stepping back without the recorder
const MAX_INFLIGHT = 8;             // chunks handed to the decoder and not yet out
const MAX_INFLIGHT_PRE = 32;        // ... while they're all before T (decoded, then closed unseen)
let liveFrames = 0;                  // decoded VideoFrames open across every player (the memory check reads it)
const closeFrame = (f) => { try { f.close(); liveFrames--; } catch { /* already closed */ } };

// Why WebCodecs is missing, for the user. Browsers only expose VideoDecoder in a secure context (HTTPS or
// localhost), so plain http://<lan-ip> hides it even in a current Chrome/Edge/Safari.
export function unsupportedReason() {
  if (!window.isSecureContext) {
    return `Playback needs HTTPS or localhost — the browser disables WebCodecs on plain http://${location.host}. ` +
      'Open it through an HTTPS proxy/tunnel, or an SSH tunnel to http://localhost.';
  }
  return 'This browser lacks WebCodecs — Chrome, Edge or Safari 16.4+ is needed.';
}

export function openVideoFrames() { return liveFrames; }

export class WCPlayer {
  /** @param canvas target <canvas>
   *  @param opts {onFrame(absTime, count), onState(state), onError(msg), onQueued(info), onSegment(msg),
   *    clock: a shared MasterClock — the owner then calls render(T) every animation frame and decides when the
   *      clock waits; without one the player runs its own, starting at its first frame,
   *    maxSpeed(): the fastest feed the recorder's budget allows for this pane (default: the playing speed),
   *    keepBehind: decoded frames kept behind the one on screen (instant back-steps; default 8)} */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.ws = null;
    this.decoder = null;
    this.state = 'idle'; // idle | connecting | queued | playing | paused | error
    this.frameCount = 0;
    this._closed = false;
    this._decodeErrors = 0;
    this.codec = 'hevc';    // from the server's "playing" message; an older server never says, and only served H.265
    this.displayFrom = null; // the requested instant of the current segment (frames before it are keyframe pre-roll)
    this.segment = null;    // the server's latest "playing"/"segment" message: time_source, approx, bound_s, …
    this._decoderConfig = null;
    this.external = !!opts.clock;
    this.clock = opts.clock || new MasterClock();
    this.speed = '1';
    this._reset();
    // Leaving the page (or it going into the back/forward cache) closes the session at once: a frozen page
    // never reads its socket again, and the recorder session (one of its four) would stay held behind it.
    this._onPageHide = () => this.disconnectSocket(true);
    window.addEventListener('pagehide', this._onPageHide);
    if (!this.external) this._loop();
  }

  get supported() {
    return 'VideoDecoder' in window;
  }

  // ------------------------------------------------------------------ store
  _reset() {
    for (const f of this.frames || []) closeFrame(f.frame);
    this.chunks = [];        // arrival order: {t, key, data, shown} — `shown`: a new latest time (displayable)
    this.base = 0;           // arrival index of chunks[0] (older ones evicted)
    this.dispT = [];         // ascending times of the displayable chunks …
    this.dispI = [];         // … and their arrival indexes
    this.bytes = 0;
    this.decodePos = 0;      // arrival index of the next chunk to decode
    this.inflight = 0;
    this.frames = [];        // decoded, ascending by t: {t, frame}
    this.painted = null;     // time of the frame on the canvas
    this.ended = false;      // the feed finished (socket closed without an error)
    this.feed = { hold: false, scale: null };   // what this player last asked the server for
    this.feedAck = null;     // the server's last {"type":"feed"} answer (an older server never sends one)
    this._anchor = !this.external;   // own clock: start it at the first frame that arrives
  }

  _connectFresh(channel, startIso, feedScale) {
    this.disconnectSocket();
    this._reset();
    this._setupDecoder();
    this._setState('connecting');
    this.segment = null;
    this.channel = channel;
    const ws = new WebSocket(wsUrl(channel, startIso, feedScale));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.feed = { hold: false, scale: feedScale };
    ws.addEventListener('message', (ev) => { if (this.ws === ws) { this._notReady = 0; this._onMessage(ev); } });
    ws.addEventListener('close', (e) => {
      if (e.code === 4401) { signInAgain(); return; }   // signed out: see player.js
      if (e.code === 4403 && !this._closed) this.opts.onError?.("Your account can't review recordings");
      // 4409: the server isn't ready to place recorded times yet (just started: no recorder clock or calibration
      // read) and says to retry shortly. It refuses before accepting, so a browser sees only 1006 — retry that too
      // while nothing has arrived on this socket: every 2 s for a minute, still "connecting".
      if ((e.code === 4409 || (e.code === 1006 && !this.segment)) && this.ws === ws && !this._closed && (this._notReady = (this._notReady || 0) + 1) <= 30) {
        this.ws = null;
        setTimeout(() => { if (!this._closed && !this.ws) this._connectFresh(channel, startIso, feedScale); }, 2000);
        return;
      }
      if (this.ws === ws && !this._closed) { this.ended = this.state !== 'error'; this.ws = null; this._setState(this.state === 'error' ? 'error' : 'paused'); }
    });
    ws.addEventListener('error', () => {});
  }

  /** Open a recorder session at `startIso`. `speed`: the playing speed (own clock), or ignored with a shared
   * clock, whose owner sets the speed; the feed starts at the fastest the budget allows, to get through the
   * keyframe pre-roll quickly. */
  connect(channel, startIso, speed = '1') {
    if (!this.external) { this.speed = speed; this.clock.setSpeed(speed); this.clock.play(); }
    this._connectFresh(channel, startIso, this._maxSpeed());
  }

  _maxSpeed() { return String(this.opts.maxSpeed?.() || (this.external ? this.clock.speed : this.speed) || '1'); }

  _send(msg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  // ------------------------------------------------------------------ decoding
  _setupDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch { /* already closed */ } }
    this._decodeErrors = 0;
    this.inflight = 0;
    this.decoder = new VideoDecoder({
      output: (frame) => this._onDecodedFrame(frame),
      error: (e) => { this._decodeErrors++; if (this._decodeErrors > 5) this.opts.onError?.('Video decoding failed: ' + e.message); },
    });
    // Configured on the first keyframe (_configure): H.264's codec string comes from its SPS, and
    // isConfigSupported is asynchronous — decoding waits for it rather than dropping the opening keyframe.
    this._cfg = 'new';
  }

  async _configure(keyData) {
    const dec = this.decoder;
    const name = this.codec === 'h264' ? 'H.264' : 'H.265';
    const fail = (why) => {
      if (dec !== this.decoder) return;
      this._cfg = 'failed';
      this._setState('error');
      this.opts.onError?.(why);
    };
    const config = decoderConfig(this.codec, keyData);
    if (!config) { fail(`This camera's ${name} recording couldn't be read (no codec settings in its first frame).`); return; }
    this._cfg = 'pending';
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
    this._pump();
  }

  _chunk(i) { return this.chunks[i - this.base]; }
  get _end() { return this.base + this.chunks.length; }

  /** Restart decoding at the keyframe at or before arrival index `i` (a step or seek back past what's decoded,
   * or a jump forward past a keyframe). */
  _decodeFrom(i) {
    let k = Math.min(i, this._end - 1);
    while (k >= this.base && !this._chunk(k).key) k--;
    if (k < this.base) return false;
    if (this._cfg === 'ready') {
      try { this.decoder.reset(); this.decoder.configure(this._decoderConfig); } catch { return false; }
    }
    this.inflight = 0;
    this.decodePos = k;
    // Decoded frames after the wanted one belong to the old decode position: they'd count as "already decoded
    // ahead" and starve the new run, so they go (they're decoded again as T reaches them).
    const want = this._chunk(i).t;
    this.frames = this.frames.filter((f) => (f.t > want + EPS ? (closeFrame(f.frame), false) : true));
    return true;
  }

  /** Feed the decoder: everything up to the frame for T, then a few frames ahead (decodeAhead), never more than
   * MAX_INFLIGHT at once. The frames before T that come out are closed at once (keyframe pre-roll). */
  _pump() {
    if (this._cfg === 'new') {
      const k = this.chunks.find((c) => c.key);
      if (k) this._configure(k.data);
      return;
    }
    if (this._cfg !== 'ready' || this.decoder.state !== 'configured') return;
    const T = this.clock.time();
    const want = shownIndex(this.dispT, T);
    if (want >= 0) {
      const wi = this.dispI[want];
      const have = this._decodedAt(this.dispT[want]);
      // The frame for T was decoded once and has been closed (a step or seek back), or the decoder is far
      // behind it with a keyframe in between (a jump forward): restart at the keyframe before it.
      if (!have && this.decodePos > wi && this.inflight === 0) this._decodeFrom(wi);
      else if (!have && wi - this.decodePos > 2 * MAX_INFLIGHT) {
        let k = wi;
        while (k > this.decodePos && !this._chunk(k).key) k--;
        if (k > this.decodePos + MAX_INFLIGHT) this._decodeFrom(k);
      }
    }
    const aheadCap = decodeAhead(this.clock.speed);
    let ahead = 0;
    for (let i = this.frames.length - 1; i >= 0 && this.frames[i].t > T + EPS; i--) ahead++;
    while (this.decodePos < this._end) {
      const c = this._chunk(this.decodePos);
      // Frames before T (a keyframe pre-roll, a re-decode after a seek back) are closed as they come out, so the
      // decoder can be kept busier there: a deeper queue roughly halved how long four panes took to reach T.
      const pre = c.t < T - EPS;
      if (this.inflight >= (pre ? MAX_INFLIGHT_PRE : MAX_INFLIGHT) || (!pre && ahead + this.inflight >= aheadCap)) break;
      this.decodePos++;
      try {
        this.decoder.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: Math.round(c.t * 1e6), data: c.data }));
        this.inflight++;
      } catch { this._decodeErrors++; }
    }
  }

  _decodedAt(t) {
    const i = frameAt(this.frames.map((f) => f.t), t);
    return i >= 0 && Math.abs(this.frames[i].t - t) < 1e-4 ? this.frames[i] : null;
  }

  _onDecodedFrame(frame) {
    liveFrames++;
    this.inflight = Math.max(0, this.inflight - 1);
    if (this._closed) { closeFrame(frame); return; }
    const t = frame.timestamp / 1e6;
    const fr = this.frames;
    let i = fr.length;
    while (i > 0 && fr[i - 1].t > t) i--;
    if (i > 0 && Math.abs(fr[i - 1].t - t) < 1e-4) { closeFrame(frame); }   // already have it (a re-decode)
    else fr.splice(i, 0, { t, frame });
    this._trim();
    this._pump();
  }

  /** Close decoded frames outside [keepBehind before the one for T, decodeAhead after it]. */
  _trim() {
    const T = this.clock.time();
    const times = this.frames.map((f) => f.t);
    let s = frameAt(times, T);
    if (s < 0) s = 0;
    const behind = this.opts.keepBehind ?? 8, ahead = decodeAhead(this.clock.speed);
    const lo = Math.max(0, s - behind), hi = s + ahead;
    if (lo === 0 && hi >= this.frames.length - 1) return;
    const keep = [];
    this.frames.forEach((f, k) => { if (k < lo || k > hi) closeFrame(f.frame); else keep.push(f); });
    this.frames = keep;
  }

  // ------------------------------------------------------------------ render (every animation frame)
  /** Paint the newest decoded frame <= T (or nothing new while it isn't decoded yet), keep the decoder fed, steer
   * the recorder's feed, and drop encoded footage long behind T. */
  render(T = this.clock.time()) {
    this._pump();
    this._trim();
    const want = shownIndex(this.dispT, T);
    if (want >= 0) {
      const f = this._decodedAt(this.dispT[want]);
      if (f && f.t !== this.painted) {
        this._paint(f.frame);
        this.painted = f.t;
        this.frameCount++;
        this.opts.onFrame?.(f.t, this.frameCount);
      }
    }
    this._steerFeed(T);
    this._evict(T);
  }

  _paint(frame) {
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);   // reads the frame, doesn't consume it
  }

  /** Where this pane stands at T (masterclock.paneState) and how much playing time it has buffered ahead. */
  status(T = this.clock.time()) {
    const n = this.dispT.length;
    const i = shownIndex(this.dispT, T);
    const cur = i >= 0 ? this.dispT[i] : null;
    const p = {
      off: this.state === 'error' || this._cfg === 'failed' || (!this.ws && !n && !this.ended && this.state !== 'connecting'),
      first: n ? this.dispT[0] : null, newest: n ? this.dispT[n - 1] : null, ended: this.ended || (this.ws == null && n > 0),
      cur, next: i + 1 < n ? this.dispT[i + 1] : null,
      shownOk: cur != null && !!this._decodedAt(cur),
    };
    const state = this.state === 'queued' && !n ? 'connecting' : paneState(p, T);
    return { state, ahead: aheadWall(p, T, this.clock.speed), shown: this.painted, cur, next: p.next, newest: p.newest, ended: p.ended };
  }

  _steerFeed(T) {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.segment) return;
    const n = this.dispT.length;
    const ahead = aheadWall({ newest: n ? this.dispT[n - 1] : null }, T, this.clock.speed);
    const plan = feedPlan(ahead, this.feed, { speed: this.clock.speed, maxSpeed: this._maxSpeed(), bytes: this.bytes });
    if (plan.hold !== this.feed.hold) {
      this._send({ type: plan.hold ? 'hold' : 'resume' });
      this.feed.hold = plan.hold;
    }
    if (plan.scale !== this.feed.scale && !(this.feedAck?.refused === plan.scale && performance.now() - this._refusedAt < 10000)) {
      this._send({ type: 'speed', scale: plan.scale });
      this.feed.scale = plan.scale;
    }
    // An older server ignores "hold": past twice the cap, stop taking more (the feed ends here and Playback
    // reopens it at T when T gets there) rather than growing without bound.
    if (this.bytes > 2 * FEED.maxBytes) this.disconnectSocket(true);
  }

  /** Drop encoded footage more than KEEP_ENCODED_BEHIND_S behind T, from a keyframe on (what's kept must decode). */
  _evict(T) {
    const limit = T - KEEP_ENCODED_BEHIND_S;
    let cut = -1;
    for (let i = this.base; i < Math.min(this.decodePos, this._end); i++) {
      const c = this._chunk(i);
      if (c.t > limit) break;
      if (c.key && i > this.base) cut = i;
    }
    if (cut <= this.base) return;
    const n = cut - this.base;
    for (const c of this.chunks.slice(0, n)) this.bytes -= c.data.byteLength;
    this.chunks.splice(0, n);
    this.base = cut;
    let d = 0;
    while (d < this.dispI.length && this.dispI[d] < cut) d++;
    if (d) { this.dispI.splice(0, d); this.dispT.splice(0, d); }
  }

  // ------------------------------------------------------------------ own clock (no shared one)
  _loop() {
    const tick = () => {
      if (this._closed) return;
      const clk = this.clock;
      const st = this.status(clk.time());
      if (clk.playing) {
        const j = gapJump([st], clk.time());
        if (j != null) clk.seek(j);
        clk.setWaiting(shouldWait([st], clk.waiting));
      } else clk.setWaiting(false);
      this.render(clk.time());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ socket
  _applySegment(msg) {
    if (msg.codec === 'hevc' || msg.codec === 'h264') {
      if (msg.codec !== this.codec && this._cfg !== 'new') { this.codec = msg.codec; this._setupDecoder(); }
      this.codec = msg.codec;
    }
    this.displayFrom = typeof msg.display_from === 'number' ? msg.display_from : null;
    this.segment = msg;
    this.opts.onSegment?.(msg);
  }

  _onMessage(ev) {
    if (typeof ev.data === 'string') {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'playing') {
        if (typeof msg.scale === 'string') this.feed.scale = msg.scale;
        this._applySegment(msg);
        this._setState(this.external || this.clock.playing ? 'playing' : 'paused');
      } else if (msg.type === 'segment') this._applySegment(msg);
      else if (msg.type === 'feed') {
        this.feedAck = msg;
        if (msg.refused && msg.refused !== 'hold') { this._refusedAt = performance.now(); this.feed.scale = msg.scale; }
        if (msg.refused === 'hold') this.feed.hold = false;
      } else if (msg.type === 'queued') { this._setState('queued'); this.opts.onQueued?.(msg); }
      else if (msg.type === 'error') { this._setState('error'); this.opts.onError?.(msg.message); }
      return;
    }
    const buf = new Uint8Array(ev.data);
    const key = buf[0] === 1;
    const t = new DataView(ev.data).getFloat64(1, false);
    const data = buf.slice(9);   // a copy: the store outlives the message
    const n = this.dispT.length;
    // A frame no newer than one already received (a recorder that restarted from a keyframe): decoded for the
    // ones after it, never shown as new — the picture can't jump back.
    const shown = !n || t > this.dispT[n - 1] + 1e-6;
    const i = this._end;
    this.chunks.push({ t, key, data, shown });
    this.bytes += data.byteLength;
    if (shown) { this.dispT.push(t); this.dispI.push(i); }
    if (this._anchor && shown) { this._anchor = false; this.clock.seek(t); }
    if (this.decoder && this.decoder.state !== 'closed') this._pump();
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState?.(s);
  }

  disconnectSocket(keepStore = false) {
    if (this.ws) { const ws = this.ws; this.ws = null; try { ws.close(); } catch { /* already closing */ } }
    if (keepStore) this.ended = true;
  }

  // ------------------------------------------------------------------ playback controls
  /** Time of the frame after (dir 1) or before (dir -1) the one shown at T, or null if none is buffered. */
  stepTime(T, dir) { return stepTime(this.dispT, T, dir); }

  /** Whether the footage buffered here covers `t` (a seek to it needs no new recorder session). */
  covers(t) {
    const n = this.dispT.length;
    return n > 0 && t >= this.dispT[0] - EPS && t <= this.dispT[n - 1] + EPS;
  }

  /** Hold the picture at the current frame (own clock). The session stays open; the feed is paused once enough
   * is buffered. */
  pauseHere() {
    this.clock.pause();
    if (this.painted != null && !this.external) this.clock.seek(this.painted);
    this._setState('paused');
  }

  /** Play on from the frame on screen (own clock). */
  resumeFollow() {
    this.clock.play();
    if (this.ws?.readyState === WebSocket.OPEN) this._setState('playing');
  }

  playFromHere() { this.resumeFollow(); }

  /** Show the buffered frame at `absTime` (epoch seconds) if the buffer reaches that far; false if it doesn't
   * (the caller then asks the recorder with seek()). Leaves the player paused there. */
  showTime(absTime) {
    const n = this.dispT.length;
    if (!n || absTime < this.dispT[0] - 0.25 || absTime > this.dispT[n - 1] + 0.25) return false;
    this.clock.pause();
    this.clock.seek(absTime);
    this._setState('paused');
    this.render(absTime);
    return true;
  }

  /** Paused: land on the frame for `absTime` once it's decoded (own clock). */
  landAt(absTime) { this.clock.pause(); this.clock.seek(absTime); }

  async stepForward() { return this._step(1); }
  async stepBackward() { return this._step(-1); }

  /** One frame on or back (own clock): waits briefly for the next frame to arrive; null when there's none. */
  async _step(dir) {
    this.clock.pause();
    this._setState('paused');
    const from = this.painted ?? this.clock.time();
    const deadline = performance.now() + 3000;
    for (;;) {
      const t = stepTime(this.dispT, from, dir);
      if (t != null) { this.clock.seek(t); this.render(t); return t; }
      if (dir < 0 || !this.ws || performance.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  /** Up to `n` consecutive decoded frames centred on the one on screen (oldest -> newest), for the AI frame
   * enhancer (docs/SPEC.md section 7.8) — VideoFrame clones (cheap: they share the decoded picture); the caller
   * owns them and must close() them. Clamps to whatever's decoded near either edge. */
  grabFrames(n = 11) {
    if (!this.frames.length) return [];
    const times = this.frames.map((f) => f.t);
    const at = Math.max(0, frameAt(times, this.painted ?? this.clock.time()));
    const half = Math.floor(n / 2);
    let start = Math.max(0, Math.min(at - half, this.frames.length - 1));
    const end = Math.min(this.frames.length - 1, start + n - 1);
    start = Math.max(0, end - n + 1);
    const out = [];
    for (let i = start; i <= end; i++) out.push(this.frames[i].frame.clone());
    out.pausedIndex = at - start;
    return out;
  }

  /** Seek within the open session (instant replay): the buffer is replaced by footage from `iso`. */
  seek(iso, scale) {
    this._reset();
    this._setupDecoder();
    this.feed.scale = this._maxSpeed();
    this._send({ type: 'seek', t: iso, scale: this.feed.scale });
  }

  /** Playing speed (own clock). The feed follows on its own (_steerFeed). */
  setSpeed(scale) {
    this.speed = scale;
    if (!this.external) this.clock.setSpeed(scale);
  }

  destroy() {
    this._closed = true;
    window.removeEventListener('pagehide', this._onPageHide);
    this.disconnectSocket();
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch { /* already closed */ } }
    this._reset();
  }
}
