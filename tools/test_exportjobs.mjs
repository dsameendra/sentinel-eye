// web/js/exportjobs.js: the Exports panel's wording for export jobs, without a browser.
//    node tools/test_exportjobs.mjs
import { ACTIVE, camerasText, rangeText, sizeText, sortJobs, statusText } from '../web/js/exportjobs.js';

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  [${extra}]` : ''}`);
};
const NOW = Date.parse('2026-11-15T10:00:00Z');
const job = (o) => ({ id: 'a1', state: 'queued', cameras: ['Gate'], start_utc: '2026-11-14T15:35:10+00:00', end_utc: '2026-11-14T15:37:40+00:00', package: 'signed', ...o });

check('queued, running and cancelling are the active states', ['queued', 'running', 'cancelling'].every((s) => ACTIVE.has(s)) && !ACTIVE.has('done') && !ACTIVE.has('interrupted'));

// Cameras
check('one camera', camerasText(job({})) === 'Gate');
check('two cameras are both named', camerasText(job({ cameras: ['Gate', 'Road'] })) === 'Gate, Road');
check('more than two are counted', camerasText(job({ cameras: ['Gate', 'Road', 'Yard', 'Back'] })) === 'Gate, Road +2');
check('no camera list (an old saved job) still reads', camerasText({}) === 'Export');

// Range, in the recorder's clock
check('range in the recorder offset (+05:30)', rangeText(job({}), 330) === '14 Nov 21:05:10 – 21:07:40', rangeText(job({}), 330));
check('range at UTC', rangeText(job({}), 0) === '14 Nov 15:35:10 – 15:37:40', rangeText(job({}), 0));
check('a range crossing midnight names both days', rangeText(job({ start_utc: '2026-11-14T18:25:00Z', end_utc: '2026-11-14T18:35:00Z' }), 330) === '14 Nov 23:55:00 – 15 Nov 00:05:00');
check('unreadable times give no range rather than "Invalid Date"', rangeText(job({ start_utc: 'x' }), 0) === '');
check('with no known offset it still formats (browser clock)', /\d\d:\d\d:\d\d – \d\d:\d\d:\d\d/.test(rangeText(job({}))));

// Sizes
check('kilobytes', sizeText(2048) === '2 KB');
check('small megabytes keep a decimal', sizeText(5.5 * 1048576) === '5.5 MB');
check('large megabytes are whole', sizeText(250 * 1048576) === '250 MB');
check('gigabytes', sizeText(2.5 * 1073741824) === '2.5 GB');
check('nothing for an unknown size', sizeText(null) === '' && sizeText(0) === '');

// Status line
check('next in line', statusText(job({ position: 1 }), NOW) === 'Waiting — next in line');
check('queue position counts the jobs ahead', statusText(job({ position: 3 }), NOW) === 'Waiting — 2 ahead of it');
check('running shows percent and the step', statusText(job({ state: 'running', percent: 42, progress: '0/2 cameras — exporting Gate' }), NOW) === '42% · 0/2 cameras — exporting Gate');
check('running without a percent yet', statusText(job({ state: 'running', percent: null, progress: '' }), NOW) === 'Exporting');
check('cancelling', statusText(job({ state: 'cancelling' }), NOW) === 'Cancelling…');
check('cancelled', statusText(job({ state: 'cancelled' }), NOW) === 'Cancelled');
check('a failure shows the server message', statusText(job({ state: 'error', error: 'RuntimeError: The recorder stopped sending video' }), NOW).includes('stopped sending video'));
check('interrupted by a restart says so', statusText(job({ state: 'interrupted', error: 'The server restarted before this export finished — export it again' }), NOW).includes('restarted'));
check('done: package, size and time left', statusText(job({ state: 'done', size_bytes: 12 * 1048576, expires_utc: '2026-11-15T11:30:00Z' }), NOW) === 'Signed package · 12 MB · kept 2 h more', statusText(job({ state: 'done', size_bytes: 12 * 1048576, expires_utc: '2026-11-15T11:30:00Z' }), NOW));
check('done: minutes when under an hour', statusText(job({ state: 'done', package: 'plain', size_bytes: 1048576, expires_utc: '2026-11-15T10:20:00Z' }), NOW) === 'Clip · 1.0 MB · kept 20 min more');
check('done but past its keep time', statusText(job({ state: 'done', expires_utc: '2026-11-15T09:00:00Z' }), NOW).endsWith('expired'));

// Panel order
const order = sortJobs([
  job({ id: 'done-old', state: 'done', created_utc: '2026-11-15T08:00:00Z' }), job({ id: 'q2', position: 2, created_utc: '2026-11-15T09:50:00Z' }),
  job({ id: 'err-new', state: 'error', created_utc: '2026-11-15T09:00:00Z' }), job({ id: 'q1', position: 1, created_utc: '2026-11-15T09:40:00Z' }),
  job({ id: 'run', state: 'running', created_utc: '2026-11-15T09:30:00Z' }),
]).map((j) => j.id).join(' ');
check('running first, then the queue in order, then finished newest first', order === 'run q1 q2 err-new done-old', order);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
