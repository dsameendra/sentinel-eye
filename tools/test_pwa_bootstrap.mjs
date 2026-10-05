// No browser dependencies: verify detection against real variations of installed Apple app signals.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/pwa.js', import.meta.url), 'utf8');
function detect({ standalone, userAgent, maxTouchPoints = 5, displayMode = false }) {
  const classes = {};
  const document = {
    documentElement: { classList: { toggle(name, value) { classes[name] = value; } }, dataset: {} },
    addEventListener() {},
  };
  const context = {
    document, navigator: { standalone, userAgent, maxTouchPoints }, window: {},
    matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' && displayMode, addEventListener() {} }),
  };
  runInNewContext(source, context);
  return classes;
}
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15';
const cases = [
  ['installed iPhone, no Safari version or display-mode', { standalone: true, userAgent: iphone }, [true, true]],
  ['installed iPad, desktop UA', { standalone: true, userAgent: ipad }, [true, true]],
  ['iPhone Safari tab', { standalone: false, userAgent: iphone }, [false, true]],
  ['iPad Safari tab', { standalone: false, userAgent: ipad }, [false, true]],
  ['Apple touch device with standalone media fallback', { userAgent: ipad, displayMode: true }, [true, true]],
  ['desktop Safari standalone mode', { userAgent: ipad, maxTouchPoints: 0, displayMode: true }, [false, false]],
  ['Android standalone mode', { userAgent: 'Mozilla/5.0 Android Chrome/140', displayMode: true }, [false, false]],
  ['desktop Chrome', { userAgent: 'Mozilla/5.0 Chrome/140', maxTouchPoints: 0 }, [false, false]],
];
for (const [name, input, expected] of cases) {
  const actual = detect(input);
  assert.equal(actual['ios-pwa'], expected[0], `${name}: install mode`);
  assert.equal(actual['apple-touch-device'], expected[1], `${name}: touch platform`);
  console.log(`PASS ${name}`);
}
