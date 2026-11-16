// web/js/masterclock.js: Playback's master clock and frame-lock scheduling, without a browser.
//    node tools/test_masterclock.mjs
import {
  FEED, GAP_S, MasterClock, aheadWall, decodeAhead, feedPlan, frameAt, gapJump, niceAtLeast, niceAtMost, paneState,
  shouldWait, shownIndex, skew, stepTime, trimDecoded,
} from '../web/js/masterclock.js';

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  [${extra}]` : ''}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const T = 1_800_000_000;
const fps15 = (from, n) => Array.from({ length: n }, (_, i) => from + i / 15);

// ---- the clock
let now = 0;
const c = new MasterClock(() => now);
c.seek(T);
check('a new clock is paused at its seek time', !c.playing && c.time() === T);
now = 5000;
check('paused: time stands still', c.time() === T);
c.play();
now = 7000;
check('playing at 1x: T advances with wall time', near(c.time(), T + 2));
c.setSpeed(4);
now = 8000;
check('a speed change rebases: no jump, then 4x', near(c.time(), T + 2 + 4));
c.setWaiting(true);
now = 9000;
check('waiting (strict sync): T holds', near(c.time(), T + 6) && !c.running);
c.setWaiting(false);
now = 9500;
check('released: carries on from where it held, not from where it would have been', near(c.time(), T + 8));
c.pause();
const held = c.time();
now = 20000;
check('pause freezes T', c.time() === held);
c.seek(T + 100);
check('seek while paused moves T, stays paused', c.time() === T + 100 && !c.playing);
c.setSpeed(0.125);
c.play();
now = 28000;
check('1/8x', near(c.time(), T + 101));
c.setSpeed(1);
c.pause();
c.play();
check('pause/play/setSpeed never move T by themselves', near(c.time(), T + 101));
now = 28000;
c.setWaiting(true); c.setWaiting(true); now = 30000; c.setWaiting(false);
check('setWaiting is idempotent', near(c.time(), T + 101));

// ---- frame selection
const times = fps15(T, 30);
check('frameAt: exact frame time', frameAt(times, T + 3 / 15) === 3);
check('frameAt: between frames -> the earlier', frameAt(times, T + 3.5 / 15) === 3);
check('frameAt: 1 ms early still counts as the frame (label rounding)', frameAt(times, T + 5 / 15 - 0.001) === 5);
check('frameAt: before the first -> -1', frameAt(times, T - 1) === -1);
check('frameAt: after the last -> the last', frameAt(times, T + 100) === 29);
check('frameAt: empty', frameAt([], T) === -1);
check('shownIndex: a first frame a moment after T (calibration scatter) is shown', shownIndex(times, T - 1) === 0);
check('shownIndex: but not one further off than GAP_S', shownIndex(times, T - GAP_S - 0.5) === -1);
check('stepTime: next frame', near(stepTime(times, T + 4 / 15, 1), T + 5 / 15));
check('stepTime: previous frame', near(stepTime(times, T + 4 / 15, -1), T + 3 / 15));
check('stepTime: from between frames steps from the one shown', near(stepTime(times, T + 4.6 / 15, 1), T + 5 / 15));
check('stepTime: none past either end', stepTime(times, T + 29 / 15, 1) === null && stepTime(times, T, -1) === null);
// Two panes, 15 fps with different phases: every T picks each pane's newest frame <= T, so they never differ by
// more than a frame interval.
const a = fps15(T + 0.01, 300), b = fps15(T + 0.05, 300);
let worst = 0;
for (let t = T + 1; t < T + 19; t += 0.013) {
  const ta = a[frameAt(a, t)], tb = b[frameAt(b, t)];
  worst = Math.max(worst, t - ta, t - tb, Math.abs(ta - tb));
}
check('two panes on one T stay within one frame interval of T and of each other', worst <= 1 / 15 + 1e-9, worst.toFixed(4));

// ---- pane state
const P = (o) => ({ off: false, first: T, newest: T + 10, ended: false, cur: T + 5, next: T + 5 + 1 / 15, shownOk: true, ...o });
check('state ok', paneState(P({}), T + 5) === 'ok');
check('state off (error)', paneState(P({ off: true }), T + 5) === 'off');
check('state connecting (nothing yet)', paneState(P({ first: null, newest: null, cur: null, next: null }), T) === 'connecting');
check('state starved: its feed hasn\'t reached T', paneState(P({ newest: T + 4 }), T + 5) === 'starved');
check('state decoding: the frame for T arrived, not decoded yet', paneState(P({ shownOk: false }), T + 5) === 'decoding');
check('state gap: its first frame is well after T', paneState(P({ first: T + 60 }), T) === 'gap');
check('state gap: mid-stream recording hole', paneState(P({ cur: T, next: T + 3600, newest: T + 3700 }), T + 30) === 'gap');
check('state: a feed that ended past T is not starved', paneState(P({ newest: T + 4, ended: true, cur: T + 4, next: null }), T + 4.5) === 'ok');
check('state: an ended feed far behind T is a gap, not a wait', paneState(P({ newest: T + 4, ended: true, cur: T + 4, next: null }), T + 10) === 'gap');
check('aheadWall: media ahead / speed', near(aheadWall(P({}), T + 2, 4), 2) && aheadWall(P({}), T + 2, 1) === 8);
check('aheadWall: ended -> infinite, nothing -> 0', aheadWall(P({ ended: true }), T, 1) === Infinity && aheadWall(P({ newest: null }), T, 1) === 0);

// ---- strict sync
const ok = (ahead = 5) => ({ state: 'ok', ahead });
check('wait while any pane connects, starves or decodes', ['connecting', 'starved', 'decoding'].every((s) => shouldWait([ok(), { state: s, ahead: 0 }], false)));
check('no wait for panes that are off or in a gap', !shouldWait([ok(), { state: 'off', ahead: 0 }, { state: 'gap', ahead: 0 }], false));
check('hysteresis: once waiting, restart only with resumeAhead buffered everywhere',
  shouldWait([ok(), ok(FEED.resumeAhead / 2)], true) && !shouldWait([ok(), ok(FEED.resumeAhead / 2)], false) && !shouldWait([ok(), ok(FEED.resumeAhead)], true));
check('gapJump: every pane in a gap -> the earliest next footage', gapJump([{ state: 'gap', next: T + 50 }, { state: 'gap', next: T + 20 }, { state: 'off' }], T) === T + 20);
check('gapJump: not while any pane has a picture', gapJump([{ state: 'gap', next: T + 50 }, ok()], T) === null);

// ---- feed regulation
check('niceAtLeast / niceAtMost', niceAtLeast(3) === '4' && niceAtLeast(100) === '16' && niceAtMost(3) === '2' && niceAtMost(0.01) === '0.125');
let f = feedPlan(0, { hold: false, scale: '4' }, { speed: 1, maxSpeed: '4' });
check('short of footage: fastest the budget allows', f.scale === '4' && !f.hold, JSON.stringify(f));
f = feedPlan(FEED.steadyAbove + 1, { hold: false, scale: '4' }, { speed: 1, maxSpeed: '4' });
check('comfortably ahead: steady 2x the playing speed', f.scale === '2' && !f.hold, JSON.stringify(f));
f = feedPlan(FEED.holdAbove + 1, { hold: false, scale: '2' }, { speed: 1, maxSpeed: '4' });
check('far enough ahead: hold the feed', f.hold);
f = feedPlan((FEED.holdAbove + FEED.resumeBelow) / 2, { hold: true, scale: '2' }, { speed: 1, maxSpeed: '4' });
check('hysteresis: a held feed stays held until it falls below resumeBelow', f.hold);
f = feedPlan(FEED.resumeBelow - 1, { hold: true, scale: '2' }, { speed: 1, maxSpeed: '4' });
check('...then resumes', !f.hold);
f = feedPlan((FEED.boostBelow + FEED.steadyAbove) / 2, { hold: false, scale: '4' }, { speed: 1, maxSpeed: '4' });
check('between boost and steady: keeps the current speed (no flapping)', f.scale === '4');
f = feedPlan(0, { hold: false, scale: '1' }, { speed: 4, maxSpeed: '4' });
check('4 cameras at 4x: the feed is 4x (never above the budget, never below the playing speed)', f.scale === '4');
f = feedPlan(20, { hold: false, scale: '16' }, { speed: 0.25, maxSpeed: '16' });
check('slow playback: steady feed is still at least 1x', f.scale === '1');
f = feedPlan(5, { hold: false, scale: '16' }, { speed: 1, maxSpeed: '8' });
check('a feed above the budget is brought under it', +f.scale <= 8);
f = feedPlan(0, { hold: false, scale: '2' }, { speed: 1, maxSpeed: '4', bytes: FEED.maxBytes + 1 });
check('too much data held: hold whatever the time', f.hold);
f = feedPlan(0, { hold: false, scale: null }, { speed: 1, maxSpeed: '1' });
check('a viewer (1x only) is never asked to go faster', f.scale === '1');

// ---- decoded-frame bounds
check('decodeAhead: at least 6 (the AI enhancer takes 5 either side)', decodeAhead(0.125) === 6 && decodeAhead(1) === 6);
check('decodeAhead: grows with speed, capped at 48', decodeAhead(4) === 24 && decodeAhead(16) === 48);
const tr = trimDecoded(fps15(T, 40), T + 20 / 15, 5, 6);
check('trimDecoded: keeps 5 behind and 6 ahead of the frame for T', tr.length === 40 - 12 && !tr.includes(15) && !tr.includes(26) && tr.includes(14) && tr.includes(27));
const sk = skew([T + 9.98, T + 9.95, null], T + 10);
check('skew: worst lag behind T and spread across panes', near(sk.max, 0.05, 1e-6) && near(sk.spread, 0.03, 1e-6));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
