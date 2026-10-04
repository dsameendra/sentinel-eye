// DVR-local date/time math, shared by anything that shows or picks DVR-local times (playback, search).
// The DVR gives us a raw UTC offset (via /api/timeline/tz), not an IANA zone, so date math goes through
// a UTC-shifted Date rather than the browser's own timezone.
import { getJSON } from './api.js';

export const partsFromEpoch = (epochSec, offMin) => {
  const d = new Date((epochSec + offMin * 60) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(), hh: d.getUTCHours(), mi: d.getUTCMinutes(), ss: d.getUTCSeconds() };
};

export const epochFromParts = (y, mo, da, hh, mi, ss, offMin) => Date.UTC(y, mo, da, hh, mi, ss) / 1000 - offMin * 60;

// The offset is remembered (here and in this browser) so a screen can draw at once with it instead of
// waiting on a request first — a request that can be slow exactly when navigating, while the server is busy
// starting or stopping a wall of streams. main.js fetches it at start-up; screens refresh it quietly.
const TZ_KEY = 'sentinel-eye-dvr-tz';
let known = null;
try { const v = localStorage.getItem(TZ_KEY); if (v !== null && v !== '' && Number.isFinite(+v)) known = +v; } catch { /* private mode */ }

/** The DVR's UTC offset in minutes as last known, or null if it has never been fetched in this browser. */
export const knownTzOffset = () => known;

/** Fetches the DVR's current UTC offset in minutes (and remembers it), falling back to the last known one,
 * then `fallbackMin` (default Asia/Kolkata, +5:30). */
export async function fetchTzOffset(fallbackMin = 330) {
  try {
    const r = await getJSON('/api/timeline/tz');
    if (r.ready) {
      known = r.offset_minutes;
      try { localStorage.setItem(TZ_KEY, String(known)); } catch { /* private mode */ }
      return known;
    }
  } catch { /* keep the fallback */ }
  return known ?? fallbackMin;
}
