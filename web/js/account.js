// "Your account" dialog: password, two-factor authentication (with recovery codes), your signed-in devices,
// sign out. Opened from the topbar's account menu — and forced open for an admin who must set up 2FA before
// anything else (Settings → Security → "Require two-factor for admins").
import { authApi } from './api.js';
import { qrSvg } from './qr.js';
import { confirmDialog, esc, icon, toast } from './ui.js';

export const fmtWhen = (ts) => {
  if (!ts) return 'never';
  const s = Date.now() / 1000 - ts;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

/** "Chrome on macOS"-style label from a user agent; good enough to recognise your own devices. */
export function deviceName(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser|Tizen/.test(ua) ? 'Samsung TV browser' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}

export function codesBlock(codes) {
  const text = codes.join('\n');
  return `<div class="codes">${codes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>
    <div class="row-actions" style="margin-top:8px"><button class="btn sm" data-copy="${esc(text)}">Copy</button>
    <a class="btn sm" download="sentinel-eye-recovery-codes.txt" href="data:text/plain;charset=utf-8,${encodeURIComponent(text + '\n')}">${icon('download')} Download</a></div>`;
}

export function wireCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast('Copy failed: select and copy the codes by hand', 'bad'); }
  }));
}

export function openAccount(ctx, { force2fa = false } = {}) {
  const root = document.getElementById('modal-root');
  const me = ctx.me();
  let sessions = null, enrol = null, codes = null;

  const close = () => {
    if (force2fa && !ctx.me().user.has_totp) return;   // can't dismiss until 2FA is set up
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);

  const passwordSection = () => `<section><h4>Password</h4>
      <form class="form" data-f="pw" novalidate>
        <div class="field"><label for="a-cur">Current password</label><input id="a-cur" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="a-new">New password</label><input id="a-new" type="password" autocomplete="new-password" minlength="10"><div class="hint">At least 10 characters. Your other devices get signed out.</div></div>
        <div class="field"><label for="a-new2">New password again</label><input id="a-new2" type="password" autocomplete="new-password"></div>
        <div><button class="btn primary" type="submit">Change password</button></div></form></section>`;

  const totpSection = () => {
    const u = ctx.me().user;
    if (codes) {
      return `<section><h4>${icon('shield')} Save your recovery codes</h4>
        <p class="sub">If you lose your phone, each of these signs you in once. They won't be shown again.</p>
        ${codesBlock(codes)}<div class="row-actions" style="margin-top:12px"><button class="btn primary" data-a="codes-done">I saved them</button></div></section>`;
    }
    if (enrol) {
      return `<section><h4>Set up two-factor authentication</h4>
        <p class="sub">Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.</p>
        <div class="enrol">${qrSvg(enrol.uri, 'QR code for your authenticator app')}
          <div style="flex:1;min-width:180px"><div class="hint">Can't scan? Enter this key:</div><div class="secret">${esc(enrol.secret.replace(/(.{4})/g, '$1 ').trim())}</div>
          <form class="form" data-f="totp" novalidate style="margin-top:12px"><div class="field"><label for="a-code">Code</label><input id="a-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456"></div>
          <div class="row-actions" style="justify-content:flex-start"><button class="btn primary" type="submit">Turn on</button><button class="btn ghost" type="button" data-a="enrol-cancel">Cancel</button></div></form></div></div></section>`;
    }
    if (u.has_totp) {
      return `<section><h4>Two-factor authentication <span class="badge ok">On</span></h4>
        <p class="sub">Signing in asks for a code from your authenticator app.</p>
        <form class="form" data-f="totp-off" novalidate><div class="field"><label for="a-pw2">Password (to change this)</label><input id="a-pw2" type="password" autocomplete="current-password"></div>
        <div class="row-actions" style="justify-content:flex-start"><button class="btn" type="button" data-a="new-codes">New recovery codes</button><button class="btn danger" type="button" data-a="totp-off">Turn off</button></div></form></section>`;
    }
    return `<section><h4>Two-factor authentication <span class="badge ${force2fa ? 'warn' : ''}">Off</span></h4>
      <p class="sub">${force2fa ? 'Admins on this Sentinel Eye must use a code from an authenticator app when signing in. Set it up to continue.'
        : 'Ask for a code from your phone as well as your password when signing in.'}</p>
      <button class="btn ${force2fa ? 'primary' : ''}" data-a="enrol">${icon('shield')} Set up</button></section>`;
  };

  const sessionsSection = () => `<section><h4>Where you're signed in</h4>${sessions === null ? '<p class="muted">Loading…</p>' : `
      <div class="sess-list">${sessions.map((s) => `<div class="sess"><div class="grow"><b>${esc(deviceName(s.user_agent))}${s.current ? ' · this device' : ''}</b>
        <small>${esc(s.ip || 'unknown address')} · active ${fmtWhen(s.last_seen_ts)}${s.remember ? ' · remembered' : ''}</small></div>
        ${s.current ? '' : `<button class="btn sm" data-revoke="${s.id}">Sign out</button>`}</div>`).join('')}</div>
      ${sessions.length > 1 ? '<div class="row-actions" style="margin-top:8px"><button class="btn sm" data-a="revoke-others">Sign out everywhere else</button></div>' : ''}`}</section>`;

  const paint = () => {
    const u = ctx.me().user;
    const onlyTotp = force2fa && !u.has_totp;
    root.innerHTML = `<div class="scrim"><div class="dialog wide" role="dialog" aria-modal="true" aria-label="Your account">
      <h3>${icon('user')} ${esc(u.username)} <span class="badge">${esc(u.role)}</span></h3>
      ${onlyTotp || codes ? totpSection() : passwordSection() + totpSection() + sessionsSection()}
      <div class="row" style="margin-top:18px"><button class="btn ghost" data-a="logout">${icon('logout')} Sign out</button><div class="spacer"></div>
        ${onlyTotp ? '' : '<button class="btn" data-a="close">Close</button>'}</div></div></div>`;
    wire();
  };

  const run = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, 'bad', 6000); } finally { if (btn?.isConnected) btn.disabled = false; }
  };

  const wire = () => {
    const $ = (s) => root.querySelector(s);
    root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) close(); });
    $('[data-a=close]')?.addEventListener('click', close);
    $('[data-a=logout]').addEventListener('click', async () => { try { await authApi.logout(); } finally { location.assign('/login'); } });
    $('[data-f=pw]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const cur = $('#a-cur').value, n1 = $('#a-new').value, n2 = $('#a-new2').value;
      if (n1.length < 10) { toast('The new password needs at least 10 characters', 'bad'); return; }
      if (n1 !== n2) { toast("The new passwords don't match", 'bad'); return; }
      run(e.submitter, async () => { await authApi.changePassword(cur, n1); toast('Password changed; your other devices were signed out'); sessions = await authApi.sessions(); paint(); });
    });
    $('[data-a=enrol]')?.addEventListener('click', (e) => run(e.target, async () => { enrol = await authApi.totpBegin(); paint(); $('#a-code')?.focus(); }));
    $('[data-a=enrol-cancel]')?.addEventListener('click', () => { enrol = null; paint(); });
    $('[data-f=totp]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        const r = await authApi.totpConfirm($('#a-code').value.trim());
        enrol = null; codes = r.recovery_codes;
        await ctx.refreshMe();
        paint();
      });
    });
    $('[data-a=codes-done]')?.addEventListener('click', () => {
      codes = null;
      if (force2fa) { force2fa = false; location.reload(); return; }   // limited session is now full: reload the app
      paint();
    });
    $('[data-a=totp-off]')?.addEventListener('click', (e) => run(e.target, async () => {
      const pw = $('#a-pw2').value;   // read first: the confirm dialog replaces this one
      const ok = await confirmDialogKeep('Turn off two-factor authentication?', 'Signing in will only need your password.');
      try {
        if (ok) { await authApi.totpDisable(pw); await ctx.refreshMe(); toast('Two-factor authentication is off'); }
      } finally { paint(); }
    }));
    $('[data-a=new-codes]')?.addEventListener('click', (e) => run(e.target, async () => {
      codes = (await authApi.totpRecovery($('#a-pw2').value)).recovery_codes; paint();
    }));
    root.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
      await authApi.revokeSession(b.dataset.revoke); sessions = await authApi.sessions(); paint();
    })));
    $('[data-a=revoke-others]')?.addEventListener('click', (e) => run(e.target, async () => {
      const r = await authApi.revokeOtherSessions(); toast(`Signed out ${r.revoked} other session(s)`); sessions = await authApi.sessions(); paint();
    }));
    wireCopy(root);
  };

  // confirmDialog renders into #modal-root too (replacing this dialog) and drops its own key handler when
  // done; re-attach ours, and the caller repaints.
  const confirmDialogKeep = async (title, body) => {
    document.removeEventListener('keydown', onKey, true);   // else Escape there would also close this dialog
    const ok = await confirmDialog({ title, body, ok: 'Turn off', danger: true });
    document.addEventListener('keydown', onKey, true);
    return ok;
  };

  paint();
  if (!(force2fa && !me.user.has_totp)) authApi.sessions().then((s) => { sessions = s; if (root.querySelector('.dialog')) paint(); }).catch(() => {});
}
