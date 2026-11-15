// web/js/eventspans.js: Playback's Skip empty spans and previous/next event reference, without a browser.
//    node tools/test_eventspans.mjs
import { ACTIVE_KINDS, buildSpans, eventJumpRef, minSkipGap, nextSpan, skipDecision, spanAt } from '../web/js/eventspans.js';

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  [${extra}]` : ''}`);
};
const T = Date.parse('2026-11-15T10:00:00Z') / 1000;
const iso = (s) => new Date((T + s) * 1000).toISOString();
const ev = (kind, s, e = s) => ({ kind, start_utc: iso(s), end_utc: iso(e) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rel = (spans) => spans.map(([s, e]) => [s - T, e - T]);

// Padding and kinds
check('one event: padded 3 s before, 5 s after', same(rel(buildSpans([ev('motion', 100, 110)])), [[97, 115]]));
check('zero-length bookmark still makes a span', same(rel(buildSpans([ev('bookmark', 50)])), [[47, 55]]));
check('video loss and unknown kinds are not "activity"', buildSpans([ev('videoloss', 10, 20), ev('other', 30)]).length === 0);
check('every active kind counts', ACTIVE_KINDS.every((k) => buildSpans([ev(k, 0)]).length === 1));
check('rows in any order come out sorted', same(rel(buildSpans([ev('line', 500), ev('motion', 100)])), [[97, 105], [497, 505]]));
check('{start, end} epoch rows work too', same(rel(buildSpans([{ kind: 'tamper', start: T + 10, end: T + 12 }])), [[7, 17]]));
check('end before start is clamped to the start', same(rel(buildSpans([ev('motion', 100, 90)])), [[97, 105]]));
check('malformed rows are skipped', buildSpans([{ kind: 'motion', start_utc: 'nope' }, null].filter(Boolean)).length === 0);

// Merging: spans closer than 10 s join; 10 s or more apart stay separate
check('padded spans 9 s apart merge', same(rel(buildSpans([ev('motion', 100, 110), ev('line', 127, 130)])), [[97, 135]]));
check('padded spans exactly 10 s apart stay separate', rel(buildSpans([ev('motion', 100, 110), ev('line', 128, 130)])).length === 2);
check('overlapping events merge and keep the later end', same(rel(buildSpans([ev('motion', 0, 100), ev('motion', 10, 20)])), [[-3, 105]]));
check('a chain of close events becomes one span', buildSpans([0, 12, 24, 36].map((s) => ev('motion', s, s + 2))).length === 1);

// Lookup
const spans = buildSpans([ev('motion', 100, 110), ev('motion', 1000, 1010), ev('bookmark', 5000)]);
check('spanAt inside', spanAt(spans, T + 105) === 0 && spanAt(spans, T + 1012) === 1);
check('spanAt on the padded edges', spanAt(spans, T + 97) === 0 && spanAt(spans, T + 115) === 0);
check('spanAt in a gap', spanAt(spans, T + 500) === -1 && spanAt(spans, T - 50) === -1);
check('nextSpan', nextSpan(spans, T + 200)[0] === T + 997 && nextSpan(spans, T + 6000) === null);

// Skip decisions
check('inside a span: nothing', skipDecision(spans, T + 105).action === 'none');
const d = skipDecision(spans, T + 116);
check('leaving a span with a long gap ahead: skip to the next padded start', d.action === 'skip' && d.to === T + 997 && Math.round(d.gap) === 881, JSON.stringify(d));
check('a short gap is played through', skipDecision(buildSpans([ev('motion', 0, 10), ev('motion', 40, 50)]), T + 16).action === 'none');
check('min gap scales with speed', minSkipGap(1) === 30 && minSkipGap(16) === 480 && minSkipGap(0.5) === 30);
check('at 16x a 7-minute gap is played through', skipDecision(buildSpans([ev('motion', 0), ev('motion', 425)]), T + 6, { speed: 16 }).action === 'none');
check('at 16x a 10-minute gap is skipped', skipDecision(buildSpans([ev('motion', 0), ev('motion', 605)]), T + 6, { speed: 16 }).action === 'skip');
check('before the first span: skip forward to it', skipDecision(spans, T - 300).to === T + 97);
check('after the last span, events known to the present: end (play on)', skipDecision(spans, T + 6000).action === 'end');
check('after the last loaded span but the fetch was cut short: none (load more first)', skipDecision(spans, T + 6000, { complete: false }).action === 'none');
check('no events at all: empty (never skip to the end)', skipDecision([], T).action === 'empty');
check('no events loaded and the fetch was cut short: none', skipDecision([], T, { complete: false }).action === 'none');

// Previous/next event reference
check('far from the last jump: the playhead', eventJumpRef(1, T + 500, T + 100) === T + 500 && eventJumpRef(-1, T, null) === T);
check('next right after a jump (pre-roll put the playhead before the event): from the event', eventJumpRef(1, T + 40, T + 100) === T + 100);
check('next once played past the event: from the playhead', eventJumpRef(1, T + 150, T + 100) === T + 150);
check('previous right after a jump: from the event, so it goes further back', eventJumpRef(-1, T + 97, T + 100) === T + 100 && eventJumpRef(-1, T + 105, T + 100) === T + 100);
check('previous after a long pre-roll still finds events between it and the jumped-to event', eventJumpRef(-1, T + 40, T + 100) === T + 100);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
