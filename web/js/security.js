// Settings → Security: turn sign-in on, and (admins) manage accounts, paired devices, sessions, network
// access and the activity log. Everything here saves immediately — no draft/savebar like the other tabs,
// since each action is a separate server-side change (and most can't be "discarded" anyway).
import { authApi } from './api.js';
import { deviceName, fmtWhen, wireCopy } from './account.js';
import { confirmDialog, esc, icon, toast } from './ui.js';

const ROLE_LABEL = { viewer: 'Viewer', operator: 'Operator', admin: 'Admin' };
const ROLE_HELP = 'Viewer: live cameras only. Operator: also playback, events, bookmarks and exports. Admin: everything, including these settings.';
const ACTION_LABEL = {
  'login.ok': 'Signed in', 'login.fail': 'Failed sign-in', 'login.fail_2fa': 'Wrong 2FA code', 'login.recovery_code': 'Used a recovery code',
  logout: 'Signed out', 'user.create': 'Created account', 'user.update': 'Changed account', 'user.delete': 'Deleted account',
  'user.password': 'Changed password', 'totp.enable': 'Turned on 2FA', 'totp.disable': 'Turned off 2FA', 'totp.recovery_codes': 'New recovery codes',
  'session.revoke': 'Signed out a session', 'session.revoke_all': 'Signed out all sessions', 'device.approve': 'Paired a device',
  'device.delete': 'Removed a device', 'config.update': 'Changed security settings', 'auth.enable': 'Turned sign-in on', 'auth.disable': 'Turned sign-in off',
};

