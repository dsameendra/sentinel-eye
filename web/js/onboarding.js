// First-run setup wizard (redesign v2) — Welcome -> Connect -> Testing -> Done, matching the design
// mockups' four-step flow. Real API calls throughout (api.discover, ctx.saveAll), not a static walkthrough:
// Testing genuinely probes the recorder and Done genuinely lists what it found, saved only once the user
// confirms "Go to Live".
import { api } from './api.js';
import { esc, icon, modalRoot } from './ui.js';

const STEPS = ['welcome', 'connect', 'testing', 'done'];

/** @param ctx { settings(), saveAll(draft), go(hash) } — the same ctx every view gets from main.js. */
export function onboardingDialog(ctx) {
  const root = modalRoot();
  const s = { step: 'welcome', host: '', username: 'admin', port: '80', password: '', found: null, error: '', saving: false };

  const close = () => { root._dispose = null; root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); };
  root._dispose = close;
  const onKey = (e) => { if (e.key === 'Escape' && s.step !== 'testing') { e.stopPropagation(); close(); } };

  function render() {
    if (root._dispose !== close) return;
    const idx = STEPS.indexOf(s.step);
    root.innerHTML = `<div class="scrim"><div class="dialog onboard-dialog" role="dialog" aria-modal="true" aria-label="First-run setup">
      <div class="onboard-dots">${STEPS.map((_, i) => `<span class="onboard-dot${i === idx ? ' on' : ''}"></span>`).join('')}</div>
      ${s.step === 'welcome' ? welcome() : s.step === 'connect' ? connect() : s.step === 'testing' ? testing() : done()}
    </div></div>`;
    wire();
  }

  function welcome() {
    return `<div class="onboard-welcome">
      <div class="brand-mark" style="width:48px;height:48px;margin:0 auto"></div>
      <h2>Welcome to Sentinel Eye</h2>
      <p>No account, no cloud — this runs entirely on your own network. First, let's connect it to your Hikvision DVR or NVR.</p>
      <button class="btn primary onboard-wide" data-x="next">Get started</button>
    </div>`;
  }

  function connect() {
    return `<div class="onboard-form">
      <h3>Connect your recorder</h3>
      ${s.error ? `<div class="result bad">${icon('alert')}<div>${esc(s.error)}</div></div>` : ''}
      <div class="field"><label for="ob-host">Host or IP address</label><input id="ob-host" type="text" value="${esc(s.host)}" placeholder="192.168.1.14" autocomplete="off" autofocus></div>
      <div class="form">
        <div class="field"><label for="ob-user">Username</label><input id="ob-user" type="text" value="${esc(s.username)}" placeholder="admin" autocomplete="off"></div>
        <div class="field"><label for="ob-port">Port</label><input id="ob-port" type="text" value="${esc(s.port)}" placeholder="80" autocomplete="off"></div>
      </div>
      <div class="field"><label for="ob-pw">Password</label><input id="ob-pw" type="password" value="${esc(s.password)}" autocomplete="off"></div>
      <div class="row" style="justify-content:flex-start;margin-top:6px">
        <button class="btn ghost" data-x="back">Back</button>
        <button class="btn primary" data-x="connect" style="flex:1">Connect</button>
      </div>
    </div>`;
  }

  function testing() {
    return `<div class="onboard-testing">
      <div class="spin"></div>
      <h3>Reaching ${esc(s.host)}…</h3>
      <p>Checking credentials, then listing channels</p>
    </div>`;
  }

  function done() {
    const found = s.found || [];
    const shown = found.slice(0, 3);
    const rest = found.length - shown.length;
    return `<div class="onboard-form">
      <div class="onboard-found"><svg class="icon" width="22" height="22" viewBox="0 0 24 24" style="color:var(--armed)"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg><h3>Found ${found.length} channel${found.length === 1 ? '' : 's'}</h3></div>
      <div class="onboard-chlist">
        ${shown.map((c) => `<div class="onboard-chrow"><span class="tag kind">Ch ${c.channel}</span><span>${esc(c.name || 'Camera ' + c.channel)}</span><span class="dot armed"></span></div>`).join('')}
        ${rest > 0 ? `<div class="onboard-chrow"><span class="hint">+${rest} more</span></div>` : ''}
        ${!found.length ? `<div class="onboard-chrow"><span class="hint">No channels responded — you can still continue and add them from Settings.</span></div>` : ''}
      </div>
      <button class="btn primary onboard-wide" data-x="finish" ${s.saving ? 'disabled' : ''}>${s.saving ? '<span class="spin sm"></span> Saving…' : 'Go to Live'}</button>
    </div>`;
  }

  async function doConnect() {
    s.host = root.querySelector('#ob-host').value.trim();
    s.username = root.querySelector('#ob-user').value.trim() || 'admin';
    s.port = root.querySelector('#ob-port').value.trim() || '80';
    s.password = root.querySelector('#ob-pw').value;
    if (!s.host) { s.error = "Enter the recorder's IP address first"; render(); return; }
    s.error = '';
    s.step = 'testing';
    render();
    try {
      const r = await api.discover({ host: s.host, http_port: +s.port || 80, rtsp_port: 554, username: s.username, password: s.password });
      s.found = r.channels;
      s.step = 'done';
    } catch (e) {
      s.error = e.message || 'Could not reach the recorder';
      s.step = 'connect';
    }
    render();
  }

  async function finish() {
    s.saving = true; render();
    try {
      const draft = structuredClone(ctx.settings());
      draft.connection = { ...draft.connection, host: s.host, http_port: +s.port || 80, username: s.username, password: s.password };
      const used = new Set(draft.channels.map((c) => c.channel));
      for (const f of s.found || []) {
        if (used.has(f.channel)) continue;
        const id = 'c' + Math.random().toString(16).slice(2, 8);
        draft.channels.push({ id, channel: f.channel, name: f.name || `Camera ${f.channel}`, enabled: true, sub_fps: 'auto', main_fps: 'auto', aspect: 'auto', sub_path: '', main_path: '' });
        draft.display.order.push(id);
        used.add(f.channel);
      }
      await ctx.saveAll(draft);
      if (root._dispose !== close) return;
      close();
      ctx.go('#/live');
    } catch (e) {
      s.saving = false;
      s.error = e.message || 'Could not save the recorder connection';
      s.step = 'connect';
      render();
    }
  }

  function wire() {
    root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim') && s.step !== 'testing') close(); });
    root.querySelector('[data-x="next"]')?.addEventListener('click', () => { s.step = 'connect'; render(); });
    root.querySelector('[data-x="back"]')?.addEventListener('click', () => { s.step = 'welcome'; render(); });
    root.querySelector('[data-x="connect"]')?.addEventListener('click', doConnect);
    root.querySelector('[data-x="finish"]')?.addEventListener('click', finish);
  }

  document.addEventListener('keydown', onKey, true);
  render();
}
