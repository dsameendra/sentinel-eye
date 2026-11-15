// The recorder's health as Live and Playback see it: polls /api/status (every 15 s, only while the tab is
// visible) and shows a compact notice when the recorder can't be reached or has rejected the saved sign-in.
// Dismissing it hides that state's notice for the rest of this browser session; a different state (or the
// recorder recovering and failing again) shows it afresh. Details live in Settings → Status.
import { api } from './api.js';
import { esc, icon, toast } from './ui.js';

const DISMISS_KEY = 'sentinel.recorderNotice';
const PERIOD_MS = 15000;

/** 'rejected' | 'unreachable' | 'ok' | null (not known yet / not configured) from an /api/status answer. */
export function recorderState(st) {
  if (!st) return null;
  if (st.recorder_auth_failed) return 'rejected';
  const r = st.recorder;
  if (!r || r.configured === false) return null;
  if (r.reachable === false) return 'unreachable';
  return r.reachable === true ? 'ok' : null;
}

const dismissed = () => { try { return sessionStorage.getItem(DISMISS_KEY); } catch { return null; } };
const setDismissed = (v) => { try { v ? sessionStorage.setItem(DISMISS_KEY, v) : sessionStorage.removeItem(DISMISS_KEY); } catch { /* private mode */ } };

export class RecorderWatch {
  /** @param host element the notice is rendered into @param ctx the app context (can(), go())
   *  @param onChange optional (state) => void — e.g. Live's health pill
   *  @param suppress optional (state) => bool — hide the notice anyway (Live: every camera is streaming, so a
   *         failing management port — a single IP camera, a path override — isn't news) */
  constructor(host, ctx, { onChange = null, suppress = null } = {}) {
    this.suppress = suppress;
    this.host = host;
    this.ctx = ctx;
    this.onChange = onChange;
    this.state = null;
    this._onVis = () => { if (!document.hidden) this.poll(); };
    document.addEventListener('visibilitychange', this._onVis);
    this.timer = setInterval(() => { if (!document.hidden) this.poll(); }, PERIOD_MS);
    this.poll();
  }

  async poll() {
    let st;
    try { st = await api.status(); } catch { return; }   // the server itself is unreachable: the app says so elsewhere
    if (this._dead) return;
    const s = recorderState(st);
    if (s === 'ok') setDismissed(null);   // recovered: the next failure is news again
    if (s !== this.state) { this.state = s; this.onChange?.(s); }
    this.render();
  }

  render() {
    if (!this.host?.isConnected) return;
    const s = this.state;
    if (!(s === 'rejected' || s === 'unreachable') || dismissed() === s || this.suppress?.(s)) { this.host.innerHTML = ''; this.host.hidden = true; return; }
    const admin = this.ctx.can('admin');
    const text = s === 'rejected'
      ? `<b>The recorder rejected the saved sign-in.</b> Sentinel Eye has stopped logging in so the recorder doesn't lock the account.${admin ? '' : ' Ask an admin to fix it.'}`
      : '<b>Can\'t reach the recorder.</b> Cameras and recordings come back on their own once it\'s reachable again.';
    const actions = admin
      ? (s === 'rejected'
        ? '<button class="btn sm" data-n="retry">Try again</button><a class="btn sm ghost" href="#/settings/connection">Settings</a>'
        : '<a class="btn sm ghost" href="#/settings/status">Status</a>')
      : '';
    this.host.hidden = false;
    this.host.innerHTML = `<div class="inline-notice bad" role="status">${icon('alert')}<span class="in-text">${text}</span>
      <span class="in-acts">${actions}<button class="btn icon sm ghost" data-n="dismiss" aria-label="Dismiss" title="Hide until something changes">${icon('close')}</button></span></div>`;
    this.host.querySelector('[data-n=dismiss]').addEventListener('click', () => { setDismissed(s); this.render(); });
    this.host.querySelector('[data-n=retry]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { await api.retryRecorder(); toast('Trying the recorder again…'); setTimeout(() => this.poll(), 8000); }
      catch (err) { toast(err.message || 'Could not retry', 'bad'); }
    });
  }

  destroy() {
    this._dead = true;
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this._onVis);
    if (this.host) this.host.innerHTML = '';
  }
}

/** A compact, dismissible notice row (same look as the recorder notice) — Playback's roll-off warning uses it.
 * `text` is HTML the caller has escaped; actions are [{id, label, primary}]. */
export function inlineNoticeHTML({ tone = 'warn', glyph = 'alert', text, actions = [], dismiss = true }) {
  return `<div class="inline-notice ${tone}" role="status">${icon(glyph)}<span class="in-text">${text}</span>
    <span class="in-acts">${actions.map((a) => `<button class="btn sm${a.primary ? '' : ' ghost'}" data-n="${esc(a.id)}">${esc(a.label)}</button>`).join('')}
    ${dismiss ? `<button class="btn icon sm ghost" data-n="dismiss" aria-label="Dismiss">${icon('close')}</button>` : ''}</span></div>`;
}
