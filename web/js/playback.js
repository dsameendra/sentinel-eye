// Playback view: DVR review, 1-4 cameras at once (the DVR's hard playback-session limit — spec 2.2/7.2).
// Left panel = camera picker (checkboxes once >1 pane), center = video pane(s) + shared transport,
// right panel = calendar/time jump, bottom = timeline for the primary (first-picked) camera.
import { Timeline } from './timeline.js';
import { bookmarkDialog, esc, icon, toast, openPopover, closePopover } from './ui.js';
import { WCPlayer } from './wcplayer.js';
import { partsFromEpoch, fetchTzOffset } from './dvrtime.js';
import { DateTimePicker } from './datepicker.js';
import { api } from './api.js';
import { Enhancer, PRESETS as ENHANCE_PRESETS } from './enhance.js';
import { ZoomPan } from './zoom.js';
import { openEnhancePopup } from './enhancePopup.js';

const SPEEDS = ['0.125', '0.25', '0.5', '1', '2', '4', '8', '16'];
const REWIND_MACROS = [5, 10, 30];
const MAX_PANES = 4; // the DVR allows at most 4 simultaneous playback sessions, full stop (spec 2.2)
const EXPORT_SCALE = 16; // must match app/export.py's EXPORT_SCALE — the DVR delivers full frames this fast during export (measured)
const pad2 = (n) => String(n).padStart(2, '0');

export class PlaybackView {
  /** @param ctx { settings(), go(hash) }
   *  @param startEpoch optional deep-link target time (unix seconds), e.g. from a search result */
  constructor(root, ctx, channelId, startEpoch) {
    this.root = root;
    this.ctx = ctx;
    this.playing = false;
    this.currentEpoch = startEpoch ? +startEpoch : Date.now() / 1000 - 30;
    this.speed = '1';
    this.tzOffsetMin = 330; // Asia/Kolkata default until /api/timeline/tz answers
    this.datePicker = null;        // DateTimePicker bound to the primary camera's coverage
    this.panes = [];               // [{cam, el, canvas, veil, statusEl, player}], panes[0] is primary
    this.clips = [];               // [[startEpoch, endEpoch], …] — multi-cut clipper's pending list (spec 10/15)
    this.onKey = (e) => this._key(e);
    document.addEventListener('keydown', this.onKey);
    this._init(channelId);
  }

  async _init(channelId) {
    this.tzOffsetMin = await fetchTzOffset(this.tzOffsetMin);
    this.build(channelId);
  }

  cams() { return this.ctx.settings().channels.filter((c) => c.enabled); }
  get primary() { return this.panes[0]?.cam; }

