// web/js/api.js safeNext(): where the sign-in page goes afterwards — only ever a path on this site.
//    node tools/test_safenext.mjs
import { safeNext } from '../web/js/api.js';

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  [${extra}]` : ''}`);
};
const O = 'http://192.168.1.20:8007';
const is = (name, next, want) => { const got = safeNext(next, O); check(name, got === want, JSON.stringify(got)); };

is('a plain path is kept', '/', '/');
is('path, query and hash are kept (the app routes by hash)', '/?pwa=1#/playback/c1/1763200000', '/?pwa=1#/playback/c1/1763200000');
is('the pairing page with its code', '/pair?code=ABCD-2345', '/pair?code=ABCD-2345');
is('nothing given -> home', null, '/');
is('empty -> home', '', '/');
is('not a string -> home', 42, '/');

// Other sites, however they are spelled
is('absolute URL -> home', 'https://evil.example/x', '/');
is('protocol-relative -> home', '//evil.example', '/');
is('backslash protocol-relative -> home', '/\\evil.example', '/');
is('tab hidden in the slashes (browsers drop it) -> home', '/\t/evil.example', '/');
is('newline hidden in the slashes -> home', '/\n/evil.example', '/');
is('carriage return + backslash -> home', '/\r\\evil.example', '/');
is('tab then backslash -> home', '/\t\\evil.example', '/');
is('javascript: URL -> home', 'javascript:alert(1)', '/');
is('data: URL -> home', 'data:text/html,<script>1</script>', '/');
is('a relative path (no leading slash) -> home', 'evil.example', '/');
is('whitespace before the slash -> home', ' //evil.example', '/');
is('a path that normalises to protocol-relative -> home', '/.//evil.example', '/');
is('the same through dot-dot -> home', '/a/..//evil.example', '/');

// Whatever is returned always resolves to this origin
for (const n of ['/a', '/\t/evil.example', '//evil.example', '/x/../y?z#w', '/%2F%2Fevil.example', '/@evil.example', '/.//evil.example']) {
  const out = safeNext(n, O);
  check(`result for ${JSON.stringify(n)} stays on this site`, out.startsWith('/') && new URL(out, O).origin === O, out);
}
check('a bad origin never throws', safeNext('/x', 'not a url') === '/');

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