export class SecurityPanel {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.data = null;
    this.load();
  }

  async load() {
    if (!this.ctx.me()?.auth_enabled) { this.paintOff(); return; }
    try {
      const [users, devices, sessions, config, audit] = await Promise.all([authApi.users(), authApi.devices(),
        authApi.allSessions(), authApi.config(), authApi.audit(100)]);
      this.data = { users, devices, sessions, config, audit };
    } catch (e) {
      this.root.innerHTML = `<div class="result bad">${icon('alert')}<div>${esc(e.message)}</div></div>`;
      return;
    }
    this.paint();
  }

  async act(btn, fn, okMsg) {
    if (btn) btn.disabled = true;
    try { await fn(); if (okMsg) toast(okMsg); await this.load(); } catch (e) { toast(e.message, 'bad', 6000); if (btn?.isConnected) btn.disabled = false; }
  }

  // ------------------------------------------------------------------ sign-in off
  paintOff() {
    this.root.innerHTML = `<h1>Security</h1><p class="lead">Sign-in is off: anyone who can reach this address can watch the cameras and change every setting, including the recorder's password.</p>
      <section class="card"><h3>${icon('lock')} Turn on sign-in</h3>
        <p class="sub">Create the first admin account. From then on everyone signs in; you can add more people and pair TVs afterwards. If you ever get locked out, <code>python app/auth.py reset-password &lt;user&gt;</code> on the server fixes it.</p>
        <form class="form" data-f="enable" novalidate>
          <div class="field"><label for="s-u">Username</label><input id="s-u" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="admin"></div>
          <div class="field"></div>
          <div class="field"><label for="s-p">Password</label><input id="s-p" type="password" autocomplete="new-password"><div class="hint">At least 10 characters.</div></div>
          <div class="field"><label for="s-p2">Password again</label><input id="s-p2" type="password" autocomplete="new-password"></div>
          <div class="field wide"><div><button class="btn primary" type="submit">${icon('lock')} Turn on sign-in</button></div></div>
        </form></section>`;
    this.root.querySelector('[data-f=enable]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = this.root.querySelector('#s-u').value.trim(), p = this.root.querySelector('#s-p').value, p2 = this.root.querySelector('#s-p2').value;
      if (p.length < 10) { toast('The password needs at least 10 characters', 'bad'); return; }
      if (p !== p2) { toast("The passwords don't match", 'bad'); return; }
      const ok = await confirmDialog({ title: 'Turn on sign-in?', body: `Every device will need to sign in (or be paired). You'll stay signed in here as ${u}.`, ok: 'Turn on' });
      if (!ok) { this.paintOff(); return; }
      try {
        await authApi.createUser(u, p, 'admin');
        location.reload();   // the whole shell changes: account menu, cookie now set
      } catch (x) { toast(x.message, 'bad', 6000); this.paintOff(); }
    });
  }

  // ------------------------------------------------------------------ sign-in on
  paint() {
    const { users, devices, sessions, config, audit } = this.data;
    const me = this.ctx.me();
    const roleSelect = (id, role, kind = 'person') => `<select data-role-of="${id}" data-kind="${kind}" aria-label="Role">${
      (kind === 'device' ? ['viewer', 'operator'] : ['viewer', 'operator', 'admin']).map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`;

    const userRows = users.map((u) => `<tr class="${u.disabled ? 'off' : ''}">
        <td><b>${esc(u.username)}</b>${u.id === me.user?.id ? ' <span class="badge">you</span>' : ''}</td>
        <td>${roleSelect(u.id, u.role)}</td>
        <td>${u.has_totp ? '<span class="badge ok">2FA</span>' : '<span class="badge">No 2FA</span>'}</td>
        <td class="muted">${fmtWhen(u.last_seen_ts)}</td>
        <td class="act"><div class="row-actions">
          <button class="btn sm" data-u-pw="${u.id}" title="Set a new password">${icon('key')}</button>
          ${u.has_totp ? `<button class="btn sm" data-u-2fa="${u.id}">Reset 2FA</button>` : ''}
          <button class="btn sm" data-u-off="${u.id}" data-off="${u.disabled ? 0 : 1}">${u.disabled ? 'Enable' : 'Disable'}</button>
          <button class="btn sm danger" data-u-del="${u.id}" title="Delete" aria-label="Delete ${esc(u.username)}">${icon('trash')}</button></div></td></tr>`).join('');

    const deviceRows = devices.map((d) => `<tr>
        <td><b>${esc(d.label || d.username)}</b></td><td>${roleSelect(d.id, d.role, 'device')}</td>
        <td class="muted">${fmtWhen(d.last_seen_ts)}</td>
        <td class="act"><div class="row-actions"><button class="btn sm" data-d-name="${d.id}">Rename</button>
          <button class="btn sm danger" data-d-del="${d.id}">${icon('trash')} Remove</button></div></td></tr>`).join('');

    const sessRows = sessions.map((s) => `<div class="sess"><div class="grow"><b>${esc(s.kind === 'device' ? s.label || 'Device' : s.username)} · ${esc(deviceName(s.user_agent))}${s.current ? ' · this device' : ''}</b>
        <small>${esc(s.ip || 'unknown address')} · active ${fmtWhen(s.last_seen_ts)}${s.remember ? ' · remembered' : ''}</small></div>
        ${s.current ? '' : `<button class="btn sm" data-s-del="${s.id}">Sign out</button>`}</div>`).join('');

    const auditRows = audit.map((a) => `<tr><td class="muted" style="white-space:nowrap">${new Date(a.ts * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${esc(a.actor || '—')}</td><td>${esc(ACTION_LABEL[a.action] || a.action)}${a.target && a.target !== a.actor ? ` · ${esc(a.target)}` : ''}</td><td class="muted">${esc(a.ip)}</td></tr>`).join('');

    this.root.innerHTML = `<h1>Security</h1><p class="lead">Who can open Sentinel Eye and what they can do. ${ROLE_HELP}</p>
    <section class="card"><h3>${icon('user')} Accounts</h3><p class="sub">People who sign in with a username and password.</p>
      <div class="tbl-scroll"><table class="tbl sec-tbl"><thead><tr><th>Username</th><th>Role</th><th>2FA</th><th>Last active</th><th></th></tr></thead><tbody>${userRows}</tbody></table></div>
      <form class="form" data-f="add" novalidate style="margin-top:16px">
        <div class="field"><label for="n-u">New account</label><input id="n-u" type="text" placeholder="Username" autocomplete="off" autocapitalize="none" spellcheck="false"></div>
        <div class="field"><label for="n-r">Role</label><select id="n-r"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select></div>
        <div class="field"><label for="n-p">Password</label><input id="n-p" type="password" autocomplete="new-password"><div class="hint">At least 10 characters. They can change it from their account menu.</div></div>
        <div class="field" style="justify-content:flex-end"><div><button class="btn primary" type="submit">${icon('plus')} Add account</button></div></div>
      </form></section>
    <section class="card"><h3>${icon('monitor')} Paired devices</h3><p class="sub">TVs and shared screens that signed in with a pairing code. They stay signed in for a year of use.</p>
      ${devices.length ? `<div class="tbl-scroll"><table class="tbl sec-tbl"><thead><tr><th>Device</th><th>Role</th><th>Last active</th><th></th></tr></thead><tbody>${deviceRows}</tbody></table></div>` : '<p class="muted">None yet.</p>'}
      <p class="sub" style="margin:14px 0 8px">On the TV, open this address and choose <b>Pair this device</b>; then approve its code here.</p>
      <a class="btn" href="/pair">${icon('monitor')} Approve a pairing code</a></section>
    <section class="card"><h3>${icon('activity')} Signed-in sessions</h3><p class="sub">Every browser and device signed in right now.</p>
      <div class="sess-list">${sessRows || '<p class="muted">None.</p>'}</div></section>
    <section class="card"><h3>${icon('shield')} Sign-in rules</h3>
      <div class="form">
        <div class="field wide"><div class="toggle-row"><label class="switch"><input type="checkbox" id="c-2fa" ${config.require_2fa_admin ? 'checked' : ''}><span></span></label>
          <span><b>Require two-factor for admins</b><br><span class="muted">Admins without it are asked to set it up right after signing in.</span></span></div></div>
        <div class="field"><label for="c-hours">Sign-in lasts (hours of inactivity)</label><input id="c-hours" type="number" min="1" max="720" value="${config.session_hours}"></div>
        <div class="field"><label for="c-days">"Keep me signed in" lasts (days)</label><input id="c-days" type="number" min="1" max="365" value="${config.remember_days}"></div>
      </div></section>
    <section class="card"><h3>${icon('plug')} Network access</h3>
      <p class="sub">Let devices on these networks open Sentinel Eye without signing in. Requests that came through a proxy or tunnel (they carry forwarding headers) always need to sign in, even from a listed address.</p>
      <div class="form">
        <div class="field"><label for="c-cidrs">Trusted networks</label><textarea id="c-cidrs" rows="3" placeholder="192.168.1.0/24" spellcheck="false">${esc(config.bypass_cidrs.join('\n'))}</textarea><div class="hint">One per line. Empty = everyone signs in.</div></div>
        <div class="field"><label for="c-role">They get</label><select id="c-role"><option value="viewer" ${config.bypass_role === 'viewer' ? 'selected' : ''}>Viewer (live only)</option><option value="operator" ${config.bypass_role === 'operator' ? 'selected' : ''}>Operator</option></select><div class="hint">Never admin.</div></div>
        <div class="field"><label for="c-proxies">Reverse proxies</label><textarea id="c-proxies" rows="2" placeholder="127.0.0.1/32" spellcheck="false">${esc(config.trusted_proxies.join('\n'))}</textarea><div class="hint">Only if a proxy in front of Sentinel Eye sets X-Forwarded-For. Used for the addresses shown here and HTTPS detection.</div></div>
      </div>
      ${config.warnings.map((w) => `<div class="warnbox">${icon('alert')} ${esc(w)}</div>`).join('')}
      <div style="margin-top:14px"><button class="btn primary" data-a="save-config">Save sign-in rules and network access</button></div></section>
    <section class="card"><h3>${icon('list')} Activity</h3><p class="sub">The last 100 sign-in and security events (kept 90 days).</p>
      <div class="tbl-scroll"><table class="tbl sec-tbl"><thead><tr><th>When</th><th>Who</th><th>What</th><th>From</th></tr></thead><tbody>${auditRows}</tbody></table></div></section>`;
    this.wire();
  }

  wire() {
    const r = this.root, $ = (s) => r.querySelector(s);
    r.querySelectorAll('[data-role-of]').forEach((sel) => sel.addEventListener('change', () => {
      const fn = sel.dataset.kind === 'device' ? authApi.updateDevice : authApi.updateUser;
      this.act(sel, () => fn(sel.dataset.roleOf, { role: sel.value }), 'Role changed');
    }));
    $('[data-f=add]').addEventListener('submit', (e) => {
      e.preventDefault();
      const u = $('#n-u').value.trim(), p = $('#n-p').value;
      if (!u || p.length < 10) { toast('Enter a username and a password of at least 10 characters', 'bad'); return; }
      this.act(e.submitter, () => authApi.createUser(u, p, $('#n-r').value), `Added ${u}`);
    });
    const user = (id) => this.data.users.find((u) => String(u.id) === String(id));
    r.querySelectorAll('[data-u-pw]').forEach((b) => b.addEventListener('click', () => this.setPassword(user(b.dataset.uPw))));
    r.querySelectorAll('[data-u-2fa]').forEach((b) => b.addEventListener('click', async () => {
      const u = user(b.dataset.u2fa);
      if (await confirmDialog({ title: `Reset ${u.username}'s two-factor?`, body: 'They sign in with just their password until they set it up again.', ok: 'Reset', danger: true })) this.act(null, () => authApi.resetUser2fa(u.id), '2FA reset');
      else this.paint();
    }));
    r.querySelectorAll('[data-u-off]').forEach((b) => b.addEventListener('click', () => {
      const off = b.dataset.off === '1';
      this.act(b, () => authApi.updateUser(b.dataset.uOff, { disabled: off }), off ? 'Account disabled and signed out' : 'Account enabled');
    }));
    r.querySelectorAll('[data-u-del]').forEach((b) => b.addEventListener('click', async () => {
      const u = user(b.dataset.uDel);
      if (await confirmDialog({ title: `Delete ${u.username}?`, body: 'They are signed out everywhere. Their bookmarks keep their name.', ok: 'Delete', danger: true })) this.act(null, () => authApi.deleteUser(u.id), 'Account deleted');
      else this.paint();
    }));
    const device = (id) => this.data.devices.find((d) => String(d.id) === String(id));
    r.querySelectorAll('[data-d-name]').forEach((b) => b.addEventListener('click', () => {
      const d = device(b.dataset.dName);
      const name = prompt('Name for this device', d.label || '');
      if (name && name.trim()) this.act(b, () => authApi.updateDevice(d.id, { label: name.trim() }), 'Renamed');
    }));
    r.querySelectorAll('[data-d-del]').forEach((b) => b.addEventListener('click', async () => {
      const d = device(b.dataset.dDel);
      if (await confirmDialog({ title: `Remove ${d.label || 'this device'}?`, body: 'It stops showing the cameras right away and has to be paired again.', ok: 'Remove', danger: true })) this.act(null, () => authApi.deleteDevice(d.id), 'Device removed');
      else this.paint();
    }));
    r.querySelectorAll('[data-s-del]').forEach((b) => b.addEventListener('click', () => this.act(b, () => authApi.revokeAnySession(b.dataset.sDel), 'Signed out')));
    $('[data-a=save-config]').addEventListener('click', (e) => {
      const lines = (id) => $(id).value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
      this.act(e.target, () => authApi.saveConfig({
        require_2fa_admin: $('#c-2fa').checked,
        session_hours: Number($('#c-hours').value), remember_days: Number($('#c-days').value),
        bypass_cidrs: lines('#c-cidrs'), bypass_role: $('#c-role').value, trusted_proxies: lines('#c-proxies'),
      }), 'Saved');
    });
    wireCopy(r);
  }

  setPassword(u) {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-label="New password">
      <h3>${icon('key')} New password for ${esc(u.username)}</h3><p>They're signed out everywhere and use this from now on.</p>
      <form class="form" novalidate><div class="field"><label for="np">New password</label><input id="np" type="password" autocomplete="new-password"><div class="hint">At least 10 characters.</div></div>
      <div class="row"><button class="btn" type="button" data-x>Cancel</button><button class="btn primary" type="submit">Set password</button></div></form></div></div>`;
    const close = () => { root.innerHTML = ''; };
    root.querySelector('[data-x]').addEventListener('click', close);
    root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) close(); });
    root.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = root.querySelector('#np').value;
      if (p.length < 10) { toast('At least 10 characters', 'bad'); return; }
      close();
      this.act(null, () => authApi.setUserPassword(u.id, p), 'Password set');
    });
    root.querySelector('#np').focus();
  }
}
