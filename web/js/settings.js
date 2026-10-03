// Settings (Settings board): Recorder connection, Cameras & channels, Display & layout, Channel-zero overview,
// Enhancement, Status (edit a draft copy; nothing is applied until Save), Security & sign-in (security.js,
// saves as it goes) and Account (its own screen, #/account). Non-admins get "This device" and Account.
import { barHTML, wireBar } from './bar.js';
import { api } from './api.js';
import { SecurityPanel } from './security.js';
import { LAYOUTS, layoutIds, layoutIcon } from './layouts.js';
import { PRESETS as ENHANCE_PRESETS } from './enhance.js';
import { confirmDialog, esc, icon, shortcutsDialog, toast } from './ui.js';

const TABS = [
  ['connection', 'Recorder connection', 'plug'],
  ['channels', 'Cameras & channels', 'video'],
  ['display', 'Display & layout', 'grid4'],
  ['overview', 'Channel-zero overview', 'overview'],
  ['enhancement', 'Enhancement', 'sparkle'],
  ['status', 'Status', 'activity'],
  ['security', 'Security & sign-in', 'shield'],
];
// Without admin rights (sign-in on, viewer/operator/device): only what belongs to this browser.
const DEVICE_TABS = [['device', 'This device', 'monitor']];
const ENHANCE_MODES = [['auto', 'Auto'], ['face', 'Face priority'], ['plate', 'Plate & text'], ['general', 'General']];
const HOST_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_CHANNEL_ZERO_PATH = '/Streaming/Channels/1';   // mirrors app/settings.py's DEFAULT_CHANNEL_ZERO_PATH
const clone = (o) => JSON.parse(JSON.stringify(o));
const phone = () => matchMedia('(max-width: 640px)').matches;
const fpsText = (v) => (v === 'auto' || v == null ? '' : String(v));

export class SettingsView {
  /** @param ctx { settings(), saveAll(draft), applyTheme(theme), go(hash) } */
  constructor(root, ctx, tab) {
    this.root = root;
    this.ctx = ctx;
    this.tabs = ctx.can('admin') ? TABS : DEVICE_TABS;
    this.tab = this.tabs.some((t) => t[0] === tab) ? tab : this.tabs[0][0];
    // On a phone, Settings is a tab root: #/settings alone shows the list of sections (iOS-style), and a
    // section opens full width with a back chevron to that list. Wider screens keep the sidebar.
    this.listMode = !tab && phone();
    this.base = clone(ctx.settings());
    this.draft = clone(this.base);
    this.tests = {};          // per-channel probe results
    this.conn = null;          // connection test result
    this.found = null;         // discovered channels
    this.busy = new Set();
    this.build();
  }

  get dirty() { return JSON.stringify(this.draft) !== JSON.stringify(this.base) || !!this.draft.connection.password || !!this.draft.connection.key; }

  /** Account is always listed (Settings board); its page explains itself when sign-in is off. */
  _showAccount() { return true; }

  setTab(tab) {
    const list = !tab && phone();
    if (list !== this.listMode) { this.listMode = list; if (tab) this.tab = tab; this.build(); return; }
    if (this.tabs.some((t) => t[0] === tab) && tab !== this.tab) { this.tab = tab; this.build(); }
  }

  // ------------------------------------------------------------- validation
  errors() {
    if (!this.ctx.can('admin')) return {};   // "This device" has nothing to validate (and no connection data)
    const e = {}, c = this.draft.connection;
    if (!c.host.trim()) e['connection.host'] = 'Enter the IP address of the recorder or camera.';
    else if (!HOST_RE.test(c.host.trim())) e['connection.host'] = 'Use just an address like 192.0.2.10 (no http://, port or path).';
    if (!Number.isInteger(+c.rtsp_port) || c.rtsp_port < 1 || c.rtsp_port > 65535) e['connection.rtsp_port'] = 'A port between 1 and 65535 (usually 554).';
    if (!Number.isInteger(+c.http_port) || c.http_port < 1 || c.http_port > 65535) e['connection.http_port'] = 'A port between 1 and 65535 (usually 80).';
    if (!c.username.trim()) e['connection.username'] = 'Enter the username.';
    if (!c.password && !this.base.connection.has_password) e['connection.password'] = 'Enter the password.';
    if (c.encrypted && !c.key && !this.base.connection.has_key) e['connection.key'] = 'Enter the verification code, or turn encryption off.';
    if (c.key && new TextEncoder().encode(c.key).length > 16) e['connection.key'] = 'At most 16 characters.';
    if (c.channel_zero_path && !c.channel_zero_path.startsWith('/')) e['connection.channel_zero_path'] = 'Must start with /';
    const seen = new Map();
    for (const ch of this.draft.channels) {
      if (!Number.isInteger(+ch.channel) || ch.channel < 1 || ch.channel > 999) e[`ch.${ch.id}.channel`] = '1–999';
      else if (seen.has(ch.channel)) e[`ch.${ch.id}.channel`] = 'Duplicate';
      seen.set(ch.channel, 1);
      if (ch.name.length > 40) e[`ch.${ch.id}.name`] = 'Max 40 characters';
      for (const k of ['sub_fps', 'main_fps']) {
        const v = ch[k];
        if (v !== 'auto' && !(typeof v === 'number' && v >= 0.5 && v <= 120)) e[`ch.${ch.id}.${k}`] = '0.5–120 or empty for auto';
      }
      for (const k of ['sub_path', 'main_path']) if (ch[k] && !ch[k].startsWith('/')) e[`ch.${ch.id}.${k}`] = 'Must start with /';
    }
    return e;
  }

