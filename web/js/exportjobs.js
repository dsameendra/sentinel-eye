// Wording for export jobs (the Exports panel, web/js/exportsTray.js): pure functions with no DOM and no imports,
// so they can be tested under node (tools/test_exportjobs.mjs). A job is one row of GET /api/export.

export const ACTIVE = new Set(['queued', 'running', 'cancelling']);

const pad = (n) => String(n).padStart(2, '0');

/** "14 Nov 21:05:10 – 21:07:40" in the recorder's own clock (the browser's until that offset is known). */
export function rangeText(j, tzOffsetMin = null) {
  const a = Date.parse(j.start_utc), b = Date.parse(j.end_utc);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const off = (tzOffsetMin === null ? -new Date(a).getTimezoneOffset() : tzOffsetMin) * 60000;
  const A = new Date(a + off), B = new Date(b + off);
  const day = (d) => `${d.getUTCDate()} ${d.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' })}`;
  const hms = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const sameDay = A.getUTCFullYear() === B.getUTCFullYear() && A.getUTCMonth() === B.getUTCMonth() && A.getUTCDate() === B.getUTCDate();
  return `${day(A)} ${hms(A)} – ${sameDay ? '' : day(B) + ' '}${hms(B)}`;
}

export function camerasText(j) {
  const c = j.cameras || [];
  if (!c.length) return 'Export';
  return c.length <= 2 ? c.join(', ') : `${c[0]}, ${c[1]} +${c.length - 2}`;
}

export function sizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

/** One line saying where the job is, in plain words. */
export function statusText(j, nowMs = Date.now()) {
  if (j.state === 'queued') return j.position > 1 ? `Waiting — ${j.position - 1} ahead of it` : 'Waiting — next in line';
  if (j.state === 'running') return `${Number.isFinite(j.percent) ? `${j.percent}% · ` : ''}${j.progress || 'Exporting'}`;
  if (j.state === 'cancelling') return 'Cancelling…';
  if (j.state === 'cancelled') return 'Cancelled';
  if (j.state === 'error' || j.state === 'interrupted') return j.error || 'Failed';
  if (j.state === 'done') {
    const left = Date.parse(j.expires_utc) - nowMs;
    const keep = !Number.isFinite(left) ? '' : left <= 0 ? ' · expired' : left < 3600000 ? ` · kept ${Math.max(1, Math.round(left / 60000))} min more` : ` · kept ${Math.round(left / 3600000)} h more`;
    return `${j.package === 'signed' ? 'Signed package' : 'Clip'}${j.size_bytes ? ` · ${sizeText(j.size_bytes)}` : ''}${keep}`;
  }
  return j.state;
}

/** Panel order: what is running, then the queue in the order it will run, then finished jobs newest first. */
export function sortJobs(jobs) {
  const rank = (j) => (j.state === 'running' || j.state === 'cancelling' ? 0 : j.state === 'queued' ? 1 : 2);
  const made = (j) => Date.parse(j.created_utc) || 0;
  return [...jobs].sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 1 ? (a.position || 0) - (b.position || 0) : made(b) - made(a)));
}
