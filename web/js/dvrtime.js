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

/** A stand-in for screens that must draw before the recorder's offset has ever been known in this browser:
 * this browser's own offset (usually the same place). Never a fixed zone — this used to assume India (+5:30),
 * which put every time hours off anywhere else. Replace it with waitTzOffset() as soon as the real one comes. */
export const provisionalTzOffset = () => known ?? -new Date().getTimezoneOffset();

async function readTz() {
  try {
    const r = await getJSON('/api/timeline/tz');
    if (r.ready) {
      known = r.offset_minutes;
      try { localStorage.setItem(TZ_KEY, String(known)); } catch { /* private mode */ }
      return known;
    }
  } catch { /* not known yet */ }
  return null;
}

/** Fetches the DVR's current UTC offset in minutes (and remembers it), falling back to the last known one,
 * then `fallbackMin` — null by default: until the server has read the recorder's clock there is no right
 * answer to give, only a stand-in (provisionalTzOffset) for the caller to replace. */
export async function fetchTzOffset(fallbackMin = null) {
  return (await readTz()) ?? known ?? fallbackMin;
}

/** Resolves with the recorder's offset once the server knows it (it reads the recorder's clock at start-up),
 * asking every few seconds; resolves null if `alive()` turns false first (the screen was left). */
export async function waitTzOffset(alive = () => true, everyMs = 5000) {
  while (alive()) {
    const m = await readTz();
    if (m !== null) return m;
    await new Promise((res) => setTimeout(res, everyMs));
  }
  return null;
}
