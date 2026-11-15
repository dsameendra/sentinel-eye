// How long the recorder keeps footage (GET /api/timeline/retention): per camera, the oldest recording it still
// has. Its disk loops, so the oldest day is overwritten every day; footage N days newer than the oldest recording
// is overwritten in about N days. Only ever from the server's own coverage index — unknown stays unknown.
import { getJSON } from './api.js';

const TTL_MS = 5 * 60 * 1000;
export const ROLL_OFF_WARN_DAYS = 3;
let cache = null;   // { at, channels: {channel: {oldest_utc, oldest_day, days}} }
let pending = null;

/** {channel: {oldest: epoch seconds | null, days}} — fetched at most every 5 minutes, shared by every view. */
export async function loadRetention(force = false) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.channels;
  if (!pending) {
    pending = getJSON('/api/timeline/retention').then((r) => {
      const channels = {};
      for (const [ch, v] of Object.entries(r.channels || {})) {
        channels[ch] = { oldest: v.oldest_utc ? Date.parse(v.oldest_utc) / 1000 : null, days: v.days };
      }
      cache = { at: Date.now(), channels };
      return channels;
    }).finally(() => { pending = null; });
  }
  try { return await pending; } catch { return cache?.channels || {}; }
}

/** For footage on `channel` at epoch `t`: {gone: true} when it's older than the oldest recording the recorder
 * still has, {days} (days until it's overwritten, ≥ 0) when the oldest recording is known, else null. */
export function rollOff(retention, channel, t) {
  const r = retention?.[channel];
  if (!r || r.oldest == null || !Number.isFinite(t)) return null;
  if (t < r.oldest) return { gone: true, days: 0 };
  return { gone: false, days: (t - r.oldest) / 86400 };
}

/** "in less than a day" / "in about 1 day" / "in about 3 days". */
export function rollOffPhrase(days) {
  if (days < 1) return 'in less than a day';
  const n = Math.round(days);
  return `in about ${n} day${n === 1 ? '' : 's'}`;
}