  build(channelId) {
    const cams = this.cams();
    if (!cams.length) {
      this.root.innerHTML = `<div class="pb"><div class="center-card"><h2>No cameras</h2><p>Enable a channel in Settings first.</p>
        <a class="btn primary" href="#/settings/channels">Open settings</a></div></div>`;
      return;
    }
    const first = cams.find((c) => c.id === channelId) || cams[0];

    this.root.innerHTML = `<div class="pb">
      <div class="pb-body">
        <aside class="pb-side pb-side-left">
          <h3>Cameras</h3>
          <div class="cam-list"></div>
          <p class="hint">Pick up to ${MAX_PANES} — the recorder can only play that many at once.</p>
        </aside>
        <div class="pb-center">
          <div class="pb-topline">
            <span class="pill pb-status"><span class="dot wait"></span><span class="txt">connecting…</span></span>
            <span class="pb-time"></span>
            <span class="spacer"></span>
            <span class="pill pb-pool" title="The recorder's shared playback-session budget"></span>
            <button class="btn icon" data-a="pbfs" title="Full screen (F)" aria-label="Full screen">${icon('fullscreen')}</button>
          </div>
          <div class="pb-stage">
            <div class="pb-panes"></div>
            <div class="pb-controls">
              <div class="pb-ctrlrow">
                <div class="pb-ctrl-left">
                  <select class="pb-speed" aria-label="Speed"></select>
                  <button class="btn sm" data-a="now">Jump to now</button>
                  <button class="btn icon" data-a="bookmark" title="Bookmark this moment (B)">${icon('flag')}</button>
                  <div class="menu-wrap enh-wrap"><button class="btn icon" data-a="enhance" title="Live enhancement" aria-label="Live enhancement" aria-haspopup="true">${icon('wand')}</button></div>
                  <button class="btn icon" data-a="aienhance" title="AI frame enhancer — pause first" aria-label="AI frame enhancer">${icon('scan')}</button>
                </div>
                <div class="pb-ctrl-center">
                  <div class="pb-macros">
                    <button class="btn icon" data-a="back30" title="Back 30 s (Shift+3)">30<span class="u">s</span></button>
                    <button class="btn icon" data-a="back10" title="Back 10 s (Shift+2)">10<span class="u">s</span></button>
                    <button class="btn icon" data-a="back5" title="Back 5 s (Shift+1)">5<span class="u">s</span></button>
                  </div>
                  <button class="btn icon" data-a="stepback" title="Previous frame (,)">${icon('left')}</button>
                  <button class="btn icon primary" data-a="playpause" title="Play / pause (Space)">${icon('play')}</button>
                  <button class="btn icon" data-a="stepfwd" title="Next frame (.)">${icon('right')}</button>
                  <div class="pb-macros">
                    <button class="btn icon" data-a="fwd5" title="Forward 5 s (Shift+4)">5<span class="u">s</span></button>
                    <button class="btn icon" data-a="fwd10" title="Forward 10 s (Shift+5)">10<span class="u">s</span></button>
                    <button class="btn icon" data-a="fwd30" title="Forward 30 s (Shift+6)">30<span class="u">s</span></button>
                  </div>
                </div>
                <div class="pb-ctrl-right">
                  <button class="btn sm" data-a="selectrange" title="Drag on the timeline to pick a range, then export it">${icon('layout')} Select range</button>
                  <button class="btn sm" data-a="clips" title="Multi-cut clipper: review, add to, or export the pending clip list" hidden>${icon('list')} Clips <span class="clip-count">0</span></button>
                  <button class="btn sm primary" data-a="export">${icon('download')} Export clip</button>
                </div>
              </div>
              <div class="pb-hintrow"><span class="hint" id="pbtl-hint"></span></div>
            </div>
          </div>
        </div>
        <aside class="pb-side pb-side-right">
          <h3>Jump to date &amp; time</h3>
          <div class="pb-cal"></div>
          <p class="hint">Pick a day, then a time — it jumps straight there.</p>
        </aside>
        <div class="pb-edge pb-edge-left" aria-hidden="true"></div>
        <div class="pb-edge pb-edge-right" aria-hidden="true"></div>
      </div>
      <div class="pb-timeline"></div>
    </div>`;

    const speedSel = this.root.querySelector('.pb-speed');
    speedSel.innerHTML = SPEEDS.map((s) => `<option value="${s}" ${s === '1' ? 'selected' : ''}>${s.startsWith('0.') ? '1/' + Math.round(1 / parseFloat(s)) : s}×</option>`).join('');
    speedSel.addEventListener('change', () => this.setSpeed(speedSel.value));

    this.statusEl = this.root.querySelector('.pb-status');
    this.timeEl = this.root.querySelector('.pb-time');
    this.poolEl = this.root.querySelector('.pb-pool');
    this.stage = this.root.querySelector('.pb-stage');
    this.panesEl = this.root.querySelector('.pb-panes');

    if (!('VideoDecoder' in window)) {
      this.stage.innerHTML = `<div class="pb-veil" style="position:static;height:100%"><div class="msg"><b>This browser can't play DVR recordings.</b><br>Chrome, Edge or Safari 16.4+ is needed (WebCodecs).</div></div>`;
      return;
    }

    this.timeline = new Timeline(this.root.querySelector('.pb-timeline'), {
      channels: [{ channel: first.channel, name: first.name || `Camera ${first.channel}` }], tz: 'Asia/Kolkata',
      onSeek: (iso) => this.seekTo(new Date(iso).getTime() / 1000),
      onRangeSelect: (a, b) => { this._setSelectRangeMode(false); this.timeline?.clearSelection(); this.openExportDialog([a, b]); },
    });
    this.root.querySelector('[data-a=selectrange]').addEventListener('click', () => this._setSelectRangeMode(!this.timeline.selectMode));
    this.root.querySelector('[data-a=clips]').addEventListener('click', () => this.openClipListDialog());

    this.datePicker = new DateTimePicker(this.root.querySelector('.pb-cal'), {
      epoch: this.currentEpoch, tzOffsetMin: this.tzOffsetMin, coverageChannel: first.channel,
      // A calendar/time jump is usually a big move — recenter the timeline's own view on it too, not just
      // move an (often now off-screen and so invisible) playhead marker within whatever range it already
      // happened to be showing. Ordinary stepping/macros go through seekTo() directly and don't recenter,
      // so small in-view adjustments don't cause the timeline to jump/reload on every click.
      onChange: (epoch) => { this.seekTo(epoch); this.timeline?.goTo(epoch); },
    });

    this.root.querySelector('[data-a=playpause]').addEventListener('click', () => this.togglePlay());
    this.root.querySelector('[data-a=stepfwd]').addEventListener('click', () => this.stepFrame(1));
    this.root.querySelector('[data-a=stepback]').addEventListener('click', () => this.stepFrame(-1));
    this.root.querySelector('[data-a=now]').addEventListener('click', () => this.seekTo(Date.now() / 1000 - 5, true));
    this.root.querySelector('[data-a=bookmark]').addEventListener('click', () => this.bookmarkHere());
    this.root.querySelector('[data-a=export]').addEventListener('click', () => this.openExportDialog());
    this.root.querySelector('[data-a=enhance]').addEventListener('click', () => this._toggleEnhanceMenu());
    this.root.querySelector('[data-a=aienhance]').addEventListener('click', () => this._openFrameEnhancer());
    for (const s of REWIND_MACROS) {
      this.root.querySelector(`[data-a=back${s}]`).addEventListener('click', () => this.seekTo(this.currentEpoch - s));
      this.root.querySelector(`[data-a=fwd${s}]`).addEventListener('click', () => this.seekTo(this.currentEpoch + s));
    }
    this.root.querySelector('[data-a=pbfs]').addEventListener('click', () => this.toggleFullscreen());

    this._renderCamList();
    this._setSelection([first.id]); // sets this.playing before controls are bound, so the very first auto-hide countdown is correct
    this._bindAutoHideControls();
    this._bindFullscreenSidePanels();
    this._pollPool();
  }

