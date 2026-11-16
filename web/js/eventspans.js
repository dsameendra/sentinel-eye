// Event spans for Playback's "Skip empty" and previous/next event (docs/SPEC.md section 7.7) — pure functions,
// no DOM, so tools/test_eventspans.mjs can check them in node.
//
// "Not empty" = any motion / line-crossing / intrusion / tamper / bookmark on any selected camera, padded a little
// before and after, with spans closer than MERGE_S joined. Everything here is in epoch seconds. It relies on the
// recorder's own motion/alarm log (and bookmarks) — a camera with motion detection off has no spans at all.

export const ACTIVE_KINDS = ['motion', 'line', 'intrusion', 'tamper', 'bookmark'];
export const PAD_BEFORE_S = 3;
export const PAD_AFTER_S = 5;
export const MERGE_S = 10;
export const MIN_GAP_S = 30;   // at 1×: a shorter stretch plays through faster than a reconnect (keyframe pre-roll)

const epoch = (v) => (typeof v === 'number' ? v : Date.parse(v) / 1000);

/** Merged active spans [[start, end], …] sorted by start, from event rows ({start_utc, end_utc, kind} or
 * {start, end, kind}). Rows of other kinds (video loss…) and malformed rows are ignored. */
export function buildSpans(events, { kinds = ACTIVE_KINDS, pre = PAD_BEFORE_S, post = PAD_AFTER_S, merge = MERGE_S } = {}) {
  const want = new Set(kinds);
  const raw = [];
  for (const ev of events || []) {
    if (!want.has(ev.kind)) continue;
    const s = epoch(ev.start ?? ev.start_utc), e = epoch(ev.end ?? ev.end_utc ?? ev.start ?? ev.start_utc);
    if (!Number.isFinite(s)) continue;
    raw.push([s - pre, Math.max(s, Number.isFinite(e) ? e : s) + post]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of raw) {
    const last = out[out.length - 1];
    if (last && s - last[1] < merge) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Index of the span containing `t`, or -1. */
export function spanAt(spans, t) {
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < spans[mid][0]) hi = mid - 1;
    else if (t > spans[mid][1]) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** The first span starting after `t`, or null. */
export function nextSpan(spans, t) {
  for (const sp of spans) if (sp[0] > t) return sp;
  return null;
}

/** Shortest empty stretch worth skipping at `speed`: a seek reconnects the recorder and starts at the keyframe
 * before the target (up to a minute of footage), so a gap only pays off when playing through it would take
 * longer — about MIN_GAP_S of wall time at any speed. */
export function minSkipGap(speed = 1, minGap = MIN_GAP_S) {
  return minGap * Math.max(1, +speed || 1);
}

/** What Skip empty should do with the playhead at `t`, given the spans loaded from the event index.
 *  { action: 'none' }            inside a span, the gap ahead is too short to be worth a seek, or the events
 *                                past the loaded window aren't known yet (fetch more and ask again)
 *  { action: 'skip', to, gap }   jump to `to` (the next span's start, already padded)
 *  { action: 'end' }             spans exist but none lies ahead, up to the present — play on, say so once
 *  { action: 'empty' }           no span at all from here to the present — play on, say so once (never skip to
 *                                the end just because there is no event data)
 * `complete`: the loaded events reach the present (the fetch wasn't cut short by its row limit). */
export function skipDecision(spans, t, { speed = 1, minGap = MIN_GAP_S, complete = true } = {}) {
  if (spanAt(spans, t) >= 0) return { action: 'none' };
  const n = nextSpan(spans, t);
  if (!n) return !complete ? { action: 'none' } : spans.length ? { action: 'end' } : { action: 'empty' };
  const gap = n[0] - t;
  return gap > minSkipGap(speed, minGap) ? { action: 'skip', to: n[0], gap } : { action: 'none' };
}

/** The reference time for previous/next event. A jump lands a few seconds before an event's start, and the
 * recorder then starts at the keyframe before that (up to a minute earlier), so the playhead alone would find the
 * same event again (next) or skip events between the pre-roll and the event (previous). While the playhead is
 * still near the last jump's event, step from that event instead: next from whichever is later, previous from
 * the event itself (the one before it). */
export function eventJumpRef(dir, playhead, lastJumpStart, { near = 120 } = {}) {
  if (lastJumpStart == null || Math.abs(playhead - lastJumpStart) > near) return playhead;
  return dir > 0 ? Math.max(playhead, lastJumpStart) : lastJumpStart;
}
