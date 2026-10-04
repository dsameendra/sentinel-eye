// "Your account" dialog: password, two-factor authentication (with recovery codes), your signed-in devices,
// sign out. Opened from the topbar's account menu — and forced open for an admin who must set up 2FA before
// anything else (Settings → Security → "Require two-factor for admins").
import { authApi } from './api.js';
import { AVATAR_COLORS, AVATAR_COLOR_NAMES, AVATAR_PRESETS, avatarInner, compressPhoto, defaultColor } from './avatar.js';
import { barHTML, wireBar } from './bar.js';
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

// ------------------------------------------------------------------------------------------- Account page
// "Your account" (Account board): who you are (your picture and username, editable), change password,
// two-factor, and everywhere you're signed in (plus paired screens, for an admin). Two ways in: the avatar
// menu opens it as a screen of its own at #/account (back chevron, no sidebar); Settings shows the same page
// in its pane at #/settings/account, with the Settings sidebar beside it (`embedded`). The dialog above
// stays for the one case that can't wait for the app to load: an admin forced to set up 2FA first.
const deviceIcon = (ua = '') => (/iPhone|Android.*Mobile/.test(ua) ? 'phone' : /SamsungBrowser|Tizen|SMART-TV|Web0S|AFT/.test(ua) ? 'tv' : 'laptop');
const agoShort = (ts) => {
  if (!ts) return 'never';
  const s = Date.now() / 1000 - ts;
  if (s < 120) return 'now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 2 * 86400) return 'yesterday';
  return new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

const AV_TABS = [['initial', 'Initial'], ['preset', 'Designed'], ['photo', 'Photo']];
const sameAvatar = (a, b) => JSON.stringify({ ...a, v: 0 }) === JSON.stringify({ ...b, v: 0 });

export class AccountView {
  /** @param opts { embedded: inside Settings' pane — no bar of its own, Settings' sidebar beside it } */
  constructor(root, ctx, opts = {}) {
    this.root = root;
    this.ctx = ctx;
    this.embedded = !!opts.embedded;
    this.sessions = null; this.devices = null; this.enrol = null; this.codes = null; this.twofaOff = false;
    this.editing = false;   // the profile editor (picture + username) is open
    this.paint();
    this.load();
  }

  get user() { return this.ctx.me()?.user; }

  async load() {
    const me = this.ctx.me();
    if (me?.via !== 'session' || this.user?.kind !== 'person') return;
    try {
      const [sessions, devices] = await Promise.all([authApi.sessions(), this.user.role === 'admin' ? authApi.devices().catch(() => []) : []]);
      this.sessions = sessions; this.devices = devices;
    } catch (e) { this.sessions = []; this.devices = []; toast(e.message, 'bad'); }
    if (this.root.isConnected) this.paint();
  }

  paint() {
    const me = this.ctx.me() || {};
    const signOut = me.via === 'session' ? `<button class="btn glass-btn" data-a="logout">${icon('logout')} Sign out${this.user?.kind === 'device' ? ' this device' : ''}</button>` : '';
    if (this.embedded) {
      this.root.innerHTML = `<header class="pane-head"><h1>Account</h1><p>Your profile, password and sign-in, and where you're signed in.</p></header>
        <div class="acct acct-embed">${this.body(me)}${signOut ? `<section class="card acct-row"><div><b>Sign out</b><small>Of this browser. Your other devices stay signed in.</small></div>${signOut}</section>` : ''}</div>`;
    } else {
      this.root.innerHTML = `${barHTML({ lead: 'back', title: 'Your account', size: 'title', actions: signOut })}<main class="acct"><div class="acct-inner">${this.body(me)}</div></main>`;
      wireBar(this.root, this.ctx, { back: 'history' });
    }
    this.wire();
  }

  // ----------------------------------------------------------------------------------------- profile
  /** Who you are: your picture and name; Edit opens the picture styles and the username in place. */
  profileCard(u, cur) {
    const meta = `${esc(cap(u.role))}${cur ? ` · signed in ${agoShort(cur.created_ts)}` : ''}${u.has_totp ? ' · 2FA on' : ''}`;
    return `<section class="card acct-prof${this.editing ? ' editing' : ''}">
      <div class="acct-id">
        ${this.editing ? `<span class="acct-av big">${this.previewAv(u)}</span>`
          : `<button class="acct-av big" type="button" data-a="edit" title="Change your picture" aria-label="Change your picture">${avatarInner(u)}<span class="acct-av-badge" aria-hidden="true">${icon('pencil')}</span></button>`}
        <div class="grow"><b>${esc(this.editing ? this.nameDraft || u.username : u.username)}</b><small>${meta}</small></div>
        ${this.editing ? '' : '<button class="btn glass-btn" type="button" data-a="edit">Edit</button>'}
      </div>${this.editing ? this.editor(u) : ''}</section>`;
  }

  previewAv(u) {
    if (this.photoData) return `<img class="av-photo" src="${this.photoData}" alt="">`;
    return avatarInner({ ...u, username: this.nameDraft || u.username }, this.avDraft);
  }

  editor(u) {
    return `<div class="prof-ed">
      <div class="prof-sec"><span class="prof-lbl">Picture</span>
        <div class="seg" role="group" aria-label="Picture style">${AV_TABS.map(([k, l]) => `<button type="button" data-avtab="${k}" aria-pressed="${this.avTab === k}">${l}</button>`).join('')}</div>
        <div class="prof-panel">${this.avPanel(u)}</div></div>
      <form class="acct-form prof-form" data-f="profile" novalidate>
        <div class="field"><label for="a-uname">Username</label><input id="a-uname" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" value="${esc(this.nameDraft)}">
          <div class="hint">What you sign in with. Changing it keeps you signed in everywhere.</div></div>
        <div class="field" data-need-pw ${this.nameDraft.trim() === u.username ? 'hidden' : ''}><label for="a-upw">Your password, to change your username</label><input id="a-upw" type="password" autocomplete="current-password"></div>
        <div class="acct-actions"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-a="edit-cancel">Cancel</button></div>
      </form></div>`;
  }

  avPanel(u) {
    const letter = esc(((this.nameDraft || u.username || '?')[0] || '?').toUpperCase());
    const d = this.avDraft || {};
    if (this.avTab === 'initial') {
      return `<div class="av-choices" role="radiogroup" aria-label="Colour">${AVATAR_COLORS.map((c, i) =>
        `<button type="button" class="av-pick" role="radio" aria-checked="${d.kind === 'initial' && d.color === c}" data-color="${c}" title="${AVATAR_COLOR_NAMES[i]}" aria-label="${AVATAR_COLOR_NAMES[i]}">${avatarInner({ username: letter }, { kind: 'initial', color: c })}</button>`).join('')}</div>`;
    }
    if (this.avTab === 'preset') {
      return `<div class="av-choices" role="radiogroup" aria-label="Designed avatars">${Object.keys(AVATAR_PRESETS).map((id) =>
        `<button type="button" class="av-pick" role="radio" aria-checked="${d.kind === 'preset' && d.id === id}" data-preset="${id}" aria-label="Avatar ${id.slice(1)}">${avatarInner(u, { kind: 'preset', id })}</button>`).join('')}</div>`;
    }
    const has = this.photoData || d.kind === 'photo';
    return `<div class="av-upload"><label class="btn glass-btn">${icon('upload')} ${has ? 'Choose another photo' : 'Choose a photo'}<input type="file" accept="image/*" data-photo hidden></label>
      <small class="acct-note">It's cropped to a square and made small before it's saved, so it loads instantly everywhere.</small></div>`;
  }

  openEditor() {
    const u = this.user;
    this.editing = true;
    this.nameDraft = u.username;
    this.avDraft = u.avatar || { kind: 'initial', color: defaultColor(u.username) };
    this.avTab = this.avDraft.kind;
    this.photoData = null;
    this.paint();
    this.root.querySelector('.acct-prof')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Repaint just the picture parts (keeps the typing in the username and password fields). */
  syncEditor() {
    const u = this.user, card = this.root.querySelector('.acct-prof');
    if (!card) return;
    card.querySelector('.acct-av').innerHTML = this.previewAv(u);
    card.querySelector('.acct-id b').textContent = this.nameDraft || u.username;
    card.querySelectorAll('[data-avtab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.avtab === this.avTab)));
    card.querySelector('.prof-panel').innerHTML = this.avPanel(u);
  }

  wireEditor() {
    const card = this.root.querySelector('.acct-prof');
    card?.querySelectorAll('[data-a=edit]').forEach((b) => b.addEventListener('click', () => this.openEditor()));
    if (!this.editing || !card) return;
    const ed = card.querySelector('.prof-ed');
    ed.addEventListener('click', (e) => {
      const t = e.target.closest('[data-avtab], [data-color], [data-preset]');
      if (!t) return;
      if (t.dataset.avtab) this.avTab = t.dataset.avtab;
      else if (t.dataset.color) { this.avDraft = { kind: 'initial', color: t.dataset.color }; this.photoData = null; }
      else { this.avDraft = { kind: 'preset', id: t.dataset.preset }; this.photoData = null; }
      this.syncEditor();
    });
    ed.addEventListener('change', async (e) => {
      if (!e.target.matches('[data-photo]') || !e.target.files[0]) return;
      try {
        this.photoData = await compressPhoto(e.target.files[0]);
        this.avDraft = { kind: 'photo' };
        this.syncEditor();
      } catch (err) { toast(err.message, 'bad'); }
    });
    const name = card.querySelector('#a-uname');
    name.addEventListener('input', () => {
      this.nameDraft = name.value;
      card.querySelector('[data-need-pw]').hidden = name.value.trim() === this.user.username;
      card.querySelector('.acct-id b').textContent = name.value.trim() || this.user.username;
      if (this.avTab === 'initial' || this.avDraft?.kind === 'initial') this.syncEditor();
    });
    card.querySelector('[data-a=edit-cancel]').addEventListener('click', () => { this.editing = false; this.photoData = null; this.paint(); });
    card.querySelector('[data-f=profile]').addEventListener('submit', (e) => {
      e.preventDefault();
      const u = this.user, newName = this.nameDraft.trim(), pw = card.querySelector('#a-upw')?.value || '';
      const renamed = newName !== u.username;
      const reAv = !!this.photoData || !sameAvatar(this.avDraft, u.avatar || { kind: 'initial', color: defaultColor(u.username) }) || (!u.avatar && this.avDraft?.kind === 'initial' && renamed);
      if (renamed && !newName) { toast('Enter a username', 'bad'); return; }
      if (renamed && !pw) { toast('Enter your password to change your username', 'bad'); card.querySelector('#a-upw').focus(); return; }
      this.run(e.submitter, async () => {
        if (renamed) await authApi.rename(newName, pw);   // first: a wrong password shouldn't leave half a change
        if (reAv) await authApi.setAvatar(this.photoData ? { kind: 'photo', photo: this.photoData } : this.avDraft);
        await this.ctx.refreshMe();
        this.editing = false; this.photoData = null;
        toast(renamed || reAv ? 'Profile updated' : 'Nothing to change');
        this.paint();
      });
    });
  }

  body(me) {
    // Not a person signed in: say why there's no account here, and the one thing to do about it.
    if (!me.auth_enabled) {
      return `<div class="acct-grid"><section class="card acct-id"><span class="acct-av">${icon('user')}</span><div><b>Sign-in is off</b><small>Anyone who can reach this address has full access — there are no accounts yet.</small></div></section>
        ${this.ctx.can('admin') ? `<section class="card acct-row"><div><b>Turn on sign-in</b><small>Create the first admin account, then add people and pair TVs.</small></div><a class="btn primary" href="#/settings/security">Set up</a></section>` : ''}</div>`;
    }
    if (me.via === 'bypass') {
      return `<div class="acct-grid"><section class="card acct-id"><span class="acct-av">${icon('user')}</span><div><b>Trusted network</b><small>You opened Sentinel Eye without signing in — this network is trusted, with ${esc(me.role)} access.</small></div></section>
        <section class="card acct-row"><div><b>Sign in</b><small>Use your own account for everything it allows.</small></div><a class="btn primary" href="/login?next=${encodeURIComponent('/#/account')}">Sign in</a></section></div>`;
    }
    const u = this.user;
    if (u?.kind === 'device') {
      return `<div class="acct-grid"><section class="card acct-id"><span class="acct-av">${icon('tv')}</span><div><b>${esc(u.label || 'This device')}</b><small>Paired screen · ${esc(cap(u.role))}</small></div></section></div>`;
    }
    const cur = this.sessions?.find((s) => s.current);
    return `${this.profileCard(u, cur)}<div class="acct-grid">
      <div class="acct-col">
        <section class="card"><h3>Change password</h3>
          <form class="acct-form" data-f="pw" novalidate>
            <div class="field"><label for="a-cur">Current password</label><input id="a-cur" type="password" autocomplete="current-password"></div>
            <div class="field"><label for="a-new">New password</label><div class="input-row"><input id="a-new" type="password" autocomplete="new-password" minlength="10" placeholder="At least 10 characters">
              <button class="btn icon ghost" type="button" data-reveal="a-new" title="Show / hide" aria-label="Show or hide the new password">${icon('eye')}</button></div></div>
            <div><button class="btn glass-btn" type="submit">Update password</button></div>
            <p class="acct-note">Keeps this session, signs your other devices out.</p></form></section>
      </div>
      <div class="acct-col">${this.twofa()}</div>
    </div>
    <section class="card acct-devices"><h3>Signed in on</h3>${this.sessionsList()}</section>`;
  }

  twofa() {
    const u = this.user;
    if (this.codes) {
      return `<section class="card"><h3>Save your recovery codes</h3><p class="acct-note">If you lose your phone, each one signs you in once. They won't be shown again.</p>
        ${codesBlock(this.codes)}<div class="acct-actions"><button class="btn primary" data-a="codes-done">I saved them</button></div></section>`;
    }
    if (this.enrol) {
      return `<section class="card"><h3>Set up two-factor authentication</h3>
        <p class="acct-note">Scan this with an authenticator app (Passwords, Google Authenticator, 1Password…), then enter the 6-digit code it shows.</p>
        <div class="enrol">${qrSvg(this.enrol.uri, 'QR code for your authenticator app')}
          <div class="enrol-side"><div class="hint">Can't scan? Enter this key:</div><div class="secret">${esc(this.enrol.secret.replace(/(.{4})/g, '$1 ').trim())}</div>
          <form data-f="totp" novalidate><div class="field"><label for="a-code">Code</label><input id="a-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456"></div>
          <div class="acct-actions"><button class="btn primary" type="submit">Turn on</button><button class="btn ghost" type="button" data-a="enrol-cancel">Cancel</button></div></form></div></div></section>`;
    }
    if (u.has_totp) {
      return `<section class="card"><div class="acct-row-in"><div><b>Two-factor authentication</b><small><span class="dot armed"></span> On — signing in asks for a code from your authenticator app.</small></div></div>
        ${this.twofaOff ? `<form data-f="totp-pw" novalidate class="acct-inline"><div class="field"><label for="a-pw2">Your password, to change this</label><input id="a-pw2" type="password" autocomplete="current-password"></div>
          <div class="acct-actions"><button class="btn glass-btn" type="button" data-a="new-codes">New recovery codes</button><button class="btn danger" type="button" data-a="totp-off">Turn off</button><button class="btn ghost" type="button" data-a="twofa-cancel">Cancel</button></div></form>`
          : '<div class="acct-actions"><button class="btn glass-btn" data-a="twofa-manage">Manage</button></div>'}</section>`;
    }
    return `<section class="card acct-row"><div><b>Two-factor authentication</b><small>Not set up yet.</small></div><button class="btn primary" data-a="enrol">Set up</button></section>`;
  }

  sessionsList() {
    if (this.sessions === null) return '<p class="acct-note"><span class="spin sm"></span> Loading…</p>';
    const rows = this.sessions.map((s) => `<div class="acct-dev"><span class="acct-dev-ico">${icon(deviceIcon(s.user_agent))}</span>
      <div class="grow"><b>${esc(deviceName(s.user_agent).replace(' on macOS', ' on Mac'))}${s.current ? ' <span class="tag">This device</span>' : ''}</b>
      <small>${s.current ? 'Active now' : `Last active ${agoShort(s.last_seen_ts)}`}${s.ip ? ` · ${esc(s.ip)}` : ''}</small></div>
      ${s.current ? '' : `<button class="btn ghost" data-revoke="${esc(s.id)}">Sign out</button>`}</div>`);
    const devs = (this.devices || []).map((d) => `<div class="acct-dev"><span class="acct-dev-ico">${icon('tv')}</span>
      <div class="grow"><b>${esc(d.label || d.username)} <span class="tag">Device · ${esc(cap(d.role))}</span></b><small>${d.last_seen_ts ? `Last active ${agoShort(d.last_seen_ts)}` : 'Not seen yet'}</small></div>
      <button class="btn ghost" data-d-del="${d.id}">Remove</button></div>`);
    const others = this.sessions.filter((s) => !s.current).length;
    return `<div class="acct-list">${rows.join('')}${devs.join('')}</div>
      ${others > 1 ? '<div class="acct-actions"><button class="btn glass-btn" data-a="revoke-others">Sign out everywhere else</button></div>' : ''}`;
  }

  async run(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, 'bad', 6000); } finally { if (btn?.isConnected) btn.disabled = false; }
  }

  wire() {
    const r = this.root, $ = (s) => r.querySelector(s);
    this.wireEditor();
    $('[data-a=logout]')?.addEventListener('click', async () => { try { await authApi.logout(); } finally { location.assign('/login'); } });
    r.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => {
      const i = r.querySelector('#' + b.dataset.reveal);
      i.type = i.type === 'password' ? 'text' : 'password';
      b.innerHTML = icon(i.type === 'password' ? 'eye' : 'eyeoff');
    }));
    $('[data-f=pw]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const cur = $('#a-cur').value, n1 = $('#a-new').value;
      if (!cur) { toast('Enter your current password', 'bad'); return; }
      if (n1.length < 10) { toast('The new password needs at least 10 characters', 'bad'); return; }
      this.run(e.submitter, async () => {
        await authApi.changePassword(cur, n1);
        toast('Password updated — your other devices were signed out.');
        this.sessions = await authApi.sessions();
        this.paint();
      });
    });
    $('[data-a=enrol]')?.addEventListener('click', (e) => this.run(e.currentTarget, async () => { this.enrol = await authApi.totpBegin(); this.paint(); $('#a-code')?.focus(); }));
    $('[data-a=enrol-cancel]')?.addEventListener('click', () => { this.enrol = null; this.paint(); });
    $('[data-f=totp]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.run(e.submitter, async () => {
        const res = await authApi.totpConfirm($('#a-code').value.trim());
        this.enrol = null; this.codes = res.recovery_codes;
        await this.ctx.refreshMe();
        this.paint();
      });
    });
    $('[data-a=codes-done]')?.addEventListener('click', () => { this.codes = null; this.paint(); });
    $('[data-a=twofa-manage]')?.addEventListener('click', () => { this.twofaOff = true; this.paint(); $('#a-pw2')?.focus(); });
    $('[data-a=twofa-cancel]')?.addEventListener('click', () => { this.twofaOff = false; this.paint(); });
    $('[data-a=new-codes]')?.addEventListener('click', (e) => this.run(e.currentTarget, async () => {
      this.codes = (await authApi.totpRecovery($('#a-pw2').value)).recovery_codes; this.twofaOff = false; this.paint();
    }));
    $('[data-a=totp-off]')?.addEventListener('click', (e) => this.run(e.currentTarget, async () => {
      const pw = $('#a-pw2').value;   // read first: the confirm dialog takes the modal root
      if (!(await confirmDialog({ title: 'Turn off two-factor authentication?', body: 'Signing in will only need your password.', ok: 'Turn off', danger: true }))) return;
      await authApi.totpDisable(pw);
      await this.ctx.refreshMe();
      this.twofaOff = false;
      toast('Two-factor authentication is off.');
      this.paint();
    }));
    r.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => this.run(b, async () => {
      await authApi.revokeSession(b.dataset.revoke); this.sessions = await authApi.sessions(); this.paint();
    })));
    r.querySelectorAll('[data-d-del]').forEach((b) => b.addEventListener('click', async () => {
      const d = this.devices.find((x) => String(x.id) === b.dataset.dDel);
      if (!(await confirmDialog({ title: `Remove ${d?.label || 'this screen'}?`, body: 'It stops showing the cameras right away, and has to be paired again.', ok: 'Remove', danger: true }))) return;
      this.run(b, async () => { await authApi.deleteDevice(d.id); this.devices = await authApi.devices(); toast('Screen removed.'); this.paint(); });
    }));
    $('[data-a=revoke-others]')?.addEventListener('click', (e) => this.run(e.currentTarget, async () => {
      const res = await authApi.revokeOtherSessions(); toast(`Signed out ${res.revoked} other session${res.revoked === 1 ? '' : 's'}.`); this.sessions = await authApi.sessions(); this.paint();
    }));
    wireCopy(r);
  }

  destroy() { this.root.innerHTML = ''; }
}