  // ------------------------------------------------------------- rendering
  build() {
    const inSection = phone() && !this.listMode;
    this.root.innerHTML = `${barHTML({ lead: 'back', title: inSection ? (this.tabs.find((t) => t[0] === this.tab)?.[1] || 'Settings') : 'Settings', size: 'title', cls: this.listMode ? 'tabroot' : '' })}<div class="settings${this.listMode ? ' list-mode' : ''}">
      <nav class="side" aria-label="Settings sections">${this.tabs.map(([id, label, ic]) =>
        `<a href="#/settings/${id}" ${id === this.tab ? 'aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span></a>`).join('')}
        ${this._showAccount() ? `<a href="#/account" class="side-account">${icon('user')}<span>Account</span></a>` : ''}</nav>
      <main class="pane"><div class="pane-inner"></div></main></div><div class="savebar" hidden></div>`;
    wireBar(this.root, this.ctx, { back: inSection ? '#/settings' : '#/live' });
    this.pane = this.root.querySelector('.pane-inner');
    this.bar = this.root.querySelector('.savebar');
    this.render();
  }

  render() {
    clearInterval(this.statusTimer);
    const fn = { connection: () => this.connectionTab(), overview: () => this.overviewTab(), channels: () => this.channelsTab(), display: () => this.displayTab(), enhancement: () => this.enhancementTab(), status: () => this.statusTab(), security: () => '', device: () => this.deviceTab() }[this.tab];
    this.pane.innerHTML = fn();
    if (this.tab === 'security') { this.bar.hidden = true; new SecurityPanel(this.pane, this.ctx); return; }   // saves as it goes: no draft
    this.wire();
    this.refresh();
    if (this.tab === 'status') this.startStatus();
  }

  fieldErr(path) { const m = this.errors()[path]; return m ? `<div class="err" data-err="${path}">${esc(m)}</div>` : `<div class="err" data-err="${path}" hidden></div>`; }

  /** A titled row with its control on the right (the board's "Stream Encryption" card). */
  srow(title, sub, control, extra = '') {
    return `<div class="srow"><div class="srow-t"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div><div class="srow-c">${control}</div></div>${extra}`;
  }

  switchHTML(bind, on, label, id = '') {
    return `<label class="switch"><input type="checkbox" ${id ? `id="${id}"` : ''} ${bind ? `data-b="${bind}" data-t="bool"` : ''} ${on ? 'checked' : ''} aria-label="${esc(label)}"><span></span></label>`;
  }

  testStatus(r, busy, idle) {
    if (busy) return '<span class="test-status"><span class="spin sm"></span> Testing…</span>';
    if (!r) return `<span class="test-status">${idle}</span>`;
    const bits = [r.codec, r.width ? `${r.width}×${r.height}` : '', r.fps ? `${r.fps} fps` : '', r.stream_encrypted ? 'encrypted' : ''].filter(Boolean).join(' · ');
    return `<span class="test-status ${r.ok ? 'ok' : 'bad'}" role="status">${icon(r.ok ? 'checkcircle' : 'alert')}<span><b>${esc(r.message || (r.ok ? 'OK' : 'Failed'))}</b>${bits ? ` <span class="muted">${esc(bits)}</span>` : ''}</span></span>`;
  }

  connectionTab() {
    const c = this.draft.connection, b = this.base.connection;
    const first = this.draft.channels.find((x) => x.enabled) || this.draft.channels[0];
    return `<h1 class="sr-only">Recorder connection</h1>
    <div class="form form-conn">
      <div class="field f-host"><label for="f-host">Host</label><input id="f-host" type="text" data-b="connection.host" value="${esc(c.host)}" placeholder="192.0.2.10" autocomplete="off" spellcheck="false">${this.fieldErr('connection.host')}</div>
      <div class="field"><label for="f-port">RTSP port</label><input id="f-port" type="number" min="1" max="65535" data-b="connection.rtsp_port" data-t="int" value="${esc(c.rtsp_port)}">${this.fieldErr('connection.rtsp_port')}</div>
      <div class="field"><label for="f-http">HTTP port</label><input id="f-http" type="number" min="1" max="65535" data-b="connection.http_port" data-t="int" value="${esc(c.http_port)}">${this.fieldErr('connection.http_port')}</div>
      <div class="field f-user"><label for="f-user">Username</label><input id="f-user" type="text" data-b="connection.username" value="${esc(c.username)}" autocomplete="off">${this.fieldErr('connection.username')}</div>
      <div class="field f-pass"><label for="f-pass">Password</label><input id="f-pass" type="password" data-b="connection.password" value="${esc(c.password)}" placeholder="${b.has_password ? '•••••••• saved — type to replace' : ''}" autocomplete="new-password">${this.fieldErr('connection.password')}</div>
    </div>
    <p class="pane-note">The recorder's (or a single IP camera's) address and login. Video is read over RTSP, usually port 554; the HTTP port, usually 80, is only used to read camera names.</p>
    ${this.srow('Stream Encryption', c.encrypted ? 'On for this recorder — video is decrypted on this computer before it is shown.' : 'Off — streams play as-is. Turn on if Stream Encryption is enabled on the recorder (Network → Platform Access).',
      this.switchHTML('connection.encrypted', c.encrypted, 'Stream is encrypted'))}
    <div class="field enc-key" ${c.encrypted ? '' : 'hidden'}><label for="f-key">Stream encryption verification code</label>
      <div class="input-row"><input id="f-key" type="password" data-b="connection.key" value="${esc(c.key)}" ${c.encrypted ? '' : 'disabled'} placeholder="${b.has_key ? '•••••••• saved — type to replace' : 'The code set on the recorder'}" autocomplete="off" spellcheck="false">
        <button class="btn icon ghost" type="button" data-reveal="f-key" ${c.encrypted ? '' : 'disabled'} title="Show / hide" aria-label="Show or hide the code">${icon('eye')}</button></div>
      ${this.fieldErr('connection.key')}<div class="hint">Up to 16 characters, stored only on this computer.</div></div>
    <div class="test-card">
      <button class="btn glass-btn" id="t-run" ${this.busy.has('conn') ? 'disabled' : ''}>Test connection</button>
      ${this.testStatus(this.conn, this.busy.has('conn'), 'Not tested yet this session')}
      <span class="spacer"></span>
      <select id="t-ch" aria-label="Channel to test">${this.draft.channels.map((x) => `<option value="${x.id}" ${first && x.id === first.id ? 'selected' : ''}>${esc(x.name || 'Channel ' + x.channel)}</option>`).join('') || '<option value="">Channel 1</option>'}</select>
      <div class="seg" role="group" aria-label="Stream"><button data-tk="sub" aria-pressed="${this.tk !== 'main'}">SD</button><button data-tk="main" aria-pressed="${this.tk === 'main'}">HD</button></div>
    </div>
    <p class="pane-note">Connects with the values above — even before saving — reads a few seconds of video, and says what it found.</p>`;
  }

  /** Channel-zero gets its own pane (board): the recorder's own multi-camera picture, one light stream. */
  overviewTab() {
    const c = this.draft.connection;
    return `<h1 class="sr-only">Channel-zero overview</h1>
    ${this.srow('Channel-zero overview', "The recorder's own multi-camera picture — what a monitor plugged straight into it shows — as one low-bandwidth stream. On, Live's Overview button switches to it, and TV mode starts there.",
      this.switchHTML('connection.channel_zero', c.channel_zero, 'Channel-zero overview'))}
    <div class="field" ${c.channel_zero ? '' : 'hidden'}><label for="f-c0path">Stream path</label>
      <input id="f-c0path" type="text" data-b="connection.channel_zero_path" value="${esc(c.channel_zero_path)}" ${c.channel_zero ? '' : 'disabled'} placeholder="${DEFAULT_CHANNEL_ZERO_PATH}" autocomplete="off" spellcheck="false">
      ${this.fieldErr('connection.channel_zero_path')}<div class="hint">Leave blank for the usual Hikvision path. Some recorder models use a different one — test it below.</div></div>
    <div class="test-card">
      <button class="btn glass-btn" id="t-c0run" ${!c.channel_zero || this.busy.has('c0') ? 'disabled' : ''}>Test channel-zero</button>
      ${this.testStatus(this.c0Test, this.busy.has('c0'), c.channel_zero ? 'Not tested yet this session' : 'Turn it on to test')}
    </div>`;
  }

  resultHtml(r, label = '') {
    const bits = [r.codec, r.width ? `${r.width}×${r.height}` : '', r.fps ? `${r.fps} fps` : '', r.stream_encrypted ? 'encrypted' : ''].filter(Boolean).join(' · ');
    return `<div class="result ${r.ok ? 'ok' : 'bad'}" role="status">${icon(r.ok ? 'check' : 'alert')}<div><b>${label}${esc(r.message || (r.ok ? 'OK' : 'Failed'))}</b>${bits ? `<div class="muted">${esc(bits)}</div>` : ''}</div></div>`;
  }

  channelsTab() {
    const d = this.draft, order = d.display.order;
    const rows = order.map((id) => d.channels.find((c) => c.id === id)).filter(Boolean);
    const body = rows.map((c, i) => {
      const t = this.tests[c.id];
      const line = (k, name) => t?.[k] ? `${name}: ${t[k].ok || t[k].width ? `${esc(t[k].codec)} ${t[k].width}×${t[k].height} · ${t[k].fps ?? '?'} fps` : esc(t[k].message)}` : '';
      return `<tr class="${c.enabled ? '' : 'off'}" data-row="${c.id}">
        <td style="width:1%;white-space:nowrap"><label class="switch"><input type="checkbox" data-b="ch.${c.id}.enabled" data-t="bool" ${c.enabled ? 'checked' : ''} aria-label="Show ${esc(c.name)}"><span></span></label></td>
        <td class="num"><input type="number" min="1" max="999" data-b="ch.${c.id}.channel" data-t="int" value="${c.channel}" aria-label="DVR channel number">${this.fieldErr(`ch.${c.id}.channel`)}</td>
        <td><input type="text" data-b="ch.${c.id}.name" value="${esc(c.name)}" placeholder="Camera ${c.channel}" aria-label="Name" maxlength="60">${this.fieldErr(`ch.${c.id}.name`)}</td>
        <td class="fps"><input type="text" data-b="ch.${c.id}.sub_fps" data-t="fps" value="${fpsText(c.sub_fps)}" placeholder="auto" aria-label="SD frame rate" inputmode="decimal">${this.fieldErr(`ch.${c.id}.sub_fps`)}</td>
        <td class="fps"><input type="text" data-b="ch.${c.id}.main_fps" data-t="fps" value="${fpsText(c.main_fps)}" placeholder="auto" aria-label="HD frame rate" inputmode="decimal">${this.fieldErr(`ch.${c.id}.main_fps`)}</td>
        <td class="act">
          <button class="btn sm icon ghost" data-up="${c.id}" ${i === 0 ? 'disabled' : ''} title="Move up" aria-label="Move up">${icon('up')}</button>
          <button class="btn sm icon ghost" data-down="${c.id}" ${i === rows.length - 1 ? 'disabled' : ''} title="Move down" aria-label="Move down">${icon('down')}</button>
          <button class="btn sm" data-test="${c.id}" ${this.busy.has('t' + c.id) ? 'disabled' : ''}>${this.busy.has('t' + c.id) ? 'Testing…' : 'Test'}</button>
          <button class="btn sm ghost" data-adv="${c.id}" aria-expanded="${!!this.adv?.has(c.id)}" title="Advanced">More</button>
          <button class="btn sm icon ghost danger" data-del="${c.id}" title="Remove channel" aria-label="Remove channel">${icon('trash')}</button></td></tr>
        ${this.adv?.has(c.id) ? `<tr class="adv"><td></td><td colspan="5"><div class="form" style="grid-template-columns:1fr 1fr">
          <div class="field"><label>SD stream path (optional)</label><input type="text" data-b="ch.${c.id}.sub_path" value="${esc(c.sub_path)}" placeholder="/Streaming/Channels/${c.channel}02" spellcheck="false">${this.fieldErr(`ch.${c.id}.sub_path`)}</div>
          <div class="field"><label>HD stream path (optional)</label><input type="text" data-b="ch.${c.id}.main_path" value="${esc(c.main_path)}" placeholder="/Streaming/Channels/${c.channel}01" spellcheck="false">${this.fieldErr(`ch.${c.id}.main_path`)}</div>
          <div class="field"><label>Picture shape</label><select data-b="ch.${c.id}.aspect">${[['auto', 'Automatic (recommended)'], ['16:9', 'Widescreen 16:9'], ['4:3', 'Standard 4:3'], ['native', 'Exactly as sent']].map(([v, l]) => `<option value="${v}" ${(c.aspect || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select><div class="hint">SD streams are often squeezed; “Automatic” restores the real shape so SD and HD match.</div></div>
          <div class="hint" style="grid-column:1/-1">Only needed for non-Hikvision cameras. Leave empty to use the standard Hikvision paths.</div></div></td></tr>` : ''}
        ${t ? `<tr class="adv"><td></td><td colspan="5"><div class="rowtest">${[line('sub', 'SD'), line('main', 'HD')].filter(Boolean).join(' &nbsp;·&nbsp; ')}
          ${t.sub?.fps || t.main?.fps ? `&nbsp; <button class="btn sm" data-usefps="${c.id}">Use measured fps</button>` : ''}</div></td></tr>` : ''}`;
    }).join('');
    const foundHtml = this.found ? this.foundHtml() : '';
    return `<h1 class="sr-only">Cameras &amp; channels</h1>
    <div class="pane-tools"><p class="pane-note">The cameras on Live. Names and order apply everywhere; frame rate is measured from the stream unless you set one.</p>
      <button class="btn glass-btn" id="detect" ${this.busy.has('detect') ? 'disabled' : ''}>${this.busy.has('detect') ? '<span class="spin sm"></span> Detecting…' : `${icon('search')} Detect channels`}</button>
      <button class="btn primary" id="add-ch">${icon('plus')} Add channel</button></div>
    <section class="card card-flush">
      ${foundHtml}
      ${rows.length ? `<div class="tbl-scroll"><table class="tbl"><thead><tr><th></th><th>Ch</th><th>Name</th><th>SD fps</th><th>HD fps</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`
        : '<p class="muted" style="padding:18px 20px;margin:0">No channels yet — add one, or detect them from the recorder.</p>'}</section>`;
  }

  foundHtml() {
    const have = new Set(this.draft.channels.map((c) => c.channel));
    const missing = this.found.filter((f) => !have.has(f.channel));
    const unnamed = this.draft.channels.filter((c) => this.found.some((f) => f.channel === c.channel && f.name && f.name !== c.name));
    const label = (f) => (f.name ? `${f.channel} (${esc(f.name)})` : f.channel);
    return `<div class="result ${this.found.length ? 'ok' : 'bad'}" style="margin:0 0 14px">${icon(this.found.length ? 'check' : 'alert')}<div>
      ${this.found.length ? `<b>Found ${this.found.length} channel${this.found.length > 1 ? 's' : ''}:</b> ${this.found.map(label).join(', ')}` : '<b>No channels responded.</b> Check the connection settings first.'}
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        ${missing.length ? `<button class="btn sm primary" id="add-found">Add ${missing.length} missing</button>` : ''}
        ${unnamed.length ? `<button class="btn sm" id="use-names">Use the recorder’s names for ${unnamed.length} existing channel${unnamed.length > 1 ? 's' : ''}</button>` : ''}
        ${this.found.length && !missing.length && !unnamed.length ? '<span class="muted">Everything is already in the list.</span>' : ''}</div></div></div>`;
  }

  displayTab() {
    const d = this.draft.display;
    const seg = (key, opts, label) => `<div class="seg" role="group" aria-label="${label}">${opts.map(([v, l]) => `<button data-o="${key}:${v}" aria-pressed="${d[key] === v}">${l}</button>`).join('')}</div>`;
    const opt = (key, val, title, sub) => `<button class="opt" data-o="${key}:${val}" aria-pressed="${d[key] === val}"><b>${title}</b><small>${sub}</small></button>`;
    return `<h1 class="sr-only">Display &amp; layout</h1>
    <section class="sgroup"><h2>Appearance</h2><div class="srows">
      ${this.srow('Theme', 'Auto follows this device’s light or dark setting.', seg('theme', [['auto', 'Auto'], ['dark', 'Dark'], ['light', 'Light']], 'Theme'))}
      ${this.srow('Picture', 'Fit never crops; Fill crops to fill each tile edge to edge. Live and Playback.', seg('fit', [['contain', 'Fit'], ['cover', 'Fill']], 'Fit'))}
      ${this.srow('TV mode', 'Bigger type and arrow-key camera selection for watching from a distance. This browser only.', this.switchHTML('', this.ctx.tvMode(), 'TV mode', 'f-tv'))}
    </div></section>
    <section class="sgroup"><h2>Layout</h2>
      <div class="laygrid">${layoutIds.map((id) => `<button data-o="layout:${id}" aria-pressed="${d.layout === id}">${layoutIcon(id, 44)}<span>${LAYOUTS[id].label}</span></button>`).join('')}</div>
      <p class="pane-note">The starting layout — change it any time from Live.</p>
      <div class="srows">${this.srow('Auto-rotate pages', 'Only when there are more cameras than fit on one page.',
        `<select id="f-rot" data-b="display.rotate_seconds" data-t="int">${[[0, 'Off'], [5, 'Every 5 s'], [10, 'Every 10 s'], [15, 'Every 15 s'], [30, 'Every 30 s'], [60, 'Every minute']].map(([v, l]) => `<option value="${v}" ${+d.rotate_seconds === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}</div></section>
    <section class="sgroup"><h2>Streaming</h2>
      <div class="opts">${opt('quality', 'auto', 'Auto', 'HD for large tiles and Focus, SD for small tiles')}${opt('quality', 'sub', 'Always SD', 'Lowest bandwidth — best for big walls')}${opt('quality', 'main', 'Always HD', 'Sharpest, heavier on network and CPU')}</div>
      <p class="pane-note">HD streams are usually H.265. Converting to H.264 here plays smoothly everywhere; playing H.265 directly saves CPU but can stutter on some cameras, and doesn't work in Firefox.</p>
      <div class="opts">${opt('main_codec', 'h264', 'Convert to H.264', 'Recommended — smooth everywhere, some CPU while HD is open')}${opt('main_codec', 'passthrough', 'Play directly', 'No extra CPU — may stutter or fail in some browsers')}</div></section>
    <section class="sgroup"><h2>Interaction</h2><div class="form">
      ${this.rangeField('display.controls_autohide_sec', d.controls_autohide_sec, { id: 'f-autohide', label: 'Hide controls after', min: 1, max: 10, step: 0.5, unit: 's', hint: 'How long Focus and Playback controls stay up after the pointer stops, while playing. They stay up while paused.' })}
      ${this.rangeField('display.snapshot_quality', d.snapshot_quality, { id: 'f-snapq', label: 'Snapshot quality', min: 0.5, max: 1, step: 0.01, hint: 'JPEG quality for snapshots. Higher is sharper, and a larger file.' })}
    </div></section>
    <section class="sgroup"><div class="srows">${this.srow('Keyboard shortcuts', 'Every shortcut, on every screen. Press ? anywhere.', '<button class="btn glass-btn" data-a="keys">Show</button>')}</div></section>`;
  }

  /** A labelled range slider bound to `data-b` path `bindPath`, with a live numeric readout — the one
   * reusable piece for every slider added across the settings tabs, since none existed before this. */
  rangeField(bindPath, value, { id, label, min, max, step, unit = '', hint }) {
    return `<div class="field"><label for="${id}">${label}</label>
      <div class="range-row"><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" data-b="${bindPath}" data-t="float" value="${value}">
        <span class="range-val" data-unit="${unit}">${Number(value).toFixed(step < 1 ? 2 : 0)}${unit}</span></div>
      ${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  }

  /** What a non-admin can change: this browser's own options. */
  deviceTab() {
    return `<h1 class="sr-only">This device</h1><p class="pane-note">Options for this browser only. Cameras, layout and everything else are set by an admin.</p>
    <section class="sgroup"><div class="srows">
      ${this.srow('TV mode', 'Bigger type and arrow-key camera selection for watching from a distance. SD by default.', this.switchHTML('', this.ctx.tvMode(), 'TV mode', 'f-tv'))}
      ${this.srow('Keyboard shortcuts', 'Every shortcut, on every screen. Press ? anywhere.', '<button class="btn glass-btn" data-a="keys">Show</button>')}
    </div></section>`;
  }

  enhancementTab() {
    const d = this.draft.display;
    return `<h1 class="sr-only">Enhancement</h1><p class="pane-note">Where the live filters and the frame enhancer start. Everything stays adjustable each time you use them.</p>
    <section class="sgroup"><h2>Live filters</h2><div class="srows">
      ${this.srow('Starting preset', 'For a newly opened tile or Playback pane. Off (recommended) starts every picture untouched.',
        `<select id="f-enh-preset" data-b="display.enhance_default_preset">${Object.entries(ENHANCE_PRESETS).filter(([k]) => k !== 'custom').map(([k, p]) => `<option value="${k}" ${d.enhance_default_preset === k ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`)}
    </div></section>
    <section class="sgroup"><h2>Frame enhancer</h2><div class="srows">
      ${this.srow('Starting mode', 'What the enhancer looks for first.', `<div class="seg" role="group" aria-label="Default mode">${ENHANCE_MODES.map(([k, l]) => `<button data-o="enhance_default_mode:${k}" aria-pressed="${d.enhance_default_mode === k}">${l}</button>`).join('')}</div>`)}
    </div><div class="form" style="margin-top:14px">
      ${this.rangeField('display.enhance_default_fidelity', d.enhance_default_fidelity, { id: 'f-fidelity', label: 'Starting fidelity', min: 0, max: 1, step: 0.05, hint: 'Lower rebuilds more of a face — and risks inventing features. Higher stays closer to the real pixels — and may stay blurry. 0.5 is recommended.' })}
    </div></section>`;
  }

  statusTab() {
    return `<h1 class="sr-only">Status</h1><p class="pane-note">What the video engine is doing right now. Updates every few seconds.</p><section class="card" id="status-card"><p class="muted">Loading…</p></section>`;
  }

  async startStatus() {
    const paint = async () => {
      const card = this.pane.querySelector('#status-card');
      if (!card) return;
      try {
        const st = await api.status();
        const names = Object.fromEntries(this.base.channels.map((c) => [c.id, c.name || `Camera ${c.channel}`]));
        const rows = Object.entries(st.streams).sort().map(([n, v]) => {
          const [id, kind] = [n.split('_')[0], n.slice(n.indexOf('_') + 1)];
          const label = { sub: 'SD', main: 'HD', main_h264: 'HD (H.264)' }[kind] || kind;
          const state = v.consumers ? 'Streaming' : v.producers ? 'Connected' : 'Idle (starts when watched)';
          return `<tr><td>${esc(names[id] || id)}</td><td>${label}</td><td><span class="dot ${v.consumers ? 'live' : v.producers ? 'wait' : ''}" style="display:inline-block"></span> ${state}</td><td>${v.consumers}</td></tr>`;
        }).join('');
        card.innerHTML = `<div class="toggle-row" style="margin-bottom:12px"><span class="dot ${st.go2rtc ? 'armed' : 'off'}"></span><b>Video engine ${st.go2rtc ? 'running' : 'not responding'}</b></div>
          <div class="tbl-scroll"><table class="tbl"><thead><tr><th>Camera</th><th>Stream</th><th>State</th><th>Viewers</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No streams configured.</td></tr>'}</tbody></table></div>`;
      } catch (e) { card.innerHTML = `<div class="result bad">${icon('alert')}<div>Cannot reach the server: ${esc(e.message)}</div></div>`; }
    };
    await paint();
    this.statusTimer = setInterval(paint, 3000);
  }

  // ------------------------------------------------------------- behaviour
  setPath(path, val) {
    const [scope, a, b] = path.split('.');
    if (scope === 'ch') this.draft.channels.find((c) => c.id === a)[b] = val;
    else this.draft[scope][a] = val;
  }

  convert(el) {
    const t = el.dataset.t;
    if (t === 'bool') return el.checked;
    if (t === 'int') return el.value === '' ? NaN : Number(el.value);
    if (t === 'fps') { const v = el.value.trim().toLowerCase(); return v === '' || v === 'auto' ? 'auto' : Number(v); }
    if (t === 'float') return el.value === '' ? NaN : Number(el.value);
    return el.value;
  }

  wire() {
    const p = this.pane;
    p.querySelectorAll('[data-b]').forEach((el) => {
      const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => {
        const path = el.dataset.b;
        this.setPath(path, this.convert(el));
        if (path === 'connection.encrypted' || path === 'connection.channel_zero' || /^ch\.[^.]+\.enabled$/.test(path)) { this.render(); }
        if (path === 'connection.host' || path.startsWith('connection.')) this.conn = null;
        if (path.startsWith('connection.channel_zero')) this.c0Test = null;
        if (path === 'display.theme') this.ctx.applyTheme(this.draft.display.theme);
        if (el.type === 'range') { const out = el.parentElement.querySelector('.range-val'); if (out) out.textContent = Number(el.value).toFixed(+el.step < 1 ? 2 : 0) + (out.dataset.unit || ''); }
        this.refresh();
      });
    });
    p.querySelectorAll('[data-o]').forEach((b) => b.addEventListener('click', () => {
      const [k, v] = b.dataset.o.split(':');
      this.draft.display[k] = v;
      if (k === 'theme') this.ctx.applyTheme(v);
      this.render(); this.refresh();
    }));
    p.querySelector('#f-tv')?.addEventListener('change', (e) => this._onTvModeToggle(e.target.checked));
    p.querySelector('[data-a=keys]')?.addEventListener('click', () => shortcutsDialog());
    p.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => {
      const i = p.querySelector('#' + b.dataset.reveal);
      i.type = i.type === 'password' ? 'text' : 'password';
      b.innerHTML = icon(i.type === 'password' ? 'eye' : 'eyeoff');
    }));
    p.querySelectorAll('[data-tk]').forEach((b) => b.addEventListener('click', () => { this.tk = b.dataset.tk; this.conn = null; this.render(); }));
    p.querySelector('#t-run')?.addEventListener('click', () => this.runConnTest());
    p.querySelector('#t-c0run')?.addEventListener('click', () => this.runChan0Test());
    p.querySelector('#add-ch')?.addEventListener('click', () => this.addChannel());
    p.querySelector('#detect')?.addEventListener('click', () => this.detect());
    p.querySelector('#add-found')?.addEventListener('click', () => this.addFound());
    p.querySelector('#use-names')?.addEventListener('click', () => this.useNames());
    p.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => this.move(b.dataset.up, -1)));
    p.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => this.move(b.dataset.down, 1)));
    p.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => this.remove(b.dataset.del)));
    p.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => this.runRowTest(b.dataset.test)));
    p.querySelectorAll('[data-adv]').forEach((b) => b.addEventListener('click', () => { (this.adv ||= new Set()); this.adv.has(b.dataset.adv) ? this.adv.delete(b.dataset.adv) : this.adv.add(b.dataset.adv); this.render(); }));
    p.querySelectorAll('[data-usefps]').forEach((b) => b.addEventListener('click', () => {
      const c = this.draft.channels.find((x) => x.id === b.dataset.usefps), t = this.tests[c.id];
      if (t.sub?.fps) c.sub_fps = t.sub.fps;
      if (t.main?.fps) c.main_fps = t.main.fps;
      this.render(); this.refresh();
    }));
  }

  /** Update validation messages, invalid styling and the save bar without re-rendering inputs. */
  refresh() {
    const errs = this.errors();
    this.pane.querySelectorAll('[data-err]').forEach((el) => { const m = errs[el.dataset.err]; el.hidden = !m; el.textContent = m || ''; });
    this.pane.querySelectorAll('[data-b]').forEach((el) => el.classList.toggle('invalid', !!errs[el.dataset.b]));
    const n = Object.keys(errs).length, dirty = this.dirty;
    this.bar.hidden = !dirty;
    this.bar.innerHTML = `<div><span>${n ? `<b style="color:var(--danger)">${n} problem${n > 1 ? 's' : ''} to fix</b> before saving` : 'You have unsaved changes'}</span>
      <button class="btn" id="discard">Discard</button><button class="btn primary" id="save" ${n || this.saving ? 'disabled' : ''}>${this.saving ? 'Saving…' : 'Save changes'}</button></div>`;
    this.bar.querySelector('#discard').addEventListener('click', () => this.discard());
    this.bar.querySelector('#save').addEventListener('click', () => this.save());
  }

  discard() {
    this.draft = clone(this.base);
    this.conn = null; this.tests = {}; this.found = null;
    this.ctx.applyTheme(this.base.display.theme);
    this.render();
  }

  async save() {
    if (Object.keys(this.errors()).length) return;
    this.saving = true; this.refresh();
    try {
      const saved = await this.ctx.saveAll(this.draft);
      this.base = clone(saved); this.draft = clone(saved);
      this.tests = {}; this.conn = null;
      toast('Settings saved. Streams are restarting…');
    } catch (e) { toast(e.message, 'bad', 7000); }
    this.saving = false;
    this.render();
  }

  /** TV mode is a local, instant toggle (main.js's ctx.setTvMode) with no save bar of its own, but turning
   * it on has real, synced side effects the operator should see coming: it enables Channel-zero for every
   * device watching this recorder (not just this one), and jumps straight into it, full screen. Turning it
   * back off is the plain, instant, no-questions-asked toggle it always was. */
  async _onTvModeToggle(checked) {
    if (!checked) { this.ctx.setTvMode(false); this.render(); return; }
    const needsChannelZero = !this.base.connection.channel_zero && this.ctx.can('admin');   // only an admin can turn it on
    const go = await confirmDialog({
      title: 'Switch to TV mode?',
      body: needsChannelZero
        ? "Bigger text and arrow-key camera selection for watching from a distance. This also turns on the recorder's Channel-zero overview stream — for every device watching this recorder, not just this one — and takes you straight to it, full screen."
        : "Bigger text and arrow-key camera selection for watching from a distance — takes you straight to the recorder's Channel-zero overview stream, full screen.",
      ok: 'Go to TV mode',
    });
    if (!go) { this.render(); return; }   // the checkbox is already visually checked (native behaviour); re-render to drop it back
    if (needsChannelZero) {
      const draft = clone(this.base);
      draft.connection.channel_zero = true;
      try {
        const saved = await this.ctx.saveAll(draft);
        this.base = clone(saved); this.draft = clone(saved);
      } catch (e) { toast(e.message, 'bad', 7000); this.render(); return; }
    }
    this.ctx.setTvMode(true);
    this.ctx.armTvFullscreen?.();
    this.ctx.go('#/live');
  }

  addChannel(channel, name) {
    const used = new Set(this.draft.channels.map((c) => c.channel));
    let n = channel || 1;
    while (used.has(n)) n++;
    const id = 'c' + Math.random().toString(16).slice(2, 8);
    this.draft.channels.push({ id, channel: n, name: name || `Camera ${n}`, enabled: true, sub_fps: 'auto', main_fps: 'auto', aspect: 'auto', sub_path: '', main_path: '' });
    this.draft.display.order.push(id);
    this.render(); this.refresh();
    this.pane.querySelector(`[data-row="${id}"] input[type=text]`)?.focus();
  }

  addFound() {
    const have = new Set(this.draft.channels.map((c) => c.channel));
    this.found.filter((f) => !have.has(f.channel)).forEach((f) => this.addChannel(f.channel, f.name));
  }

  useNames() {
    for (const f of this.found) {
      const c = this.draft.channels.find((x) => x.channel === f.channel);
      if (c && f.name) c.name = f.name.slice(0, 40);
    }
    this.render(); this.refresh();
  }

  move(id, dir) {
    const o = this.draft.display.order, i = o.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    this.render(); this.refresh();
  }

  async remove(id) {
    const c = this.draft.channels.find((x) => x.id === id);
    if (!(await confirmDialog({ title: 'Remove this channel?', body: `“${c.name || 'Channel ' + c.channel}” will disappear from the live view once you save. The camera itself is not affected.`, ok: 'Remove', danger: true }))) return;
    this.draft.channels = this.draft.channels.filter((x) => x.id !== id);
    this.draft.display.order = this.draft.display.order.filter((x) => x !== id);
    delete this.tests[id];
    this.render(); this.refresh();
  }

  async runConnTest() {
    const errs = this.errors();
    const bad = Object.keys(errs).filter((k) => k.startsWith('connection.'));
    if (bad.length) { this.conn = { ok: false, message: errs[bad[0]] }; this.render(); return; }
    const ch = this.draft.channels.find((c) => c.id === this.pane.querySelector('#t-ch')?.value) || this.draft.channels[0];
    this.busy.add('conn'); this.render();
    try {
      this.conn = await api.test(this.draft.connection, ch ? ch.channel : 1, this.tk === 'main' ? 'main' : 'sub', ch ? (this.tk === 'main' ? ch.main_path : ch.sub_path) : '');
    } catch (e) { this.conn = { ok: false, message: e.message }; }
    this.busy.delete('conn'); this.render();
  }

  async runChan0Test() {
    const c = this.draft.connection;
    this.busy.add('c0'); this.render();
    try {
      // api.test's generic path fallback (channel/kind → "{channel}01"/"{channel}02") isn't the channel-
      // zero one — that only lives in app/settings.py's channel_zero_channel, used once this actually
      // saves — so an empty override has to be resolved to the real default here explicitly, or this
      // button tests the wrong path entirely (found directly: it silently probed /Streaming/Channels/002,
      // a 400, instead of the recorder's real channel-zero path).
      this.c0Test = await api.test(c, 0, 'sub', c.channel_zero_path || DEFAULT_CHANNEL_ZERO_PATH);
    } catch (e) { this.c0Test = { ok: false, message: e.message }; }
    this.busy.delete('c0'); this.render();
  }

  async runRowTest(id) {
    const c = this.draft.channels.find((x) => x.id === id);
    this.busy.add('t' + id); this.render();
    const one = (kind) => api.test(this.draft.connection, c.channel, kind, c[kind + '_path']).catch((e) => ({ ok: false, message: e.message }));
    const [sub, main] = await Promise.all([one('sub'), one('main')]);
    this.tests[id] = { sub, main };
    this.busy.delete('t' + id); this.render();
    if (!sub.ok && !main.ok) toast(`Channel ${c.channel}: ${sub.message}`, 'bad', 6000);
  }

  async detect() {
    this.busy.add('detect'); this.render();
    try { this.found = (await api.discover(this.draft.connection)).channels; }
    catch (e) { this.found = null; toast(e.message, 'bad', 6000); }
    this.busy.delete('detect'); this.render();
  }

  /** Called before leaving: false = stay. */
  async beforeLeave() {
    if (!this.dirty) return true;
    return confirmDialog({ title: 'Discard unsaved changes?', body: 'You changed some settings but have not saved them.', ok: 'Discard changes', danger: true });
  }

  destroy() {
    clearInterval(this.statusTimer);
    this.ctx.applyTheme(this.ctx.settings().display.theme);   // drop any unsaved theme preview
    this.root.innerHTML = '';
  }
}
