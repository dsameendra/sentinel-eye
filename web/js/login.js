// Sign-in page (/login): password, then a 2FA code when the account has one, or "pair this device" for a TV
// that shows a code for an admin to approve from their phone. Standalone: imports none of the app's views.
import { authApi } from './api.js';
import { qrSvg } from './qr.js';
import { esc, icon } from './ui.js';

const card = document.getElementById('card');
const tvMode = document.documentElement.classList.contains('tv-mode');
const params = new URLSearchParams(location.search);

// Only a path on this site: "/x" yes, "//evil.example" or "/\evil.example" (both protocol-relative) no.
const next = (() => {
  const n = params.get('next') || '/';
  return /^\/(?![/\\])/.test(n) ? n : '/';
})();
const go = () => location.replace(next);

const brand = `<div class="auth-brand"><div class="brand-mark"></div><span>Sentinel Eye</span></div>`;

function showError(msg) {
  const el = card.querySelector('.auth-err');
  el.textContent = msg;
  el.hidden = !msg;
}

async function busy(btn, fn) {
  btn.disabled = true;
  const label = btn.innerHTML;
  btn.innerHTML = '<span class="spin sm"></span>';
  try { await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
}

function passwordStep() {
  card.innerHTML = `${brand}<h1>Sign in</h1>
    <form class="auth-form" novalidate>
      <div class="field"><label for="u">Username</label><input id="u" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
      <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
      <label class="auth-check"><input id="r" type="checkbox" ${tvMode ? 'checked' : ''}> Keep me signed in on this device</label>
      <div class="auth-err" role="alert" hidden></div>
      <button class="btn primary auth-submit" type="submit">Sign in</button>
    </form>
    <div class="auth-alt"><button class="btn ${tvMode ? 'primary' : 'ghost'}" data-a="pair">${icon('monitor')} Pair this device instead</button>
      <p class="hint">For a TV or a shared screen: show a code here and approve it from your phone.</p></div>`;
  const form = card.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const u = card.querySelector('#u').value.trim(), p = card.querySelector('#p').value;
    if (!u || !p) { showError('Enter your username and password.'); return; }
    busy(form.querySelector('button[type=submit]'), async () => {
      try {
        const r = await authApi.login(u, p, card.querySelector('#r').checked);
        if (r.totp_required) codeStep(r.challenge);
        else go();
      } catch (err) {
        showError(err.message);
        card.querySelector('#p').select();
      }
    });
  });
  card.querySelector('[data-a=pair]').addEventListener('click', pairStep);
  card.querySelector('#u').focus();
}

function codeStep(challenge, recovery = false) {
  card.innerHTML = `${brand}<h1>${recovery ? 'Use a recovery code' : 'Two-factor code'}</h1>
    <p class="auth-lead">${recovery ? 'One of the codes you saved when you set up two-factor authentication. Each works once.'
      : 'The 6-digit code from your authenticator app.'}</p>
    <form class="auth-form" novalidate>
      <div class="field"><label for="c">${recovery ? 'Recovery code' : 'Code'}</label>
        <input id="c" type="text" ${recovery ? 'autocomplete="off" placeholder="xxxx-xxxx"' : 'inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456"'} spellcheck="false" required></div>
      <div class="auth-err" role="alert" hidden></div>
      <button class="btn primary auth-submit" type="submit">Verify</button>
    </form>
    <div class="auth-alt"><button class="btn ghost" data-a="swap">${recovery ? 'Use the authenticator app' : 'Lost your phone? Use a recovery code'}</button>
      <button class="btn ghost" data-a="back">Start over</button></div>`;
  const form = card.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = card.querySelector('#c').value.trim();
    if (!code) return;
    busy(form.querySelector('button[type=submit]'), async () => {
      try { await authApi.loginTotp(challenge, code); go(); } catch (err) {
        if (err.status === 401 && /start again/.test(err.message)) { passwordStep(); showError(err.message); return; }
        showError(err.message);
        card.querySelector('#c').select();
      }
    });
  });
  card.querySelector('[data-a=swap]').addEventListener('click', () => codeStep(challenge, !recovery));
  card.querySelector('[data-a=back]').addEventListener('click', passwordStep);
  card.querySelector('#c').focus();
}

let pollTimer = 0, tickTimer = 0;
function stopPairing() { clearTimeout(pollTimer); clearInterval(tickTimer); }

async function pairStep() {
  stopPairing();
  card.innerHTML = `${brand}<div class="auth-pair"><span class="spin"></span></div>`;
  let p;
  try { p = await authApi.pairStart(); } catch (err) {
    card.innerHTML = `${brand}<h1>Pair this device</h1><div class="auth-err" role="alert">${esc(err.message)}</div>
      <div class="auth-alt"><button class="btn" data-a="back">Back to sign in</button></div>`;
    card.querySelector('[data-a=back]').addEventListener('click', passwordStep);
    return;
  }
  const url = `${location.origin}/pair?code=${encodeURIComponent(p.user_code)}`;
  const expires = Date.now() + p.expires_in * 1000;
  card.innerHTML = `${brand}<h1>Pair this device</h1>
    <p class="auth-lead">On your phone, signed in as an admin, scan the code or open <b>${esc(location.host)}/pair</b> and enter:</p>
    <div class="auth-pair">${qrSvg(url, 'QR code to approve this device')}<div class="pair-code" aria-label="Pairing code">${esc(p.user_code)}</div></div>
    <p class="hint auth-countdown" aria-live="off"></p>
    <div class="auth-alt"><button class="btn" data-a="back">Sign in with a password instead</button></div>`;
  card.querySelector('[data-a=back]').addEventListener('click', () => { stopPairing(); passwordStep(); });
  const countdown = card.querySelector('.auth-countdown');
  const tick = () => {
    const s = Math.max(0, Math.round((expires - Date.now()) / 1000));
    countdown.textContent = `Waiting for approval · code valid for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  tickTimer = setInterval(tick, 1000);
  const poll = async () => {
    try {
      const r = await authApi.pairPoll(p.device_code);
      if (r.status === 'approved') { stopPairing(); go(); return; }
      if (r.status === 'expired') { stopPairing(); expired(); return; }
    } catch { /* server briefly unreachable: keep polling */ }
    pollTimer = setTimeout(poll, 3000);
  };
  pollTimer = setTimeout(poll, 3000);
}

function expired() {
  card.innerHTML = `${brand}<h1>That code expired</h1><p class="auth-lead">Codes last 10 minutes.</p>
    <div class="auth-alt"><button class="btn primary" data-a="again">Get a new code</button><button class="btn ghost" data-a="back">Sign in with a password</button></div>`;
  card.querySelector('[data-a=again]').addEventListener('click', pairStep);
  card.querySelector('[data-a=back]').addEventListener('click', passwordStep);
  card.querySelector('[data-a=again]').focus();
}

async function boot() {
  // Already in (e.g. arrived from a link on another site, where SameSite=Strict held the cookie back on that
  // first navigation), or sign-in is off: straight into the app.
  try {
    const me = await authApi.me();
    if (!me.auth_enabled || me.via === 'session') { go(); return; }
  } catch { /* show the form anyway */ }
  if (params.get('pair') === '1' || tvMode) pairStep(); else passwordStep();
}

boot();