  // ---------------------------------------------------------------- overlay controls: show on activity, hide while playing and idle
  _bindAutoHideControls() {
    this.controlsEl = this.root.querySelector('.pb-controls');
    // A popover (e.g. the enhance menu) is anchored to a button inside these controls but, since
    // openPopover() renders it to <body>, moving the mouse onto it fires no mousemove on the stage — so a
    // hide timer armed just *before* the menu opened would otherwise fire out from under it. The armed
    // callback re-checks at fire time and reschedules rather than trusting the check made when it was
    // scheduled, which is the only way this holds regardless of when the popover opens relative to it.
    const busy = () => !!document.body._openPopover || !!document.getElementById('modal-root')?.firstChild;
    const maybeHide = () => {
      if (!this.playing || busy()) { this._hideTimer = setTimeout(maybeHide, 600); return; }
      this.controlsEl.classList.remove('show');
    };
    const show = () => {
      this.controlsEl.classList.add('show');
      clearTimeout(this._hideTimer);
      if (this.playing) this._hideTimer = setTimeout(maybeHide, 2600); // paused: stays up, checked continuously if it ever does fire
    };
    this._showControls = show;
    this.stage.addEventListener('mousemove', show);
    this.stage.addEventListener('mouseenter', show);
    this.stage.addEventListener('touchstart', show, { passive: true });
    this.stage.addEventListener('mouseleave', () => { if (this.playing) clearTimeout(this._hideTimer) || (this._hideTimer = setTimeout(() => this.controlsEl.classList.remove('show'), 400)); });
    show();
  }

  toggleFullscreen() {
    const el = this.root.querySelector('.pb');
    if (document.fullscreenElement) document.exitFullscreen();
    else el?.requestFullscreen?.().catch(() => toast('Full screen is not available here.', 'bad'));
  }

