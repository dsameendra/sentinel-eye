// Live view: layouts, pages, drag-to-reorder, quality selection and the large "focus" view.
import { LAYOUTS, layoutIds, layoutIcon, slotsOf } from './layouts.js';
import { Tile } from './tile.js';
import { bookmarkDialog, closePopover, esc, icon, notify, toast, openPopover, shortcutsDialog } from './ui.js';
import { barHTML, globalActionsHTML, markBell, wireGlobal } from './bar.js';
import { onboardingDialog } from './onboarding.js';
import { WCPlayer, unsupportedReason } from './wcplayer.js';
import { api, getJSON } from './api.js';
import { enhancePanelHTML, wireEnhancePanel, summarizeEnhParams } from './enhancePanel.js';

// The recorder's channel-zero overview stream (Settings > Connection) — a synthetic "camera" that isn't a
// real entry in settings.channels (mirrors app/settings.py's channel_zero_channel), so it never touches
// Arrange order, the Channels tab, or channel counts anywhere else. `channel` is a harmless placeholder,
// same reasoning as the backend's: tile.js/player.js build the go2rtc stream name from `id` alone
// ("chan0_sub"/"chan0_main"), never from `channel`.
const CHAN0_ID = 'chan0';
// aspect: '16:9', not 'auto' — the recorder encodes this at 704x576 (D1/4CIF, confirmed directly), which
// is non-square-pixel content meant for 16:9 display, same as a real camera's SD sub-stream. tile.js's
// `_shape()` auto-detection only catches THAT case by its known 2:1-squeeze ratio (e.g. 960x480); 704x576
// is ~1.22:1, nowhere near 2:1, so 'auto' was rendering it at its raw, unsquashed pixel ratio — squarer
// than even 4:3, which is exactly the "weird aspect ratio" reported. Forcing it sidesteps the heuristic
// entirely, the same escape hatch a real camera's own Aspect setting (Channels tab) already offers.
const CHAN0_CAM = { id: CHAN0_ID, channel: 0, name: 'Channel 0', enabled: true, aspect: '16:9' };
const isChan0 = (cam) => cam?.id === CHAN0_ID;

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
    this.pendingFocusId = null;
    this.zoomMem = {};          // grid zoom per camera, kept while paging/re-laying out
    this.fitOverride = null;   // null = follow Settings > Display > Fit; 'contain'/'cover' = this-session-only override, never saved (see fitMode())
    // Read once at construction (Settings tears down and rebuilds LiveView on any route change — see
    // main.js route() — so a fresh read here already picks up a toggle flipped from within Settings).
    this.tvMode = !!ctx.tvMode?.();
    this.tvQualityPref = ctx.tvQuality?.() || 'sub';
    this.tvLayoutPref = ctx.tvLayout?.() || '1x1';
    this.tvIndex = 0;   // currently-selected tile in TV mode's own arrow-key grid navigation
    // Overview mode: channel-zero shown full-screen, replacing the grid entirely — one on/off state (redesign
    // v2; was two separate toggles, "add it to the grid" and "view it alone"). Local to this device
    // (localStorage), off by default everywhere except TV mode, which always starts there when the recorder
    // offers it (see chan0Displayed): a phone or laptop shouldn't jump into Overview because someone turned
    // it on for the TV in the other room.
    this.overviewOn = (this.tvMode && this.channelZeroOn) || !!ctx.overviewOn?.();
    // Set once by Settings right before ctx.go('#/live') (see settings.js's TV-mode confirm flow) —
    // consumed here so a plain reload/return to Live never re-triggers an unrequested full-screen jump.
    this._autoFs = !!ctx.consumeTvFullscreen?.();
    this.onKey = (e) => this.key(e);
    document.addEventListener('keydown', this.onKey);
    this.onTvEdge = (e) => this._tvEdge(e);
    document.addEventListener('tvnav-edge', this.onTvEdge);
    this.onVis = () => { if (!document.hidden && this.tvMode) this._tvWakeLock(); };
    document.addEventListener('visibilitychange', this.onVis);
    this.onFs = () => this.syncFullscreen();
    document.addEventListener('fullscreenchange', this.onFs);
    this.rotTimer = setInterval(() => this.rotate(), 1000);
    this.rotSince = Date.now();
    this.evTimer = setInterval(() => this.pollEvents(), 4000);
    this.pollEvents();
    this.build();
  }

  get s() { return this.ctx.settings(); }
  get d() { return this.s.display; }
  get channelZeroOn() { return !!this.s.connection.channel_zero; }   // the recorder actually offers it (Settings > Connection)
  // ...and this device is showing it. TV mode starts in Overview (constructor) but its toggle still works —
  // it used to force Overview whenever TV mode was on, leaving the TV's Grid button doing nothing.
  get chan0Displayed() { return this.channelZeroOn && this.overviewOn; }
  fitMode() { return this.fitOverride || this.d.fit; }
  toggleFit() {
    this.fitOverride = this.fitMode() === 'cover' ? 'contain' : 'cover';
    // Just the class — NOT renderWall(), which starts from disposeTiles() and would tear down and
    // reconnect every single camera stream (found directly: every tile went back to "Connecting…") for
    // what should be a purely cosmetic, instant change. Live view's tiles don't need touching at all here.
    this.wall?.classList.toggle('fill', this.fitMode() === 'cover');
    this.renderBar();
    this.focus?.el.classList.toggle('fill', this.fitMode() === 'cover'); // focus is a separate overlay, not inside .wall — kept in sync here too
  }
  cams() {
    // Channel-zero is never one of these (redesign v2) — Overview mode replaces the grid outright
    // (renderWall/_renderChan0SingleView), it doesn't add a tile to it.
    const by = Object.fromEntries(this.s.channels.filter((c) => c.enabled).map((c) => [c.id, c]));
    return this.d.order.map((id) => by[id]).filter(Boolean);
  }
  slots() { return slotsOf(this.effLayout()); }
  pages() { return Math.max(1, Math.ceil(this.cams().length / this.slots())); }

  // ---------------------------------------------------------------- structure
  build() {
    this.disposeTiles();
    const s = this.s;
    // Empty states keep the bar (so Settings/Playback/your account stay one click away) and use the States
    // board's designed treatment rather than a bare card.
    const emptyState = (iconName, title, body, actionsHtml) => {
      this.root.innerHTML = `<main class="liveview"><div class="live-bar"></div><div class="state-card"><div class="state-ico">${icon(iconName)}</div>
        <h2>${title}</h2><p>${body}</p>${actionsHtml}</div></main>`;
      this.live = this.root.querySelector('.liveview');
      this.bar = this.root.querySelector('.live-bar');
      this.wall = null;
      this.renderBar();
    };
    if (!s.connection.host && !s.connection.configured) {   // configured: the redacted form non-admins get
      if (this.ctx.can('admin')) {
        emptyState('briefcase', 'No cameras yet', "Add your recorder's address to start watching.",
          '<div class="state-actions"><button class="btn primary" data-a="setup">Add recorder</button><a class="btn ghost" href="#/settings/connection">Open settings</a></div>');
        this.root.querySelector('[data-a=setup]').addEventListener('click', () => onboardingDialog(this.ctx));
      } else {
        emptyState('briefcase', 'No recorder yet', 'An admin needs to connect the recorder before the cameras show up here.', '');
      }
      return;
    }
    if (!this.cams().length && !this.chan0Displayed) {
      emptyState('video', 'No cameras yet', 'Add or enable channels to start watching.',
        this.ctx.can('admin') ? '<div class="state-actions"><a class="btn primary" href="#/settings/channels">Manage channels</a></div>' : '');
      return;
    }
    this.root.innerHTML = `<main class="liveview"><div class="live-bar"></div><div class="wall"></div><div class="pager-row" hidden></div>
      <p class="live-hint">Long-press any tile for quick actions</p>
      <div class="tv-fs-controls">
        <button class="tv-fs-btn" data-a="pgprev" title="Previous page" aria-label="Previous page">${icon('left')}</button>
        <span class="tv-fs-page"></span>
        <button class="tv-fs-btn" data-a="pgnext" title="Next page" aria-label="Next page">${icon('right')}</button>
        <button class="tv-fs-btn" data-a="wallfs" title="Exit full screen (F)" aria-label="Exit full screen">${icon('fullscreen')}</button>
      </div>${this.tvMode ? '<div class="tv-hints" aria-hidden="true"></div>' : ''}</main>`;
    this.live = this.root.querySelector('.liveview');
    this.bar = this.root.querySelector('.live-bar');
    this.wall = this.root.querySelector('.wall');
    this.pager = this.root.querySelector('.pager-row');
    this.wall.addEventListener('focusin', (e) => this._tvFocusIn(e));
    this.live.querySelector('.tv-fs-controls [data-a=wallfs]').addEventListener('click', () => this.toggleFullscreen(this.live));
    this.live.querySelector('[data-a=pgprev]').addEventListener('click', () => this.goPage(this.page - 1));
    this.live.querySelector('[data-a=pgnext]').addEventListener('click', () => this.goPage(this.page + 1));
    this._bindWallFsAutoHide();
    if (this.tvMode) {
      this.live.addEventListener('mousemove', () => this._tvWake());
      this._tvWake();
      this._tvWakeLock();
    }
    this.page = Math.min(this.page, this.pages() - 1);
    this.renderBar();
    this.renderWall();
    if (this.tvMode) this._tvDefaultFocus();
    if (this.pendingFocusId) this.route(this.pendingFocusId);
  }

  // TV mode + full screen on the grid itself (not a single camera's own focus view, which already has
  // _bindFocusAutoHide): the subbar disappears entirely (CSS, gated to html.tv-mode .liveview:fullscreen)
  // so the wall of cameras is the only thing on screen, and this floating cluster — page prev/next (when
  // there's more than one page), a page indicator, and exit — is what's left to control it. Hidden until
  // you move the mouse or touch the screen, same idle cycle as _bindFocusAutoHide. A no-op everywhere else:
  // outside that exact fullscreen+TV-mode state the cluster stays display:none regardless of .show.
  // The same idle state also drives .show on `this.live` itself (not `this.wall` — renderWall()/renderBar()
  // reset .wall's and .subbar's own className on every layout/page/quality change, which would wipe a class
  // living there; .liveview's own className is set once in build() and never touched again), which the CSS
  // uses to hide every tile's name/SD-HD tag/tile-actions menu too — true full screen, not just no subbar.
  _bindWallFsAutoHide() {
    const el = this.live.querySelector('.tv-fs-controls');
    let hideTimer;
    const hide = () => { el.classList.remove('show'); this.live.classList.remove('show'); };
    // Exposed on the instance (not just closed over) so syncFullscreen() can call it directly the moment
    // fullscreen actually starts — see that method's own comment for why that matters, not just this bind
    // call's own initial show() a few lines down.
    this._fsShow = () => {
      el.classList.add('show');
      this.live.classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 2600);
    };
    const show = this._fsShow;
    this.live.addEventListener('mousemove', show);
    this.live.addEventListener('mouseenter', show);
    this.live.addEventListener('touchstart', show, { passive: true });
    show();
  }

  /** Keeps the floating fullscreen page controls in sync with the real pager — called from renderBar(),
   * which already recomputes pages()/this.page on every layout, camera, or page change. */
  _syncFsControls() {
    const el = this.live?.querySelector('.tv-fs-controls');
    if (!el) return;
    const single = this.chan0Displayed;
    const pages = this.pages(), multi = !single && pages > 1;
    el.querySelector('[data-a=pgprev]').hidden = !multi;
    el.querySelector('[data-a=pgnext]').hidden = !multi;
    // hidden, not just emptied — a single-page view (or channel-zero's own single view) has nothing here,
    // and a childless span still keeps its own padding (.tv-fs-page), which read as a stray blank patch
    // next to the exit button — the reported "weird shape" once prev/next have nothing to flank.
    const pageEl = el.querySelector('.tv-fs-page');
    pageEl.hidden = !multi;
    pageEl.textContent = multi ? `${this.page + 1}/${pages}` : '';
  }

  renderBar() {
    if (!this.bar) return;
    if (this.tvMode) { this._renderTvBar(); return; }
    const layout = this.effLayout();
    // Channel-zero's Overview mode replaces the grid outright (its own stream, filling the wall), so the
    // layout picker gives way to the single Overview/Grid toggle — matching the Live board, where the layout
    // button only exists in grid mode.
    const single = this.chan0Displayed;
    const context = `
      ${this.channelZeroOn ? `<button class="btn ghost view-toggle" data-a="overview" aria-pressed="${single}" title="${single ? 'Switch back to the camera grid' : "Show the recorder's own Channel 0 overview, full screen"}">${icon(single ? 'grid4' : 'overview')}<span>${single ? 'Grid · all cameras' : 'Overview'}</span></button>` : ''}
      ${single || !this.wall ? '' : `<button class="btn ghost lay-btn" data-a="layout" aria-haspopup="true" title="Layout and view options">${layoutIcon(layout, 18)}<span>${LAYOUTS[layout].label}</span>${icon('down')}</button>`}
      ${this.edit ? '<button class="btn primary sm" data-a="edit-done" title="Finish arranging (E or Esc)">Done</button>' : ''}`;
    const actions = `${this.wall ? `<button class="btn icon ghost" data-a="wallfs" title="Full screen (F)" aria-label="Full screen">${icon('fullscreen')}</button><span class="bar-sep"></span>` : ''}${globalActionsHTML(this.ctx)}`;
    this.bar.innerHTML = barHTML({ lead: 'brand', title: 'Live', after: this.wall ? this._healthHTML() : '', context, actions, cls: 'live' });
    wireGlobal(this.bar, this.ctx);
    this.bar.querySelector('[data-a=layout]')?.addEventListener('click', (e) => this._openViewMenu(e.currentTarget));
    this.bar.querySelector('[data-a=edit-done]')?.addEventListener('click', () => this.toggleEdit(false));
    this.bar.querySelector('[data-a=overview]')?.addEventListener('click', () => {
      this.overviewOn = !this.overviewOn;
      this.ctx.setOverviewOn?.(this.overviewOn);
      if (!this.wall) { this.build(); return; }
      this.renderBar(); this.renderWall();
    });
    this.bar.querySelector('[data-a=wallfs]')?.addEventListener('click', () => this.toggleFullscreen(this.live));
    if (this._lastEventRows) markBell(this.bar, this._lastEventRows);
    this._renderPager();
    this._syncFsControls();
  }

  /** TV mode's header (TV Mode board): the mark and name, a clock with the camera count, and only the
   * controls a remote needs — Overview/Grid, layout, Settings — big enough to land on. */
  _renderTvBar() {
    const single = this.chan0Displayed;
    const layout = this.effLayout();
    const fs = !!document.fullscreenElement;
    const actions = `<span class="tv-clock"></span>
      ${this.channelZeroOn ? `<button class="btn ghost tv-btn view-toggle" data-a="overview" aria-pressed="${single}">${icon(single ? 'grid4' : 'overview')}<span>${single ? 'Camera grid' : 'Overview'}</span></button>` : ''}
      ${single || !this.wall ? '' : `<button class="btn ghost tv-btn lay-btn" data-a="layout" aria-haspopup="true">${layoutIcon(layout, 18)}<span>${LAYOUTS[layout].label}</span></button>`}
      <button class="btn ghost tv-btn" data-a="tvfs">${icon(fs ? 'collapse' : 'expand')}<span>${fs ? 'Exit full screen' : 'Full screen'}</span></button>
      <a class="btn icon ghost tv-btn" href="#/settings" title="Settings" aria-label="Settings">${icon('gear')}</a>`;
    this.bar.innerHTML = barHTML({ lead: 'brand', title: 'Sentinel Eye', actions, cls: 'live tv' });
    this.bar.querySelector('[data-a=layout]')?.addEventListener('click', (e) => this._openViewMenu(e.currentTarget));
    this.bar.querySelector('[data-a=overview]')?.addEventListener('click', () => this._setOverview(!this.chan0Displayed));
    this.bar.querySelector('[data-a=tvfs]').addEventListener('click', () => this.toggleFullscreen(this.live));
    const clock = this.bar.querySelector('.tv-clock');
    const tick = () => {
      const d = new Date();
      const day = d.toLocaleDateString(undefined, { weekday: 'short' });
      const n = this.cams().length, pages = this.chan0Displayed ? 1 : this.pages();
      clock.textContent = `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${n} camera${n === 1 ? '' : 's'}${pages > 1 ? ` · page ${this.page + 1} of ${pages}` : ''}`;
    };
    tick();
    clearInterval(this.clockTimer);
    this.clockTimer = setInterval(tick, 15000);
    // What the remote does right now, in this mode.
    const hints = this.live?.querySelector('.tv-hints');
    if (hints) {
      const h = (glyph, text) => `<span><i>${glyph}</i>${text}</span>`;
      const pp = '<b class="pp">▶︎❚❚</b>';
      hints.innerHTML = single
        ? `${h(pp, 'Camera grid')}${h(icon('dpad'), 'Controls')}`
        : `${h(icon('dpad'), this.pages() > 1 ? 'Move · past the edge turns the page' : 'Move')}${h('OK', 'Open a camera')}${this.channelZeroOn ? h('Back', 'Overview') : ''}`;
    }
    this._renderPager();
    this._syncFsControls();
    this._tvDefaultFocus();
  }




  /** The bar's quiet health indicator (States board: "lives permanently in the top bar's corner — never
   * hidden, never alarming at rest"): a plain camera count when everything's streaming, a dot + live/total
   * only when something isn't. */
  _healthHTML() {
    const total = this.tiles.length, n = this.liveCount ?? 0;
    const all = total > 0 && n === total;
    // States board's three: connected, reconnecting, unreachable. "Unreachable" only once nothing has
    // come up for a while, so a normal cold start reads as connecting, not as an alarm.
    const down = total > 0 && n === 0 && Date.now() - (this.wallSince || 0) > 20000 && this.tiles.every((t) => t.state !== 'live');
    const label = all ? `${total} camera${total === 1 ? '' : 's'}<span class="all-note"> · all connected</span>` : down ? 'Recorder unreachable' : total && n ? `${n}/${total} live` : 'Connecting…';
    const tip = all ? 'Every camera on this page is streaming' : down ? "No camera has connected — check the recorder's power and network" : 'Some cameras are still connecting or reconnecting';
    return `<span class="pill health${all ? '' : ' degraded'}${down ? ' down' : ''}" title="${tip}"><span class="dot ${down ? 'off' : 'wait'}"${all ? ' hidden' : ''}></span><span class="livecount">${label}</span></span>`;
  }

  /** Page control under the wall (the Live board's 1×1 pager: ‹ 1 / 8 ›), only when there's more than one page. */
  _renderPager() {
    if (!this.pager) return;
    const pages = this.pages();
    const show = !this.chan0Displayed && pages > 1;
    this.pager.hidden = !show;
    if (!show) { this.pager.innerHTML = ''; return; }
    const d = this.d;
    this.pager.innerHTML = `<button class="btn icon glass-btn" data-a="prev" aria-label="Previous page">${icon('left')}</button>
      <span class="pager-n">${this.page + 1} / ${pages}</span>
      <button class="btn icon glass-btn" data-a="next" aria-label="Next page">${icon('right')}</button>
      ${d.rotate_seconds > 0 ? `<button class="btn icon ghost pager-rot" data-a="rotate" aria-pressed="${this.rotating}" title="${this.rotating ? `Auto-rotating every ${d.rotate_seconds}s — click to pause` : 'Auto-rotate paused — click to resume'}" aria-label="Auto-rotate pages">${icon(this.rotating ? 'pause' : 'play')}</button>` : ''}`;
    this.pager.querySelector('[data-a=prev]').addEventListener('click', () => this.goPage(this.page - 1));
    this.pager.querySelector('[data-a=next]').addEventListener('click', () => this.goPage(this.page + 1));
    this.pager.querySelector('[data-a=rotate]')?.addEventListener('click', () => { this.rotating = !this.rotating; this.rotSince = Date.now(); this._renderPager(); });
  }

  /** Layout + view options in one popover (the Live board's layout menu, plus the controls the old second
   * bar carried — quality, fit/fill, arrange — so nothing is lost by folding the bars into one). */
  _openViewMenu(btn) {
    const layout = this.effLayout(), q = this.effQuality(), fill = this.fitMode() === 'cover';
    const menu = openPopover(btn, `<div class="view-menu">
      <div class="pop-label">Layout</div>
      <div class="lay">${layoutIds.map((id) => `<button data-l="${id}" aria-pressed="${layout === id}">${layoutIcon(id, 36)}<span>${LAYOUTS[id].label}</span></button>`).join('')}</div>
      <div class="pop-sep"></div>
      <div class="pop-row"><span>Quality</span><div class="seg" role="group" aria-label="Video quality">
        <button data-q="auto" aria-pressed="${q === 'auto'}" title="HD for large tiles and the large view, SD for small tiles">Auto</button><button data-q="sub" aria-pressed="${q === 'sub'}" title="Always the lighter sub-stream">SD</button><button data-q="main" aria-pressed="${q === 'main'}" title="Always the full-quality main stream">HD</button></div></div>
      <div class="pop-row"><span>Picture</span><div class="seg" role="group" aria-label="Fit or fill">
        <button data-f="contain" aria-pressed="${!fill}" title="Letterbox — never crops">Fit</button><button data-f="cover" aria-pressed="${fill}" title="Fill the tile — crops the edges. This session only.">Fill</button></div></div>
      <button class="pop-item" data-a="edit">${icon('move')}<span>Arrange cameras</span><kbd>E</kbd></button>
    </div>`, { className: 'view-pop', align: 'left' });
    if (!menu) return;
    menu.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => {
      closePopover();
      // TV mode: local preference (see effLayout()), not the setting every other device shares.
      if (this.tvMode) { this.tvLayoutPref = b.dataset.l; this.ctx.setTvLayout?.(b.dataset.l); this.page = 0; this.renderBar(); this.renderWall(); }
      else this.setDisplay({ layout: b.dataset.l }, true);
    }));
    menu.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      menu.querySelectorAll('[data-q]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      // TV mode: writes the local TV-only preference (see effQuality()) instead of the shared setting.
      if (this.tvMode) { this.tvQualityPref = b.dataset.q; this.ctx.setTvQuality?.(b.dataset.q); this.renderWall(); }
      else this.setDisplay({ quality: b.dataset.q }, true, true);
    }));
    menu.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
      if ((this.fitMode() === 'cover') !== (b.dataset.f === 'cover')) this.toggleFit();
      menu.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    menu.querySelector('[data-a=edit]').addEventListener('click', () => { closePopover(); this.toggleEdit(true); });
  }

  // TV mode's own Auto/SD/HD choice in place of the synced Settings one (see main.js's tvQuality) — same
  // "auto" rule either way (HD only for the one big/large tile, SD for the rest), just pointed at whichever
  // preference is active. Defaults to SD (a full wall of simultaneous HD decodes is what was actually
  // lagging on the Tizen browser this was built for) but a TV browser with room for it can switch to HD
  // from the same quality control every other client uses.
  effQuality() { return this.tvMode ? this.tvQualityPref : this.d.quality; }
  // Same reasoning, for memory instead of bandwidth: TV mode's own grid layout defaults to 1x1 (main.js's
  // tvLayout) rather than whatever the synced Settings > Display layout is — a full wall of tiles is a real
  // crash risk on a TV's limited RAM, not just a lag one. A layout picked from the TV itself overrides that
  // default from then on, remembered per-browser; it never writes back to the setting every other device shares.
  effLayout() { return this.tvMode ? this.tvLayoutPref : this.d.layout; }
  qualityFor(cell, cam) {
    // Channel-zero has exactly one real stream (confirmed directly: the recorder 400s a request for a
    // second one) — chan0_main in go2rtc is only ever an alias of the same source, not a sharper picture,
    // so requesting anything but 'sub' for it would just make the SD/HD badge lie about what's on screen.
    if (isChan0(cam)) return 'sub';
    const q = this.effQuality();
    return q === 'main' ? 'main' : q === 'sub' ? 'sub' : cell.big ? 'main' : 'sub';
  }

  renderWall() {
    if (!this.wall) return;
    if (this.chan0Displayed) { this._renderChan0SingleView(); return; }
    this.disposeTiles();
    const layout = LAYOUTS[this.effLayout()], slots = layout.cells.length, cams = this.cams();
    const w = this.wall;
    w.className = 'wall' + (this.edit ? ' editing' : '') + (this.fitMode() === 'cover' ? ' fill' : '');
    w.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(0, 1fr))`;
    w.style.gridTemplateRows = `repeat(${layout.rows}, minmax(0, 1fr))`;
    w.style.setProperty('--fit', this.d.fit);
    w.innerHTML = '';
    layout.cells.forEach((cell, i) => {
      const cam = cams[this.page * slots + i];
      let el;
      if (cam) {
        // Channel-zero isn't a real DVR channel with its own recording/event timeline, so instant replay
        // (keyed to a real channel number server-side) doesn't apply to it — the button's hidden outright
        // (tile.js's noReplay), not just wired up to fail. Bookmarking it instead applies to every real
        // camera at once (bookmarkAllCams) — the closest honest equivalent to "this moment," since
        // channel-zero itself has no timeline of its own to find a bookmark on later.
        const chan0 = isChan0(cam);
        const t = new Tile(cam, {
          kind: this.qualityFor(cell, cam), display: this.d, chrome: true, tv: this.tvMode,
          noReplay: chan0, fixedQuality: chan0, bookmarkLabel: chan0 ? 'Bookmark this moment on every camera' : undefined,
          zoomInit: this.zoomMem[cam.id],
          onZoom: (id, st) => { if (st.s > 1.001) this.zoomMem[id] = st; else delete this.zoomMem[id]; },
          onFocus: () => this.ctx.go(`#/live/${cam.id}`),
          onUpdate: () => this.countLive(),
          onHevcFallback: () => toast('This browser could not play H.265, so HD now uses a converted H.264 stream.', 'ok', 7000),
          onKindFail: (tile, kind) => toast(`${cam.name || 'Camera'}: the ${kind === 'main' ? 'HD' : 'SD'} stream could not be started. Keeping the current stream.`, 'bad', 6000),
          onReplay: chan0 ? null : () => this.openReplay(cam),
          onBookmark: chan0 ? () => this.bookmarkAllCams() : () => this.bookmarkNow(cam),
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
    this.liveCount = 0; this.wallSince = Date.now();
    if (this.tvMode) {
      this.tvIndex = Math.max(0, Math.min(this.tiles.length - 1, this.tvIndex));
      this.tiles[this.tvIndex]?.el.querySelector('.hit')?.focus({ preventScroll: true });
    }
  }

  /** Channel-zero's own Overview mode — just that one stream, filling the wall — no grid, no per-camera
   * actions that don't apply to it (see the chan0 comment in renderWall), no Arrange. TV mode defaults
   * here; any device can reach it via the subbar's single Overview/Grid toggle (redesign v2). */
  _renderChan0SingleView() {
    this.disposeTiles();
    const w = this.wall;
    w.className = 'wall chan0-single' + (this.fitMode() === 'cover' ? ' fill' : '');
    w.style.gridTemplateColumns = '1fr';
    w.style.gridTemplateRows = '1fr';
    w.style.setProperty('--fit', this.d.fit);
    w.innerHTML = '';
    const t = new Tile(CHAN0_CAM, {
      kind: 'sub', display: this.d, chrome: true, tv: this.tvMode,   // one real stream — see qualityFor's own comment
      noReplay: true, fixedQuality: true, bookmarkLabel: 'Bookmark this moment on every camera',
      onZoom: () => {},
      onFocus: null,
      onUpdate: () => this.countLive(),
      onHevcFallback: () => toast('This browser could not play H.265, so HD now uses a converted H.264 stream.', 'ok', 7000),
      onKindFail: () => toast('The stream could not be started. Keeping the current one.', 'bad', 6000),
      onReplay: null,
      onBookmark: () => this.bookmarkAllCams(),
    });
    this.tiles.push(t);
    t.el.style.gridColumn = '1 / span 1';
    t.el.style.gridRow = '1 / span 1';
    // The Live board's Overview: full-bleed, an OVERVIEW pill + what it is, and the one action that means
    // something different here (bookmark = every real camera at this moment).
    const n = this.s.channels.filter((c) => c.enabled).length;
    t.el.classList.add('overview-tile');
    t.el.insertAdjacentHTML('beforeend', `<div class="overview-cap top"><span class="ov-pill"><span class="dot live"></span>Overview</span><span>All ${n} channel${n === 1 ? '' : 's'}, one mosaic feed · fixed quality</span></div>
      ${this.ctx.can('operator') && !this.tvMode ? `<div class="overview-cap bottom"><span class="spacer"></span><button class="btn glass-btn" data-a="bookmark-all">${icon('bookmark')}Bookmark all cameras</button></div>` : ''}`);
    t.el.querySelector('[data-a=bookmark-all]')?.addEventListener('click', (e) => { e.stopPropagation(); this.bookmarkAllCams(); });
    w.append(t.el);
    this.liveCount = 0; this.wallSince = Date.now();
    if (this._autoFs) {
      this._autoFs = false;
      // Only ever fires once, right after the confirm-dialog flow in settings.js (ctx.armTvFullscreen) —
      // that click is real user activation, but the settings save it waited on eats into how long the
      // browser considers that activation still "fresh"; if it's expired by the time we get here,
      // requestFullscreen rejects quietly and the floating fullscreen button (subbar) still works normally.
      this.live.requestFullscreen?.().catch(() => {});
    }
  }

  countLive() {
    this.liveCount = this.tiles.filter((t) => t.state === 'live').length;
    const pill = this.bar?.querySelector('.health');
    if (!pill) return;
    const html = this._healthHTML();
    if (pill.outerHTML !== html) pill.outerHTML = html;
  }

  disposeTiles() { this.tiles.forEach((t) => t.dispose()); this.tiles = []; }

  // ---------------------------------------------------------------- actions
  async setDisplay(patch, rebuild) {
    const next = { ...this.d, ...patch };
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
    if (this.tvMode) this._tvDefaultFocus();
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
    // Swapping cameras while focused (nav arrows, or ArrowLeft/Right) goes through close-then-reopen — if
    // that's happening while fullscreen, remember it: the element about to close is what's actually
    // fullscreened, and the browser exits fullscreen on its own the instant it's removed from the DOM
    // (standard behaviour, not something this code controls), so without re-requesting it on the new
    // element below, every camera swap silently dropped out of fullscreen (found directly, not assumed).
    const wasFullscreen = this.focus && document.fullscreenElement === this.focus.el;
    this.closeFocus(true);
    this.toggleEdit(false);
    const cams = this.cams();
    const idx = cams.findIndex((c) => c.id === cam.id);
    const kind = isChan0(cam) ? 'sub' : (this.effQuality() === 'sub' ? 'sub' : 'main');

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
    f.className = 'focus' + (this.fitMode() === 'cover' ? ' fill' : '');
    f.dataset.tvScope = '';   // a remote moves among Focus's own controls, not the grid behind it
    const c0 = isChan0(cam), op = this.ctx.can('operator');
    // Focus board: glass bars over the picture (fading on idle), a zoom navigator once you're zoomed in,
    // and the actions that matter one tap away. Everything the old control strip had is still here — the
    // rarer ones (fit/fill, zoom buttons, shortcuts) live under ⋯.
    f.innerHTML = `<div class="focus-bar">
        <button class="btn icon ghost bar-back" data-a="close" title="Back to all cameras (Esc)" aria-label="Back to all cameras">${icon('left')}</button>
        <div class="bar-title"><h2>${esc(cam.name || 'Camera ' + cam.channel)}</h2>
          <div class="bar-sub"><span class="dot live"></span><span class="stat"></span><span class="tag fx" ${summarizeEnhParams(tile.enhParams).active ? '' : 'hidden'} title="Live filters active">${icon('wand')}</span></div></div>
        <span class="spacer"></span>
        ${c0 ? '' : '<div class="seg" role="group" aria-label="Video quality"><button data-k="main">HD</button><button data-k="sub">SD</button></div>'}
        <button class="btn icon ghost" data-a="bookmark" title="${c0 ? 'Bookmark this moment on every camera (B)' : 'Bookmark this moment (B)'}" aria-label="Bookmark this moment">${icon('bookmark')}</button>
        <button class="btn icon ghost" data-a="more" title="More" aria-label="More options" aria-haspopup="true">${icon('more')}</button>
      </div>
      <div class="zoom-nav" hidden><div class="zoom-view"></div></div>
      <div class="zoomctl focus-zoom" role="group" aria-label="Zoom" hidden><button class="btn icon ghost" data-a="zout" title="Zoom out (-)" aria-label="Zoom out">${icon('minus')}</button>
        <button class="btn ghost pct" data-a="zreset" title="Reset zoom (0)">100%</button><button class="btn icon ghost" data-a="zin" title="Zoom in (+)" aria-label="Zoom in">${icon('plus')}</button></div>
      <div class="focus-bottom">
        ${c0 ? '<span></span>' : `<button class="btn replay-pill" data-a="replay" title="Instant replay">${icon('back2')}<b>Instant replay</b><span>· last 10s</span></button>`}
        <span class="spacer"></span>
        ${c0 ? '' : `<button class="btn ghost" data-a="playback" title="${op ? 'Open this camera in Playback' : 'Playback needs an Operator or Admin account'}">${icon('calendar')}<b>Playback</b></button>`}
        <div class="menu-wrap enh-wrap"><button class="btn icon ghost" data-a="enhance" title="Picture adjustments" aria-label="Picture adjustments" aria-haspopup="true">${icon('sparkle')}</button></div>
        <button class="btn icon ghost" data-a="snap" title="Save snapshot (S)" aria-label="Save snapshot">${icon('share')}</button>
        <button class="btn icon ghost" data-a="fs" title="Full screen (F)" aria-label="Full screen">${icon('expand')}</button>
      </div>
      ${cams.length > 1 ? `<button class="nav-arrow prev" aria-label="Previous camera">${icon('left')}</button><button class="nav-arrow next" aria-label="Next camera">${icon('right')}</button>` : ''}
      <div class="stage-host"></div>`;
    // The stage is last on purpose: the borrowed grid tile inside it carries its own (hidden) zin/snap/
    // replay/enhance buttons, and every querySelector below must find the Focus view's own controls first.
    tile.el.style.cssText = 'position:absolute;inset:0;border:0;border-radius:0';
    f.querySelector('.stage-host').append(tile.el);
    const hit = document.createElement('div');
    hit.className = 'hitzone';
    f.querySelector('.stage-host').append(hit);
    tile.enableZoom(hit, { dbl: true });   // single click does nothing (never pauses); double click/tap toggles zoom
    this.live.append(f);
    this.focus = { tile, id: cam.id, el: f, idx, fromGrid: !!fromGrid };
    // Carry fullscreen across the swap (see the wasFullscreen comment above) — the old element's removal
    // above already dropped the browser out of fullscreen, so this is a fresh request, not a toggle.
    if (wasFullscreen) f.requestFullscreen?.().catch(() => {});
    f.querySelector('[data-a=close]').addEventListener('click', () => this.ctx.go('#/live'));
    f.querySelector('[data-a=snap]').addEventListener('click', () => { if (!tile.snapshot()) toast('No picture to save yet.', 'bad'); });
    f.querySelector('[data-a=replay]')?.addEventListener('click', () => this.openReplay(cam));
    f.querySelector('[data-a=playback]')?.addEventListener('click', () => {
      if (!op) { toast('Playback needs an Operator or Admin account — ask an admin to change your role.', 'bad', 5000); return; }
      this.ctx.go(`#/playback/${cam.id}/${Math.round(Date.now() / 1000 - 60)}`);
    });
    f.querySelector('[data-a=bookmark]').addEventListener('click', () => (c0 ? this.bookmarkAllCams() : this.bookmarkNow(cam)));
    f.querySelector('[data-a=fs]').addEventListener('click', () => this.toggleFullscreen(f));
    f.querySelector('[data-a=enhance]').addEventListener('click', () => this._toggleFocusEnhanceMenu(tile));
    f.querySelector('[data-a=more]').addEventListener('click', (e) => this._openFocusMore(e.currentTarget, tile));
    f.querySelector('[data-a=zin]').addEventListener('click', () => tile.zoom.zoomBy(1.6));
    f.querySelector('[data-a=zout]').addEventListener('click', () => tile.zoom.zoomBy(1 / 1.6));
    f.querySelector('[data-a=zreset]').addEventListener('click', () => tile.zoom.reset());
    f.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => tile.setKind(b.dataset.k)));
    f.querySelector('.prev')?.addEventListener('click', () => this.stepFocus(-1));
    f.querySelector('.next')?.addEventListener('click', () => this.stepFocus(1));
    if (tile.kind !== kind) tile.setKind(kind);   // upgrade in place (gapless swap already built into Tile)
    this.paintFocus(tile);
    this._bindFocusAutoHide(f);
  }

  // Same show-on-activity/hide-while-idle cycle Playback's topline/controls use, not a :hover reveal — see
  // .focus:fullscreen's own CSS comment for why. A harmless no-op in windowed mode (nothing there reads the
  // .show class the CSS only applies under .focus:fullscreen). Listeners live on `f` itself, so they're
  // discarded along with it on close/swap — no separate teardown needed.
  _bindFocusAutoHide(f) {
    const chrome = f.querySelectorAll('.focus-bar, .focus-bottom, .nav-arrow, .focus-zoom');
    let hideTimer;
    const hide = () => { if (f.querySelector('.focus-bar:hover, .focus-bottom:hover')) { hideTimer = setTimeout(hide, 2600); return; } chrome.forEach((a) => a.classList.remove('show')); };
    const show = () => {
      chrome.forEach((a) => a.classList.add('show'));
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 2600);
    };
    f.addEventListener('mousemove', show);
    f.addEventListener('mouseenter', show);
    f.addEventListener('touchstart', show, { passive: true });
    show();
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
      // Zoom navigator (Focus board, top-right): the part of the picture you're looking at, live, while
      // zoomed — computed from the same scale/offset the stage transform uses.
      const nav = f.querySelector('.zoom-nav'), ctl = f.querySelector('.focus-zoom');
      nav.hidden = !z.zoomed; ctl.hidden = !z.zoomed;
      if (z.zoomed) {
        const m = z.metrics();
        const clamp01 = (v) => Math.min(1, Math.max(0, v));
        const l = clamp01(((-m.w / 2 - z.x) / z.s + m.bw / 2) / m.bw), t = clamp01(((-m.h / 2 - z.y) / z.s + m.bh / 2) / m.bh);
        const w = Math.min(1 - l, (m.w / z.s) / m.bw), h = Math.min(1 - t, (m.h / z.s) / m.bh);
        Object.assign(f.querySelector('.zoom-view').style, { left: `${l * 100}%`, top: `${t * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
      }
    }
    const pending = tile.pend ? ` · loading ${tile.pend.kind === 'main' ? 'HD' : 'SD'}…` : '';
    const live = tile.state === 'live';
    f.querySelector('.bar-sub .dot').className = `dot ${live ? 'live' : tile.state === 'off' ? 'off' : 'wait'}`;
    f.querySelector('.stat').textContent = (live ? `Live${tile.summary() ? ' · ' + tile.summary() : ''}` : tile.state === 'off' ? 'No signal — retrying' : 'Connecting…') + pending;
  }

  /** ⋯ in the Focus bar: the less-frequent controls (fit/fill, zoom, shortcuts). */
  _openFocusMore(btn, tile) {
    const fill = this.fitMode() === 'cover';
    const menu = openPopover(btn, `<div class="view-menu">
      <div class="pop-row"><span>Picture</span><div class="seg" role="group" aria-label="Fit or fill">
        <button data-f="contain" aria-pressed="${!fill}">Fit</button><button data-f="cover" aria-pressed="${fill}">Fill</button></div></div>
      <div class="pop-sep"></div>
      <button class="pop-item" data-m="zin">${icon('plus')}<span>Zoom in</span><kbd>+</kbd></button>
      <button class="pop-item" data-m="zout">${icon('minus')}<span>Zoom out</span><kbd>−</kbd></button>
      <button class="pop-item" data-m="zreset">${icon('refresh')}<span>Reset zoom</span><kbd>0</kbd></button>
      <div class="pop-sep"></div>
      <button class="pop-item" data-m="keys">${icon('layout')}<span>Keyboard shortcuts</span><kbd>?</kbd></button>
    </div>`, { className: 'view-pop' });
    if (!menu) return;
    menu.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
      if ((this.fitMode() === 'cover') !== (b.dataset.f === 'cover')) this.toggleFit();
      menu.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    menu.querySelector('[data-m=zin]').addEventListener('click', () => tile.zoom.zoomBy(1.6));
    menu.querySelector('[data-m=zout]').addEventListener('click', () => tile.zoom.zoomBy(1 / 1.6));
    menu.querySelector('[data-m=zreset]').addEventListener('click', () => { closePopover(); tile.zoom.reset(); });
    menu.querySelector('[data-m=keys]').addEventListener('click', () => { closePopover(); shortcutsDialog(); });
  }

  stepFocus(dir) {
    const cams = this.cams();
    if (cams.length < 2 || !this.focus) return;
    const i = (cams.findIndex((c) => c.id === this.focus.id) + dir + cams.length) % cams.length;
    this.ctx.go(`#/live/${cams[i].id}`);
  }

  closeFocus(silent) {
    if (!this.focus) return;
    // silent: this is openFocus() swapping to a different camera, not a genuine close — the caller decides
    // whether to carry fullscreen over to the new element (see openFocus's wasFullscreen), not this exit.
    if (!silent && document.fullscreenElement === this.focus.el) document.exitFullscreen?.();
    const { tile, fromGrid } = this.focus;
    if (fromGrid && this.tiles.includes(tile)) {
      // hand the still-running tile back to its grid cell — no reconnect, no black frame
      tile.zoom?.reset(false);
      tile.el.classList.remove('in-focus');
      tile.el.style.cssText = '';
      tile.opts.onUpdate = () => this.countLive();
      tile.enableZoom(tile.el.querySelector('.hit'), { dbl: false });   // back to grid rules: click opens focus, no dbl-click zoom
      const cell = LAYOUTS[this.effLayout()].cells[tile.cellIndex];
      if (cell) { tile.el.style.gridColumn = `${cell.c} / span ${cell.w}`; tile.el.style.gridRow = `${cell.r} / span ${cell.h}`; }
      const wantKind = this.qualityFor(cell || {}, tile.cam);
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
    this.countLive();   // also lets "Recorder unreachable" appear once its grace period passes
    try {
      const since = new Date(Date.now() - 20000).toISOString();
      if (!this.ctx.can('operator')) return;   // the event index is review data: operator and up
      const rows = await getJSON(`/api/timeline/events?start_utc=${encodeURIComponent(since)}&limit=200`);
      const byChannel = new Map();
      for (const row of rows) {
        if (row.kind === 'bookmark') continue;   // a person's note, not an alert — the bell lists it, tiles don't ring for it
        if (!byChannel.has(row.channel)) byChannel.set(row.channel, new Set());
        byChannel.get(row.channel).add(row.kind);
      }
      for (const t of this.tiles) t.setBadges(byChannel.get(t.cam.channel));
      this._toastNewEvents(rows);
      this._lastEventRows = rows;
      markBell(this.bar, rows);
    } catch { /* transient network hiccup — next poll retries */ }
  }

  /** States board: a new event pops a top-centre toast ("Motion at Driveway, just now") that opens that
   * camera in Focus when tapped. Only events that start after Live opened; one toast per camera a minute
   * and one every 15 s overall, so a busy motion afternoon reads as a few nudges, not a stream. */
  _toastNewEvents(rows) {
    const now = Date.now();
    this._evSeen ||= new Set(rows.map((r) => r.id));   // first poll: what's already happening isn't news
    this._evCamAt ||= new Map();
    const KIND = {
      motion: ['Motion', 'motion', 'var(--ev-motion)'], line: ['Line crossed', 'range', 'var(--ev-line)'], intrusion: ['Intrusion', 'shield', 'var(--ev-line)'],
      tamper: ['Tamper', 'alert', 'var(--tamper)'], videoloss: ['Video lost', 'offline', 'var(--ev-videoloss)'],
    };
    for (const r of rows) {
      if (this._evSeen.has(r.id)) continue;
      this._evSeen.add(r.id);
      if (!KIND[r.kind] || this.focus || document.hidden) continue;
      const cam = this.cams().find((c) => c.channel === r.channel);
      if (!cam || now - (this._evCamAt.get(cam.id) || 0) < 60000 || now - (this._evToastAt || 0) < 15000) continue;
      this._evCamAt.set(cam.id, now); this._evToastAt = now;
      const [title, glyph, color] = KIND[r.kind];
      const tile = this.tiles.find((t) => t.cam.id === cam.id);
      notify({ title: `${title} · ${cam.name || 'Camera ' + cam.channel}`, body: 'Just now — open to watch', glyph, color, thumb: tile?.thumbnail(), onClick: () => this.ctx.go(`#/live/${cam.id}`) });
    }
  }


  // ---------------------------------------------------------------- bookmarks (spec section 9/11.6)
  async bookmarkNow(cam) {
    if (!this.ctx.can('operator')) { toast("Your account can't add bookmarks", 'bad'); return; }
    const r = await bookmarkDialog({ subtitle: `${cam.name || 'Camera ' + cam.channel} · right now` });
    if (!r) return;
    try {
      await api.createBookmark({ channels: [cam.id], time_utc: new Date().toISOString(), ...r });
      toast('Bookmark saved.', 'ok');
    } catch (e) {
      toast(e.message || 'Could not save the bookmark', 'bad');
    }
  }

  /** Channel-zero isn't a real recorded channel of its own — it's the recorder's composite of every real
   * one — so bookmarking "it" applies to every real camera at once instead (the same createBookmark call
   * already takes a `channels` array; this is just all of them). The closest honest equivalent to
   * bookmarking the whole property at this moment, rather than a channel that has no timeline to find it on. */
  async bookmarkAllCams() {
    if (!this.ctx.can('operator')) { toast("Your account can't add bookmarks", 'bad'); return; }
    const real = this.s.channels.filter((c) => c.enabled);
    if (!real.length) return;
    const r = await bookmarkDialog({ subtitle: `All ${real.length} cameras · right now` });
    if (!r) return;
    try {
      await api.createBookmark({ channels: real.map((c) => c.id), time_utc: new Date().toISOString(), ...r });
      toast('Bookmark saved on every camera.', 'ok');
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
    r.dataset.tvScope = '';
    r.innerHTML = `<div class="focus-bar show">
        <button class="btn icon ghost bar-back" data-a="x" title="Close (Esc)" aria-label="Close instant replay">${icon('left')}</button>
        <div class="bar-title"><h2>Instant replay</h2><div class="bar-sub"><span class="dot wait"></span><span class="stat">starting…</span><span>· ${esc(cam.name || 'Camera ' + cam.channel)} · last ${seconds}s</span></div></div>
        <span class="spacer"></span>
      </div><div class="replay-stage"><canvas></canvas></div>
      <div class="focus-bottom show"><span class="spacer"></span><button class="btn primary" data-a="live">${icon('play')}Back to live</button></div>`;
    this.live.append(r);
    const canvas = r.querySelector('canvas');
    const pill = r.querySelector('.stat');
    const player = new WCPlayer(canvas, {
      onState: (s) => { pill.textContent = s === 'playing' ? 'Replaying' : s === 'queued' ? 'Waiting for a recorder session…' : (s ? s[0].toUpperCase() + s.slice(1) : ''); pill.previousElementSibling.className = `dot ${s === 'playing' ? 'armed' : 'wait'}`; },
      onError: (msg) => { pill.textContent = 'error'; toast(`Instant replay: ${msg}`, 'bad', 6000); },
    });
    if (!player.supported) { toast(`Instant replay unavailable: ${unsupportedReason()}`, 'bad', 8000); r.remove(); return; }
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

  /** Called by main.js when the tab/installed app regains visibility (see Tile.resume's own comment for
   * why this is needed at all — a backgrounded iOS home-screen app's network connections die well before
   * anything else does). Every live tile gets kicked, including whichever one is open in the large view. */
  resume() {
    this.tiles.forEach((t) => t.resume());
    this.focus?.tile.resume();
  }

  // ---------------------------------------------------------------- fullscreen & keys
  toggleFullscreen(el) {
    if (document.fullscreenElement) document.exitFullscreen();
    else el?.requestFullscreen?.().catch(() => toast('Full screen is not available here.', 'bad'));
  }
  // Restarts the fullscreen chrome's idle timer the moment fullscreen actually begins, not whenever
  // _bindWallFsAutoHide happened to run (build() time — which, via the Settings "go to TV mode" confirm
  // flow, can be seconds earlier: a settings save, a navigation, then the fullscreen request itself all
  // happen first). Without this, that gap could already exceed the 2.6s idle window on its own, so the
  // very first thing a real user saw on entering fullscreen was already the chrome-hidden state — never
  // having had a chance to see the labels/controls at all, let alone watch them fade.
  syncFullscreen() {
    if (document.fullscreenElement === this.live) this._fsShow?.();
    if (this.tvMode && !this.focus) this.renderBar();   // the header's Full screen / Exit full screen label
  }

  key(e) {
    if (!this.wall || e.target?.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.getElementById('modal-root').firstChild) return;
    // A TV remote's keys arrive under different names depending on the set's browser (Tizen sends keyCode
    // 10009 for Back and 10252 for Play/Pause; others send the standard key names).
    const tvBack = this.tvMode && (/^(Backspace|BrowserBack|GoBack|XF86Back)$/.test(e.key) || e.keyCode === 10009);
    const tvPlay = this.tvMode && (/^(MediaPlayPause|MediaPlay|MediaPause|MediaStop)$/.test(e.key) || [10252, 415, 19, 413].includes(e.keyCode));
    const k = tvBack ? 'Escape' : e.key;
    if (this.tvMode) this._tvWake();
    if (tvPlay) { e.preventDefault(); this._tvPlayPause(); return; }
    if (tvBack && document.body._openPopover) { e.preventDefault(); closePopover(); return; }
    if (k === '?') { shortcutsDialog(); return; }
    if (this.replay) { if (k === 'Escape') { e.preventDefault(); this.closeReplay(); } return; }
    if (this.focus) {
      // On a remote, Left/Right switch cameras unless a control in Focus's own bars has the focus — then
      // they move between those controls (tvnav); Up/Down always go to the controls.
      const inBars = document.activeElement?.closest?.('.focus-bar, .focus-bottom, .focus-zoom');
      if (this.tvMode && (k === 'ArrowUp' || k === 'ArrowDown' || ((k === 'ArrowLeft' || k === 'ArrowRight') && inBars))) { this._focusShow?.(); return; }
      if (k === 'Escape' && !document.fullscreenElement) { e.preventDefault(); if (this.focus.tile.zoom?.zoomed) this.focus.tile.zoom.reset(); else this.ctx.go('#/live'); }
      else if (k === '+' || k === '=') this.focus.tile.zoom?.zoomBy(1.6);
      else if (k === '-' || k === '_') this.focus.tile.zoom?.zoomBy(1 / 1.6);
      else if (k === '0') this.focus.tile.zoom?.reset();
      else if (k === 'ArrowLeft') { e.preventDefault(); this.stepFocus(-1); }
      else if (k === 'ArrowRight') { e.preventDefault(); this.stepFocus(1); }
      else if (k === 'f' || k === 'F') this.toggleFullscreen(this.focus.el);
      else if (k === 's' || k === 'S') this.focus.tile.snapshot();
      else if ((k === 'h' || k === 'H') && !isChan0(this.focus.tile.cam)) this.focus.tile.setKind(this.focus.tile.kind === 'main' ? 'sub' : 'main');
      else if (k === 'b' || k === 'B') { const c = this.focus.tile.cam; isChan0(c) ? this.bookmarkAllCams() : this.bookmarkNow(c); }
      return;
    }
    if (this.tvMode) {
      // Arrows belong to tvnav (spatial focus across tiles and the header); Back from the grid returns to
      // the Overview — the TV's resting state.
      if (k === 'Escape') { e.preventDefault(); if (!this.chan0Displayed && this.channelZeroOn) this._setOverview(true); }
      else if (k === 'f' || k === 'F') this.toggleFullscreen(this.live);
      return;
    }
    if (k === 'Escape') { if (this.edit) this.toggleEdit(false); }
    else if (k === 'ArrowLeft') this.goPage(this.page - 1);
    else if (k === 'ArrowRight') this.goPage(this.page + 1);
    else if (k === 'e' || k === 'E') this.toggleEdit();
    else if (k === 'f' || k === 'F') this.toggleFullscreen(this.live);
    else if (/^[1-9]$/.test(k)) { const t = this.tiles[+k - 1]; if (t) this.ctx.go(`#/live/${t.cam.id}`); }
  }


  // ---------------------------------------------------------------- TV mode grid navigation
  /** Moves the TV-mode selection cursor by `delta` tiles (±1 for left/right, ±cols for up/down) and gives
   * that tile's hit-target real keyboard focus — works identically on a real TV remote and a laptop
   * keyboard, since nothing here depends on the browser's own focus-traversal order. */
  /** tvnav found nothing further left/right from a tile: turn the page (a remote has no other way to). */
  _tvEdge(e) {
    const { dx, from } = e.detail;
    if (!this.tvMode || this.focus || this.chan0Displayed || !dx || this.pages() < 2 || !from?.closest?.('.wall')) return;
    this.goPage(this.page + dx);
    const t = dx > 0 ? this.tiles[0] : this.tiles[this.tiles.length - 1];
    t?.el.querySelector('.hit')?.focus();
  }

  _setOverview(on) {
    if (!this.channelZeroOn || this.overviewOn === on) return;
    this.overviewOn = on;
    this.ctx.setOverviewOn?.(on);
    if (!this.wall) { this.build(); return; }
    this.renderBar(); this.renderWall();
    if (this.tvMode) this._tvDefaultFocus();
  }

  /** Play/Pause on the remote: Overview ⇄ grid; from a camera in Focus, back out to where it came from. */
  _tvPlayPause() {
    if (this.focus) { this.ctx.go('#/live'); return; }
    if (this.channelZeroOn) this._setOverview(!this.chan0Displayed);
  }

  /** Where a remote's first arrow press lands: the Overview/Grid button on the Overview, else the first
   * camera. Marked for tvnav and focused straight away if nothing has focus yet. */
  _tvDefaultFocus() {
    this.root.querySelectorAll('[data-tv-default]').forEach((el) => el.removeAttribute('data-tv-default'));
    const el = this.chan0Displayed ? this.bar?.querySelector('[data-a=overview]') : this.tiles[0]?.el.querySelector('.hit');
    el?.setAttribute('data-tv-default', '');
  }

  /** TV chrome (header, hints) shows on any key or pointer movement and fades after a few quiet seconds,
   * unless a header control has the focus. Five quiet minutes on the grid go back to the Overview, the
   * TV's resting state. */
  _tvWake() {
    if (!this.tvMode || !this.live) return;
    this.live.classList.add('tv-awake');
    clearTimeout(this.tvHideTimer);
    const hide = () => {
      if (this.bar?.contains(document.activeElement) || document.body._openPopover) { this.tvHideTimer = setTimeout(hide, 4000); return; }
      this.live?.classList.remove('tv-awake');
    };
    this.tvHideTimer = setTimeout(hide, 6000);
    clearTimeout(this.tvIdleTimer);
    this.tvIdleTimer = setTimeout(() => { if (!this.focus && !this.chan0Displayed && this.channelZeroOn) this._setOverview(true); }, 5 * 60 * 1000);
  }

  /** Keep the TV from dimming or sleeping while it's showing cameras (where the browser allows it). */
  async _tvWakeLock() {
    if (!this.tvMode || !navigator.wakeLock || document.hidden) return;
    try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed here */ }
  }


  /** Keeps tvIndex in sync when a tile is focused by some other means (mouse click, Tab) — so arrow-key
   * navigation picks up from wherever focus actually is, not a stale cursor position. */
  _tvFocusIn(e) {
    const hit = e.target.closest?.('.hit');
    if (!hit) return;
    const i = this.tiles.findIndex((t) => t.el.contains(hit));
    if (i >= 0) this.tvIndex = i;
  }

  destroy() {
    this.disposeTiles();
    this.focus?.tile.dispose();
    this.focus = null;
    this.closeReplay();
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('fullscreenchange', this.onFs);
    clearInterval(this.rotTimer);
    clearInterval(this.evTimer);
    clearInterval(this.clockTimer);
    clearTimeout(this.tvHideTimer);
    clearTimeout(this.tvIdleTimer);
    document.removeEventListener('tvnav-edge', this.onTvEdge);
    document.removeEventListener('visibilitychange', this.onVis);
    this.wakeLock?.release?.().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen?.();
    this.root.innerHTML = '';
  }
}
