// Bookmarks panel (Playback): every bookmark on the visible day — or all of them — with search, a severity
// filter, jump-to, edit and delete (docs/SPEC.md section 9). A side sheet with its own scrim, scoped like the
// Events filter sheet (ui.js scopeLayers), so the bookmark and confirm dialogs can open over it.
//
// Who may change a bookmark is the server's decision (app/server.py _may_change_bookmark); canChangeBookmark
// mirrors it only to hide buttons that would be refused.
import { api, getJSON } from './api.js';
import { bookmarkDialog, confirmDialog, esc, icon, scopeLayers, toast } from './ui.js';
import { partsFromEpoch } from './dvrtime.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEVERITIES = [['', 'Any'], ['info', 'Info'], ['warning', 'Warning'], ['critical', 'Critical']];
const pad2 = (n) => String(n).padStart(2, '0');

/** Sign-in off: anyone. Admins: any. Operators: their own (by account id). A trusted-network operator without
 * an account: bookmarks made the same way. */
export function canChangeBookmark(me, b) {
  if (!me || !me.auth_enabled || me.via === 'none') return true;
  if (me.role === 'admin') return true;
  if (me.role !== 'operator') return false;
  if (me.via === 'session') return b.author_user_id != null && b.author_user_id === me.user?.id;
  if (me.via === 'bypass') return b.author_user_id == null && b.author === `LAN (${me.role})`;
  return false;
}

