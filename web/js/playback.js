// Playback view: DVR review, 1-4 cameras at once (the DVR's hard playback-session limit — spec 2.2/7.2).
// Left panel = camera picker (checkboxes once >1 pane), center = video pane(s) + shared transport,
// right panel = calendar/time jump, bottom = timeline for the primary (first-picked) camera.
import { ViewerControls, immersive, toggleViewer, leaveViewer, bindViewerToggle, viewerAutoHideDelay } from './viewer.js';
import { barHTML, wireBar } from './bar.js';
import { Timeline } from './timeline.js';
import { bookmarkDialog, closePopover, esc, icon, toast, openPopover, shortcutsDialog, modalRoot } from './ui.js';
import { WCPlayer, unsupportedReason } from './wcplayer.js';
import { partsFromEpoch, fetchTzOffset, knownTzOffset } from './dvrtime.js';
import { DateTimePicker } from './datepicker.js';
import { api, getJSON } from './api.js';
import { Enhancer, PRESETS as ENHANCE_PRESETS } from './enhance.js';
import { enhancePanelHTML, wireEnhancePanel, summarizeEnhParams } from './enhancePanel.js';
import { ZoomPan } from './zoom.js';
import { ZoomHud } from './zoomhud.js';
import { openEnhancePopup } from './enhancePopup.js';