  // ---------------------------------------------------------------- fullscreen side panels (hover to show)
  // Only relevant in fullscreen (the CSS keeps .pb-edge invisible/non-interactive otherwise, so these
  // listeners are harmless no-ops in windowed mode). A small hide delay lets the pointer travel from the
  // thin edge strip into the panel itself without it closing in between.
  _bindFullscreenSidePanels() {
    const left = this.root.querySelector('.pb-side-left'), right = this.root.querySelector('.pb-side-right');
    const edgeLeft = this.root.querySelector('.pb-edge-left'), edgeRight = this.root.querySelector('.pb-edge-right');
    const wire = (edge, panel) => {
      let hideTimer;
      const show = () => { clearTimeout(hideTimer); panel.classList.add('show'); };
      const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => panel.classList.remove('show'), 250); };
      edge.addEventListener('mouseenter', show);
      panel.addEventListener('mouseenter', show);
      edge.addEventListener('mouseleave', scheduleHide);
      panel.addEventListener('mouseleave', scheduleHide);
    };
    wire(edgeLeft, left);
    wire(edgeRight, right);
    // Kept on `this` and removed in destroy() — a document-level listener added fresh on every build()
    // and never cleaned up would accumulate one per navigation into Playback, each still holding a
    // reference to that build's (by-then-destroyed) panel elements.
    this._onFsChange = () => {
      if (!document.fullscreenElement) { left.classList.remove('show'); right.classList.remove('show'); }
    };
    document.addEventListener('fullscreenchange', this._onFsChange);
  }

  // ---------------------------------------------------------------- camera panel (multi-select, max 4)
  _renderCamList() {
    const list = this.root.querySelector('.cam-list');
    const cams = this.cams();
    const selected = new Set(this.panes.map((p) => p.cam.id));
    list.innerHTML = cams.map((c) => {
      const on = selected.has(c.id);
      const disable = !on && selected.size >= MAX_PANES;
      return `<label class="cam-item ${on ? 'on' : ''}" data-id="${c.id}">
        <input type="checkbox" ${on ? 'checked' : ''} ${disable ? 'disabled' : ''}>
        <span class="dot ${on ? 'live' : ''}"></span><span class="name">${esc(c.name || 'Camera ' + c.channel)}</span></label>`;
    }).join('');
    list.querySelectorAll('.cam-item input').forEach((cb) => cb.addEventListener('change', () => {
      const id = cb.closest('.cam-item').dataset.id;
      let ids = this.panes.map((p) => p.cam.id);
      if (cb.checked) { if (ids.length < MAX_PANES) ids.push(id); }
      else { ids = ids.filter((x) => x !== id); if (!ids.length) ids = [id]; } // never end up with zero panes
      this._setSelection(ids);
    }));
  }

  _setSelection(ids) {
    // Incremental: only tear down panes for cameras that were actually deselected, only create panes for
    // ones newly added. A full rebuild here would close and reopen every session on every checkbox click,
    // starving whichever pane's session request lands last against the DVR's 4-slot limit — reproduced and
    // confirmed directly (a 4th pane stalled indefinitely while three others kept reconnecting in a loop).
    const cams = this.cams();
    const primaryChanged = this.panes[0] && this.panes[0].cam.id !== ids[0];
    const keep = new Map(this.panes.map((p) => [p.cam.id, p]));
    for (const [id, pane] of keep) if (!ids.includes(id)) { pane.player.destroy(); pane.enhancer?.destroy(); pane.zoom?.destroy(); keep.delete(id); }
    this.panes = ids.map((id) => keep.get(id) || this._makePane(cams.find((c) => c.id === id))).filter(Boolean);
    this._layoutPanes();
    this._renderCamList();
    // Every selected camera's events, not just the primary's — the timeline gives each one its own lane.
    this.timeline?.setChannels(this.panes.map((p) => ({ channel: p.cam.channel, name: p.cam.name || `Camera ${p.cam.channel}` })));
    if (primaryChanged) this.datePicker?.setChannel(this.primary.channel);
    // A pending clip list applies to whichever cameras are selected at export time (_runExportOne reads
    // this.panes fresh), so a clip added against one camera set would silently switch to a different one
    // if the selection changed underneath it — clear the list instead of ever exporting a range against
    // cameras the operator didn't mean it for.
    if (this.clips.length) { this.clips = []; this._syncClipUi(); toast('Camera selection changed — pending clip list cleared.', 'bad'); }
    // Keep the current position in the URL (not just the camera) so a deep link from search survives a
    // refresh. This is the view syncing its own address as state changes, not a navigation, so replace
    // rather than push — otherwise every camera toggle fills history with entries that all render this
    // same view, and Back becomes a several-times-in-a-row no-op.
    this.ctx.replace(`#/playback/${this.primary.id}/${Math.round(this.currentEpoch)}`);
    // (re)connect only the panes that don't already have a live session at the current position
    const iso = new Date(this.currentEpoch * 1000).toISOString();
    for (const pane of this.panes) {
      if (pane.player.ws?.readyState === WebSocket.OPEN || pane.player.ws?.readyState === WebSocket.CONNECTING) continue;
      this.playing = true;
      pane.player.connect(pane.cam.id, iso, this.speed);
    }
    this._paintPlayIcon();
  }

  _makePane(cam) {
    if (!cam) return null;
    const el = document.createElement('div');
    el.className = 'pb-pane';
    el.innerHTML = `<div class="pb-pane-label">${esc(cam.name || 'Camera ' + cam.channel)}</div>
      <div class="pb-pic">
        <canvas></canvas>
        <canvas class="enh-canvas" hidden></canvas>
      </div>
      <div class="hitzone"></div>
      <button class="zoomtag" hidden title="Reset zoom" aria-label="Reset zoom">Reset</button>
      <div class="pb-veil"><div class="spin"></div><div class="msg">Loading…</div></div>`;
    const canvas = el.querySelector('canvas');
    const enhCanvas = el.querySelector('.enh-canvas');
    const veil = el.querySelector('.pb-veil');
    const pane = { cam, el, canvas, enhCanvas, veil, enhancer: null };
    pane.player = new WCPlayer(canvas, {
      onFrame: (t) => this._onFrame(pane, t),
      onState: (s, m) => this._onPaneState(pane, s, m),
      onError: (m) => { this._onPaneState(pane, 'error', m); if (pane === this.panes[0]) toast(`${cam.name || 'Camera'}: ${m}`, 'bad', 6000); },
      onQueued: (info) => this._onPaneState(pane, 'queued', `Recorder busy: ${info.busy}/${info.limit} sessions in use`),
    });
    if (this.enhPreset && this.enhPreset !== 'off') this._applyEnhance(pane, this.enhPreset);
    // Zoom/pan, same component the live view uses: wheel/pinch/drag, double-click/tap to toggle.
    const zoomtag = el.querySelector('.zoomtag');
    pane.zoom = new ZoomPan(el, el.querySelector('.hitzone'), {
      dbl: true,
      onChange: (st) => { zoomtag.hidden = st.s <= 1.001; zoomtag.textContent = `${Math.round(st.s * 100)}%`; },
    });
    zoomtag.addEventListener('click', () => pane.zoom.reset());
    return pane;
  }

  _teardownPanes() {
    for (const p of this.panes) { p.player.destroy(); p.enhancer?.destroy(); p.zoom?.destroy(); }
    this.panes = [];
  }

  // ---------------------------------------------------------------- AI frame enhancer (docs/enhance-ai-spec.md, M6 L2)
  _openFrameEnhancer() {
    if (this.playing || !this.panes.length) return;
    const primary = this.panes[0];
    const images = primary.player.grabFrames(5);
    if (!images.length) { toast('No decoded frame available to enhance yet.', 'bad'); return; }
    openEnhancePopup({ images, channel: primary.cam.channel, atUtc: new Date(this.currentEpoch * 1000).toISOString() });
  }

  // ---------------------------------------------------------------- L0 live enhancement (all panes together)
  _toggleEnhanceMenu() {
    const btn = this.root.querySelector('[data-a=enhance]');
    const html = Object.entries(ENHANCE_PRESETS).filter(([k]) => k !== 'custom').map(([k, p]) =>
      `<button data-preset="${k}" aria-pressed="${(this.enhPreset || 'off') === k}">${esc(p.label)}</button>`).join('');
    const menu = openPopover(btn, html, { className: 'enh-menu' });
    if (!menu) return;
    menu.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setEnhancePreset(b.dataset.preset);
      closePopover();
    }));
  }

  setEnhancePreset(name) {
    this.enhPreset = name;
    this.root.querySelector('[data-a=enhance]')?.setAttribute('aria-pressed', String(name !== 'off'));
    for (const pane of this.panes) this._applyEnhance(pane, name);
  }

  _applyEnhance(pane, name) {
    if (name === 'off') {
      pane.enhancer?.stop();
      pane.enhCanvas.hidden = true;
      return;
    }
    if (!pane.enhancer) {
      pane.enhancer = new Enhancer(pane.canvas, pane.enhCanvas);
      if (!pane.enhancer.supported) { pane.enhancer = null; return; }
    }
    pane.enhancer.setPreset(name);
    pane.enhCanvas.hidden = false;
    pane.enhancer.start();
  }

  _layoutPanes() {
    this.panesEl.innerHTML = '';
    const n = this.panes.length;
    const fill = this.ctx.settings().display.fit === 'cover'; // same setting live view uses (Settings > Display > Picture & behaviour)
    this.panesEl.className = 'pb-panes' + (n > 1 ? ' multi' : '') + (fill ? ' fill' : '');
    this.panesEl.style.gridTemplateColumns = n <= 1 ? '1fr' : n === 2 ? 'repeat(2, 1fr)' : n === 3 ? 'repeat(2, 1fr)' : 'repeat(2, 1fr)';
    this.panesEl.style.gridTemplateRows = n <= 2 ? '1fr' : 'repeat(2, 1fr)';
    for (const p of this.panes) this.panesEl.append(p.el);
  }

  _setSelectRangeMode(on) {
    this.timeline?.setSelectMode(on);
    const btn = this.root.querySelector('[data-a=selectrange]');
    const hint = this.root.querySelector('#pbtl-hint');
    btn?.setAttribute('aria-pressed', String(on));
    if (hint) hint.textContent = on ? 'Drag across the timeline to pick a range…' : '';
  }

  // ---------------------------------------------------------------- playback control (applies to every pane)
  // Pausing no longer disconnects (that's what made frame-stepping slow — every step had to open a brand
  // new DVR session from scratch, real RTSP setup latency each time). It now just stops auto-advancing the
  // displayed frame while the session keeps decoding into WCPlayer's own ring buffer in the background —
  // see wcplayer.js. Resuming jumps to the newest buffered frame instead of reconnecting.
  play() {
    this.playing = true;
    this._paintPlayIcon();
    const iso = new Date(this.currentEpoch * 1000).toISOString();
    for (const p of this.panes) {
      if (p.player.ws?.readyState === WebSocket.OPEN) p.player.resumeFollow();
      else p.player.connect(p.cam.id, iso, this.speed);
    }
    this._showControls?.(); // starts the auto-hide countdown now that playing again
  }

  pause() {
    this.playing = false;
    this._paintPlayIcon();
    for (const p of this.panes) p.player.pauseHere();
    this._onState('paused');
    this._showControls?.(); // paused = actively reviewing — stays visible (show() checks this.playing)
  }

  togglePlay() { this.playing ? this.pause() : this.play(); }

  /** @param forcePlay start playing even if currently paused (used by "Jump to now") — a plain seekTo()
   * while paused just updates the position/UI silently, matching the previous behaviour. */
  seekTo(epoch, forcePlay = false) {
    this.currentEpoch = epoch;
    this._renderTime();
    this.timeline?.setPlayhead(epoch);
    this.datePicker?.setEpoch(epoch, { silent: true });
    if (!this.playing && !forcePlay) return;
    const iso = new Date(epoch * 1000).toISOString();
    this.playing = true;
    this._paintPlayIcon();
    // Always a fresh session, never the in-session "seek" WS message — measured directly (not assumed)
    // that reissuing PLAY with a new clock= range on an already-open RTSP session can land noticeably off
    // target (observed: requested exact midnight, landed ~89 minutes later). A fresh connect for the same
    // request did NOT reproduce that specific failure mode, so this removes one source of imprecision —
    // but a fresh connect can still land off target for footage several days old, which turned out to be a
    // separate, deeper issue in the RTP-to-UTC time calibration itself, not this connect-vs-seek choice.
    // See docs/playback-spec.md's timing notes for that investigation's findings.
    for (const pane of this.panes) pane.player.connect(pane.cam.id, iso, this.speed);
  }

  setSpeed(s) {
    this.speed = s;
    if (!this.playing) return;
    for (const p of this.panes) if (p.player.ws?.readyState === WebSocket.OPEN) p.player.setSpeed(s);
  }

  async stepFrame(dir) {
    this.playing = false;
    this._paintPlayIcon();
    this._onState('paused');
    this._showControls?.();
    // no spinner-first here: stepping is normally instant now (buffered), and flashing a veil on every
    // click would make the common case feel slower than it is — only the rare backward-past-buffer fetch
    // takes real time, and that pane's own veil (wired in _makePane) covers it if it does.
    try {
      const results = await Promise.all(this.panes.map((p) =>
        (dir > 0 ? p.player.stepForward() : p.player.stepBackward(this.currentEpoch, p.cam.id))));
      const t = results[0];
      if (t != null) { this.currentEpoch = t; this._renderTime(); this.timeline?.setPlayhead(t); }
    } catch (e) {
      toast(String(e.message || e), 'bad');
    }
  }

  // ---------------------------------------------------------------- per-pane state -> shared UI
  _onFrame(pane, absTime) {
    pane.veil.hidden = true;
    // Keep the pane's --ar in sync with the decoded frame's real shape (tile.js does the same for live
    // view) — without this the canvas sizing CSS falls back to a fixed 16:9 guess, which is wrong for any
    // camera whose stream isn't 16:9 and produces the same "too much black" effect this was meant to fix.
    const { width: w, height: h } = pane.canvas;
    if (w && h) {
      const ar = w / h;
      if (pane.ar !== ar) { pane.ar = ar; pane.el.style.setProperty('--ar', ar.toFixed(4)); }
    }
    if (pane === this.panes[0]) {
      this.currentEpoch = absTime;
      this._renderTime();
      this.timeline?.setPlayhead(absTime);
    }
  }

  _onPaneState(pane, s, msg) {
    const labels = { connecting: ['wait', 'Connecting…'], queued: ['wait', msg || 'Queued…'], playing: ['live', 'Playing'],
      paused: ['off', 'Paused'], error: ['off', msg || 'Error'], idle: ['off', 'Idle'] };
    const [cls, label] = labels[s] || ['off', s];
    if (s === 'connecting' || s === 'queued') { pane.veil.hidden = false; pane.veil.innerHTML = `<div class="spin"></div><div class="msg">${esc(label)}</div>`; }
    if (s === 'error') pane.veil.innerHTML = `<div class="msg"><b>No signal</b><br>${esc(msg || '')}</div>`;
    if (pane === this.panes[0]) this._onState(s, msg);
  }

  _onState(s, msg) {
    const dot = this.statusEl.querySelector('.dot');
    const txt = this.statusEl.querySelector('.txt');
    const labels = { connecting: ['wait', 'Connecting…'], queued: ['wait', msg || 'Queued…'], playing: ['live', 'Playing'],
      paused: ['off', 'Paused'], error: ['off', msg || 'Error'], idle: ['off', 'Idle'] };
    const [cls, label] = labels[s] || ['off', s];
    dot.className = `dot ${cls}`;
    txt.textContent = label;
    if (s === 'error') { this.playing = false; this._paintPlayIcon(); }
  }

  async _pollPool() {
    if (this._poolTimer) return;
    const tick = async () => {
      try {
        const r = await fetch('/api/playback/pool').then((x) => x.json());
        this.poolEl.textContent = `${r.busy}/${r.limit} recorder sessions`;
        this.poolEl.classList.toggle('warn', r.busy >= r.limit);
      } catch { /* transient */ }
    };
    tick();
    this._poolTimer = setInterval(tick, 4000);
  }

  _renderTime() {
    const p = partsFromEpoch(this.currentEpoch, this.tzOffsetMin);
    this.timeEl.textContent = `${p.y}-${pad2(p.mo + 1)}-${pad2(p.da)}  ${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`;
    this.datePicker?.syncDisplay(this.currentEpoch);
  }

  _paintPlayIcon() {
    this.root.querySelector('[data-a=playpause]').innerHTML = icon(this.playing ? 'pause' : 'play');
    // The AI frame enhancer (docs/enhance-ai-spec.md) operates on the exact frame on screen — while
    // playing that's a moving target, so it's disabled rather than silently grabbing whatever frame
    // happens to land at click time.
    const aiBtn = this.root.querySelector('[data-a=aienhance]');
    if (aiBtn) { aiBtn.disabled = this.playing; aiBtn.title = this.playing ? 'AI frame enhancer — pause first' : 'AI frame enhancer'; }
  }

  _key(e) {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
    else if (e.key === '.') this.stepFrame(1);
    else if (e.key === ',') this.stepFrame(-1);
    else if (e.shiftKey && e.key === '1') this.seekTo(this.currentEpoch - 5);
    else if (e.shiftKey && e.key === '2') this.seekTo(this.currentEpoch - 10);
    else if (e.shiftKey && e.key === '3') this.seekTo(this.currentEpoch - 30);
    else if (e.shiftKey && e.key === '4') this.seekTo(this.currentEpoch + 5);
    else if (e.shiftKey && e.key === '5') this.seekTo(this.currentEpoch + 10);
    else if (e.shiftKey && e.key === '6') this.seekTo(this.currentEpoch + 30);
    else if (e.key === 'b' || e.key === 'B') this.bookmarkHere();
    else if (e.key === 'f' || e.key === 'F') this.toggleFullscreen();
  }

  // ---------------------------------------------------------------- bookmarks (spec section 9)
  async bookmarkHere() {
    if (!this.panes.length) return;
    const subtitle = this.panes.length === 1
      ? `${esc(this.primary.name || 'Camera ' + this.primary.channel)} · ${this.timeEl.textContent}`
      : `${this.panes.length} cameras · ${this.timeEl.textContent}`;
    const r = await bookmarkDialog({ subtitle });
    if (!r) return;
    try {
      await api.createBookmark({
        channels: this.panes.map((p) => p.cam.id),
        time_utc: new Date(this.currentEpoch * 1000).toISOString(),
        ...r,
      });
      toast('Bookmark saved.', 'ok');
      this.timeline?.refresh();
    } catch (e) {
      toast(e.message || 'Could not save the bookmark', 'bad');
    }
  }

  // ---------------------------------------------------------------- export (spec section 10)
  // Single-range clip export for now (the spec's multi-cut batch clipper is a separate, larger UI —
  // deferred rather than built half-way). Reuses a real DVR playback session per channel (the export
  // engine runs through the same 4-session pool as any playback pane), so it can queue behind other
  // playback/export activity exactly like opening a 5th pane would.
  /** @param range optional [startEpoch, endEpoch] — e.g. from a timeline drag-select; defaults to ±15s around now. */
  openExportDialog(range) {
    if (!this.panes.length) return;
    let startEpoch = range?.[0] ?? this.currentEpoch - 15;
    let endEpoch = range?.[1] ?? this.currentEpoch + 15;
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="scrim"><div class="dialog exp-dialog" style="width:min(620px,100%)" role="dialog" aria-modal="true" aria-label="Export clip">
      <h3>${icon('download')} Export clip</h3>
      <p>${this.panes.length} camera${this.panes.length > 1 ? 's' : ''}: ${esc(this.panes.map((p) => p.cam.name || 'Camera ' + p.cam.channel).join(', '))}. Up to 2 hours per export.</p>
      <div class="exp-range">
        <div class="dtp-host" id="exp-start-host"></div>
        <div class="dtp-host" id="exp-end-host"></div>
      </div>
      <div class="form">
        <div class="field wide"><label>Package</label>
          <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin-bottom:6px"><input type="radio" name="exp-pkg" value="signed" checked> Signed evidence package — clip + manifest + Ed25519 signature + offline verifier (recommended)</label>
          <label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type="radio" name="exp-pkg" value="plain"> Plain video only, no signing</label>
        </div>
      </div>
      <p class="hint" id="exp-eta"></p>
      <p class="hint" id="exp-status"></p>
      <div class="row"><button class="btn" data-x="cancel">Cancel</button><button class="btn" data-x="addclip">${icon('list')} Add to clip list</button><button class="btn primary" data-x="go">${icon('download')} Export</button></div>
    </div></div>`;

    const etaEl = root.querySelector('#exp-eta');
    const goBtn = root.querySelector('[data-x=go]');
    const updateEta = () => {
      if (endEpoch <= startEpoch) { etaEl.textContent = 'End must be after start.'; goBtn.disabled = true; return; }
      goBtn.disabled = false;
      const span = endEpoch - startEpoch;
      const etaSec = Math.max(10, span / EXPORT_SCALE); // the DVR delivers at ~16x during export — see app/export.py
      const etaText = etaSec < 60 ? `${Math.ceil(etaSec)}s` : `${Math.ceil(etaSec / 60)}min`;
      etaEl.textContent = `Exports at ~${EXPORT_SCALE}x — expect roughly ${etaText}. Don't close this while it runs.`;
    };
    const startPicker = new DateTimePicker(root.querySelector('#exp-start-host'), {
      epoch: startEpoch, tzOffsetMin: this.tzOffsetMin, coverageChannel: this.primary.channel, label: 'Start',
      onChange: (e) => { startEpoch = e; updateEta(); },
    });
    const endPicker = new DateTimePicker(root.querySelector('#exp-end-host'), {
      epoch: endEpoch, tzOffsetMin: this.tzOffsetMin, coverageChannel: this.primary.channel, label: 'End',
      onChange: (e) => { endEpoch = e; updateEta(); },
    });
    updateEta();

    const close = () => { root.innerHTML = ''; };
    root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) close(); });
    root.querySelector('[data-x=cancel]').addEventListener('click', close);
    root.querySelector('[data-x=addclip]').addEventListener('click', () => {
      if (endEpoch <= startEpoch) { root.querySelector('#exp-status').textContent = 'End must be after start.'; return; }
      this._addClip(startEpoch, endEpoch);
      close();
    });
    goBtn.addEventListener('click', async () => {
      const statusEl = root.querySelector('#exp-status');
      if (endEpoch <= startEpoch) { statusEl.textContent = 'End must be after start.'; return; }
      const pkg = root.querySelector('input[name=exp-pkg]:checked').value;
      goBtn.disabled = true;
      statusEl.textContent = 'Starting export…';
      try {
        const job_id = await this._runExportOne(startEpoch, endEpoch, pkg, (msg) => { statusEl.textContent = msg; });
        const a = document.createElement('a');
        a.href = `/api/export/${job_id}/download`;
        a.click();
        toast('Export ready — download started.', 'ok');
        close();
      } catch (e) {
        statusEl.textContent = e.message || 'Export failed.';
        goBtn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------- multi-cut clipper (spec 10/15)
  // A non-destructive list of pending ranges — built from repeated timeline drag-selects ("Add to clip
  // list" in the single-export dialog) or typed in directly — exported as one batch. Each clip still goes
  // through the existing single-range /api/export job one at a time: the DVR's 4-session budget is a hard
  // ceiling shared with live playback (spec 2.2/7.3), so running them one after another — never in
  // parallel — is what keeps a big batch from starving whatever else is using the recorder at the time.
  _addClip(startEpoch, endEpoch) {
    if (endEpoch <= startEpoch) return;
    this.clips.push([startEpoch, endEpoch]);
    this._syncClipUi();
    toast(`Added to clip list (${this.clips.length} pending).`, 'ok');
  }

  _syncClipUi() {
    const btn = this.root.querySelector('[data-a=clips]');
    if (!btn) return;
    btn.hidden = this.clips.length === 0;
    btn.querySelector('.clip-count').textContent = String(this.clips.length);
    this.timeline?.setClips(this.clips);
  }

  openClipListDialog() {
    const root = document.getElementById('modal-root');
    const fmt = (t) => new Date(t * 1000).toLocaleString(undefined, { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const durStr = (a, b) => { const s = Math.round(b - a); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
    const render = () => `<div class="scrim"><div class="dialog exp-dialog" style="width:min(640px,100%)" role="dialog" aria-modal="true" aria-label="Clip list">
      <h3>${icon('list')} Clip list — ${this.clips.length} pending</h3>
      <p>${this.panes.length} camera${this.panes.length > 1 ? 's' : ''}: ${esc(this.panes.map((p) => p.cam.name || 'Camera ' + p.cam.channel).join(', '))}, applied to every clip below.</p>
      <div class="clip-rows">${this.clips.length ? this.clips.map(([a, b], i) => `
        <div class="clip-row" data-i="${i}"><span class="clip-idx">${i + 1}</span><span class="clip-range">${esc(fmt(a))} → ${esc(fmt(b))}</span><span class="clip-dur">${durStr(a, b)}</span><span class="clip-status hint"></span><button class="btn icon sm ghost" data-x="rm" title="Remove">${icon('trash')}</button></div>`).join('')
        : '<p class="hint">No clips yet — drag a range on the timeline (Select range) and choose "Add to clip list", or add one below.</p>'}</div>
      <div class="exp-range">
        <div class="dtp-host" id="clip-start-host"></div>
        <div class="dtp-host" id="clip-end-host"></div>
      </div>
      <div class="row"><button class="btn sm" data-x="addrange">${icon('plus')} Add this range</button></div>
      <div class="form">
        <div class="field wide"><label>Package for the whole batch</label>
          <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin-bottom:6px"><input type="radio" name="clip-pkg" value="signed" checked> Signed evidence package — clip + manifest + Ed25519 signature + offline verifier (recommended)</label>
          <label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type="radio" name="clip-pkg" value="plain"> Plain video only, no signing</label>
        </div>
      </div>
      <p class="hint" id="clip-status"></p>
      <div class="row"><button class="btn" data-x="close">Close</button><button class="btn" data-x="clear" ${this.clips.length ? '' : 'disabled'}>Clear all</button><button class="btn primary" data-x="exportall" ${this.clips.length ? '' : 'disabled'}>${icon('download')} Export all (${this.clips.length})</button></div>
    </div></div>`;

    let rangeStart = this.currentEpoch - 15, rangeEnd = this.currentEpoch + 15;
    const close = () => { root.innerHTML = ''; };
    const draw = () => {
      root.innerHTML = render();
      root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) close(); });
      root.querySelector('[data-x=close]').addEventListener('click', close);
      root.querySelector('[data-x=clear]')?.addEventListener('click', () => { this.clips = []; this._syncClipUi(); draw(); });
      root.querySelectorAll('[data-x=rm]').forEach((b) => b.addEventListener('click', () => {
        const i = +b.closest('.clip-row').dataset.i;
        this.clips.splice(i, 1);
        this._syncClipUi();
        draw();
      }));
      new DateTimePicker(root.querySelector('#clip-start-host'), {
        epoch: rangeStart, tzOffsetMin: this.tzOffsetMin, coverageChannel: this.primary.channel, label: 'Start',
        onChange: (e) => { rangeStart = e; },
      });
      new DateTimePicker(root.querySelector('#clip-end-host'), {
        epoch: rangeEnd, tzOffsetMin: this.tzOffsetMin, coverageChannel: this.primary.channel, label: 'End',
        onChange: (e) => { rangeEnd = e; },
      });
      root.querySelector('[data-x=addrange]').addEventListener('click', () => {
        if (rangeEnd <= rangeStart) { root.querySelector('#clip-status').textContent = 'End must be after start.'; return; }
        this._addClip(rangeStart, rangeEnd);
        draw();
      });
      root.querySelector('[data-x=exportall]')?.addEventListener('click', async () => {
        const pkg = root.querySelector('input[name=clip-pkg]:checked').value;
        const exportBtn = root.querySelector('[data-x=exportall]');
        const clearBtn = root.querySelector('[data-x=clear]');
        exportBtn.disabled = true; clearBtn.disabled = true;
        const rows = [...root.querySelectorAll('.clip-row')];
        const done = [];
        for (let i = 0; i < this.clips.length; i++) {
          const [a, b] = this.clips[i];
          const statusCell = rows[i]?.querySelector('.clip-status');
          if (statusCell) statusCell.textContent = 'Starting…';
          try {
            const job_id = await this._runExportOne(a, b, pkg, (msg) => { if (statusCell) statusCell.textContent = msg; });
            if (statusCell) statusCell.innerHTML = `<a href="/api/export/${job_id}/download">${esc('Ready — download')}</a>`;
            done.push(i);
          } catch (e) {
            if (statusCell) statusCell.textContent = e.message || 'Failed';
          }
        }
        // Clips that exported cleanly come off the pending list, but this dialog keeps showing their rows
        // (with a live download link each) rather than redrawing — a full re-render would rebuild the row
        // list from the now-shorter this.clips and the just-finished download links would vanish before
        // anyone got to click them. Only the header/count/button labels are patched in place.
        this.clips = this.clips.filter((_, i) => !done.includes(i));
        this._syncClipUi();
        toast(`${done.length}/${rows.length} clip${rows.length > 1 ? 's' : ''} exported.`, done.length === rows.length ? 'ok' : 'bad');
        root.querySelector('h3').innerHTML = `${icon('list')} Clip list — ${this.clips.length} pending`;
        exportBtn.innerHTML = `${icon('download')} Export all (${this.clips.length})`;
        exportBtn.disabled = this.clips.length === 0; clearBtn.disabled = this.clips.length === 0;
      });
    };
    draw();
  }

  /** Runs one export job to completion (create + poll) and resolves to its job_id. Shared by the single-
   * clip dialog and the multi-cut clipper's batch export — a batch is just this, called once per clip,
   * in order (see _addClip's comment on why never in parallel). */
  async _runExportOne(startEpoch, endEpoch, pkg, onProgress) {
    const { job_id } = await api.createExport({
      channels: this.panes.map((p) => p.cam.id),
      start_utc: new Date(startEpoch * 1000).toISOString(),
      end_utc: new Date(endEpoch * 1000).toISOString(),
      package: pkg,
    });
    await this._pollExport(job_id, endEpoch - startEpoch, onProgress);
    return job_id;
  }

  _pollExport(jobId, spanSec, onProgress) {
    // Must track app/export.py's own per-channel deadline (span/EXPORT_SCALE*3 + 60s, floor 60s), or a
    // genuinely-long export just errors out client-side while it's still running server-side. Camera count
    // adds queueing, not just per-channel time, so scale by pane count too, with real margin on top.
    const perChannel = Math.max(60, spanSec / EXPORT_SCALE * 3 + 60);
    const deadline = Date.now() + perChannel * this.panes.length * 1000;
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (Date.now() > deadline) { reject(new Error('Export is taking much longer than expected — check Settings > Status, or try a shorter range.')); return; }
        let job;
        try { job = await api.exportStatus(jobId); } catch (e) { reject(e); return; }
        if (job.state === 'error') { reject(new Error(job.error || 'Export failed')); return; }
        if (job.state === 'done') { resolve(); return; }
        onProgress?.(job.progress || 'Working…');
        setTimeout(tick, 1500);
      };
      tick();
    });
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey);
    if (this._onFsChange) document.removeEventListener('fullscreenchange', this._onFsChange);
    clearInterval(this._poolTimer);
    clearTimeout(this._hideTimer);
    this._teardownPanes();
    this.timeline?.destroy();
    this.root.innerHTML = '';
  }
}
