// No browser dependencies: verify detection against real variations of installed Apple app signals.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/pwa.js', import.meta.url), 'utf8');
function detect({ standalone, userAgent, maxTouchPoints = 5, displayMode = false }) {
  let enabled;
  const document = {
    documentElement: { classList: { toggle(_name, value) { enabled = value; } }, dataset: {} },
    addEventListener() {},
  };
  const context = {
    document, navigator: { standalone, userAgent, maxTouchPoints }, window: {},
    matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' && displayMode, addEventListener() {} }),
  };
  runInNewContext(source, context);
  return enabled;
}
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15';
const cases = [
  ['installed iPhone, no Safari version or display-mode', { standalone: true, userAgent: iphone }, true],
  ['installed iPad, desktop UA', { standalone: true, userAgent: ipad }, true],
  ['iPhone Safari tab', { standalone: false, userAgent: iphone }, false],
  ['iPad Safari tab', { standalone: false, userAgent: ipad }, false],
  ['Apple touch device with standalone media fallback', { userAgent: ipad, displayMode: true }, true],
  ['desktop Safari installed app', { userAgent: ipad, maxTouchPoints: 0, displayMode: true }, false],
  ['Android installed app', { userAgent: 'Mozilla/5.0 Android Chrome/140', displayMode: true }, false],
  ['desktop Chrome', { userAgent: 'Mozilla/5.0 Chrome/140', maxTouchPoints: 0 }, false],
];
for (const [name, input, expected] of cases) {
  assert.equal(detect(input), expected, name);
  console.log(`PASS ${name}`);
}
