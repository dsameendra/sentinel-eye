// Live view: layouts, pages, drag-to-reorder, quality selection and the large "focus" view.
import { LAYOUTS, layoutIds, layoutIcon, slotsOf } from './layouts.js';
import { Tile } from './tile.js';
import { esc, icon, toast } from './ui.js';

export class LiveView {
  /** @param ctx { settings(): current settings, saveDisplay(display): Promise, go(hash) } */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.page = 0;
    this.edit = false;
    this.rotating = true;
    this.tiles = [];
    this.focus = null;         // { tile, id }
    this.menuOpen = false;
    this.pendingFocusId = null;
    this.onKey = (e) => this.key(e);
    document.addEventListener('keydown', this.onKey);
    this.onFs = () => this.syncFullscreen();
    document.addEventListener('fullscreenchange', this.onFs);
    this.onDoc = (e) => { if (this.menuOpen && !e.target.closest('.menu-wrap')) { this.menuOpen = false; this.renderBar(); } };
    document.addEventListener('click', this.onDoc);
    this.rotTimer = setInterval(() => this.rotate(), 1000);
    this.rotSince = Date.now();
    this.build();
  }

  get s() { return this.ctx.settings(); }
  get d() { return this.s.display; }
  cams() {
    const by = Object.fromEntries(this.s.channels.filter((c) => c.enabled).map((c) => [c.id, c]));
    return this.d.order.map((id) => by[id]).filter(Boolean);
  }
  slots() { return slotsOf(this.d.layout); }
  pages() { return Math.max(1, Math.ceil(this.cams().length / this.slots())); }

  // ---------------------------------------------------------------- structure
  build() {
    this.disposeTiles();
    const s = this.s;
    if (!s.connection.host) {
      this.root.innerHTML = `<div class="liveview"><div class="center-card"><div style="color:var(--accent)">${icon('plug').replace('class="i"', 'class="i" style="width:34px;height:34px"')}</div>
        <h2>Connect your recorder</h2><p>Enter the IP address and login of your DVR or camera to see the live video.</p>
        <a class="btn primary" href="#/settings/connection">Open settings</a></div></div>`;
      return;
    }
    if (!this.cams().length) {
      this.root.innerHTML = `<div class="liveview"><div class="center-card"><div style="color:var(--accent)">${icon('video').replace('class="i"', 'class="i" style="width:34px;height:34px"')}</div>
        <h2>No cameras yet</h2><p>Add or enable channels to start watching.</p><a class="btn primary" href="#/settings/channels">Manage channels</a></div></div>`;
      return;
    }
    this.root.innerHTML = `<div class="liveview"><div class="subbar"></div><div class="wall"></div></div>`;
    this.live = this.root.querySelector('.liveview');
    this.bar = this.root.querySelector('.subbar');
    this.wall = this.root.querySelector('.wall');
    this.page = Math.min(this.page, this.pages() - 1);
    this.renderBar();
    this.renderWall();
    if (this.pendingFocusId) this.route(this.pendingFocusId);
  }

  renderBar() {
    if (!this.bar) return;
    const d = this.d, pages = this.pages(), q = d.quality;
    const seg = (v, label, tip) => `<button data-q="${v}" aria-pressed="${q === v}" title="${tip}">${label}</button>`;
    this.bar.innerHTML = `
      <div class="menu-wrap">
        <button class="btn" data-a="layout" aria-haspopup="true" aria-expanded="${this.menuOpen}">${layoutIcon(d.layout, 22)} ${LAYOUTS[d.layout].label} ${icon('down')}</button>
        ${this.menuOpen ? `<div class="menu" style="left:0;right:auto;min-width:250px"><div class="lay">${layoutIds.map((id) =>
          `<button data-l="${id}" aria-pressed="${d.layout === id}">${layoutIcon(id, 40)}<span>${LAYOUTS[id].label}</span></button>`).join('')}</div></div>` : ''}
      </div>
      <div class="seg" role="group" aria-label="Video quality">
        ${seg('auto', 'Auto', 'HD for large tiles and the large view, SD for small tiles')}${seg('sub', 'SD', 'Always use the lighter sub-stream')}${seg('main', 'HD', 'Always use the full quality main stream')}
      </div>
      <button class="btn" data-a="edit" aria-pressed="${this.edit}" title="Drag tiles to change their order (E)">${icon('move')} Arrange</button>
      ${d.rotate_seconds > 0 && pages > 1 ? `<button class="btn" data-a="rotate" aria-pressed="${this.rotating}" title="Auto-rotate pages every ${d.rotate_seconds}s">${icon(this.rotating ? 'pause' : 'play')} Rotate</button>` : ''}
      <span class="spacer"></span>
      ${pages > 1 ? `<div class="pager"><button class="btn icon ghost" data-a="prev" aria-label="Previous page">${icon('left')}</button>
        <div class="dots">${Array.from({ length: pages }, (_, i) => `<button data-p="${i}" aria-label="Page ${i + 1}" aria-current="${i === this.page}"></button>`).join('')}</div>
        <span>${this.page + 1} / ${pages}</span><button class="btn icon ghost" data-a="next" aria-label="Next page">${icon('right')}</button></div>` : ''}
      <span class="pill" title="Cameras currently showing live video"><span class="dot ${this.liveCount === this.tiles.length && this.tiles.length ? 'live' : 'wait'}"></span><span class="livecount">${this.liveCount ?? 0}/${this.tiles.length} live</span></span>
      <button class="btn icon" data-a="wallfs" title="Full screen" aria-label="Full screen">${icon('fullscreen')}</button>`;
    this.bar.querySelector('[data-a=layout]').addEventListener('click', (e) => { e.stopPropagation(); this.menuOpen = !this.menuOpen; this.renderBar(); });
    this.bar.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => this.setDisplay({ layout: b.dataset.l }, true)));
    this.bar.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => this.setDisplay({ quality: b.dataset.q }, true)));
    this.bar.querySelector('[data-a=edit]').addEventListener('click', () => this.toggleEdit());
    this.bar.querySelector('[data-a=rotate]')?.addEventListener('click', () => { this.rotating = !this.rotating; this.rotSince = Date.now(); this.renderBar(); });
    this.bar.querySelector('[data-a=prev]')?.addEventListener('click', () => this.goPage(this.page - 1));
    this.bar.querySelector('[data-a=next]')?.addEventListener('click', () => this.goPage(this.page + 1));
    this.bar.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => this.goPage(+b.dataset.p)));
    this.bar.querySelector('[data-a=wallfs]').addEventListener('click', () => this.toggleFullscreen(this.live));
  }

  qualityFor(cell) {
    const q = this.d.quality;
    return q === 'main' ? 'main' : q === 'sub' ? 'sub' : cell.big ? 'main' : 'sub';
  }

  renderWall() {
    if (!this.wall) return;
    this.disposeTiles();
    const layout = LAYOUTS[this.d.layout], slots = layout.cells.length, cams = this.cams();
    const w = this.wall;
    w.className = 'wall' + (this.edit ? ' editing' : '');
    w.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(0, 1fr))`;
    w.style.gridTemplateRows = `repeat(${layout.rows}, minmax(0, 1fr))`;
    w.style.setProperty('--fit', this.d.fit);
    w.innerHTML = '';
    layout.cells.forEach((cell, i) => {
      const cam = cams[this.page * slots + i];
      let el;
      if (cam) {
        const t = new Tile(cam, {
          kind: this.qualityFor(cell), display: this.d, chrome: true,
          onFocus: () => this.ctx.go(`#/live/${cam.id}`),
          onUpdate: () => this.countLive(),
          onHevcFallback: () => toast('This browser could not play H.265, so HD now uses a converted H.264 stream.', 'ok', 7000),
          onKindFail: (tile, kind) => toast(`${cam.name || 'Camera'}: the ${kind === 'main' ? 'HD' : 'SD'} stream could not be started. Keeping the current stream.`, 'bad', 6000),
        });
        t.cellIndex = i;
        this.tiles.push(t);
        el = t.el;
        this.bindDrag(el, cam.id);
      } else {
        el = document.createElement('div');
        el.className = 'tile empty';
        el.textContent = 'Empty';
      }
      el.style.gridColumn = `${cell.c} / span ${cell.w}`;
      el.style.gridRow = `${cell.r} / span ${cell.h}`;
      w.append(el);
    });
    this.liveCount = 0;
  }

  countLive() {
    const n = this.tiles.filter((t) => t.state === 'live').length;
    if (n === this.liveCount) return;
    this.liveCount = n;
    const pill = this.bar?.querySelector('.livecount');
    if (pill) {
      pill.textContent = `${n}/${this.tiles.length} live`;
      pill.previousElementSibling.className = `dot ${n === this.tiles.length ? 'live' : 'wait'}`;
    }
  }

  disposeTiles() { this.tiles.forEach((t) => t.dispose()); this.tiles = []; }

  // ---------------------------------------------------------------- actions
  async setDisplay(patch, rebuild) {
    const next = { ...this.d, ...patch };
    this.menuOpen = false;
    try {
      const saved = await this.ctx.saveDisplay(next);
      Object.assign(this.s.display, saved);
    } catch (e) { toast(e.message, 'bad'); return; }
    if ('layout' in patch) this.page = 0;
    this.page = Math.min(this.page, this.pages() - 1);
    this.renderBar();
    if (rebuild) this.renderWall();
  }

  goPage(p) {
    const n = this.pages();
    this.page = ((p % n) + n) % n;
    this.rotSince = Date.now();
    this.renderBar();
    this.renderWall();
  }

  toggleEdit(force) {
    this.edit = force ?? !this.edit;
    this.wall?.classList.toggle('editing', this.edit);
    this.tiles.forEach((t) => { t.el.draggable = this.edit; });
    this.renderBar();
    if (this.edit) toast('Drag a camera onto another one to change the order.', 'ok', 3500);
  }

  rotate() {
    const sec = this.d.rotate_seconds;
    if (!sec || !this.rotating || this.edit || this.focus || this.pages() < 2 || document.hidden) return;
    if (Date.now() - this.rotSince >= sec * 1000) this.goPage(this.page + 1);
  }

  bindDrag(el, id) {
    el.draggable = this.edit;
    el.addEventListener('dragstart', (e) => { if (!this.edit) return; this.dragId = id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); this.wall.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
    el.addEventListener('dragover', (e) => { if (this.edit && this.dragId && this.dragId !== id) { e.preventDefault(); el.classList.add('over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); if (this.edit && this.dragId && this.dragId !== id) this.reorder(this.dragId, id); this.dragId = null; });
  }

  async reorder(fromId, toId) {
    const order = [...this.d.order];
    const from = order.indexOf(fromId), to = order.indexOf(toId);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    try {
      const saved = await this.ctx.saveDisplay({ ...this.d, order });
      Object.assign(this.s.display, saved);
    } catch (e) { toast(e.message, 'bad'); return; }
    this.renderWall();
    if (this.edit) this.tiles.forEach((t) => { t.el.draggable = true; });
  }

  // ---------------------------------------------------------------- focus (large view)
  route(id) {
    this.pendingFocusId = id || null;
    if (!this.wall) return;
    if (!id) { if (this.focus) this.closeFocus(); return; }
    if (this.focus?.id === id) return;
    const cam = this.cams().find((c) => c.id === id);
    if (!cam) { this.ctx.go('#/live'); return; }
    this.openFocus(cam);
  }

  openFocus(cam) {
    this.closeFocus(true);
    this.toggleEdit(false);
    this.disposeTiles();   // free the grid streams while looking at one camera
    const cams = this.cams();
    const idx = cams.findIndex((c) => c.id === cam.id);
    const kind = this.d.quality === 'sub' ? 'sub' : 'main';
    const f = document.createElement('div');
    f.className = 'focus';
    f.innerHTML = `<div class="focus-bar">
        <button class="btn" data-a="close">${icon('left')} Back</button>
        <h2>${esc(cam.name || 'Camera ' + cam.channel)}</h2><span class="pill stat"></span><span class="spacer"></span>
        <div class="seg" role="group" aria-label="Video quality"><button data-k="sub">SD</button><button data-k="main">HD</button></div>
        <button class="btn icon" data-a="snap" title="Save snapshot" aria-label="Save snapshot">${icon('camera')}</button>
        <button class="btn icon" data-a="fs" title="Full screen (F)" aria-label="Full screen">${icon('fullscreen')}</button>
        <button class="btn icon ghost" data-a="x" title="Close (Esc)" aria-label="Close">${icon('close')}</button>
      </div><div class="stage-host" style="position:relative;flex:1;min-height:0"></div>
      ${cams.length > 1 ? `<button class="nav-arrow prev" aria-label="Previous camera">${icon('left')}</button><button class="nav-arrow next" aria-label="Next camera">${icon('right')}</button>` : ''}`;
    const tile = new Tile(cam, { kind, display: this.d, chrome: false,
      onUpdate: (t) => this.paintFocus(t),
      onHevcFallback: () => toast('This browser could not play H.265, so HD now uses a converted H.264 stream.', 'ok', 7000),
      onKindFail: (t, k) => toast(`The ${k === 'main' ? 'HD' : 'SD'} stream could not be started.`, 'bad', 6000) });
    tile.el.style.cssText = 'position:absolute;inset:0;border:0;border-radius:0';
    tile.el.style.setProperty('--fit', 'contain');
    f.querySelector('.stage-host').append(tile.el);
    const hit = document.createElement('div');
    hit.className = 'hitzone';
    hit.addEventListener('dblclick', () => this.toggleFullscreen(f));   // single click does nothing: never pauses the feed
    f.querySelector('.stage-host').append(hit);
    this.live.append(f);
    this.focus = { tile, id: cam.id, el: f, idx };
    f.querySelector('[data-a=close]').addEventListener('click', () => this.ctx.go('#/live'));
    f.querySelector('[data-a=x]').addEventListener('click', () => this.ctx.go('#/live'));
    f.querySelector('[data-a=snap]').addEventListener('click', () => { if (!tile.snapshot()) toast('No picture to save yet.', 'bad'); });
    f.querySelector('[data-a=fs]').addEventListener('click', () => this.toggleFullscreen(f));
    f.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => tile.setKind(b.dataset.k)));
    f.querySelector('.prev')?.addEventListener('click', () => this.stepFocus(-1));
    f.querySelector('.next')?.addEventListener('click', () => this.stepFocus(1));
    this.paintFocus(tile);
  }

  paintFocus(tile) {
    const f = this.focus?.el;
    if (!f || this.focus.tile !== tile) return;
    f.querySelectorAll('[data-k]').forEach((b) => b.setAttribute('aria-pressed', String(tile.kind === b.dataset.k)));
    const pill = f.querySelector('.stat');
    const pending = tile.pend ? ` · loading ${tile.pend.kind === 'main' ? 'HD' : 'SD'}…` : '';
    pill.textContent = (tile.summary() || (tile.state === 'live' ? 'live' : 'connecting…')) + pending;
  }

  stepFocus(dir) {
    const cams = this.cams();
    if (cams.length < 2 || !this.focus) return;
    const i = (cams.findIndex((c) => c.id === this.focus.id) + dir + cams.length) % cams.length;
    this.ctx.go(`#/live/${cams[i].id}`);
  }

  closeFocus(silent) {
    if (!this.focus) return;
    if (document.fullscreenElement === this.focus.el) document.exitFullscreen?.();
    this.focus.tile.dispose();
    this.focus.el.remove();
    this.focus = null;
    if (!silent) {
      // return to the page that contains the camera we were just looking at
      this.renderWall();
    }
  }

  // ---------------------------------------------------------------- fullscreen & keys
  toggleFullscreen(el) {
    if (document.fullscreenElement) document.exitFullscreen();
    else el?.requestFullscreen?.().catch(() => toast('Full screen is not available here.', 'bad'));
  }
  syncFullscreen() {}

  key(e) {
    if (!this.wall || e.target?.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.getElementById('modal-root').firstChild) return;
    const k = e.key;
    if (this.focus) {
      if (k === 'Escape' && !document.fullscreenElement) this.ctx.go('#/live');
      else if (k === 'ArrowLeft') this.stepFocus(-1);
      else if (k === 'ArrowRight') this.stepFocus(1);
      else if (k === 'f' || k === 'F') this.toggleFullscreen(this.focus.el);
      else if (k === 's' || k === 'S') this.focus.tile.snapshot();
      else if (k === 'h' || k === 'H') this.focus.tile.setKind(this.focus.tile.kind === 'main' ? 'sub' : 'main');
      return;
    }
    if (k === 'Escape') { if (this.edit) this.toggleEdit(false); }
    else if (k === 'ArrowLeft') this.goPage(this.page - 1);
    else if (k === 'ArrowRight') this.goPage(this.page + 1);
    else if (k === 'e' || k === 'E') this.toggleEdit();
    else if (k === 'f' || k === 'F') this.toggleFullscreen(this.live);
    else if (/^[1-9]$/.test(k)) { const t = this.tiles[+k - 1]; if (t) this.ctx.go(`#/live/${t.cam.id}`); }
  }

  destroy() {
    this.disposeTiles();
    this.focus?.tile.dispose();
    this.focus = null;
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('fullscreenchange', this.onFs);
    document.removeEventListener('click', this.onDoc);
    clearInterval(this.rotTimer);
    if (document.fullscreenElement) document.exitFullscreen?.();
    this.root.innerHTML = '';
  }
}
