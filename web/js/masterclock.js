// One master clock for frame-locked playback (docs/SPEC.md section 7.2), and the pure scheduling decisions
// around it: which decoded frame each pane shows for the master time T, whether every pane can show T (or the
// clock must wait for one — strict sync), how far ahead each pane's feed may run before the recorder is asked to
// pause it, and how fast to ask the recorder to send. No DOM, no WebCodecs: tools/test_masterclock.mjs runs it
// under node.
//
// The clock: T(now) = T0 + (now - t0) × speed while playing and not waiting for a pane, frozen otherwise. Every
// pane paints the newest decoded frame whose recorded time is <= T, so panes stay on the same instant however
// their recorder sessions happen to deliver (each starts at its own camera's keyframe before the request, and
// delivery is bursty — measured 0.5×–1.5× swings at 1×, several-second near-stalls after a speed change).

export const NICE_SPEEDS = ['0.125', '0.25', '0.5', '1', '2', '4', '8', '16'];
export const EPS = 0.002;          // label rounding: a frame at T ± 2 ms is "at T"
export const GAP_S = 2.0;          // a pane's next frame further than this past T: it has no picture for T (a recording gap)

// Feed regulation, in seconds of *playing time* ahead of T (media seconds ÷ speed), so it means the same at
// every speed. Bursty delivery needs a few seconds of cushion; encoded video is small (~5 KB a frame here), so
// the cushion is kept encoded and only a handful of frames ahead are decoded (decodeAhead).
export const FEED = {
  boostBelow: 4,     // less than this ahead: ask the recorder for the fastest the budget allows
  steadyAbove: 8,    // more than this: drop back to the steady feed (2× the playing speed)
  holdAbove: 14,     // more than this: pause the recorder's feed (RTSP PAUSE) …
  resumeBelow: 9,    // … until it falls below this
  resumeAhead: 1.0,  // after waiting for a pane, restart the clock once every pane has this much ahead
  maxBytes: 48e6,    // encoded data kept per pane, ahead and behind: past this the feed is held whatever the time
};

export class MasterClock {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.T0 = 0;
    this.t0 = now();
    this.speed = 1;
    this.playing = false;
    this.waiting = false;   // strict sync: a pane can't show T yet, so T stands still
  }

  get running() { return this.playing && !this.waiting; }

  /** Master time T, epoch seconds. */
  time() {
    return this.running ? this.T0 + ((this.now() - this.t0) / 1000) * this.speed : this.T0;
  }

  _rebase() { this.T0 = this.time(); this.t0 = this.now(); }

  /** Jump to T (keeps playing/paused as it was). */
  seek(T) { this.T0 = T; this.t0 = this.now(); }
  play() { this._rebase(); this.playing = true; }
  pause() { this._rebase(); this.playing = false; }
  setSpeed(s) { this._rebase(); this.speed = Math.max(0.01, Number(s) || 1); }
  setWaiting(w) { if (!!w !== this.waiting) { this._rebase(); this.waiting = !!w; } }
}

/** Index of the newest time <= T (+EPS) in ascending `times`, or -1 when every one is later. */
export function frameAt(times, T) {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= T + EPS) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** The time of the frame after (dir 1) or before (dir -1) the one shown at T, or null when `times` has none. */
export function stepTime(times, T, dir) {
  const i = frameAt(times, T);
  if (dir > 0) return i + 1 < times.length ? times[i + 1] : null;
  return i - 1 >= 0 ? times[i - 1] : null;
}

/** Which of ascending `times` a pane shows at T: the newest <= T, or — when its very first frame is a moment
 * after T (calibration scatter: labels are good to about a second) — that first frame rather than nothing. */
export function shownIndex(times, T) {
  const i = frameAt(times, T);
  if (i < 0 && times.length && times[0] <= T + GAP_S) return 0;
  return i;
}

/** A pane's status for master time T:
 *   off      — closed or failed: shown as such, never holds the clock;
 *   connecting — nothing received yet: holds the clock (strict sync);
 *   gap      — its next frame is more than GAP_S after T (a recording gap): nothing to show, doesn't hold the clock;
 *   starved  — its feed hasn't reached T yet: holds the clock;
 *   decoding — the frame for T has arrived but isn't decoded yet: holds the clock;
 *   ok       — showing the frame for T.
 * p: {off, first, newest, ended, cur, next, shownOk} — first/newest = recorded times of the first/newest frame
 * received since the last seek (null before any), ended = the feed finished (the recorder has nothing newer),
 * cur/next = the received frame shown at T (shownIndex) and the one after it, shownOk = cur is decoded. */
