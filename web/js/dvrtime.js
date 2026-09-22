// DVR-local date/time math, shared by anything that shows or picks DVR-local times (playback, search).
// The DVR gives us a raw UTC offset (via /api/timeline/tz), not an IANA zone, so date math goes through
// a UTC-shifted Date rather than the browser's own timezone.

export const partsFromEpoch = (epochSec, offMin) => {
  const d = new Date((epochSec + offMin * 60) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(), hh: d.getUTCHours(), mi: d.getUTCMinutes(), ss: d.getUTCSeconds() };
};

export const epochFromParts = (y, mo, da, hh, mi, ss, offMin) => Date.UTC(y, mo, da, hh, mi, ss) / 1000 - offMin * 60;

/** Fetches the DVR's current UTC offset in minutes, falling back to `fallbackMin` (default Asia/Kolkata, +5:30). */
export async function fetchTzOffset(fallbackMin = 330) {
  try {
    const r = await fetch('/api/timeline/tz').then((x) => x.json());
    if (r.ready) return r.offset_minutes;
  } catch { /* keep the fallback */ }
  return fallbackMin;
}