const SPEEDS = ['0.125', '0.25', '0.5', '1', '2', '4', '8', '16'];
// The recorder's playback budget (app/playback_session.py's SPEED_BUDGET, measured on it): the speeds of
// every open session add up to at most 16 real-time streams — 1 camera up to 16x, 2 up to 8x, 3–4 up to 4x.
const SPEED_BUDGET = 16;
const maxSpeedFor = (n) => SPEEDS.filter((sp) => Math.max(1, +sp) * Math.max(1, n) <= SPEED_BUDGET).pop() || '1';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_PANES = 4; // the DVR allows at most 4 simultaneous playback sessions, full stop (spec 2.2)
const EXPORT_SCALE = 16; // must match app/export.py's EXPORT_SCALE — the DVR delivers full frames this fast during export (measured)
const pad2 = (n) => String(n).padStart(2, '0');
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export class PlaybackView {
  /** @param ctx { settings(), go(hash) }
   *  @param startEpoch optional deep-link target time (unix seconds), e.g. from a search result */
  constructor(root, ctx, channelId, startEpoch) {
    this.root = root;
    this.ctx = ctx;
    this.playing = false;
    // The DVR refuses PLAY for a time too close to "now" (still-open recording segment — see _play_loop's
    // own comment: "how close is inconsistent, not a fixed margin we can just default past"). -30s landed
    // inside that margin often enough that opening Playback with no deep link commonly meant sitting on
    // "Connecting…" through several of the backend's 20s retry-backoff steps before anything played —
    // found directly, not assumed. 3 minutes back is comfortably clear of that margin on every DVR
    // reboot/segment-rollover pattern seen so far, so the very first connect succeeds immediately instead
    // of gambling on the retry loop; "Jump to now" is one click away for whoever actually wants live edge.
    this.currentEpoch = startEpoch ? +startEpoch : Date.now() / 1000 - 180;
    this.speed = '1';
    this.tzOffsetMin = 330; // Asia/Kolkata default until /api/timeline/tz answers
    this.panes = [];               // [{cam, el, canvas, veil, statusEl, player}], panes[0] is primary
    this.clips = [];               // [[startEpoch, endEpoch], …] — multi-cut clipper's pending list (spec 10/15)
    // Settings > Enhancement > "Live filters" default preset (was hardcoded "off" — Tile already honoured
    // this setting, Playback didn't, an inconsistency found and fixed here). Applied to every pane together.
    this.enhParams = { ...(ENHANCE_PRESETS[ctx.settings().display.enhance_default_preset] || ENHANCE_PRESETS.off) };
    this._roiSelectMode = false;   // armed via the wand panel's "Select region" button — next drag on any pane sets *that* pane's ROI
    this._flashlightMode = false;  // armed via "Digital flashlight" — cursor over any pane locally lifts shadows around it there
    this._alignSeq = 0;            // bumped on every seek/selection change so a slow, superseded pane's landing can't retroactively trigger alignment
    this.fitOverride = null;       // null = follow Settings > Display > Fit; 'contain'/'cover' = this-session-only override, never saved (see fitMode())
    this.onKey = (e) => this._key(e);
    document.addEventListener('keydown', this.onKey);
    // Rotating a phone/iPad between portrait and landscape crosses the stacked/grid breakpoint above —
    // re-run the same layout decision live rather than leaving panes arranged for the orientation the view
    // happened to open in.
    this.onResize = () => this._layoutPanes();
    window.addEventListener('resize', this.onResize);
    this._init(channelId);
  }

  // Builds at once with the DVR offset already known (main.js fetches it at start-up); only a first visit
  // ever, with nothing known yet, waits for it. The offset is checked again in the background, and a change
  // (a recorder that follows daylight saving) is applied in place — every time shown reads it afresh.
  async _init(channelId) {
    const known = knownTzOffset();
    this.tzOffsetMin = known ?? await fetchTzOffset(this.tzOffsetMin);
    if (this._dead) return;   // left before a first-ever fetch came back
    this.build(channelId);
    if (known !== null) fetchTzOffset(known).then((m) => {
      if (this._dead || m === this.tzOffsetMin) return;
      this.tzOffsetMin = m;
      if (this.timeline) { this.timeline.opts.tzOffsetMin = m; this.timeline.refresh?.(); }
    });
  }

  // Same order the operator arranged on Live/Settings (display.order), not just the enabled subset in
  // whatever order the backend happens to return channels — found via report, not assumed: this used to
  // ignore display.order entirely, so the camera picker here (and the primary/coverage camera it implies)
  // could silently disagree with Live's own arrangement.
  cams() {
    const by = Object.fromEntries(this.ctx.settings().channels.filter((c) => c.enabled).map((c) => [c.id, c]));
    return this.ctx.settings().display.order.map((id) => by[id]).filter(Boolean);
  }
  get primary() { return this.panes[0]?.cam; }
  fitMode() { return this.fitOverride || this.ctx.settings().display.fit; }
  toggleFit() {
    this.fitOverride = this.fitMode() === 'cover' ? 'contain' : 'cover';
    this._layoutPanes();
    this._syncFitButton();
  }
  _syncFitButton() {
    const btn = this.root.querySelector('[data-a=fit]');
    if (!btn) return;
    const on = this.fitMode() === 'cover';
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Filling (cropped) — tap to letterbox instead. This session only, not saved.' : 'Letterboxed to fit — tap to fill instead (crops). This session only, not saved.';
  }

  build(channelId) {
    const cams = this.cams();
    if (!cams.length) {
      this.root.innerHTML = `<main class="pb">${barHTML({ lead: 'back', title: 'Playback' })}<div class="center-card"><div class="cc-icon">${icon('video')}</div>
        <h2>No cameras</h2><p>Enable a channel in Settings first.</p>
        <a class="btn primary" href="#/settings/channels">Open settings</a></div></main>`;
      wireBar(this.root, this.ctx);
      return;
    }
    const first = cams.find((c) => c.id === channelId) || cams[0];

    const spLabel = (sp) => (sp.startsWith('0.') ? `${sp.replace(/^0/, '')}×`.replace('.5×', '0.5×') : `${sp}×`);
    this.root.innerHTML = `<main class="pb">${barHTML({
      lead: 'back', title: 'Playback', cls: 'tabroot',
      sub: '<span class="pb-status"><span class="dot wait"></span><span class="txt">Connecting…</span></span>',
      context: `<div class="date-step" role="group" aria-label="Day">
          <button data-a="dayprev" title="Previous day" aria-label="Previous day">${icon('left')}</button>
          <button class="date-label" data-a="cal" title="Jump to a date and time" aria-haspopup="dialog"><span class="pb-date"></span></button>
          <button data-a="daynext" title="Next day" aria-label="Next day">${icon('right')}</button></div>
        <div class="cam-chips"></div>`,
      actions: `<span class="pill pb-pool warn" hidden title="The recorder's shared playback-session budget is full"></span>
        <div class="seg speed-seg" role="group" aria-label="Speed">${SPEEDS.filter((sp) => ['0.5', '1', '4', '16'].includes(sp)).map((sp) => `<button data-sp="${sp}" aria-pressed="${sp === '1'}">${spLabel(sp)}</button>`).join('')}
          <button class="more-sp" data-a="speedmore" title="More speeds" aria-label="More speeds" aria-haspopup="true">${icon('down')}</button></div>
        <button class="btn glass-btn" data-a="export" aria-label="Export clip">${icon('share')}<span class="lbl">Export clip</span><span class="clip-count" hidden>0</span></button>`,
    })}
      <div class="pb-body">
        <div class="pb-stage"><div class="pb-panes"></div></div>
        <div class="pb-controls">
          <div class="pb-ctrlrow">
            <div class="pb-ctrl-left">
              <span class="pb-time"></span>
              <button class="btn ghost sm" data-a="now" title="Jump to the live edge">Jump to now</button>
            </div>
            <div class="pb-ctrl-center">
              <button class="btn icon ghost" data-a="stepback" title="Previous frame (,)" aria-label="Previous frame">${icon('left')}</button>
              <button class="btn icon ghost" data-a="back10" title="Back 10 s (Shift+2)" aria-label="Back 10 seconds">${icon('back2')}</button>
              <button class="btn play-btn" data-a="playpause" title="Play / pause (Space)" aria-label="Play or pause">${icon('play')}</button>
              <button class="btn icon ghost" data-a="fwd10" title="Forward 10 s (Shift+5)" aria-label="Forward 10 seconds">${icon('fwd2')}</button>
              <button class="btn icon ghost" data-a="stepfwd" title="Next frame (.)" aria-label="Next frame">${icon('right')}</button>
            </div>
            <div class="pb-ctrl-right">
              <button class="btn icon ghost" data-a="timeline" title="Timeline and review tools" aria-label="Timeline and review tools" aria-expanded="false">${icon('calendar')}</button>
              <button class="btn icon ghost" data-a="bookmark" title="Bookmark this moment (B)" aria-label="Bookmark this moment">${icon('bookmark')}</button>
              <div class="menu-wrap enh-wrap"><button class="btn icon ghost" data-a="enhance" title="Picture adjustments" aria-label="Picture adjustments" aria-haspopup="true">${icon('sparkle')}</button></div>
              <button class="btn icon ghost" data-a="aienhance" title="AI frame enhancer — pause first" aria-label="AI frame enhancer">${icon('scan')}</button>
              <button class="btn icon ghost" data-a="selectrange" title="Pick a range on the timeline to export" aria-label="Select a range">${icon('range')}</button>
              <button class="btn icon ghost" data-a="pbfs" title="Full screen (F)" aria-label="Full screen">${icon('expand')}</button>
              <button class="btn icon ghost" data-a="pbmore" title="More" aria-label="More playback options" aria-haspopup="true">${icon('more')}</button>
            </div>
          </div>
          <div class="pb-timeline-panel">
            <div class="tlp-head"><b class="tlp-range">Timeline</b><span class="spacer"></span>
              <div class="tlp-legend">
                <span><i style="background:var(--ev-motion)"></i>Motion</span><span><i style="background:var(--ev-line)"></i>Line cross</span><span><i style="background:var(--tamper)"></i>Tamper</span>
                <span data-k="videoloss" hidden><i style="background:var(--ev-videoloss)"></i>Video loss</span><span data-k="bookmark" hidden><i style="background:var(--ev-bookmark)"></i>Bookmark</span>
              </div><span class="bar-sep"></span>
              <button class="btn icon ghost sm" data-a="tlzout" title="Zoom out" aria-label="Zoom timeline out">${icon('minus')}</button>
              <button class="btn icon ghost sm" data-a="tlzin" title="Zoom in" aria-label="Zoom timeline in">${icon('plus')}</button></div>
            <div class="pb-timeline"></div>
            <div class="tlp-foot"><span class="tlp-ph"></span><span class="hint" id="pbtl-hint"></span></div>
          </div>
        </div>
      </div>
      <button class="viewer-exit" data-a="leaveview" aria-label="Exit expanded view">${icon('collapse')}<span>Exit view</span></button>
    </main>`;
    wireBar(this.root, this.ctx);
    this.statusEl = this.root.querySelector('.pb-status');
    this.timeEl = this.root.querySelector('.pb-time');
    this.dateEl = this.root.querySelector('.pb-date');
    this.poolEl = this.root.querySelector('.pb-pool');
    this.stage = this.root.querySelector('.pb-stage');
    this.panesEl = this.root.querySelector('.pb-panes');
    this.root.querySelector('[data-a=leaveview]').addEventListener('click', () => leaveViewer(this.root.querySelector('.pb')));

    if (!('VideoDecoder' in window)) {
      this.stage.innerHTML = `<div class="state-card"><div class="state-ico danger">${icon('alert')}</div><h2>Can't play recordings in this browser</h2><p>${esc(unsupportedReason())}</p></div>`;
      return;
    }

    this.timeline = new Timeline(this.root.querySelector('.pb-timeline'), {
      channels: [{ channel: first.channel, name: first.name || `Camera ${first.channel}` }], tzOffsetMin: this.tzOffsetMin,
      onSeek: (iso) => this.seekTo(new Date(iso).getTime() / 1000),
      onRangeSelect: (a, b) => { this._setSelectRangeMode(false); this.timeline?.clearSelection(); this.openExportDialog([a, b]); },
      onView: (t0, t1, ph) => this._paintTimelinePanel(t0, t1, ph),
    });
    this._setHint();
    this.root.querySelector('[data-a=selectrange]').addEventListener('click', () => this._setSelectRangeMode(!this.timeline.selectMode));
    this.root.querySelector('[data-a=tlzin]').addEventListener('click', () => this.timeline.zoomBy(1.8));
    this.root.querySelector('[data-a=tlzout]').addEventListener('click', () => this.timeline.zoomBy(1 / 1.8));

    this.root.querySelector('[data-a=playpause]').addEventListener('click', () => this.togglePlay());
    this.root.querySelector('[data-a=stepfwd]').addEventListener('click', () => this.stepFrame(1));
    this.root.querySelector('[data-a=stepback]').addEventListener('click', () => this.stepFrame(-1));
    this.root.querySelector('[data-a=back10]').addEventListener('click', () => this.seekTo(this.currentEpoch - 10));
    this.root.querySelector('[data-a=fwd10]').addEventListener('click', () => this.seekTo(this.currentEpoch + 10));
    this.root.querySelector('[data-a=now]').addEventListener('click', () => this.seekTo(Date.now() / 1000 - 5, true));
    this.root.querySelector('[data-a=bookmark]').addEventListener('click', () => this.bookmarkHere());
    this.root.querySelector('[data-a=export]').addEventListener('click', () => (this.clips.length ? this.openClipListDialog() : this.openExportDialog()));
    this.root.querySelector('[data-a=enhance]').addEventListener('click', () => this._toggleEnhanceMenu());
    this.root.querySelector('[data-a=aienhance]').addEventListener('click', () => this._openFrameEnhancer());
    bindViewerToggle(this.root.querySelector('[data-a=pbfs]'), this.root.querySelector('.pb'));
    this.root.querySelector('[data-a=pbmore]').addEventListener('click', (e) => this._openMoreMenu(e.currentTarget));
    this.root.querySelector('[data-a=dayprev]').addEventListener('click', () => { this.seekTo(this.currentEpoch - 86400); this.timeline?.goTo(this.currentEpoch); });
    this.root.querySelector('[data-a=daynext]').addEventListener('click', () => { this.seekTo(Math.min(Date.now() / 1000 - 5, this.currentEpoch + 86400)); this.timeline?.goTo(this.currentEpoch); });
    this.root.querySelector('[data-a=cal]').addEventListener('click', (e) => this._openCalendar(e.currentTarget));
    this.root.querySelectorAll('[data-sp]').forEach((b) => b.addEventListener('click', () => this._pickSpeed(b.dataset.sp)));
    this.root.querySelector('[data-a=speedmore]').addEventListener('click', (e) => this._openSpeedMenu(e.currentTarget));

    this._renderTime();
    this.timeline.goTo(this.currentEpoch);
    this._setSelection([first.id]); // sets this.playing before controls are bound, so the very first auto-hide countdown is correct
    this._bindAutoHideControls();
    this.root.querySelector('[data-a=timeline]').addEventListener('click', () => this.toggleDetails());
    this._pollPool();
  }

  // The same presentation contract as Focus/replay; normal review tools never auto-hide.
  _bindAutoHideControls() {
    const el = this.root.querySelector('.pb');
    this.viewerControls?.destroy();
    this.viewerControls = new ViewerControls(el, {
      chrome: '.topbar,.pb-controls,.pb-inspect,.pb-pane-label,.pb-pane-time,.zhud', background: '.pb-stage',
      enabled: () => immersive(el), paused: () => !this.playing,
      delay: () => viewerAutoHideDelay(this.ctx.settings().display.controls_autohide_sec),
      held: () => this._roiSelectMode || this.timeline?.selectMode || el.classList.contains('details-open'),
      exited: () => this.resetInspection(),
    });
    this._showControls = () => this.viewerControls.show();
  }

  toggleFullscreen() { toggleViewer(this.root.querySelector('.pb')); }

  resetInspection() {
    this.inspected = null;
    this.panesEl?.classList.remove('inspecting');
    for (const p of this.panes || []) {
      p.el.classList.remove('inspected');
      const button = p.el.querySelector('[data-a=inspect]');
      button?.setAttribute('aria-pressed', 'false');
      button?.setAttribute('aria-label', 'Enlarge this camera');
      if (button) button.title = 'Enlarge this camera';
    }
  }

  toggleDetails(force) {
    const el = this.root.querySelector('.pb');
    const on = force ?? !el.classList.contains('details-open');
    el.classList.toggle('details-open', on);
    el.querySelector('[data-a=timeline]')?.setAttribute('aria-expanded', String(on));
    this.viewerControls?.show();
  }

  inspectPane(pane) {
    this.inspected = this.inspected === pane ? null : pane;
    this.panesEl.classList.toggle('inspecting', !!this.inspected);
    for (const p of this.panes) {
      p.el.classList.toggle('inspected', p === this.inspected);
      const button = p.el.querySelector('[data-a=inspect]');
      const selected = p === this.inspected;
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', selected ? 'Show all selected cameras' : 'Enlarge this camera');
      button.title = selected ? 'Show all selected cameras' : 'Enlarge this camera';
      const svg = button.querySelector('svg.i');
      if (svg) svg.outerHTML = icon(selected ? 'collapse' : 'expand');
    }
    this.viewerControls?.show();
    const viewer = this.root.querySelector('.pb');
    if (this.inspected && !immersive(viewer)) toggleViewer(viewer);
    else if (!this.inspected) leaveViewer(viewer);
  }

  // ---------------------------------------------------------------- bar: cameras, date, speed
  /** Camera chips (board): the selected cameras as outlined chips, then "+N" for the rest — any of them opens
   * the picker (up to 4 at once, the recorder's playback-session limit). The chip's dot is the camera's own
   * timeline lane colour once more than one is open, so a chip, a pane and a timeline row read as one thing. */
  _renderCamList() {
    const host = this.root.querySelector('.cam-chips');
    if (!host) return;
    const rest = this.cams().length - this.panes.length;
    const multi = this.panes.length > 1;
    host.innerHTML = this.panes.map((p, i) => `<button class="cam-chip on" data-pick title="${esc(p.cam.name || 'Camera ' + p.cam.channel)}"><span class="av"${multi ? ` style="background:var(--cam-${(i % 4) + 1})"` : ''}></span><span class="cam-name">${esc(p.cam.name || 'Camera ' + p.cam.channel)}</span></button>`).join('')
      + `<button class="pill cam-more" data-pick title="${rest ? 'Add cameras (up to 4 at once)' : 'Change cameras'}">${rest ? `+${rest}` : icon('down')}</button>`;
    host.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', (e) => this._openCamPicker(e.currentTarget)));
  }

  _openCamPicker(anchor) {
    // Pick several at once: the popover stays open, ticks are staged, and the panes change once — when it
    // closes (Done, a tap outside, Esc) — instead of reconnecting the recorder on every tick.
    const before = this.panes.map((p) => p.cam.id);
    const picked = [...before];
    const menu = openPopover(anchor, `<div class="cam-picker">
      <div class="pop-label">Cameras · up to ${MAX_PANES} at once</div>
      <div class="cam-list">${this.cams().map((c) => `<label class="cam-item" data-id="${c.id}"><input type="checkbox"><span class="name">${esc(c.name || 'Camera ' + c.channel)}</span></label>`).join('')}</div>
      <div class="cam-pick-foot"><span class="cam-pick-n"></span><button class="btn primary sm" data-a="done">Done</button></div>
      ${this._pool ? `<div class="pop-foot">${this._pool.busy}/${this._pool.limit} recorder sessions in use</div>` : ''}
    </div>`, {
      className: 'cam-pop', align: 'left',
      onClose: () => { if (picked.join() !== before.join()) this._setSelection(picked); },
    });
    if (!menu) return;
    const paint = () => {
      menu.querySelectorAll('.cam-item').forEach((el) => {
        const id = el.dataset.id, on = picked.includes(id), cb = el.querySelector('input');
        cb.checked = on;
        el.classList.toggle('on', on);
        // Full at four: the rest wait. And never zero: the last one can't be unticked.
        cb.disabled = (!on && picked.length >= MAX_PANES) || (on && picked.length === 1);
        el.title = !on && picked.length >= MAX_PANES ? `Up to ${MAX_PANES} cameras at once — untick one first` : on && picked.length === 1 ? 'At least one camera stays selected' : '';
      });
      menu.querySelector('.cam-pick-n').textContent = `${picked.length} of ${MAX_PANES} selected`;
    };
    menu.querySelectorAll('.cam-item input').forEach((cb) => cb.addEventListener('change', () => {
      const id = cb.closest('.cam-item').dataset.id;
      const i = picked.indexOf(id);
      if (cb.checked && i < 0 && picked.length < MAX_PANES) picked.push(id);
      if (!cb.checked && i >= 0 && picked.length > 1) picked.splice(i, 1);
      paint();
      // The fourth tick fills the screen — close (and apply) on its own, a beat later so the tick is seen.
      if (cb.checked && picked.length === MAX_PANES) setTimeout(() => { if (document.body._openPopover === menu) closePopover(); }, 380);
    }));
    menu.querySelector('[data-a=done]').addEventListener('click', () => closePopover());
    paint();
  }


  /** Date label → the shared date/time picker in a popover (Calendar board), with the board's quick jumps. */
  _openCalendar(anchor) {
    // Calendar board: the month on the left; Time and Quick jump cards on the right; nothing moves until
    // Apply (picking a day then a time used to seek twice, opening two recorder sessions in a row).
    const menu = openPopover(anchor, `<div class="cal-pop">
      <div class="cal-card"><div class="cal-pop-host"></div><div class="cal-note"><span class="dot"></span>Has recorded footage</div></div>
      <div class="cal-side">
        <div class="cal-card"><h4>Time</h4><div class="cal-time-host"></div><p>DVR-local time · shown and sent exactly as the recorder reports it</p></div>
        <div class="cal-card"><h4>Quick jump</h4><div class="quick-jumps"><button data-q="now">Now</button><button data-q="midnight">Today, midnight</button><button data-q="24h">24 hours ago</button><button data-q="7d">7 days ago</button></div></div>
        <button class="btn primary cal-apply" data-a="apply"></button>
      </div></div>`, { className: 'cal-popover', align: 'left' });
    if (!menu) return;
    const jump = (epoch) => { closePopover(); this.seekTo(epoch); this.timeline?.goTo(epoch); };
    let pending = this.currentEpoch;
    const apply = menu.querySelector('[data-a=apply]');
    const label = () => {
      const p = partsFromEpoch(pending, this.tzOffsetMin);
      apply.textContent = `Apply — ${MONTHS[p.mo]} ${p.da}, ${pad2(p.hh)}:${pad2(p.mi)}`;
    };
    // Deliberately not this.datePicker: playback keeps running underneath, and its per-frame sync would
    // overwrite the day and time being chosen.
    new DateTimePicker(menu.querySelector('.cal-pop-host'), {
      epoch: this.currentEpoch, tzOffsetMin: this.tzOffsetMin, coverageChannel: this.primary?.channel,
      timeHost: menu.querySelector('.cal-time-host'),
      onChange: (epoch) => { pending = epoch; label(); },
    });
    label();
    apply.addEventListener('click', () => jump(Math.min(pending, Date.now() / 1000 - 5)));
    menu.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      const now = Date.now() / 1000;
      if (b.dataset.q === 'now') { closePopover(); this.seekTo(now - 5, true); this.timeline?.goTo(now); return; }
      if (b.dataset.q === 'midnight') { const p = partsFromEpoch(now, this.tzOffsetMin); jump(Date.UTC(p.y, p.mo, p.da) / 1000 - this.tzOffsetMin * 60); return; }
      jump(now - (b.dataset.q === '24h' ? 86400 : 7 * 86400));
    }));
  }

  /** Grey out the speeds the recorder can't serve for this many cameras (with why), and step the current
   * speed down if a camera was just added past the line. */
  _syncSpeedLimits(announce = false) {
    const n = this.panes.length, max = maxSpeedFor(n);
    const over = (sp) => +sp > +max;
    const why = `With ${n} cameras the recorder plays up to ${max}× — show fewer cameras to go faster`;
    this.root.querySelectorAll('[data-sp]').forEach((b) => { b.disabled = over(b.dataset.sp); b.title = b.disabled ? why : ''; });
    if (over(this.speed)) {
      if (announce) toast(`Playing at ${max}× — the recorder can't go faster with ${n} cameras.`, 'ok', 5000);
      this._pickSpeed(max);
    }
  }

  _pickSpeed(sp) {
    if (+sp > +maxSpeedFor(this.panes.length)) return;
    this.setSpeed(sp);
    this.root.querySelectorAll('[data-sp]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sp === sp)));
    const more = this.root.querySelector('[data-a=speedmore]');
    const inSeg = !!this.root.querySelector(`[data-sp="${sp}"]`);
    more.classList.toggle('on', !inSeg);
    more.innerHTML = inSeg ? icon('down') : `${sp.startsWith('0.') ? sp.replace(/^0/, '') : sp}×`;
  }

  _openSpeedMenu(anchor) {
    const max = maxSpeedFor(this.panes.length);
    const menu = openPopover(anchor, `<div class="speed-menu">${SPEEDS.map((sp) => `<button data-s="${sp}" aria-pressed="${sp === this.speed}" ${+sp > +max ? `disabled title="With ${this.panes.length} cameras the recorder plays up to ${max}×"` : ''}>${sp.startsWith('0.') ? '1/' + Math.round(1 / parseFloat(sp)) : sp}×</button>`).join('')}
      ${this.panes.length > 1 ? `<p class="speed-note">Up to ${max}× with ${this.panes.length} cameras</p>` : ''}</div>`, { className: 'speed-pop' });
    menu?.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => { closePopover(); this._pickSpeed(b.dataset.s); }));
  }

  /** ⋯ in the transport: the less-frequent controls — 5 s / 30 s skips, fit/fill, keyboard shortcuts. */
  _openMoreMenu(anchor) {
    const fill = this.fitMode() === 'cover';
    // On a phone the bar's speed control and the select-range/fullscreen buttons are hidden for room —
    // they surface here instead, so nothing is lost at any width.
    const hidden = (sel) => { const el = this.root.querySelector(sel); return !!el && (!el.getClientRects().length || getComputedStyle(el).display === 'none'); };
    const speedRow = hidden('.speed-seg') ? `<div class="pop-row"><span>Speed</span><div class="seg" role="group" aria-label="Speed">
        ${SPEEDS.map((sp) => `<button ${+sp > +maxSpeedFor(this.panes.length) ? 'disabled' : ''} data-s="${sp}" aria-pressed="${sp === this.speed}">${sp === '0.5' ? '½' : sp}×</button>`).join('')}</div></div>` : '';
    const extra = [
      ...[['stepback','Previous frame'],['stepfwd','Next frame'],['bookmark','Bookmark this moment'],['enhance','Picture adjustments'],['aienhance','AI frame enhancer'],['now','Jump to now']].filter(([a]) => hidden(`[data-a=${a}]`)).map(([a,label]) => `<button class="pop-item" data-proxy="${a}" ${this.root.querySelector(`[data-a=${a}]`)?.disabled ? 'disabled title="Pause playback first"' : ''}><span>${label}</span></button>`),
      hidden('[data-a=selectrange]') ? `<button class="pop-item" data-m="range">${icon('range')}<span>Select a range to export</span></button>` : '',
      hidden('[data-a=pbfs]') ? `<button class="pop-item" data-m="fs">${icon('expand')}<span>Full screen</span></button>` : '',
    ].join('');
    const menu = openPopover(anchor, `<div class="view-menu">
      ${speedRow}
      <div class="pop-row"><span>Skip</span><div class="seg" role="group" aria-label="Skip">
        <button data-j="-30">−30s</button><button data-j="-5">−5s</button><button data-j="5">+5s</button><button data-j="30">+30s</button></div></div>
      <div class="pop-row"><span>Picture</span><div class="seg" role="group" aria-label="Fit or fill">
        <button data-f="contain" aria-pressed="${!fill}">Fit</button><button data-f="cover" aria-pressed="${fill}">Fill</button></div></div>
      <div class="pop-sep"></div>
      ${extra}
      <button class="pop-item" data-m="keys">${icon('layout')}<span>Keyboard shortcuts</span><kbd>?</kbd></button>
    </div>`, { className: 'view-pop' });
    if (!menu) return;
    menu.querySelectorAll('[data-proxy]').forEach(b => b.addEventListener('click', () => { closePopover(); if (b.dataset.proxy === 'enhance') this._toggleEnhanceMenu(anchor); else this.root.querySelector(`[data-a=${b.dataset.proxy}]`)?.click(); }));
    menu.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => {
      this._pickSpeed(b.dataset.s);
      menu.querySelectorAll('[data-s]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    menu.querySelector('[data-m=range]')?.addEventListener('click', () => { closePopover(); this._setSelectRangeMode(true); });
    menu.querySelector('[data-m=fs]')?.addEventListener('click', () => { closePopover(); this.toggleFullscreen(); });
    menu.querySelectorAll('[data-j]').forEach((b) => b.addEventListener('click', () => this.seekTo(this.currentEpoch + +b.dataset.j)));
    menu.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
      if ((this.fitMode() === 'cover') !== (b.dataset.f === 'cover')) this.toggleFit();
      menu.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    menu.querySelector('[data-m=keys]').addEventListener('click', () => { closePopover(); shortcutsDialog(); });
  }

  /** Timeline panel header/footer (board): visible range in the title, playhead time bottom-left, and the
   * extra legend entries only when those kinds are actually in view. */
  _paintTimelinePanel(t0, t1, ph) {
    const fmt = (t) => { const p = partsFromEpoch(t, this.tzOffsetMin); return `${pad2(p.hh)}:${pad2(p.mi)}`; };
    const day = (t) => { const p = partsFromEpoch(t, this.tzOffsetMin); return `${MONTHS[p.mo]} ${p.da}`; };
    const range = this.root.querySelector('.tlp-range');
    if (range) range.textContent = `Timeline — ${t1 - t0 > 86400 ? `${day(t0)} to ${day(t1)}` : `${fmt(t0)} to ${fmt(t1)}`}`;
    const phEl = this.root.querySelector('.tlp-ph');
    if (phEl && ph != null) { const p = partsFromEpoch(ph, this.tzOffsetMin); phEl.textContent = `${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`; }
    const kinds = new Set((this.timeline?.events || []).map((e) => e.kind));
    this.root.querySelectorAll('.tlp-legend [data-k]').forEach((el) => { el.hidden = !kinds.has(el.dataset.k); });
  }

  _setHint() {
    const hint = this.root.querySelector('#pbtl-hint');
    if (hint) hint.textContent = this.timeline?.selectMode ? 'Drag across the lane to pick a range…' : 'Drag on the lane to scrub — snaps to the nearest event · drag the times above it to pan';
  }

  _setSelection(ids) {
    // Incremental: only tear down panes for cameras that were actually deselected, only create panes for
    // ones newly added. A full rebuild here would close and reopen every session on every checkbox click,
    // starving whichever pane's session request lands last against the DVR's 4-slot limit — reproduced and
    // confirmed directly (a 4th pane stalled indefinitely while three others kept reconnecting in a loop).
    const cams = this.cams();
    const keep = new Map(this.panes.map((p) => [p.cam.id, p]));
    for (const [id, pane] of keep) if (!ids.includes(id)) { pane.player.destroy(); pane.enhancer?.destroy(); pane.zoom?.destroy(); pane.hud?.destroy(); pane._roiResizeObs?.disconnect(); keep.delete(id); }
    this.panes = ids.map((id) => keep.get(id) || this._makePane(cams.find((c) => c.id === id))).filter(Boolean);
    this._layoutPanes();
    this._renderCamList();
    this._syncSpeedLimits(true);
    // Every selected camera's events, not just the primary's — the timeline gives each one its own lane.
    this.timeline?.setChannels(this.panes.map((p) => ({ channel: p.cam.channel, name: p.cam.name || `Camera ${p.cam.channel}` })));
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
    // (re)connect only the panes that don't already have a live session at the current position — and, if
    // any of them lands later than the cameras already playing (same keyframe-snap reality _alignPanes
    // handles for a full seek), pull the rest forward to match rather than leaving the newly-added camera
    // permanently a few seconds ahead of the ones already open.
    const toConnect = this.panes.filter((pane) =>
      pane.player.ws?.readyState !== WebSocket.OPEN && pane.player.ws?.readyState !== WebSocket.CONNECTING);
    if (toConnect.length) {
      this.playing = true;
      this._alignPanes(this.panes, this.currentEpoch, this.speed, this.playing, toConnect);
    }
    this._paintPlayIcon();
  }

  _makePane(cam) {
    if (!cam) return null;
    const el = document.createElement('div');
    el.className = 'pb-pane';
    el.innerHTML = `<button class="pb-inspect btn icon" data-a="inspect" aria-label="Enlarge this camera" aria-pressed="false" title="Enlarge this camera">${icon('expand')}</button><div class="pb-pane-label"><b>${esc(cam.name || 'Camera ' + cam.channel)}</b><span class="tag kind">HD</span><span class="tag fx" hidden title="Live filters active">${icon('wand')}</span></div>
      <div class="pb-pane-time"></div>
      <div class="pb-pic">
        <canvas></canvas>
        <canvas class="enh-canvas" hidden></canvas>
      </div>
      <div class="hitzone"></div>
      <div class="pb-roi-layer"><div class="pb-roi-box" hidden></div></div>
      <div class="pb-veil"><div class="spin"></div><div class="msg">Loading…</div></div>`;
    el.querySelector('[data-a=inspect]').addEventListener('click', () => this.inspectPane(pane));
    const canvas = el.querySelector('canvas');
    const enhCanvas = el.querySelector('.enh-canvas');
    const veil = el.querySelector('.pb-veil');
    const pane = { cam, el, canvas, enhCanvas, veil, enhancer: null, _roi: null, _pauseOnNextFrame: false };
    pane.player = new WCPlayer(canvas, {
      onFrame: (t) => this._onFrame(pane, t),
      onState: (s, m) => this._onPaneState(pane, s, m),
      onError: (m) => { this._onPaneState(pane, 'error', m); if (pane === this.panes[0]) toast(`${cam.name || 'Camera'}: ${m}`, 'bad', 6000); },
      onQueued: (info) => this._onPaneState(pane, 'queued', `Recorder busy: ${info.busy}/${info.limit} sessions in use`),
    });
    this._applyEnhance(pane);
    // Zoom/pan, same component the live view uses: wheel/pinch/drag, double-click/tap to toggle.
    pane.hud = new ZoomHud(el, () => pane.zoom);
    pane.zoom = new ZoomPan(el, el.querySelector('.hitzone'), {
      dbl: true,
      onChange: () => { pane.hud.update(); this._updateRoiBox(pane); },
    });
    pane._roiResizeObs = new ResizeObserver(() => this._updateRoiBox(pane));
    pane._roiResizeObs.observe(el);
    this._wireRoiAndFlashlight(pane);
    return pane;
  }

  _teardownPanes() {
    for (const p of this.panes) { p.player.destroy(); p.enhancer?.destroy(); p.zoom?.destroy(); p.hud?.destroy(); p._roiResizeObs?.disconnect(); }
    this.panes = [];
  }

  // ---------------------------------------------------------------- L0 interactive tools (Playback only —
  // spec's "operator inspecting a paused/stepped frame" scope, not the live grid): a per-pane draggable ROI
  // that restricts the whole L0 pipeline to just a plate/face box (cheap — a GPU scissor test, not extra
  // shader work — see enhance.js's ROI comment), and a cursor-follow "digital flashlight" that locally lifts
  // shadows around the pointer instead of the whole frame.
  _wireRoiAndFlashlight(pane) {
    const { el, canvas } = pane;
    const roiLayer = el.querySelector('.pb-roi-layer');
    const roiBox = el.querySelector('.pb-roi-box');
    const frac = (clientX, clientY) => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return { fx: 0, fy: 0 };
      return { fx: clamp01((clientX - r.left) / r.width), fy: clamp01((clientY - r.top) / r.height) };
    };
    let dragStart = null;
    roiLayer.addEventListener('pointerdown', (e) => {
      if (!this._roiSelectMode) return;
      e.preventDefault();
      try { roiLayer.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      dragStart = frac(e.clientX, e.clientY);
      this._drawRoiBox(pane, dragStart.fx, dragStart.fy, 0, 0);
    });
    roiLayer.addEventListener('pointermove', (e) => {
      if (!dragStart) return;
      const cur = frac(e.clientX, e.clientY);
      this._drawRoiBox(pane, Math.min(dragStart.fx, cur.fx), Math.min(dragStart.fy, cur.fy), Math.abs(cur.fx - dragStart.fx), Math.abs(cur.fy - dragStart.fy));
    });
    roiLayer.addEventListener('pointerup', (e) => {
      if (!dragStart) return;
      const cur = frac(e.clientX, e.clientY);
      const x = Math.min(dragStart.fx, cur.fx), y = Math.min(dragStart.fy, cur.fy);
      const w = Math.abs(cur.fx - dragStart.fx), h = Math.abs(cur.fy - dragStart.fy);
      dragStart = null;
      this._roiSelectMode = false;
      document.querySelectorAll('.pb-roi-layer.active').forEach((l) => l.classList.remove('active'));
      document.querySelectorAll('[data-x=roi]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      // A drag too small to be deliberate: if this pane already has a region, treat it as "tap to clear";
      // otherwise it's just a missed/accidental click — leave things as they are.
      if (w < 0.02 || h < 0.02) {
        if (pane._roi) { pane._roi = null; pane.enhancer?.setRoi(null); this._updateRoiBox(pane); this._applyEnhance(pane); }
        return;
      }
      pane._roi = { x, y, w, h };
      this._applyEnhance(pane); // a region can be set with every slider still neutral — make sure a canvas/enhancer exists to show it in
      pane.enhancer?.setRoi(pane._roi);
      this._updateRoiBox(pane);
    });
    // Flashlight tracking uses plain mousemove (not pointer events), so it's unaffected by the ROI layer's
    // pointer capture above and needs no dedicated hit-testing element of its own.
    el.addEventListener('mousemove', (e) => {
      if (!this._flashlightMode || !pane.enhancer) return;
      const { fx, fy } = frac(e.clientX, e.clientY);
      const r = canvas.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      pane.enhancer.setFlashlight(inside ? fx : null, inside ? fy : null);
    });
    el.addEventListener('mouseleave', () => { if (this._flashlightMode) pane.enhancer?.setFlashlight(null); });
  }

  _drawRoiBox(pane, x, y, w, h) {
    const { canvas, el } = pane;
    const roiLayer = el.querySelector('.pb-roi-layer'), roiBox = el.querySelector('.pb-roi-box');
    const ir = canvas.getBoundingClientRect(), lr = roiLayer.getBoundingClientRect();
    roiBox.style.left = `${ir.left - lr.left + x * ir.width}px`;
    roiBox.style.top = `${ir.top - lr.top + y * ir.height}px`;
    roiBox.style.width = `${w * ir.width}px`;
    roiBox.style.height = `${h * ir.height}px`;
    roiBox.hidden = false;
  }

  _updateRoiBox(pane) {
    if (!pane._roi) { pane.el.querySelector('.pb-roi-box').hidden = true; return; }
    this._drawRoiBox(pane, pane._roi.x, pane._roi.y, pane._roi.w, pane._roi.h);
  }

  // ---------------------------------------------------------------- AI frame enhancer (docs/SPEC.md section 7.8, M6 L2)
  _openFrameEnhancer() {
    if (this.playing || !this.panes.length) return;
    const primary = this.panes[0];
    const frames = primary.player.grabFrames(11); // the enhancer lets you pick any of these (it closes them)
    if (!frames.length) { toast('No decoded frame available to enhance yet.', 'bad'); return; }
    const d = this.ctx.settings().display; // Settings > Enhancement — were hardcoded 'auto'/0.5
    openEnhancePopup({
      frames, pausedIndex: frames.pausedIndex, camName: primary.cam.name || `Camera ${primary.cam.channel}`,
      channel: primary.cam.channel, atUtc: new Date(this.currentEpoch * 1000).toISOString(), tzOffsetMin: this.tzOffsetMin,
      defaultMode: d.enhance_default_mode, defaultFidelity: d.enhance_default_fidelity,
    });
  }

  // ---------------------------------------------------------------- L0 live enhancement (all panes together)
  // Presets are quick-fill starting points; every slider underneath (and the ROI/flashlight tools, Playback-
  // only) stays individually adjustable and stacks with the rest — see enhancePanel.js and enhance.js.
  _toggleEnhanceMenu(anchor) {
    const btn = anchor || this.root.querySelector('[data-a=enhance]');
    const menu = openPopover(btn, enhancePanelHTML({ roi: true, flashlight: true }), { className: 'enh-menu enh2-panel' });
    if (!menu) return;
    menu.querySelector('[data-x=roi]')?.setAttribute('aria-pressed', String(this._roiSelectMode));
    menu.querySelector('[data-x=flashlight]')?.setAttribute('aria-pressed', String(this._flashlightMode));
    wireEnhancePanel(menu, {
      getParams: () => this.enhParams,
      onPreset: (name) => this.applyEnhancePreset(name),
      onParam: (key, value) => this.applyEnhParam(key, value),
      onRoiToggle: () => {
        this._roiSelectMode = !this._roiSelectMode;
        menu.querySelector('[data-x=roi]')?.setAttribute('aria-pressed', String(this._roiSelectMode));
        for (const pane of this.panes) pane.el.querySelector('.pb-roi-layer')?.classList.toggle('active', this._roiSelectMode);
      },
      onFlashlightToggle: () => {
        this._flashlightMode = !this._flashlightMode;
        menu.querySelector('[data-x=flashlight]')?.setAttribute('aria-pressed', String(this._flashlightMode));
        for (const pane of this.panes) pane.el.classList.toggle('flashlight-on', this._flashlightMode);
        if (!this._flashlightMode) for (const pane of this.panes) pane.enhancer?.setFlashlight(null);
        this._applyEnhToAllPanes(); // flashlight can be the only thing on — make sure every pane has a live enhancer to drive it
      },
    });
  }

  applyEnhancePreset(name) {
    this.enhParams = { ...(ENHANCE_PRESETS[name] || ENHANCE_PRESETS.off) };
    this._applyEnhToAllPanes();
  }

  applyEnhParam(key, value) {
    this.enhParams = { ...this.enhParams, [key]: value };
    this._applyEnhToAllPanes();
  }

  _isEnhOff() {
    const neutral = Object.entries(ENHANCE_PRESETS.off).every(([k, v]) => k === 'label' || this.enhParams[k] === v);
    // Flashlight and ROI both live outside enhParams (per-pane/runtime, not part of the stackable preset
    // mix), so a neutral slider set doesn't mean "nothing to show" if either is active — without this, the
    // canvas would be hidden/stopped right out from under a flashlight or region with no other effect on.
    return neutral && !this._flashlightMode && !this.panes.some((p) => p._roi);
  }

  _applyEnhToAllPanes() {
    this.root.querySelector('[data-a=enhance]')?.setAttribute('aria-pressed', String(!this._isEnhOff()));
    for (const pane of this.panes) this._applyEnhance(pane);
  }

  _applyEnhance(pane) {
    const fxTag = pane.el.querySelector('.tag.fx');
    if (fxTag) fxTag.hidden = !summarizeEnhParams(this.enhParams).active;
    if (this._isEnhOff()) {
      pane.enhancer?.stop();
      pane.enhCanvas.hidden = true;
      return;
    }
    if (!pane.enhancer) {
      pane.enhancer = new Enhancer(pane.canvas, pane.enhCanvas);
      if (!pane.enhancer.supported) { pane.enhancer = null; return; }
      if (pane._roi) pane.enhancer.setRoi(pane._roi);
    }
    pane.enhancer.setParams(this.enhParams);
    pane.enhCanvas.hidden = false;
    pane.enhancer.start();
  }

  _layoutPanes() {
    if (!this.panesEl) return; // resize fired before build() set it up, or after destroy() tore it down
    if (this.inspected && !this.panes.includes(this.inspected)) this.inspected = null;
    this.panesEl.replaceChildren(...this.panes.map(p => p.el));
    const n = this.panes.length;
    const fill = this.fitMode() === 'cover'; // same setting live view uses (Settings > Display > Picture & behaviour), overridable for this session only via the topline's Fit/Fill toggle
    this.panesEl.className = 'pb-panes' + (n > 1 ? ' multi' : '') + (fill ? ' fill' : '');
    // A 2-column grid halves each pane's *width* first — fine on a wide screen, but for 16:9-ish CCTV
    // footage on a narrow-and-tall viewport (a phone, or an iPad in portrait) that's the wrong dimension to
    // give up: two side-by-side quarter-tiles letterbox hard, while full-width stacked panes keep the whole
    // available width for every camera and only trade away height, which these shapes have comparatively
    // more of. Landscape phones are deliberately excluded (checked orientation, not just width) — there
    // width is the abundant dimension and a short landscape strip is the wrong place to stack 3-4 panes
    // full-height-divided instead of side by side.
    // Two portrait panes can use the full width when stacked; three and four cameras stay in the 2×2
    // wall so a phone never turns Playback into a long vertical strip of tiny feeds.
    const stacked = n === 2 && window.matchMedia('(max-width: 900px) and (orientation: portrait)').matches;
    this.panesEl.classList.toggle('stacked', stacked);
    if (stacked) {
      this.panesEl.style.gridTemplateColumns = '1fr';
      this.panesEl.style.gridTemplateRows = `repeat(${n}, 1fr)`;
    } else {
      this.panesEl.style.gridTemplateColumns = n <= 1 ? '1fr' : n === 2 ? 'repeat(2, 1fr)' : n === 3 ? 'repeat(2, 1fr)' : 'repeat(2, 1fr)';
      this.panesEl.style.gridTemplateRows = n <= 2 ? '1fr' : 'repeat(2, 1fr)';
    }
    this.panesEl.classList.toggle('inspecting', !!this.inspected);
    for (const p of this.panes) p.el.classList.toggle('inspected', p === this.inspected);
  }

  _setSelectRangeMode(on) {
    if (on) this.toggleDetails(true);
    this.timeline?.setSelectMode(on);
    this.root.querySelector('[data-a=selectrange]')?.setAttribute('aria-pressed', String(on));
    this._setHint();
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

  /** @param forcePlay start playing even if currently paused (used by "Jump to now"). Used to also update
   * only the displayed position/UI while paused, leaving the actual player session untouched — found
   * (not assumed) to desync the two: picking a new date/time while paused moved the playhead and time
   * fields, but the still-open session just sat at its old position, so pressing Play resumed from wherever
   * that stale session happened to be (e.g. an initial midnight/deep-link position) instead of from the
   * newly picked time. A seek is always a deliberate "go here" action regardless of play state, so it now
   * always reconnects — and, if this wasn't a play request, immediately re-pauses once the first frame at
   * the new position has actually painted, landing paused exactly where the UI already claimed to be
   * instead of silently drifting away from it. */
  seekTo(epoch, forcePlay = false) {
    this.currentEpoch = epoch;
    this._renderTime();
    this.timeline?.setPlayhead(epoch);
    const shouldPlay = this.playing || forcePlay;
    this.playing = shouldPlay;
    this._paintPlayIcon();
    // Always a fresh session, never the in-session "seek" WS message — measured directly (not assumed)
    // that reissuing PLAY with a new clock= range on an already-open RTSP session can land noticeably off
    // target (observed: requested exact midnight, landed ~89 minutes later). A fresh connect for the same
    // request did NOT reproduce that specific failure mode, so this removes one source of imprecision.
    // Separately (see _alignPanes below): each channel's DVR session independently snaps the requested
    // instant to that channel's own nearest available keyframe, so two cameras seeked to the exact same
    // epoch can genuinely start from different real recorded moments — several seconds apart, confirmed
    // directly against the cameras' own burned-in clocks, not just this app's computed label of them. A
    // calibration error (docs/SPEC.md's timing notes) can compound this, but isn't the whole story: even
    // with perfect per-channel calibration, independent sessions can still land on different keyframes.
    for (const pane of this.panes) pane._pauseOnNextFrame = !shouldPlay;   // consumed once in _onFrame, below
    this._alignPanes(this.panes, epoch, this.speed, shouldPlay);
  }

  /** Connects (or reconnects) every pane in `toConnect` (default: all of `panes`) to `epoch`, then pulls
   * any pane — connecting or already playing — that sits on an earlier real moment than the latest of its
   * siblings forward to match, so "the same seek" (or adding a camera mid-review) actually means the same
   * recorded instant across every camera, not just the same request.
   *
   * The real bug this fixes (found by testing directly against the DVR, not assumed): with an anchored
   * PlaybackReader, a *single* channel lands exactly on its requested target every time — there is no
   * meaningful DVR-side keyframe slop to correct for. The actual source of the gap was this function
   * itself: an already-playing pane's "current position" was read as a synchronous snapshot at the moment
   * connecting began, via `Promise.resolve(pane._lastAbsTime)` inside the same `Promise.all` that was still
   * waiting on the newly-connecting pane's session to negotiate (RTSP setup, DVR queueing — real time, not
   * instant). The already-playing pane keeps playing forward for that whole wait, so by the time the new
   * pane's first (correctly-anchored) frame arrives, the "target" it was compared against was already
   * stale — every pane looked aligned to the *value read before the wait*, not to where anyone actually was
   * once it was over. Fixed by reading every pane's position fresh, after every connect has finished, not
   * before it started. */
  async _alignPanes(panes, epoch, speed, shouldPlay, toConnect = panes) {
    const iso = new Date(epoch * 1000).toISOString();
    const seq = ++this._alignSeq;
    const connecting = new Set(toConnect);
    await Promise.all(panes.filter((pane) => connecting.has(pane)).map((pane) => new Promise((resolve) => {
      pane._alignResolve = (t) => { pane._alignResolve = null; resolve(t); };
      pane.player.connect(pane.cam.id, iso, speed);
      setTimeout(() => { if (pane._alignResolve) { const r = pane._alignResolve; pane._alignResolve = null; r(null); } }, 6000);
    })));
    if (seq !== this._alignSeq) return; // superseded by a newer seek/selection change while we were waiting
    // Fresh as of right now — an already-playing pane not in toConnect has kept advancing in real time for
    // however long the connects above took, so this must be read after awaiting them, not before.
    const landings = panes.map((pane) => pane._lastAbsTime ?? null);
    const known = landings.filter((t) => t != null);
    if (known.length < 2) return;
    const target = Math.max(...known);
    const targetIso = new Date(target * 1000).toISOString();
    const corrected = [];
    panes.forEach((pane, i) => {
      if (landings[i] != null && landings[i] < target - 0.35) {
        pane._pauseOnNextFrame = !shouldPlay; // _onFrame already consumed this once for the initial landing — re-arm for the correction
        corrected.push(new Promise((resolve) => {
          pane._alignResolve = (t) => { pane._alignResolve = null; resolve(); };
          pane.player.seek(targetIso, speed);
          setTimeout(() => { if (pane._alignResolve) { const r = pane._alignResolve; pane._alignResolve = null; r(); } }, 6000);
        }));
      }
    });
    // Waited on (not fire-and-forget) so a second, closely-spaced align (e.g. adding a 3rd camera right
    // after a 2nd) reads *this* round's corrected positions instead of racing them — resolved via the same
    // _alignResolve _onFrame already reports every landing through, so this is just confirming the
    // correction actually happened, not issuing a second one.
    await Promise.all(corrected);
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
    pane._lastAbsTime = absTime; // this pane's own last known real position — what _alignPanes compares an about-to-connect sibling against
    if (pane._alignResolve) pane._alignResolve(absTime); // reports this pane's actual landed position to _alignPanes, if a (re)connect is waiting on it
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
    // Consumes the flag seekTo() set: this pane just reconnected for a seek that wasn't a play request, so
    // hold here at the frame that actually landed rather than letting WCPlayer's default post-connect
    // "follow" behaviour keep streaming it forward in the background while the rest of the UI says paused.
    if (pane._pauseOnNextFrame) { pane._pauseOnNextFrame = false; pane.player.pauseHere(); }
  }

  _onPaneState(pane, s, msg) {
    const labels = { connecting: ['wait', 'Connecting…'], queued: ['wait', msg || 'Queued…'], playing: ['armed', 'Playing'],
      paused: ['', 'Paused'], error: ['off', msg || 'Error'], idle: ['', 'Idle'] };
    const [cls, label] = labels[s] || ['off', s];
    if (s === 'connecting' || s === 'queued') { pane.veil.hidden = false; pane.veil.className = 'pb-veil is-wait'; pane.veil.innerHTML = `<div class="msg">${esc(label)}</div>`; }
    if (s === 'error') { pane.veil.className = 'pb-veil'; pane.veil.innerHTML = `<div class="veil-ico">${icon('offline')}</div><div class="msg" title="${esc(msg || '')}">Couldn't play this moment — try another time or camera</div>`; }
    if (pane === this.panes[0]) this._onState(s, msg);
  }

  _onState(s, msg) {
    const dot = this.statusEl.querySelector('.dot');
    const txt = this.statusEl.querySelector('.txt');
    const labels = { connecting: ['wait', 'Connecting…'], queued: ['wait', msg || 'Queued…'], playing: ['armed', 'Playing'],
      paused: ['', 'Paused'], error: ['off', msg || 'Error'], idle: ['', 'Idle'] };
    const [cls, label] = labels[s] || ['off', s];
    dot.className = `dot ${cls}`;
    txt.textContent = label;
    if (s === 'error') { this.playing = false; this._paintPlayIcon(); }
  }

  async _pollPool() {
    if (this._poolTimer) return;
    const tick = async () => {
      try {
        const r = await getJSON('/api/playback/pool');
        // "recorder sessions" in its own span, CSS-hidden below the width it stops fitting — same
        // shorten-instead-of-wrap treatment as .nav/.brand's own secondary text, and the direct fix for a
        // real bug: this .pill has no min-width, so at exactly the widths where the topline is tightest
        // (touch drawer breakpoints, several buttons already competing for room) the text wrapped to two
        // lines inside the pill's fixed 24px height instead of the pill just being narrower — the tooltip
        // still carries the full meaning either way.
        this._pool = r;
        // Only surfaces when it matters (the recorder's shared session budget is full); otherwise it lives
        // in the camera picker's footer.
        this.poolEl.textContent = `${r.busy}/${r.limit} sessions`;
        this.poolEl.hidden = r.busy < r.limit;
      } catch { /* transient */ }
    };
    tick();
    this._poolTimer = setInterval(tick, 4000);
  }

  _renderTime() {
    const p = partsFromEpoch(this.currentEpoch, this.tzOffsetMin);
    this.timeEl.textContent = `${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`;
    if (this.dateEl) this.dateEl.textContent = `${MONTHS[p.mo]} ${p.da}, ${p.y}`;
    for (const pane of this.panes) { const t = pane.el.querySelector('.pb-pane-time'); if (t) t.textContent = this.timeEl.textContent; }
  }

  _paintPlayIcon() {
    this.root.querySelector('[data-a=playpause]').innerHTML = icon(this.playing ? 'pause' : 'play');
    // The AI frame enhancer (docs/SPEC.md section 7.8) operates on the exact frame on screen — while
    // playing that's a moving target, so it's disabled rather than silently grabbing whatever frame
    // happens to land at click time.
    const aiBtn = this.root.querySelector('[data-a=aienhance]');
    if (aiBtn) { aiBtn.disabled = this.playing; aiBtn.title = this.playing ? 'Frame enhancer — pause first' : 'Frame enhancer'; }
  }

  _key(e) {
    if (e.target.closest('input, select, textarea')) return;
    // A dialog (export, bookmark, the shortcuts overlay itself) already owns the keyboard while it's open —
    // without this, e.g. the shortcuts overlay's own Escape/Tab handling raced against this handler's own
    // key bindings underneath it (confirmed directly: Space toggled playback behind an open dialog).
    if (document.getElementById('modal-root').firstChild) return;
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
  // Export board: a full screen, not a dialog — the frame at the playhead, a Trim bar, the two package
  // choices as cards, and the multi-cut clip list one tap away ("Clips N"). Every export reuses a real DVR
  // playback session per channel (the same 4-session pool a pane uses), so it can queue like a 5th pane.
  /** @param range optional [startEpoch, endEpoch] (a timeline drag-select); defaults to ±15s around the playhead. */
  openExportDialog(range) { this._openExport(range, false); }

  openClipListDialog() { this._openExport(null, true); }

  _openExport(range, clipsMode) {
    if (!this.panes.length) return;
    const now = () => Date.now() / 1000;
    let a = range?.[0] ?? this.currentEpoch - 15;
    let b = Math.min(range?.[1] ?? this.currentEpoch + 15, now());
    // The Trim bar's window: the selection with room either side to widen it by dragging.
    let w0, w1;
    const fitWindow = () => {
      const pad = Math.max(30, (b - a) * 0.5);
      w0 = a - pad; w1 = Math.min(b + pad, now());
      if (w1 - w0 < (b - a) * 1.5) w0 = w1 - (b - a) * 1.5 - 1;
    };
    fitWindow();
    let pkg = 'signed', running = false, mode = clipsMode ? 'clips' : 'single';
    const cams = this.panes.map((p) => p.cam);
    const camNames = cams.map((c) => c.name || 'Camera ' + c.channel);
    const tp = (t) => partsFromEpoch(t, this.tzOffsetMin);
    const hms = (t) => { const p = tp(t); return `${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`; };
    const md = (t) => { const p = tp(t); return `${MONTHS[p.mo]} ${p.da}`; };
    const dur = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`; };
    const eta = (span) => { const s = Math.max(10, span / EXPORT_SCALE * cams.length); return s < 60 ? `about ${Math.ceil(s / 5) * 5} s` : `about ${Math.ceil(s / 60)} min`; };
    const files = [...cams.map((c) => `clip_${(c.name || 'ch' + c.channel).replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`), 'manifest.json', 'signature.json', 'verify.html'];

    const root = modalRoot();
    root.innerHTML = `<div class="xp" role="dialog" aria-modal="true" aria-label="Export clip">
      ${barHTML({ lead: 'back', title: 'Export clip', sub: '<span class="xp-sub"></span>',
        actions: `<button class="btn glass-btn xp-clips" data-x="clips" aria-pressed="false">${icon('list')} Clips <span class="count"></span></button>` })}
      <div class="xp-body">
        <div class="xp-left">
          <div class="xp-preview"><canvas></canvas><div class="pb-pane-label"><b>${esc(camNames[0])}</b>${cams.length > 1 ? `<span class="tag kind">+${cams.length - 1}</span>` : ''}</div></div>
          <div class="xp-trim-head"><h4>Trim</h4><span class="hint">Drag the handles, or set exact times</span></div>
          <div class="xp-trim" tabindex="-1">
            <div class="xp-track"><div class="xp-sel" role="group" aria-label="Clip range">
              <button class="xp-h" data-h="a" aria-label="Clip start — arrow keys nudge 1 s"></button>
              <span class="xp-dur"></span>
              <button class="xp-h" data-h="b" aria-label="Clip end — arrow keys nudge 1 s"></button>
            </div></div>
            <div class="xp-ends"><span class="w0"></span><span class="w1"></span></div>
          </div>
          <div class="xp-exact"><button class="btn sm ghost" data-x="seta">Start <b class="ta"></b></button><button class="btn sm ghost" data-x="setb">End <b class="tb"></b></button></div>
        </div>
        <div class="xp-right">
          <div class="xp-clipsview" hidden>
            <div class="xp-clips-head"><h4>Clips</h4><button class="btn sm ghost" data-x="clear">Clear all</button></div>
            <div class="clip-rows"></div>
          </div>
          <div class="xp-pkgs" role="radiogroup" aria-label="Package">
            <label class="xp-pkg"><input type="radio" name="xp-pkg" value="signed" checked><span class="xp-radio"></span><span>
              <b>Signed evidence package</b>
              <small>Recommended — the clip, a manifest covering every file's SHA-256 hash and the exact time range, an Ed25519 signature, and an offline verify.html that checks it all with nothing installed.</small>
              <span class="xp-files">${files.map((f) => `<span>${esc(f)}</span>`).join('')}</span></span></label>
            <label class="xp-pkg"><input type="radio" name="xp-pkg" value="plain"><span class="xp-radio"></span><span>
              <b>Plain MP4</b>
              <small>Just the clip — a quick look, not an evidence package. Stream copy, no re-encoding, no quality loss either way.</small></span></label>
          </div>
          <span class="spacer"></span>
          <div class="xp-meta"><span class="k">Takes</span><span class="v"></span></div>
          <p class="xp-status" aria-live="polite" hidden></p>
          <button class="btn xp-add" data-x="add">${icon('plus')} Add to clips, keep trimming</button>
          <button class="btn primary xp-go" data-x="go"></button>
        </div>
      </div></div>`;
    const el = root.querySelector('.xp');
    const $ = (sel) => el.querySelector(sel);
    const backButton = $('[data-bar=back]');
    backButton.title = 'Back to Playback'; backButton.setAttribute('aria-label', 'Back to Playback');
    const statusEl = $('.xp-status');
    const setStatus = (txt, cls = '') => { statusEl.hidden = !txt; statusEl.className = `xp-status ${cls}`; statusEl.innerHTML = txt || ''; };

    // The still at the playhead, copied from the primary pane (the board's preview).
    try {
      const src = this.panes[0].canvas, dst = $('.xp-preview canvas');
      if (src.width && src.height) { dst.width = src.width; dst.height = src.height; dst.getContext('2d').drawImage(src, 0, 0); }
    } catch { /* nothing decoded yet — the empty preview is fine */ }

    const paint = () => {
      const span = w1 - w0;
      $('.xp-sub').textContent = `${camNames.join(', ')} · ${md(a)}, ${hms(a)} – ${md(b) !== md(a) ? md(b) + ', ' : ''}${hms(b)}`;
      const sel = $('.xp-sel');
      sel.style.left = `${((a - w0) / span) * 100}%`;
      sel.style.width = `${((b - a) / span) * 100}%`;
      $('.xp-dur').textContent = dur(b - a);
      $('.w0').textContent = hms(w0); $('.w1').textContent = hms(w1);
      $('.ta').textContent = hms(a); $('.tb').textContent = hms(b);
      const tooLong = b - a > 2 * 3600;
      $('.xp-meta .v').textContent = tooLong ? 'Up to 2 hours per export' : eta(mode === 'clips' ? this.clips.reduce((n, [x, y]) => n + y - x, 0) || b - a : b - a);
      $('.xp-meta').classList.toggle('bad', tooLong);
      const n = this.clips.length;
      $('.xp-clips .count').textContent = n ? String(n) : '';
      $('.xp-clips').hidden = !n && mode !== 'clips';
      $('.xp-clips').setAttribute('aria-pressed', String(mode === 'clips'));
      $('.xp-clipsview').hidden = mode !== 'clips';
      const go = $('.xp-go');
      if (!running) go.innerHTML = mode === 'clips' ? `Export all${n ? ` (${n})` : ''}` : 'Export clip';
      go.disabled = running || (mode === 'clips' ? !n : tooLong);
      $('.xp-add').disabled = running || tooLong;
      $('[data-x=clear]').disabled = running || !n;
      if (mode === 'clips') renderClips();
    };
    const renderClips = () => {
      const rows = $('.clip-rows');
      rows.innerHTML = this.clips.length ? this.clips.map(([x, y], i) => `
        <div class="clip-row" data-i="${i}"><span class="clip-idx">${i + 1}</span><span class="clip-range">${esc(md(x))}, ${hms(x)} – ${hms(y)}</span><span class="clip-dur">${dur(y - x)}</span><span class="clip-status hint"></span><button class="btn icon sm ghost" data-x="rm" title="Remove" aria-label="Remove clip ${i + 1}" ${running ? 'disabled' : ''}>${icon('trash')}</button></div>`).join('')
        : '<p class="hint">No clips yet — trim a range on the left and choose “Add to clips”.</p>';
      rows.querySelectorAll('[data-x=rm]').forEach((btn) => btn.addEventListener('click', () => {
        this.clips.splice(+btn.closest('.clip-row').dataset.i, 1); this._syncClipUi(); paint();
      }));
    };

    // Trim: drag a handle, drag the selection to move it, arrow keys nudge a focused handle by a second.
    const track = $('.xp-track');
    const tAt = (clientX) => { const r = track.getBoundingClientRect(); return w0 + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (w1 - w0); };
    const setRange = (na, nb) => { a = Math.max(w0, Math.min(na, nb - 1)); b = Math.min(w1, now(), Math.max(nb, a + 1)); paint(); };
    track.addEventListener('pointerdown', (e) => {
      if (running) return;
      const h = e.target.closest('.xp-h')?.dataset.h;
      const onSel = !h && e.target.closest('.xp-sel');
      if (!h && !onSel) return;
      e.preventDefault();
      track.setPointerCapture(e.pointerId);
      const t0 = tAt(e.clientX), a0 = a, b0 = b;
      const move = (ev) => {
        const t = tAt(ev.clientX);
        if (h === 'a') setRange(Math.round(t), b);
        else if (h === 'b') setRange(a, Math.round(t));
        else { const d = Math.max(w0 - a0, Math.min(Math.min(w1, now()) - b0, t - t0)); setRange(Math.round(a0 + d), Math.round(b0 + d)); }
      };
      const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up); };
      track.addEventListener('pointermove', move); track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
    });
    el.querySelectorAll('.xp-h').forEach((btn) => btn.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (!d || running) return;
      e.preventDefault();
      const step = d * (e.shiftKey ? 10 : 1);
      if (btn.dataset.h === 'a') { if (a + step < w0) w0 = a + step; setRange(a + step, b); } else { if (b + step > w1) w1 = Math.min(now(), b + step); setRange(a, b + step); }
    }));
    // Exact times: the shared picker in a popover; a time outside the window widens it.
    const exact = (which, btn) => {
      const menu = openPopover(btn, '<div class="xp-exact-pop"><div class="host"></div></div>', { className: 'cal-popover xp-exact-popover', align: 'left' });
      if (!menu) return;
      new DateTimePicker(menu.querySelector('.host'), {
        epoch: which === 'a' ? a : b, tzOffsetMin: this.tzOffsetMin, coverageChannel: this.primary.channel,
        onChange: (t) => {
          t = Math.min(t, now());
          if (which === 'a') { a = t; if (b <= a) b = Math.min(now(), a + 30); } else { b = t; if (a >= b) a = b - 30; }
          if (a < w0 || b > w1) fitWindow();
          paint();
        },
      });
    };
    $('[data-x=seta]').addEventListener('click', (e) => exact('a', e.currentTarget));
    $('[data-x=setb]').addEventListener('click', (e) => exact('b', e.currentTarget));

    el.querySelectorAll('input[name=xp-pkg]').forEach((r) => r.addEventListener('change', () => { pkg = r.value; }));
    $('[data-x=clips]').addEventListener('click', () => { mode = mode === 'clips' ? 'single' : 'clips'; setStatus(''); paint(); });
    $('[data-x=clear]').addEventListener('click', () => { this.clips = []; this._syncClipUi(); paint(); });
    $('[data-x=add]').addEventListener('click', () => {
      this._addClip(a, b);
      // Keep trimming: step past the clip just added so the next one starts where it ended.
      const span = b - a;
      if (b + 1 < now()) { a = b; b = Math.min(now(), a + span); if (b > w1) fitWindow(); }
      paint();
    });

    const close = () => {
      root._dispose = null;
      if (running) toast('Export continues in the background — it downloads when ready.', 'ok', 5000);
      document.removeEventListener('keydown', onKey, true);
      root.innerHTML = '';
    };
    root._dispose = close;
    const onKey = (e) => { if (e.key === 'Escape' && !document.body._openPopover) { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey, true);
    $('[data-bar=back]').addEventListener('click', close);

    const go = $('.xp-go');
    const busy = (txt) => { go.innerHTML = `<span class="spin sm"></span> ${esc(txt)}`; };
    go.addEventListener('click', async () => {
      running = true; paint();
      if (mode === 'single') {
        setStatus('');
        busy('Starting export…');
        try {
          const jobId = await this._runExportOne(a, b, pkg, (msg) => busy(msg));
          const link = document.createElement('a');
          link.href = `/api/export/${jobId}/download`; link.click();
          toast('Export ready — download started.', 'ok');
          setStatus(`${icon('checkcircle')} Exported. <a href="/api/export/${jobId}/download">Download again</a>${pkg === 'signed' ? ' · open verify.html inside to check it' : ''}`, 'ok');
        } catch (e) {
          setStatus(esc(e.message || 'Export failed.'), 'bad');
        }
      } else {
        const rows = [...el.querySelectorAll('.clip-row')];
        const done = [];
        for (let i = 0; i < this.clips.length; i++) {
          const [x, y] = this.clips[i];
          const cell = rows[i]?.querySelector('.clip-status');
          busy(`Clip ${i + 1} of ${this.clips.length}…`);
          if (cell) cell.textContent = 'Starting…';
          try {
            const jobId = await this._runExportOne(x, y, pkg, (msg) => { if (cell) cell.textContent = msg; });
            if (cell) cell.innerHTML = `<a href="/api/export/${jobId}/download">Download</a>`;
            done.push(i);
          } catch (e) {
            if (cell) cell.textContent = e.message || 'Failed';
          }
        }
        // Finished clips leave the pending list, but their rows (each with its download link) stay on screen
        // until the next change — redrawing now would drop the links before anyone could click them.
        this.clips = this.clips.filter((_, i) => !done.includes(i));
        this._syncClipUi();
        toast(`${done.length}/${rows.length} clip${rows.length > 1 ? 's' : ''} exported.`, done.length === rows.length ? 'ok' : 'bad');
        running = false;
        $('.xp-clips .count').textContent = this.clips.length ? String(this.clips.length) : '';
        go.innerHTML = `Export all${this.clips.length ? ` (${this.clips.length})` : ''}`;
        go.disabled = !this.clips.length;
        $('.xp-add').disabled = false;
        return;
      }
      running = false; paint();
    });
    paint();
    $('.xp-go').focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- multi-cut clipper (spec 10/15)
  // A non-destructive list of pending ranges, exported as one batch from the export screen's Clips view.
  // Each clip still goes through the single-range /api/export job one at a time: the DVR's 4-session
  // budget is a hard ceiling shared with live playback (spec 2.2/7.3), so running them one after another —
  // never in parallel — keeps a big batch from starving whatever else is using the recorder.
  _addClip(startEpoch, endEpoch) {
    if (endEpoch <= startEpoch) return;
    this.clips.push([startEpoch, endEpoch]);
    this._syncClipUi();
    toast(`Added to clips (${this.clips.length} pending).`, 'ok');
  }

  _syncClipUi() {
    // Pending clips ride on Playback's Export button (Export board's "Clips N"): with any pending, Export
    // opens straight into the Clips view.
    const n = this.root.querySelector('[data-a=export] .clip-count');
    if (n) { n.hidden = this.clips.length === 0; n.textContent = String(this.clips.length); }
    this.timeline?.setClips(this.clips);
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
    // The server exports as fast as the recorder's playback budget allows at that moment — 16x when nothing
    // else is playing, as slow as 1x alongside a busy review — so allow for the slow case here.
    const perChannel = Math.max(90, spanSec * 3 + 60);
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
    this._dead = true;
    this.viewerControls?.destroy();
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    if (this._onFsChange) document.removeEventListener('fullscreenchange', this._onFsChange);
    clearInterval(this._poolTimer);
    clearTimeout(this._hideTimer);
    this._teardownPanes();
    this.timeline?.destroy();
    this.root.innerHTML = '';
  }
}