export function paneState(p, T) {
  if (p.off) return 'off';
  if (p.first == null) return p.ended ? 'off' : 'connecting';
  if (p.first > T + GAP_S) return 'gap';
  if (p.newest < T - EPS && !p.ended) return 'starved';
  if (p.cur != null && p.cur < T - GAP_S && (p.next == null ? p.ended : p.next > T + GAP_S)) return 'gap';
  return p.shownOk ? 'ok' : 'decoding';
}

const HOLDS = new Set(['connecting', 'starved', 'decoding']);

/** Playing time a pane has buffered ahead of T, seconds (Infinity once its feed has ended). */
export function aheadWall(p, T, speed) {
  if (p.ended) return Infinity;
  if (p.newest == null) return 0;
  return Math.max(0, p.newest - T) / Math.max(0.125, Number(speed) || 1);
}

/** Strict sync: should the clock wait? While already waiting it restarts only once every pane that holds it
 * is showing T with FEED.resumeAhead of playing time buffered, so a pane that just scraped past T doesn't
 * stop it again a frame later. `panes`: [{state, ahead}]. */
export function shouldWait(panes, waiting) {
  if (panes.some((p) => HOLDS.has(p.state))) return true;
  if (!waiting) return false;
  return panes.some((p) => p.state === 'ok' && p.ahead < FEED.resumeAhead);
}

/** When no pane has a picture for T because every one is in a recording gap, the next instant any of them has
 * footage (play straight on to it instead of running the clock through the gap); else null. `panes`: [{state, next}]. */
export function gapJump(panes, T) {
  const live = panes.filter((p) => p.state !== 'off');
  if (!live.length || !live.every((p) => p.state === 'gap')) return null;
  const n = live.map((p) => p.next).filter((v) => v != null && v > T);
  return n.length ? Math.min(...n) : null;
}

/** The slowest NICE speed >= v (capped at the fastest). */
export function niceAtLeast(v) {
  return NICE_SPEEDS.find((s) => +s >= v - 1e-9) || NICE_SPEEDS[NICE_SPEEDS.length - 1];
}

/** The fastest NICE speed <= v (at least the slowest). */
export function niceAtMost(v) {
  return [...NICE_SPEEDS].reverse().find((s) => +s <= v + 1e-9) || NICE_SPEEDS[0];
}

/** How the recorder should feed one pane: {hold, scale}. A pane short of footage gets the fastest speed the
 * recorder's budget allows (`maxSpeed`, e.g. 4× with four cameras), a pane comfortably ahead a steady 2× its
 * playing speed (at least 1×), and a pane far enough ahead — or holding too much data — has its feed paused
 * until it falls back: real back-pressure, so nothing is ever dropped. Hysteresis keeps it from flapping.
 * `cur`: the current {hold, scale}. */
export function feedPlan(ahead, cur, { speed, maxSpeed, bytes = 0 }) {
  const boost = niceAtMost(+maxSpeed || 1);
  const steady = niceAtMost(Math.min(+boost, Math.max(1, 2 * (+speed || 1))));
  let scale = cur.scale;
  if (ahead < FEED.boostBelow) scale = boost;
  else if (ahead > FEED.steadyAbove || scale == null) scale = steady;
  if (+scale > +boost) scale = boost;
  if (+scale < +steady) scale = steady;
  const hold = bytes > FEED.maxBytes || (cur.hold ? ahead > FEED.resumeBelow : ahead > FEED.holdAbove);
  return { hold, scale };
}

/** How many decoded frames to keep ready ahead of T: about 0.4 s of playing time, at least 6 (the AI enhancer
 * takes 5 either side of the paused frame), at most 48 (decoded 1080p frames are ~3 MB each). */
export function decodeAhead(speed, fps = 15) {
  return Math.max(6, Math.min(48, Math.ceil((+speed || 1) * fps * 0.4)));
}

/** Which decoded frames to close: everything older than the `keepBehind` frames up to and including the one
 * shown at T, and everything past `keepAhead` frames after it. Returns indexes into ascending `times`. */
export function trimDecoded(times, T, keepBehind, keepAhead) {
  const i = frameAt(times, T);
  const out = [];
  const lo = Math.max(0, i - keepBehind), hi = i + keepAhead;
  for (let k = 0; k < times.length; k++) if (k < lo || k > hi) out.push(k);
  return out;
}

/** Cross-pane skew stats for the debug hook: given each pane's shown time, {max, spread} in seconds. */
export function skew(shown, T) {
  const v = shown.filter((x) => x != null);
  if (!v.length) return { max: null, spread: null };
  return { max: Math.max(...v.map((x) => T - x)), spread: Math.max(...v) - Math.min(...v) };
}
