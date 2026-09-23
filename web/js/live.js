// Live view: layouts, pages, drag-to-reorder, quality selection and the large "focus" view.
import { LAYOUTS, layoutIds, layoutIcon, slotsOf } from './layouts.js';
import { Tile } from './tile.js';
import { bookmarkDialog, esc, icon, toast, openPopover } from './ui.js';
import { WCPlayer } from './wcplayer.js';
import { api } from './api.js';
import { enhancePanelHTML, wireEnhancePanel, summarizeEnhParams } from './enhancePanel.js';

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
    this.zoomMem = {};          // grid zoom per camera, kept while paging/re-laying out
    this.onKey = (e) => this.key(e);
    document.addEventListener('keydown', this.onKey);
    this.onFs = () => this.syncFullscreen();
    document.addEventListener('fullscreenchange', this.onFs);
    this.onDoc = (e) => { if (this.menuOpen && !e.target.closest('.menu-wrap')) { this.menuOpen = false; this.renderBar(); } };
    document.addEventListener('click', this.onDoc);
    this.rotTimer = setInterval(() => this.rotate(), 1000);
    this.rotSince = Date.now();
    this.evTimer = setInterval(() => this.pollEvents(), 4000);
    this.pollEvents();
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
      this.root.innerHTML = `<div class="liveview"><div class="center-card"><div class="cc-icon">${icon('plug')}</div>
        <h2>Connect your recorder</h2><p>Enter the IP address and login of your DVR or camera to see the live video.</p>
        <a class="btn primary" href="#/settings/connection">Open settings</a></div></div>`;
      return;
    }
    if (!this.cams().length) {
      this.root.innerHTML = `<div class="liveview"><div class="center-card"><div class="cc-icon">${icon('video')}</div>
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
    w.className = 'wall' + (this.edit ? ' editing' : '') + (this.d.fit === 'cover' ? ' fill' : '');
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
          zoomInit: this.zoomMem[cam.id],
          onZoom: (id, st) => { if (st.s > 1.001) this.zoomMem[id] = st; else delete this.zoomMem[id]; },
          onFocus: () => this.ctx.go(`#/live/${cam.id}`),
          onUpdate: () => this.countLive(),
          onHevcFallback: () => toast('This browser could not play H.265, so HD now uses a converted H.264 stream.', 'ok', 7000),
          onKindFail: (tile, kind) => toast(`${cam.name || 'Camera'}: the ${kind === 'main' ? 'HD' : 'SD'} stream could not be started. Keeping the current stream.`, 'bad', 6000),
          onReplay: () => this.openReplay(cam),
          onBookmark: () => this.bookmarkNow(cam),
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
    const cams = this.cams();
    const idx = cams.findIndex((c) => c.id === cam.id);
    const kind = this.d.quality === 'sub' ? 'sub' : 'main';

    // Seamless upgrade: reuse the tile already running in the grid (same player, same connection) instead
    // of disposing it and opening a fresh one — no reconnect, no black frame, and the grid's other tiles
    // (and this one, once we hand it back) keep playing behind the overlay. If the camera isn't on the
    // current page (e.g. a direct link), there's no running tile to reuse — fall back to a fresh one.
    const fromGrid = this.tiles.find((t) => t.cam.id === cam.id) || null;
    const tile = fromGrid || new Tile(cam, { kind, display: this.d, chrome: false,
      onHevcFallback: () => toast('This browser could not play H.265, so HD now uses a converted H.264 stream.', 'ok', 7000),
      onKindFail: (t, k) => toast(`The ${k === 'main' ? 'HD' : 'SD'} stream could not be started.`, 'bad', 6000) });
    tile.opts.onUpdate = (t) => this.paintFocus(t);
    // The focus bar is its own header, not the grid tile's own chrome (which is hidden while in focus —
    // see .tile.in-focus's own CSS comment), so the "filters active" pill needs its own copy kept in sync.
    tile.opts.onFxChange = (active) => { const t = this.focus?.el.querySelector('.tag.fx'); if (t) t.hidden = !active; };
    if (fromGrid) {
      tile.el.remove();               // detach from the wall; the tile/player object itself stays alive
      tile.el.classList.add('in-focus');
    }

    const f = document.createElement('div');
    f.className = 'focus';
    f.innerHTML = `<div class="focus-bar">
        <button class="btn" data-a="close">${icon('left')} Back</button>
        <h2>${esc(cam.name || 'Camera ' + cam.channel)}</h2><span class="tag fx" ${summarizeEnhParams(tile.enhParams).active ? '' : 'hidden'} title="Live filters active">${icon('wand')}</span><span class="pill stat"></span><span class="spacer"></span>
        <div class="seg" role="group" aria-label="Video quality"><button data-k="sub">SD</button><button data-k="main">HD</button></div>
        <div class="zoomctl" role="group" aria-label="Zoom"><button class="btn icon" data-a="zout" title="Zoom out (-)" aria-label="Zoom out">${icon('minus')}</button>
          <button class="btn pct" data-a="zreset" title="Reset zoom (0)">100%</button><button class="btn icon" data-a="zin" title="Zoom in (+)" aria-label="Zoom in">${icon('plus')}</button></div>
        <button class="btn icon" data-a="snap" title="Save snapshot" aria-label="Save snapshot">${icon('camera')}</button>
        <button class="btn icon" data-a="replay" title="Instant replay (last 10s)" aria-label="Instant replay">${icon('rewind')}</button>
        <button class="btn icon" data-a="bookmark" title="Bookmark this moment" aria-label="Bookmark this moment">${icon('flag')}</button>
        <div class="menu-wrap enh-wrap"><button class="btn icon" data-a="enhance" title="Live enhancement" aria-label="Live enhancement" aria-haspopup="true">${icon('wand')}</button></div>
        <button class="btn icon" data-a="fs" title="Full screen (F)" aria-label="Full screen">${icon('fullscreen')}</button>
        <button class="btn icon ghost" data-a="x" title="Close (Esc)" aria-label="Close">${icon('close')}</button>
      </div><div class="stage-host" style="position:relative;flex:1;min-height:0"></div>
      ${cams.length > 1 ? `<button class="nav-arrow prev" aria-label="Previous camera">${icon('left')}</button><button class="nav-arrow next" aria-label="Next camera">${icon('right')}</button>` : ''}`;
    tile.el.style.cssText = 'position:absolute;inset:0;border:0;border-radius:0';
    f.querySelector('.stage-host').append(tile.el);
    const hit = document.createElement('div');
    hit.className = 'hitzone';
    f.querySelector('.stage-host').append(hit);
    tile.enableZoom(hit, { dbl: true });   // single click does nothing (never pauses); double click/tap toggles zoom
    this.live.append(f);
    this.focus = { tile, id: cam.id, el: f, idx, fromGrid: !!fromGrid };
    f.querySelector('[data-a=close]').addEventListener('click', () => this.ctx.go('#/live'));
    f.querySelector('[data-a=x]').addEventListener('click', () => this.ctx.go('#/live'));
    f.querySelector('[data-a=snap]').addEventListener('click', () => { if (!tile.snapshot()) toast('No picture to save yet.', 'bad'); });
    f.querySelector('[data-a=replay]').addEventListener('click', () => this.openReplay(cam));
    f.querySelector('[data-a=bookmark]').addEventListener('click', () => this.bookmarkNow(cam));
    f.querySelector('[data-a=fs]').addEventListener('click', () => this.toggleFullscreen(f));
    f.querySelector('[data-a=enhance]').addEventListener('click', () => this._toggleFocusEnhanceMenu(tile));
    f.querySelector('[data-a=zin]').addEventListener('click', () => tile.zoom.zoomBy(1.6));
    f.querySelector('[data-a=zout]').addEventListener('click', () => tile.zoom.zoomBy(1 / 1.6));
    f.querySelector('[data-a=zreset]').addEventListener('click', () => tile.zoom.reset());
    f.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => tile.setKind(b.dataset.k)));
    f.querySelector('.prev')?.addEventListener('click', () => this.stepFocus(-1));
    f.querySelector('.next')?.addEventListener('click', () => this.stepFocus(1));
    if (tile.kind !== kind) tile.setKind(kind);   // upgrade in place (gapless swap already built into Tile)
    this.paintFocus(tile);
  }

  paintFocus(tile) {
    const f = this.focus?.el;
    if (!f || this.focus.tile !== tile) return;
    f.querySelectorAll('[data-k]').forEach((b) => b.setAttribute('aria-pressed', String(tile.kind === b.dataset.k)));
    const z = tile.zoom;
    if (z) {
      f.querySelector('.pct').textContent = `${z.percent}%`;
      f.querySelector('[data-a=zin]').disabled = z.atMax;
      f.querySelector('[data-a=zout]').disabled = !z.zoomed;
      f.querySelector('[data-a=zreset]').disabled = !z.zoomed;
    }
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
    const { tile, fromGrid } = this.focus;
    if (fromGrid && this.tiles.includes(tile)) {
      // hand the still-running tile back to its grid cell — no reconnect, no black frame
      tile.zoom?.reset(false);
      tile.el.classList.remove('in-focus');
      tile.el.style.cssText = '';
      tile.opts.onUpdate = () => this.countLive();
      tile.enableZoom(tile.el.querySelector('.hit'), { dbl: false });   // back to grid rules: click opens focus, no dbl-click zoom
      const cell = LAYOUTS[this.d.layout].cells[tile.cellIndex];
      if (cell) { tile.el.style.gridColumn = `${cell.c} / span ${cell.w}`; tile.el.style.gridRow = `${cell.r} / span ${cell.h}`; }
      const wantKind = this.qualityFor(cell || {});
      if (tile.kind !== wantKind) tile.setKind(wantKind);
      this.wall.append(tile.el);
    } else {
      tile.dispose();
    }
    this.focus.el.remove();
    this.focus = null;
    if (!silent && !fromGrid) this.renderWall();   // the borrowed-tile case needs no rebuild — everything else kept running
  }

  // ---------------------------------------------------------------- live event badges
  // Polls the same unified event index the timeline/playback UI reads (fed live by the DVR's
  // alertStream subscriber — see app/events.py AlertStreamSubscriber) for anything active or that
  // just ended, and paints small badges onto each grid tile for its channel.
  async pollEvents() {
    try {
      const since = new Date(Date.now() - 20000).toISOString();
      const r = await fetch(`/api/timeline/events?start_utc=${encodeURIComponent(since)}&limit=200`);
      if (!r.ok) return;
      const rows = await r.json();
      const byChannel = new Map();
      for (const row of rows) {
        if (!byChannel.has(row.channel)) byChannel.set(row.channel, new Set());
        byChannel.get(row.channel).add(row.kind);
      }
      for (const t of this.tiles) t.setBadges(byChannel.get(t.cam.channel));
    } catch { /* transient network hiccup — next poll retries */ }
  }

  // ---------------------------------------------------------------- bookmarks (spec section 9/11.6)
  async bookmarkNow(cam) {
    const r = await bookmarkDialog({ subtitle: `${cam.name || 'Camera ' + cam.channel} · right now` });
    if (!r) return;
    try {
      await api.createBookmark({ channels: [cam.id], time_utc: new Date().toISOString(), ...r });
      toast('Bookmark saved.', 'ok');
    } catch (e) {
      toast(e.message || 'Could not save the bookmark', 'bad');
    }
  }

  // ---------------------------------------------------------------- L0 live enhancement (focus bar)
  // The focus view's control bar lives outside the Tile's own element (unlike the grid tile's built-in
  // popover), so it gets its own small menu here rather than reusing Tile._toggleEnhanceMenu — both just
  // end up driving the same tile.enhParams. This is also what fullscreen shows (wall fullscreen keeps the
  // grid's own per-tile hover controls; opening a tile in focus — including fullscreen focus — used to have
  // no enhancement control at all, found by checking, not assumed working from the grid case.
  _toggleFocusEnhanceMenu(tile) {
    const btn = this.focus?.el.querySelector('[data-a=enhance]');
    if (!btn) return;
    const menu = openPopover(btn, enhancePanelHTML({}), { className: 'enh-menu enh2-panel' });
    if (!menu) return;
    wireEnhancePanel(menu, {
      getParams: () => tile.enhParams,
      onPreset: (name) => tile.applyEnhancePreset(name),
      onParam: (key, value) => tile.applyEnhParam(key, value),
    });
  }

  // ---------------------------------------------------------------- instant replay
  // A dedicated small overlay that opens a real playback session (WCPlayer over /api/playback/ws)
  // starting ~10s in the past and playing forward at 1x, rather than a client-side ring buffer — this
  // reuses the already-verified DVR playback path instead of new plumbing. Counts against the DVR's
  // 4-session playback cap like any other playback stream; released the moment it's closed.
  openReplay(cam, seconds = 10) {
    this.closeReplay();
    const r = document.createElement('div');
    r.className = 'replay-overlay';
    r.innerHTML = `<div class="replay-bar">
        ${icon('rewind')} <span>Instant replay · ${esc(cam.name || 'Camera ' + cam.channel)}</span>
        <span class="pill stat">starting…</span><span class="spacer"></span>
        <button class="btn primary" data-a="live">${icon('play')} Back to live</button>
        <button class="btn icon ghost" data-a="x" title="Close (Esc)" aria-label="Close">${icon('close')}</button>
      </div><div class="replay-stage"><canvas></canvas></div>`;
    this.live.append(r);
    const canvas = r.querySelector('canvas');
    const pill = r.querySelector('.stat');
    const player = new WCPlayer(canvas, {
      onState: (s) => { pill.textContent = s === 'playing' ? 'replaying' : s === 'queued' ? 'waiting for a recorder session…' : s; },
      onError: (msg) => { pill.textContent = 'error'; toast(`Instant replay: ${msg}`, 'bad', 6000); },
    });
    if (!player.supported) { toast('This browser does not support instant replay (WebCodecs unavailable).', 'bad'); r.remove(); return; }
    const startIso = new Date(Date.now() - seconds * 1000).toISOString();
    player.connect(cam.id, startIso, '1');
    this.replay = { el: r, player, cam };
    r.querySelector('[data-a=live]').addEventListener('click', () => this.closeReplay());
    r.querySelector('[data-a=x]').addEventListener('click', () => this.closeReplay());
  }

  closeReplay() {
    if (!this.replay) return;
    this.replay.player.destroy();
    this.replay.el.remove();
    this.replay = null;
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
    if (this.replay) { if (k === 'Escape') this.closeReplay(); return; }
    if (this.focus) {
      if (k === 'Escape' && !document.fullscreenElement) { if (this.focus.tile.zoom?.zoomed) this.focus.tile.zoom.reset(); else this.ctx.go('#/live'); }
      else if (k === '+' || k === '=') this.focus.tile.zoom?.zoomBy(1.6);
      else if (k === '-' || k === '_') this.focus.tile.zoom?.zoomBy(1 / 1.6);
      else if (k === '0') this.focus.tile.zoom?.reset();
      else if (k === 'ArrowLeft') this.stepFocus(-1);
      else if (k === 'ArrowRight') this.stepFocus(1);
      else if (k === 'f' || k === 'F') this.toggleFullscreen(this.focus.el);
      else if (k === 's' || k === 'S') this.focus.tile.snapshot();
      else if (k === 'h' || k === 'H') this.focus.tile.setKind(this.focus.tile.kind === 'main' ? 'sub' : 'main');
      else if (k === 'b' || k === 'B') this.bookmarkNow(this.focus.tile.cam);
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
    this.closeReplay();
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('fullscreenchange', this.onFs);
    document.removeEventListener('click', this.onDoc);
    clearInterval(this.rotTimer);
    clearInterval(this.evTimer);
    if (document.fullscreenElement) document.exitFullscreen?.();
    this.root.innerHTML = '';
  }
}