export class BookmarksPanel {
  /** @param host the element the sheet and its scrim are appended to (Playback's .pb)
   *  @param o { ctx, tzOffset(), playhead(), camName(channel), onJump(bookmark), onChanged(), onAdd() } */
  constructor(host, o) {
    this.o = o;
    this.scope = 'day';
    this.sev = '';
    this.query = '';
    this.rows = [];
    this.scrim = document.createElement('div');
    this.scrim.className = 'pb-sheet-scrim';
    this.scrim.hidden = true;
    this.el = document.createElement('aside');
    this.el.className = 'pb-sheet';
    this.el.setAttribute('aria-label', 'Bookmarks');
    this.el.innerHTML = `<div class="pbs-head"><h2>${icon('bookmark')} Bookmarks</h2><span class="spacer"></span>
        <button class="btn icon sm ghost" data-b="close" aria-label="Close bookmarks" title="Close (Esc)">${icon('close')}</button></div>
      <label class="ev-search pbs-search">${icon('search')}<input type="search" placeholder="Search bookmarks…" aria-label="Search bookmarks" autocomplete="off" spellcheck="false"></label>
      <div class="pbs-filters">
        <div class="seg pbs-scope" role="group" aria-label="Which bookmarks"><button data-scope="day" aria-pressed="true">This day</button><button data-scope="all" aria-pressed="false">All</button></div>
        <div class="pbs-sevs" role="group" aria-label="Severity">${SEVERITIES.map(([v, l]) => `<button class="ev-kind" data-sev="${v}" aria-pressed="${v === ''}">${v ? `<span class="sev-dot ${v}"></span>` : ''}${l}</button>`).join('')}</div>
      </div>
      <div class="pbs-list" role="list" aria-live="polite"></div>
      <div class="pbs-foot"><span class="pbs-count hint"></span><button class="btn sm" data-b="add">${icon('flag')} Bookmark this moment</button></div>`;
    host.append(this.scrim, this.el);
    this.list = this.el.querySelector('.pbs-list');
    this.el.querySelector('[data-b=close]').addEventListener('click', () => this.close());
    this.el.querySelector('[data-b=add]').addEventListener('click', () => this.o.onAdd?.());
    this.scrim.addEventListener('click', () => this.close());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('modal-root')?.firstChild) { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
    const q = this.el.querySelector('input[type=search]');
    q.addEventListener('input', () => { this.query = q.value.trim().toLowerCase(); this.render(); });
    this.el.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
      this.scope = b.dataset.scope;
      this.el.querySelectorAll('[data-scope]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      this.load();
    }));
    this.el.querySelectorAll('[data-sev]').forEach((b) => b.addEventListener('click', () => {
      this.sev = b.dataset.sev;
      this.el.querySelectorAll('[data-sev]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      this.render();
    }));
  }

  get isOpen() { return this.el.classList.contains('open'); }

  open() {
    this._returnFocus = document.activeElement;
    this.el.classList.add('open');
    this.scrim.hidden = false;
    scopeLayers();
    this.el.querySelector('input[type=search]').focus({ preventScroll: true });
    this.load();
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.remove('open');
    this.scrim.hidden = true;
    scopeLayers();
    if (this._returnFocus?.isConnected) this._returnFocus.focus({ preventScroll: true });
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  /** The DVR-local day around the playhead, as [startEpoch, endEpoch]. */
  _day() {
    const off = this.o.tzOffset();
    const p = partsFromEpoch(this.o.playhead(), off);
    const start = Date.UTC(p.y, p.mo, p.da) / 1000 - off * 60;
    return [start, start + 86400];
  }

  async load() {
    if (!this.isOpen) return;
    const seq = (this._seq = (this._seq || 0) + 1);
    this.list.innerHTML = '<div class="pbs-empty"><span class="spin sm"></span></div>';
    const qs = new URLSearchParams({ limit: '1000' });
    if (this.scope === 'day') {
      const [a, b] = this._day();
      qs.set('start_utc', new Date(a * 1000).toISOString());
      qs.set('end_utc', new Date(b * 1000).toISOString());
    }
    try {
      const rows = await getJSON(`/api/bookmarks?${qs}`);
      if (seq !== this._seq) return;
      this.rows = this.scope === 'day' ? rows.slice().reverse() : rows;   // a day reads in time order; all, newest first
      this.render();
    } catch (e) {
      if (seq !== this._seq) return;
      this.list.innerHTML = `<div class="pbs-empty">${esc(e.message || "Couldn't load bookmarks")}</div>`;
    }
  }

  _when(iso) {
    const p = partsFromEpoch(Date.parse(iso) / 1000, this.o.tzOffset());
    return `${MONTHS[p.mo]} ${p.da} · ${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`;
  }

  render() {
    const me = this.o.ctx.me?.();
    const rows = this.rows.filter((b) => (!this.sev || b.severity === this.sev) && (!this.query
      || `${b.title} ${b.note} ${b.author} ${b.channels.map((c) => this.o.camName(c)).join(' ')}`.toLowerCase().includes(this.query)));
    const count = this.el.querySelector('.pbs-count');
    count.textContent = this.rows.length ? `${rows.length} of ${this.rows.length}` : '';
    if (!rows.length) {
      const what = this.scope === 'day' ? 'on this day' : 'yet';
      this.list.innerHTML = `<div class="pbs-empty">${this.rows.length ? 'Nothing matches.' : `No bookmarks ${what}.`}</div>`;
      return;
    }
    this.list.innerHTML = rows.map((b) => {
      const mine = canChangeBookmark(me, b);
      const cams = b.channels.map((c) => this.o.camName(c)).join(', ');
      const by = `${b.author || '—'}${b.edited_utc ? ` · edited${b.edited_by && b.edited_by !== b.author ? ` by ${b.edited_by}` : ''}` : ''}`;
      return `<div class="pbs-item" role="listitem" data-id="${b.id}">
        <button class="pbs-jump" data-b="jump" title="Play from here">
          <span class="sev-dot ${esc(b.severity || 'info')}" aria-hidden="true"></span>
          <span class="pbs-main"><b>${esc(b.title || 'Untitled bookmark')}</b>
            <small class="pbs-when">${esc(this._when(b.time_utc))} · ${esc(cams)}</small>
            ${b.note ? `<small class="pbs-note">${esc(b.note)}</small>` : ''}
            <small class="pbs-by">${esc(by)}</small></span></button>
        ${mine ? `<span class="pbs-acts"><button class="btn icon sm ghost" data-b="edit" aria-label="Edit bookmark ${esc(b.title || '')}" title="Edit">${icon('pencil')}</button>
          <button class="btn icon sm ghost" data-b="del" aria-label="Delete bookmark ${esc(b.title || '')}" title="Delete">${icon('trash')}</button></span>` : ''}
      </div>`;
    }).join('');
    this.list.querySelectorAll('.pbs-item').forEach((item) => {
      const b = rows.find((x) => x.id === +item.dataset.id);
      item.querySelector('[data-b=jump]').addEventListener('click', () => this.o.onJump(b));
      item.querySelector('[data-b=edit]')?.addEventListener('click', () => this.edit(b));
      item.querySelector('[data-b=del]')?.addEventListener('click', () => this.remove(b));
    });
  }

  async edit(b) {
    const r = await bookmarkDialog({ subtitle: `${this._when(b.time_utc)} · ${b.channels.map((c) => this.o.camName(c)).join(', ')}`, initial: b });
    if (!r) return;
    try {
      await api.updateBookmark(b.id, r);
      toast('Bookmark updated.', 'ok');
      this.o.onChanged?.();
      this.load();
    } catch (e) { toast(e.message || 'Could not update the bookmark', 'bad'); }
  }

  async remove(b) {
    const ok = await confirmDialog({ title: 'Delete bookmark?', body: 'This removes the bookmark and its marker from the timeline. This can\'t be undone.', ok: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deleteBookmark(b.id);
      toast('Bookmark deleted.', 'ok');
      this.o.onChanged?.();
      this.load();
    } catch (e) { toast(e.message || 'Could not delete the bookmark', 'bad'); }
  }

  destroy() { this.el.remove(); this.scrim.remove(); }
}
