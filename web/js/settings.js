// Settings: Connection, Channels, Display, Enhancement, Status. Edits a draft copy; nothing is applied
// until Save.
import { api } from './api.js';
import { LAYOUTS, layoutIds, layoutIcon } from './layouts.js';
import { PRESETS as ENHANCE_PRESETS } from './enhance.js';
import { confirmDialog, esc, icon, toast } from './ui.js';

const TABS = [
  ['connection', 'Connection', 'plug'],
  ['channels', 'Channels', 'video'],
  ['display', 'Display', 'monitor'],
  ['enhancement', 'Enhancement', 'wand'],
  ['status', 'Status', 'activity'],
];
const ENHANCE_MODES = [['auto', 'Auto'], ['face', 'Face priority'], ['plate', 'Plate & text'], ['general', 'General']];
const HOST_RE = /^[A-Za-z0-9._-]+$/;
const clone = (o) => JSON.parse(JSON.stringify(o));
const fpsText = (v) => (v === 'auto' || v == null ? '' : String(v));

export class SettingsView {
  /** @param ctx { settings(), saveAll(draft), applyTheme(theme), go(hash) } */
  constructor(root, ctx, tab) {
    this.root = root;
    this.ctx = ctx;
    this.tab = TABS.some((t) => t[0] === tab) ? tab : 'connection';
    this.base = clone(ctx.settings());
    this.draft = clone(this.base);
    this.tests = {};          // per-channel probe results
    this.conn = null;          // connection test result
    this.found = null;         // discovered channels
    this.busy = new Set();
    this.build();
  }

  get dirty() { return JSON.stringify(this.draft) !== JSON.stringify(this.base) || !!this.draft.connection.password || !!this.draft.connection.key; }

  setTab(tab) { if (TABS.some((t) => t[0] === tab) && tab !== this.tab) { this.tab = tab; this.build(); } }

  // ------------------------------------------------------------- validation
  errors() {
    const e = {}, c = this.draft.connection;
    if (!c.host.trim()) e['connection.host'] = 'Enter the IP address of the recorder or camera.';
    else if (!HOST_RE.test(c.host.trim())) e['connection.host'] = 'Use just an address like 192.0.2.10 (no http://, port or path).';
    if (!Number.isInteger(+c.rtsp_port) || c.rtsp_port < 1 || c.rtsp_port > 65535) e['connection.rtsp_port'] = 'A port between 1 and 65535 (usually 554).';
    if (!Number.isInteger(+c.http_port) || c.http_port < 1 || c.http_port > 65535) e['connection.http_port'] = 'A port between 1 and 65535 (usually 80).';
    if (!c.username.trim()) e['connection.username'] = 'Enter the username.';
    if (!c.password && !this.base.connection.has_password) e['connection.password'] = 'Enter the password.';
    if (c.encrypted && !c.key && !this.base.connection.has_key) e['connection.key'] = 'Enter the verification code, or turn encryption off.';
    if (c.key && new TextEncoder().encode(c.key).length > 16) e['connection.key'] = 'At most 16 characters.';
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
    this.root.innerHTML = `<div class="settings">
      <nav class="side" aria-label="Settings sections">${TABS.map(([id, label, ic]) =>
        `<a href="#/settings/${id}" ${id === this.tab ? 'aria-current="page"' : ''}>${icon(ic)}${label}</a>`).join('')}</nav>
      <main class="pane"><div class="pane-inner"></div></main></div><div class="savebar" hidden></div>`;
    this.pane = this.root.querySelector('.pane-inner');
    this.bar = this.root.querySelector('.savebar');
    this.render();
  }

  render() {
    clearInterval(this.statusTimer);
    const fn = { connection: () => this.connectionTab(), channels: () => this.channelsTab(), display: () => this.displayTab(), enhancement: () => this.enhancementTab(), status: () => this.statusTab() }[this.tab];
    this.pane.innerHTML = fn();
    this.wire();
    this.refresh();
    if (this.tab === 'status') this.startStatus();
  }

  fieldErr(path) { const m = this.errors()[path]; return m ? `<div class="err" data-err="${path}">${esc(m)}</div>` : `<div class="err" data-err="${path}" hidden></div>`; }

