// Approve a device (/pair?code=…): an admin, usually on their phone after scanning the QR a TV shows on its
// sign-in page, names the device and picks what it may do.
import { authApi, signInAgain } from './api.js';
import { esc, icon } from './ui.js';

const card = document.getElementById('card');
const brand = `<div class="auth-brand"><div class="brand-mark"></div><span>Sentinel Eye</span></div>`;

function form(code = '') {
  card.innerHTML = `${brand}<h1>Pair a device</h1>
    <p class="auth-lead">Enter the code the TV or screen is showing on its sign-in page.</p>
    <form class="auth-form" novalidate>
      <div class="field"><label for="c">Code</label><input id="c" type="text" class="pair-input" value="${esc(code)}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required></div>
      <div class="field"><label for="n">Name it</label><input id="n" type="text" maxlength="64" placeholder="Living room TV" required></div>
      <div class="field"><span class="lbl">It can</span>
        <div class="opts" role="radiogroup" aria-label="Access">
          <button type="button" class="opt" data-role="viewer" aria-pressed="true"><b>Watch live</b><small>Live cameras only</small></button>
          <button type="button" class="opt" data-role="operator" aria-pressed="false"><b>Watch and review</b><small>Also playback, events and exports</small></button>
        </div></div>
      <div class="auth-err" role="alert" hidden></div>
      <button class="btn primary auth-submit" type="submit">${icon('check')} Approve</button>
    </form>
    <div class="auth-alt"><a class="btn ghost" href="/">Back to Sentinel Eye</a></div>`;
  let role = 'viewer';
  card.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
    role = b.dataset.role;
    card.querySelectorAll('[data-role]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  const err = card.querySelector('.auth-err');
  card.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = card.querySelector('#c').value.trim(), n = card.querySelector('#n').value.trim();
    if (!c || !n) { err.textContent = 'Enter the code and a name for the device.'; err.hidden = false; return; }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await authApi.pairApprove(c, role, n);
      done(n);
    } catch (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; }
  });
  card.querySelector(code ? '#n' : '#c').focus();
}

function done(name) {
  card.innerHTML = `${brand}<div class="cc-icon">${icon('check')}</div><h1>${esc(name)} is paired</h1>
    <p class="auth-lead">It opens Sentinel Eye by itself in a few seconds. You can rename or remove it any time in Settings → Security.</p>
    <div class="auth-alt"><a class="btn primary" href="/">Back to Sentinel Eye</a><button class="btn ghost" data-a="more">Pair another</button></div>`;
  card.querySelector('[data-a=more]').addEventListener('click', () => form());
}

async function boot() {
  const me = await authApi.me().catch(() => null);
  if (me && !me.auth_enabled) {
    card.innerHTML = `${brand}<h1>Sign-in is off</h1><p class="auth-lead">Every device can already open Sentinel Eye. Turn sign-in on in Settings → Security to pair devices.</p>
      <div class="auth-alt"><a class="btn primary" href="/#/settings/security">Open Settings</a></div>`;
    return;
  }
  if (!me || me.via !== 'session') { signInAgain(); return; }
  if (me.role !== 'admin' || me.user?.kind !== 'person') {
    card.innerHTML = `${brand}<h1>Ask an admin</h1><p class="auth-lead">Only an admin can pair a new device.</p>
      <div class="auth-alt"><a class="btn" href="/">Back to Sentinel Eye</a></div>`;
    return;
  }
  form(new URLSearchParams(location.search).get('code') || '');
}

boot();