  connectionTab() {
    const c = this.draft.connection, b = this.base.connection;
    const first = this.draft.channels.find((x) => x.enabled) || this.draft.channels[0];
    const t = this.conn;
    return `<h1>Connection</h1><p class="lead">How Sentinel Eye reaches your recorder or camera.</p>
    <section class="card"><h3>Recorder</h3><p class="sub">The address and login of the DVR/NVR (or a single IP camera). Streams are read over RTSP.</p>
      <div class="form">
        <div class="field"><label for="f-host">IP address or hostname</label><input id="f-host" type="text" data-b="connection.host" value="${esc(c.host)}" placeholder="192.0.2.10" autocomplete="off" spellcheck="false">${this.fieldErr('connection.host')}</div>
        <div class="field"><label for="f-port">RTSP port</label><input id="f-port" type="number" min="1" max="65535" data-b="connection.rtsp_port" data-t="int" value="${esc(c.rtsp_port)}">${this.fieldErr('connection.rtsp_port')}<div class="hint">Almost always 554.</div></div>
        <div class="field"><label for="f-http">Web (HTTP) port</label><input id="f-http" type="number" min="1" max="65535" data-b="connection.http_port" data-t="int" value="${esc(c.http_port)}">${this.fieldErr('connection.http_port')}<div class="hint">Used only to read camera names. Usually 80.</div></div>
        <div class="field"><label for="f-user">Username</label><input id="f-user" type="text" data-b="connection.username" value="${esc(c.username)}" autocomplete="off">${this.fieldErr('connection.username')}</div>
        <div class="field"><label for="f-pass">Password</label><input id="f-pass" type="password" data-b="connection.password" value="${esc(c.password)}" placeholder="${b.has_password ? '•••••••• (saved, leave blank to keep)' : ''}" autocomplete="new-password">${this.fieldErr('connection.password')}</div>
      </div></section>
    <section class="card"><h3>Stream encryption</h3>
      <p class="sub">If you turned on “Stream Encryption” on the recorder (Network → Platform Access), the video is scrambled and needs its verification code. Leave this off for normal, unencrypted streams.</p>
      <div class="toggle-row"><label class="switch"><input type="checkbox" data-b="connection.encrypted" data-t="bool" ${c.encrypted ? 'checked' : ''} aria-label="Stream is encrypted"><span></span></label>
        <span><b>${c.encrypted ? 'Encrypted' : 'Not encrypted'}</b> <span class="muted">— ${c.encrypted ? 'video is decrypted on this computer' : 'video is played as-is'}</span></span></div>
      <div class="form" style="margin-top:14px"><div class="field wide"><label for="f-key">Verification code</label>
        <div class="input-row"><input id="f-key" type="password" data-b="connection.key" value="${esc(c.key)}" ${c.encrypted ? '' : 'disabled'} placeholder="${c.encrypted ? (b.has_key ? '•••••••• (saved, leave blank to keep)' : 'The code set on the recorder') : 'Turn encryption on to enter the code'}" autocomplete="off" spellcheck="false">
          <button class="btn icon" type="button" data-reveal="f-key" ${c.encrypted ? '' : 'disabled'} title="Show / hide" aria-label="Show or hide the code">${icon('eye')}</button></div>
        ${this.fieldErr('connection.key')}<div class="hint">Up to 16 characters. It is stored only on this computer.</div></div></div></section>
    <section class="card"><h3>Test connection</h3><p class="sub">Connects with the values above (even before saving), reads a few seconds of video, and tells you what it found.</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="t-ch" style="width:auto;min-width:170px" aria-label="Channel to test">${this.draft.channels.map((x) => `<option value="${x.id}" ${first && x.id === first.id ? 'selected' : ''}>${esc(x.name || 'Channel ' + x.channel)} (ch ${x.channel})</option>`).join('') || '<option value="">Channel 1</option>'}</select>
        <div class="seg" role="group" aria-label="Stream"><button data-tk="sub" aria-pressed="${this.tk !== 'main'}">SD</button><button data-tk="main" aria-pressed="${this.tk === 'main'}">HD</button></div>
        <button class="btn primary" id="t-run" ${this.busy.has('conn') ? 'disabled' : ''}>${this.busy.has('conn') ? '<span class="spin" style="width:14px;height:14px"></span> Testing…' : 'Test connection'}</button></div>
      ${t ? this.resultHtml(t) : ''}</section>`;
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
    return `<h1>Channels</h1><p class="lead">The cameras shown on the live view. Names and order apply everywhere.</p>
    <section class="card"><div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn primary" id="add-ch">${icon('plus')} Add channel</button>
        <button class="btn" id="detect" ${this.busy.has('detect') ? 'disabled' : ''}>${icon('search')} ${this.busy.has('detect') ? 'Detecting…' : 'Detect channels'}</button>
        <span class="muted" style="font-size:12.5px">Frame rate is normally measured from the stream itself (leave “auto”). Set a number only to override it.</span></div>
      ${foundHtml}
      ${rows.length ? `<table class="tbl"><thead><tr><th></th><th>Ch</th><th>Name</th><th>SD fps</th><th>HD fps</th><th></th></tr></thead><tbody>${body}</tbody></table>`
        : '<p class="muted">No channels yet. Add one or detect them from the recorder.</p>'}</section>`;
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
    const opt = (key, val, title, sub) => `<button class="opt" data-o="${key}:${val}" aria-pressed="${d[key] === val}"><b>${title}</b><small>${sub}</small></button>`;
    return `<h1>Display</h1><p class="lead">How the live view looks and behaves.</p>
    <section class="card"><h3>Appearance</h3><div class="form">
      <div class="field wide"><span class="lbl">Fit</span><div class="seg" role="group" aria-label="Fit"><button data-o="fit:contain" aria-pressed="${d.fit === 'contain'}">Fit</button><button data-o="fit:cover" aria-pressed="${d.fit === 'cover'}">Fill tile</button></div>
        <div class="hint">Applies to both the live grid/large view and Playback. "Fit" never crops (letterboxed if the shapes don't match); "Fill tile" crops to fill the space edge-to-edge.</div></div>
      <div class="field"><span class="lbl">Theme</span><div class="seg" role="group" aria-label="Theme"><button data-o="theme:auto" aria-pressed="${d.theme === 'auto'}">Auto</button><button data-o="theme:dark" aria-pressed="${d.theme === 'dark'}">Dark</button><button data-o="theme:light" aria-pressed="${d.theme === 'light'}">Light</button></div></div></div></section>
    <section class="card"><h3>Layout &amp; rotation</h3>
      <div class="form"><div class="field"><label for="f-rot">Auto-rotate pages</label><select id="f-rot" data-b="display.rotate_seconds" data-t="int">${[[0, 'Off'], [5, 'Every 5 seconds'], [10, 'Every 10 seconds'], [15, 'Every 15 seconds'], [30, 'Every 30 seconds'], [60, 'Every minute']].map(([v, l]) => `<option value="${v}" ${+d.rotate_seconds === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="hint">Only matters when there are more cameras than fit on one page.</div></div></div>
      <p class="sub" style="margin-top:14px">Default layout — you can also change it any time from the live view.</p>
      <div class="laygrid">${layoutIds.map((id) => `<button data-o="layout:${id}" aria-pressed="${d.layout === id}">${layoutIcon(id, 44)}<span>${LAYOUTS[id].label}</span></button>`).join('')}</div></section>
    <section class="card"><h3>Streaming</h3><p class="sub">Each camera has a light SD sub-stream and a sharp HD main stream.</p>
      <div class="opts">${opt('quality', 'auto', 'Auto', 'HD for large tiles and the large view, SD for small tiles')}${opt('quality', 'sub', 'Always SD', 'Lowest bandwidth. Best for big walls')}${opt('quality', 'main', 'Always HD', 'Sharpest picture, heavier on network and CPU')}</div>
      <p class="sub" style="margin-top:14px">H.265 (HD) playback — HD streams are usually H.265. Converting to H.264 on this computer plays smoothly everywhere; playing H.265 directly saves CPU but can stutter on some cameras and doesn't work in Firefox.</p>
      <div class="opts">${opt('main_codec', 'h264', 'Convert to H.264', 'Recommended. Smooth everywhere; uses some CPU while an HD stream is open')}${opt('main_codec', 'passthrough', 'Play directly', 'No extra CPU. May stutter or fail in some browsers')}</div></section>
    <section class="card"><h3>Interaction</h3><p class="sub">Fine-tuning for how the overlay controls and snapshots behave — sensible as-is for most people, here if you want to tune them.</p>
      <div class="form">
        ${this.rangeField('display.controls_autohide_sec', d.controls_autohide_sec, { id: 'f-autohide', label: 'Auto-hide controls after', min: 1, max: 10, step: 0.5, unit: 's', hint: 'How long the play/pause/zoom overlay (Live large view, Playback) stays up after you stop moving the mouse, while playing. Always stays up while paused.' })}
        ${this.rangeField('display.snapshot_quality', d.snapshot_quality, { id: 'f-snapq', label: 'Snapshot quality', min: 0.5, max: 1, step: 0.01, hint: 'JPEG quality for the camera snapshot button. Higher is sharper but a larger file.' })}
      </div></section>
    <section class="card"><h3>Keyboard shortcuts</h3><dl class="kv">
      <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Previous / next page, or camera in the large view</dd><dt><kbd>1</kbd>–<kbd>9</kbd></dt><dd>Open that camera on the page</dd>
      <dt><kbd>E</kbd></dt><dd>Arrange mode (drag to reorder)</dd><dt><kbd>F</kbd></dt><dd>Full screen</dd><dt><kbd>H</kbd> / <kbd>S</kbd></dt><dd>Large view: toggle HD / save snapshot</dd><dt><kbd>+</kbd> <kbd>-</kbd> <kbd>0</kbd></dt><dd>Large view: zoom in / out / reset (scroll or pinch also works, drag to pan)</dd><dt><kbd>Esc</kbd></dt><dd>Reset zoom, then close the large view</dd></dl></section>`;
  }

  /** A labelled range slider bound to `data-b` path `bindPath`, with a live numeric readout — the one
   * reusable piece for every slider added across the settings tabs, since none existed before this. */
  rangeField(bindPath, value, { id, label, min, max, step, unit = '', hint }) {
    return `<div class="field"><label for="${id}">${label}</label>
      <div class="range-row"><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" data-b="${bindPath}" data-t="float" value="${value}">
        <span class="range-val" data-unit="${unit}">${Number(value).toFixed(step < 1 ? 2 : 0)}${unit}</span></div>
      ${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  }

  enhancementTab() {
    const d = this.draft.display;
    return `<h1>Enhancement</h1><p class="lead">Defaults for the live "wand" filters and the frame enhancer — every control stays freely adjustable per-session, this just sets where it starts.</p>
    <section class="card"><h3>Live filters</h3><p class="sub">The starting preset for a newly-opened live tile or Playback pane. Presets are just quick-fills — every slider underneath stays individually adjustable afterwards.</p>
      <div class="form"><div class="field wide"><label for="f-enh-preset">Default preset</label>
        <select id="f-enh-preset" data-b="display.enhance_default_preset">${Object.entries(ENHANCE_PRESETS).filter(([k]) => k !== 'custom').map(([k, p]) => `<option value="${k}" ${d.enhance_default_preset === k ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
        <div class="hint">"Off" (recommended) starts every tile untouched — turn a preset on per-camera from the wand menu when you actually need it.</div></div></div></section>
    <section class="card"><h3>Frame enhancer</h3><p class="sub">Starting mode and fidelity for the AI frame enhancer popup (Playback, pause first). docs/enhance-ai-spec.md section 2d covers why 0.5 fidelity is the recommended default.</p>
      <div class="form">
        <div class="field wide"><span class="lbl">Default mode</span><div class="seg" role="group" aria-label="Default mode">${ENHANCE_MODES.map(([k, l]) => `<button data-o="enhance_default_mode:${k}" aria-pressed="${d.enhance_default_mode === k}">${l}</button>`).join('')}</div></div>
        ${this.rangeField('display.enhance_default_fidelity', d.enhance_default_fidelity, { id: 'f-fidelity', label: 'Default fidelity', min: 0, max: 1, step: 0.05, hint: 'Lower = more face reconstruction (risk of inventing features); higher = closer to the real pixels (risk of staying blurry). Recommended: 0.5.' })}
      </div></section>`;
  }

  statusTab() {
    return `<h1>Status</h1><p class="lead">What the video server is doing right now.</p><section class="card" id="status-card"><p class="muted">Loading…</p></section>`;
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
        card.innerHTML = `<div class="toggle-row" style="margin-bottom:12px"><span class="dot ${st.go2rtc ? 'live' : 'off'}"></span><b>Video engine ${st.go2rtc ? 'running' : 'not responding'}</b></div>
          <table class="tbl"><thead><tr><th>Camera</th><th>Stream</th><th>State</th><th>Viewers</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No streams configured.</td></tr>'}</tbody></table>`;
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
        if (path === 'connection.encrypted' || /^ch\.[^.]+\.enabled$/.test(path)) { this.render(); }
        if (path === 'connection.host' || path.startsWith('connection.')) this.conn = null;
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
    p.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => {
      const i = p.querySelector('#' + b.dataset.reveal);
      i.type = i.type === 'password' ? 'text' : 'password';
      b.innerHTML = icon(i.type === 'password' ? 'eye' : 'eyeoff');
    }));
    p.querySelectorAll('[data-tk]').forEach((b) => b.addEventListener('click', () => { this.tk = b.dataset.tk; this.conn = null; this.render(); }));
    p.querySelector('#t-run')?.addEventListener('click', () => this.runConnTest());
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
