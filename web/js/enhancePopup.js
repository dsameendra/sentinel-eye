// AI Frame Enhancer (docs/SPEC.md section 7.8; Enhance board) — a full screen in two steps:
//   1. Pick frames: a large preview of the reference frame (the middle of the ones selected — what the
//      server aligns the others to), cropped to the region when one is set, over a strip of the up-to-11
//      frames grabbed around the paused one. Choose any of them (more means multi-frame fusion — denoise, at
//      the risk of softening a moving subject), and optionally select a region (a plate, a face) first.
//   2. Compare: the server's Real-ESRGAN + GFPGAN result against its own source frame with a before/after
//      wipe, zoom/pan, fidelity, the "wand" live filters and flashlight, a progress stepper, what was
//      detected, OCR on demand, and Discard / Save.
// Forensic-integrity rules are built in, not described: the source (pre-AI) frame is always fetched
// alongside the enhanced one, and the "ENHANCED" label is on screen whenever any enhanced pixels are.
import { esc, icon, toast, openPopover } from './ui.js';
import { ZoomPan } from './zoom.js';
import { api } from './api.js';
import { Enhancer, PRESETS as FILTER_PRESETS } from './enhance.js';
import { enhancePanelHTML, wireEnhancePanel } from './enhancePanel.js';
import { partsFromEpoch } from './dvrtime.js';

const PLATE_KEY = 'sentinel-eye-ocr-plate';   // "Number plate" in Read text, remembered
const MODES = [['auto', 'Auto'], ['face', 'Face'], ['plate', 'Plate'], ['general', 'General']];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad2 = (n) => String(n).padStart(2, '0');

/** @param opts { frames: [VideoFrame | ImageBitmap | canvas | img, ...] (oldest->newest; closed when the
 *  enhancer closes), pausedIndex (which one is on screen), camName, channel (DVR channel number), atUtc
 *  (ISO), tzOffsetMin, defaultMode, defaultFidelity } */
export function openEnhancePopup(opts) {
  const root = document.getElementById('modal-root');
  const burst = opts.frames;
  const size = (f) => [f.displayWidth || f.naturalWidth || f.width, f.displayHeight || f.naturalHeight || f.height];
  const [FW, FH] = size(burst[0]);
  const FAR = FW / FH;
  // Small JPEGs for the strip (fast); the full frames are only encoded — as lossless PNG — for the ones sent.
  const thumb = (f, w = 320) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = Math.round(w / FAR);
    c.getContext('2d').drawImage(f, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  };
  const encodePNG = async (f) => {
    const c = document.createElement('canvas');
    c.width = FW; c.height = FH;
    c.getContext('2d').drawImage(f, 0, 0, FW, FH);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  };
  const thumbs = burst.map((f) => thumb(f));
  const paused = clamp(opts.pausedIndex ?? Math.floor(burst.length / 2), 0, burst.length - 1);
  let mode = opts.defaultMode || 'auto';
  // Fidelity: a real linear blend between GFPGAN's face restoration and a plain upscale with no face
  // synthesis at all (spec 2d) — NOT GFPGANer's own `weight` argument, which does nothing in the installed
  // package. 0.5 (Settings > Enhancement default) is the recommended middle ground.
  let weight = opts.defaultFidelity ?? 0.5;
  // Only the paused frame to start: fusion helps a static, noisy scene but can soften a moving subject
  // even with the motion-adaptive weighting (app/enhance_ai.py's _align_and_fuse), so it's opt-in.
  const picked = new Set([paused]);
  // Fractions (0-1) of the frame to crop to before enhancing (spec 2c); null = whole frame.
  let roi = null;
  let step = 'pick';
  let job = null;          // { job_id, resultUrl, sourceUrl, faces, frames, roiUsed }
  let split = 50;          // wipe position, % of the stage width
  let running = false;
  let zoom = null;
  let filterParams = { ...FILTER_PRESETS.off };
  let filterFlashlight = false;
  let liveFilter = null;

  let when = '';
  if (opts.atUtc) {
    const t = Date.parse(opts.atUtc) / 1000;
    const p = opts.tzOffsetMin != null ? partsFromEpoch(t, opts.tzOffsetMin) : null;
    when = p ? `${MONTHS[p.mo]} ${p.da}, ${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`
      : new Date(t * 1000).toLocaleString(undefined, { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  root.innerHTML = `<div class="enh2" role="dialog" aria-modal="true" aria-label="AI Frame Enhancer">
    <header class="topbar appbar enh2-bar">
      <button class="btn icon ghost bar-back" data-x="back" aria-label="Back">${icon('left')}</button>
      <div class="bar-title"><h1>AI Frame Enhancer</h1><div class="bar-sub">${esc([opts.camName, when].filter(Boolean).join(' · '))}</div></div>
      <span class="spacer"></span>
      <div class="bar-actions"><div class="seg enh2-modes" role="group" aria-label="Mode">${MODES.map(([k, l]) => `<button data-mode="${k}" aria-pressed="${k === mode}">${l}</button>`).join('')}</div></div>
    </header>
    <section class="enh2-pick">
      <div class="enh2-pv" title="Select a region"><canvas class="enh2-pv-c" aria-label="Preview of the reference frame"></canvas></div>
      <p class="enh2-pv-cap"><span class="what"></span><span class="roi"></span></p>
      <div class="enh2-strip" role="group" aria-label="Frames, oldest to newest">${thumbs.map((src, i) => `<div class="enh2-frame" data-i="${i}" role="checkbox" tabindex="0" aria-label="Frame ${i + 1} of ${burst.length}${i === paused ? ', the paused frame' : ''}">
        <img src="${src}" alt="" draggable="false"><span class="ck">${icon('check')}</span>${i === paused ? '<span class="enh2-here" title="The paused frame"></span>' : ''}<span class="enh2-roi" hidden></span></div>`).join('')}</div>
      <div class="enh2-pick-bar">
        <p class="enh2-cap"></p>
        <span class="spacer"></span>
        <button class="btn ghost" data-x="clear-roi" hidden>Whole frame</button>
        <button class="btn glass-btn" data-x="edit-roi">${icon('crop')}<span>Select region</span></button>
        <button class="btn primary enh2-go" data-x="go"></button>
      </div>
    </section>
    <section class="enh2-crop" hidden>
      <div><h2>Select a region</h2><p class="enh2-cap">Drag the box, or its corners, to fit a plate or a face. Only this part of the frame is enhanced — every output pixel goes to it. Drag anywhere outside the box to draw a new one.</p></div>
      <div class="enh2-crop-stage"><div class="enh2-crop-wrap" style="--ar:${FAR.toFixed(4)}"><canvas class="enh2-crop-c" width="${FW}" height="${FH}" aria-label="The reference frame"></canvas>
        <div class="enh2-crop-box" tabindex="0" role="group" aria-label="Region — arrow keys move it, Shift for bigger steps">${['nw', 'ne', 'sw', 'se'].map((h) => `<span class="h" data-h="${h}"></span>`).join('')}<span class="dims"></span></div></div></div>
      <div class="enh2-crop-actions"><button class="btn ghost" data-x="crop-whole">Whole frame</button><span class="spacer"></span>
        <button class="btn glass-btn" data-x="crop-cancel">Cancel</button><button class="btn primary" data-x="crop-done">Use this region</button></div>
    </section>
    <section class="enh2-result" hidden>
      <div class="enh2-main">
        <div class="enh2-stage">
          <div class="enh2-pic">
            <img class="enh2-img enh2-src" alt="Original frame">
            <div class="enh2-after"><img class="enh2-img enh2-res" alt="Enhanced frame"><canvas class="enh2-filter" hidden></canvas></div>
            <div class="enh2-ocrlayer" hidden><div class="enh2-ocrbox" tabindex="0" role="group" aria-label="Text box — arrow keys move it, [ and ] turn it, 0 levels it, Enter reads">
              ${['nw', 'ne', 'sw', 'se'].map((h) => `<span class="h" data-h="${h}"></span>`).join('')}<span class="rot" data-h="rot" title="Turn the box to follow slanted text"></span><span class="ang"></span></div></div>
          </div>
          <div class="hitzone"></div>
          <span class="enh2-tag l">Before</span><span class="enh2-tag r">After</span>
          <div class="enh2-split" role="slider" tabindex="0" aria-label="Before and after divider" aria-valuemin="0" aria-valuemax="100"><span>${icon('left')}${icon('right')}</span></div>
          <button class="zoomtag" hidden title="Reset zoom">Reset</button>
          <div class="enh2-busy"><span class="spin"></span><span class="msg">Starting…</span></div>
          <div class="enh2-ocrbar" hidden><span class="t">Drag a box around the text. Turn it with the round handle if the text is slanted.</span>
            <label class="enh2-plate" title="Reads it as a licence plate — a plate reader, plate characters only"><input type="checkbox" data-x="ocr-plate"> Number plate</label>
            <button class="btn sm glass-btn" data-x="ocr-cancel">Cancel</button><button class="btn sm primary" data-x="ocr-read">Read text</button></div>
        </div>
        <div class="enh2-badge" role="note">${icon('alert')}<span><b>ENHANCED</b> — reconstructed detail, not the original recording. An investigative lead, not evidence.</span></div>
        <div class="enh2-under">
          <label class="enh2-fid"><span>Fidelity</span><input type="range" data-x="weight" min="0" max="1" step="0.05" value="${weight}" aria-label="Fidelity"><span>Identity-safe</span></label>
          <span class="spacer"></span>
          <button class="btn icon ghost" data-x="wand" aria-pressed="false" title="Live filters and flashlight — for looking only; never changes what Save writes" aria-label="Live filters">${icon('wand')}</button>
          <button class="btn icon ghost" data-x="fullscreen" title="Full screen" aria-label="Full screen">${icon('expand')}</button>
        </div>
      </div>
      <aside class="enh2-side">
        <div class="card"><h3>Progress</h3><div class="enh-steps"></div></div>
        <div class="card"><h3>Detected</h3><p class="enh2-detected">—</p></div>
        <div class="card"><h3>Read text</h3><div class="enh2-ocr"></div></div>
        <div class="enh2-actions">
          <button class="btn glass-btn" data-x="discard">Discard</button>
          <button class="btn primary" data-x="save" disabled>Save result</button>
        </div>
        <button class="btn sm ghost enh2-saveorig" data-x="save-source" disabled>Save the original frame</button>
      </aside>
    </section>
  </div>`;

  const $ = (s) => root.querySelector(s);
  const viewer = $('.enh2');
  const stage = $('.enh2-stage'), pic = $('.enh2-pic');
  const imgSrc = $('.enh2-src'), imgRes = $('.enh2-res'), after = $('.enh2-after');
  const filterCanvas = $('.enh2-filter');
  const splitEl = $('.enh2-split');
  const busyEl = $('.enh2-busy');
  const zoomtag = $('.zoomtag');

  // ---------------------------------------------------------------- step 1: pick frames (+ optional region)
  // The preview shows the reference frame — the middle of the selected ones, which the server aligns the
  // others to — or, while the pointer rests on a frame in the strip, that frame. With a region set it shows
  // just the region, large. Thumbnails keep the frame's own shape, so the region drawn over them in
  // fractions lines up exactly with what the server crops.
  root.querySelectorAll('.enh2-frame').forEach((el) => el.style.setProperty('--ar', FAR.toFixed(4)));
  const pv = $('.enh2-pv'), pvc = $('.enh2-pv-c');
  let hoverI = null;
  const refIndex = () => { const sel = [...picked].sort((a, b) => a - b); return sel.length ? sel[Math.floor(sel.length / 2)] : paused; };
  const paintPreview = () => {
    const i = hoverI ?? refIndex();
    const r = roi || { x: 0, y: 0, w: 1, h: 1 };
    const sw = r.w * FW, sh = r.h * FH;
    const scale = Math.min(1, 1600 / Math.max(sw, sh)) * (roi ? Math.max(1, 900 / Math.max(sw, sh)) : 1);   // small regions drawn larger, smoothly
    pvc.width = Math.max(1, Math.round(sw * scale)); pvc.height = Math.max(1, Math.round(sh * scale));
    const g = pvc.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(burst[i], r.x * FW, r.y * FH, sw, sh, 0, 0, pvc.width, pvc.height);
    pv.style.setProperty('--pv-ar', (sw / sh).toFixed(4));
    const sel = picked.size;
    $('.enh2-pv-cap .what').textContent = hoverI != null ? `Frame ${i + 1} of ${burst.length}${i === paused ? ' · the paused frame' : ''}`
      : sel > 1 ? `Reference frame ${i + 1} of ${burst.length} — the other ${sel - 1} are aligned to it and fused` : `Frame ${i + 1} of ${burst.length}${i === paused ? ' · the paused frame' : ''}`;
    $('.enh2-pv-cap .roi').textContent = roi ? ` · region ${Math.round(sw)} × ${Math.round(sh)} px` : '';
    root.querySelectorAll('.enh2-frame').forEach((el) => el.classList.toggle('ref', +el.dataset.i === refIndex() && picked.size > 0));
  };
  const paintPick = () => {
    const n = picked.size;
    $('.enh2-cap').innerHTML = `${n} of ${burst.length} selected. More frames fuse into a cleaner picture while the subject barely moves. `
      + `<button class="linkish" data-x="all">${n === burst.length ? '' : 'Select all'}</button>${n === burst.length ? '' : ' · '}<button class="linkish" data-x="only">Only the paused frame</button>`;
    root.querySelectorAll('.enh2-frame').forEach((el) => {
      const on = picked.has(+el.dataset.i);
      el.classList.toggle('on', on);
      el.setAttribute('aria-checked', String(on));
      const box = el.querySelector('.enh2-roi');
      box.hidden = !roi;
      if (roi) Object.assign(box.style, { left: `${roi.x * 100}%`, top: `${roi.y * 100}%`, width: `${roi.w * 100}%`, height: `${roi.h * 100}%` });
    });
    $('[data-x=clear-roi]').hidden = !roi;
    $('[data-x=edit-roi] span').textContent = roi ? 'Edit region' : 'Select region';
    $('.enh2-go').textContent = n ? `Enhance ${n} frame${n === 1 ? '' : 's'}` : 'Select a frame';
    $('.enh2-go').disabled = n === 0 || running;
    paintPreview();
  };
  const toggleFrame = (i) => { if (picked.has(i)) picked.delete(i); else picked.add(i); paintPick(); };
  root.querySelectorAll('.enh2-frame').forEach((el) => {
    const i = +el.dataset.i;
    el.addEventListener('click', () => toggleFrame(i));
    el.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleFrame(i); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); el[e.key === 'ArrowLeft' ? 'previousElementSibling' : 'nextElementSibling']?.focus(); }
    });
    el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hoverI = i; paintPreview(); } });
    el.addEventListener('pointerleave', () => { if (hoverI === i) { hoverI = null; paintPreview(); } });
  });
  $('.enh2-pick-bar').addEventListener('click', (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'all') { burst.forEach((_, i) => picked.add(i)); paintPick(); }
    else if (x === 'only') { picked.clear(); picked.add(paused); paintPick(); }
  });
  $('[data-x=clear-roi]').addEventListener('click', () => { roi = null; paintPick(); });
  $('[data-x=edit-roi]').addEventListener('click', () => openCrop());
  pv.addEventListener('click', () => openCrop());

  // ---------------------------------------------------------------- the region editor
  // The paused frame, large, with a box to move (drag inside), resize (drag a corner) or redraw (drag
  // outside). Fractions are of the image's own box, which the wrapper hugs exactly.
  const MIN = 0.03;
  let draft = null;
  const wrap = $('.enh2-crop-wrap'), cbox = $('.enh2-crop-box');
  const paintCrop = () => {
    Object.assign(cbox.style, { left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` });
    cbox.querySelector('.dims').textContent = `${Math.round(draft.w * FW)} × ${Math.round(draft.h * FH)} px`;
  };
  const openCrop = () => {
    wrap.querySelector('canvas').getContext('2d').drawImage(burst[refIndex()], 0, 0, FW, FH);   // the frame the preview shows
    draft = roi ? { ...roi } : { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
    showStep('crop');
    paintCrop();
    cbox.focus({ preventScroll: true });
  };
  const fracAt = (e) => { const r = wrap.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }; };
  wrap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const p0 = fracAt(e), d0 = { ...draft };
    const handle = e.target.closest('.h')?.dataset.h;
    const inside = !handle && e.target.closest('.enh2-crop-box');
    const move = (ev) => {
      const p = fracAt(ev);
      if (handle) {
        // The corner opposite the one held stays put.
        const ax = handle.includes('w') ? d0.x + d0.w : d0.x, ay = handle.includes('n') ? d0.y + d0.h : d0.y;
        const bx = clamp(p.x, 0, 1), by = clamp(p.y, 0, 1);
        draft = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.max(MIN, Math.abs(bx - ax)), h: Math.max(MIN, Math.abs(by - ay)) };
      } else if (inside) {
        draft = { ...d0, x: clamp(d0.x + p.x - p0.x, 0, 1 - d0.w), y: clamp(d0.y + p.y - p0.y, 0, 1 - d0.h) };
      } else {
        draft = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.max(MIN, Math.abs(p.x - p0.x)), h: Math.max(MIN, Math.abs(p.y - p0.y)) };
      }
      draft.w = Math.min(draft.w, 1 - draft.x); draft.h = Math.min(draft.h, 1 - draft.y);
      paintCrop();
    };
    const up = () => { wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', up); wrap.removeEventListener('pointercancel', up); };
    wrap.addEventListener('pointermove', move); wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
  });
  cbox.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    draft.x = clamp(draft.x + d[0], 0, 1 - draft.w); draft.y = clamp(draft.y + d[1], 0, 1 - draft.h);
    paintCrop();
  });
  $('[data-x=crop-whole]').addEventListener('click', () => { roi = null; showStep('pick'); });
  $('[data-x=crop-cancel]').addEventListener('click', () => showStep('pick'));
  $('[data-x=crop-done]').addEventListener('click', () => {
    // A box covering (nearly) everything is the whole frame — no crop at all.
    roi = draft.w > 0.97 && draft.h > 0.97 ? null : { ...draft };
    showStep('pick');
  });
  $('[data-x=go]').addEventListener('click', () => { showStep('result'); run(); });

  const showStep = (s) => {
    step = s;
    $('.enh2-pick').hidden = s !== 'pick';
    $('.enh2-crop').hidden = s !== 'crop';
    $('.enh2-result').hidden = s !== 'result';
    $('[data-x=back]').setAttribute('aria-label', s === 'pick' ? 'Close' : 'Back to frames');
    if (s === 'pick') paintPick();
  };

  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    root.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.mode === mode)));
    $('.enh2-fid').hidden = !(mode === 'face' || mode === 'auto');
    if (step === 'result' && !running) run();
  }));
  $('.enh2-fid').hidden = !(mode === 'face' || mode === 'auto');

  // ---------------------------------------------------------------- step 2: compare
  zoom = new ZoomPan(stage, $('.hitzone'), {
    dbl: true,
    onChange: (st) => { zoomtag.hidden = st.s <= 1.001; zoomtag.textContent = `${Math.round(st.s * 100)}%`; paintSplit(); },
  });
  zoomtag.addEventListener('click', () => zoom.reset());
  const ro = new ResizeObserver(() => paintSplit());
  ro.observe(stage);

  /** The wipe: the divider lives in stage (screen) space; the clip is applied to the zoomed picture, so it
   * is converted to the picture's own fraction each time either one moves. */
  function paintSplit() {
    const hasResult = !!job?.resultUrl;
    splitEl.hidden = !hasResult;
    $('.enh2-tag.l').hidden = !hasResult; $('.enh2-tag.r').hidden = !hasResult;
    if (!hasResult) { after.style.clipPath = 'none'; $('.enh2-badge').hidden = true; return; }   // nothing enhanced on screen
    $('.enh2-badge').hidden = false;
    const sr = stage.getBoundingClientRect(), ir = imgSrc.getBoundingClientRect();
    splitEl.style.left = `${split}%`;
    splitEl.setAttribute('aria-valuenow', String(Math.round(split)));
    const x = sr.left + (split / 100) * sr.width;
    const f = ir.width ? clamp((x - ir.left) / ir.width, 0, 1) : split / 100;
    after.style.clipPath = `inset(0 0 0 ${(f * 100).toFixed(2)}%)`;
    $('.enh2-badge').classList.toggle('off', f >= 0.999);   // wiped all the way to Before: no enhanced pixels (kept in place, no jump)
  }
  splitEl.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    splitEl.setPointerCapture(e.pointerId);
    const move = (ev) => { const r = stage.getBoundingClientRect(); split = clamp(((ev.clientX - r.left) / r.width) * 100, 0, 100); paintSplit(); };
    const up = () => { splitEl.removeEventListener('pointermove', move); splitEl.removeEventListener('pointerup', up); };
    splitEl.addEventListener('pointermove', move); splitEl.addEventListener('pointerup', up);
  });
  splitEl.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0;
    if (d) { e.preventDefault(); split = clamp(split + d, 0, 100); paintSplit(); }
  });

  const weightInput = $('[data-x=weight]');
  weightInput.addEventListener('change', () => { weight = Number(weightInput.value); if (!running) run(); });

  // "wand" live filters + flashlight: the same WebGL engine and panel as Live/Playback, painted over the
  // enhanced side (or the source, when there's no result). Inspection only — never touches the AI output
  // or what Save writes (spec 6's forensic rules apply to the real pipeline, not this aid).
  const filterSource = () => (job?.resultUrl ? imgRes : imgSrc);
  const filterOff = () => Object.entries(FILTER_PRESETS.off).every(([k, v]) => k === 'label' || filterParams[k] === v) && !filterFlashlight;
  function applyLiveFilter() {
    $('[data-x=wand]').setAttribute('aria-pressed', String(!filterOff()));
    if (filterOff() || !job) { liveFilter?.stop(); filterCanvas.hidden = true; return; }
    if (!liveFilter) { liveFilter = new Enhancer(filterSource(), filterCanvas); if (!liveFilter.supported) { liveFilter = null; return; } }
    else liveFilter.source = filterSource();
    liveFilter.setParams(filterParams);
    filterCanvas.hidden = false;
    liveFilter.start();
  }
  $('[data-x=wand]').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const menu = openPopover(btn, enhancePanelHTML({ flashlight: true }), { className: 'enh-menu enh2-panel' });
    if (!menu) return;
    menu.querySelector('[data-x=flashlight]')?.setAttribute('aria-pressed', String(filterFlashlight));
    wireEnhancePanel(menu, {
      getParams: () => filterParams,
      onPreset: (name) => { filterParams = { ...(FILTER_PRESETS[name] || FILTER_PRESETS.off) }; applyLiveFilter(); },
      onParam: (key, value) => { filterParams = { ...filterParams, [key]: value }; applyLiveFilter(); },
      onFlashlightToggle: () => {
        filterFlashlight = !filterFlashlight;
        menu.querySelector('[data-x=flashlight]')?.setAttribute('aria-pressed', String(filterFlashlight));
        stage.classList.toggle('flashlight-on', filterFlashlight);
        if (!filterFlashlight) liveFilter?.setFlashlight(null);
        applyLiveFilter();
      },
    });
  });
  stage.addEventListener('mousemove', (e) => {
    if (!filterFlashlight || !liveFilter) return;
    const r = filterSource().getBoundingClientRect();
    const inside = r.width && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    liveFilter.setFlashlight(inside ? (e.clientX - r.left) / r.width : null, inside ? (e.clientY - r.top) / r.height : null);
  });
  stage.addEventListener('mouseleave', () => { if (filterFlashlight) liveFilter?.setFlashlight(null); });

  $('[data-x=fullscreen]').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else viewer.requestFullscreen().catch(() => toast('Full screen was blocked by the browser.', 'bad'));
  });

  // ---------------------------------------------------------------- side panel
  const STEP_ORDER = ['decode', 'fuse', 'restore', 'done'];
  let stepIdx = 0;
  const stepsHTML = (frames) => `
    <div class="enh-step" data-step="decode"><span class="n"></span><span>Decoding frames</span></div>
    ${frames > 1 ? `<div class="enh-step" data-step="fuse"><span class="n"></span><span>Aligning &amp; fusing ${frames} frames</span></div>` : ''}
    <div class="enh-step" data-step="restore"><span class="n"></span><span>${mode === 'plate' || mode === 'general' ? 'Upscaling detail' : 'Restoring detail'}</span></div>
    <div class="enh-step" data-step="done"><span class="n"></span><span>Done</span></div>`;
  // The server reports real per-stage text (app/enhance_ai.py's progress callback); map it onto the steps.
  // Anything after decode/fuse — model loading, waiting behind another job — counts as restoring.
  const stepFor = (t = '') => (/decod/i.test(t) ? 'decode' : /align|fus/i.test(t) ? 'fuse' : 'restore');
  function setStep(name, failed = false) {
    const idx = STEP_ORDER.indexOf(name);
    if (idx < stepIdx) return;
    stepIdx = idx;
    root.querySelectorAll('.enh-steps .enh-step').forEach((el) => {
      const i = STEP_ORDER.indexOf(el.dataset.step);
      el.classList.toggle('done', i < stepIdx || (name === 'done' && i === stepIdx));
      el.classList.toggle('now', i === stepIdx && name !== 'done' && !failed);
      el.classList.toggle('fail', i === stepIdx && failed);
    });
  }

  // ---------------------------------------------------------------- read text (OCR)
  // Best read: mark where the text is. "Select text" puts a box on the picture (in the picture's own space,
  // so it stays put through zoom and pan) to draw, move, resize and turn to follow slanted text; the server
  // levels that patch, enlarges it and reads it (app/enhance_ai.py _ocr_region). Reading the whole picture
  // stays available, and the levelled patch that was read is shown with the result.
  const ocrEl = $('.enh2-ocr');
  const layer = $('.enh2-ocrlayer'), obox = $('.enh2-ocrbox'), obar = $('.enh2-ocrbar');
  let ob = null;           // { cx, cy, w, h, a } in the picture's own (unzoomed) CSS px; a = degrees clockwise
  let ocrLast = null;      // { lines, crop, region }
  const ocrWhich = () => (job?.resultUrl ? 'result' : 'source');
  const ocrIdle = () => {
    if (ocrLast) { ocrResult(); return; }
    ocrEl.innerHTML = `<p class="enh2-note">Mark where the text is for the best read — slanted text too. Verify by eye before acting on it.</p>
      <div class="enh2-ocracts"><button class="btn sm primary" data-x="ocr-mark" ${job ? '' : 'disabled'}>${icon('scan')} Select text</button>
      <button class="btn sm ghost" data-x="ocr-whole" ${job ? '' : 'disabled'}>Read whole picture</button></div>`;
  };
  const ocrResult = () => {
    const { lines, crop, engine } = ocrLast;
    ocrEl.innerHTML = `${crop ? `<div class="enh2-ocrcrop"><img src="${crop}" alt="The text that was read, levelled"></div>` : ''}
      ${lines.length ? lines.map((l) => `<div class="enh2-ocrline"><span>${esc(l.text)}</span><span class="pill ${l.confidence >= 80 ? 'ok' : ''}">${l.confidence.toFixed(0)}%</span></div>`).join('')
        : '<p class="enh2-note">No text could be read there.</p>'}
      <p class="enh2-note">${engine === 'plate' ? 'The plate reader’s best read of the enhanced and the original frame, with its confidence' : 'Tesseract’s read, with its own confidence'} — verify by eye before acting on it.</p>
      <div class="enh2-ocracts"><button class="btn sm glass-btn" data-x="ocr-mark">${ocrLast.region ? 'Adjust the box' : 'Select text'}</button>
        <button class="btn sm ghost" data-x="ocr-whole">Read whole picture</button></div>`;
  };
  ocrEl.addEventListener('click', (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'ocr-mark') ocrMode(true);
    else if (x === 'ocr-whole') runOcr(null);
  });
  async function runOcr(region) {
    if (!job) return;
    ocrEl.innerHTML = '<p class="enh2-note"><span class="spin sm"></span> Reading…</p>';
    try {
      const plate = region ? $('[data-x=ocr-plate]').checked : false;
      try { localStorage.setItem(PLATE_KEY, plate ? '1' : '0'); } catch { /* private mode */ }
      const r = await api.enhanceOcr(job.job_id, ocrWhich(), region, plate);
      ocrLast = { lines: r.lines, crop: r.crop, engine: r.engine, region };
      ocrResult();
    } catch (e) {
      ocrLast = null;
      ocrIdle();
      ocrEl.insertAdjacentHTML('afterbegin', `<p class="enh2-note enh2-err">${esc(e.message || 'OCR failed.')}</p>`);
    }
  }

  function ocrMode(on) {
    stage.classList.toggle('ocr-mode', on);
    layer.hidden = !on; obar.hidden = !on;
    if (!on) return;
    const W = pic.offsetWidth, H = pic.offsetHeight;
    if (!ob) ob = { cx: W / 2, cy: H / 2, w: W * 0.4, h: H * 0.14, a: 0 };
    // Number plate: as last time, else on in Plate mode.
    let remembered = null;
    try { remembered = localStorage.getItem(PLATE_KEY); } catch { /* private mode */ }
    $('[data-x=ocr-plate]').checked = remembered === null ? mode === 'plate' : remembered === '1';
    paintBox();
    obox.focus({ preventScroll: true });
  }
  function paintBox() {
    Object.assign(obox.style, { left: `${ob.cx - ob.w / 2}px`, top: `${ob.cy - ob.h / 2}px`, width: `${ob.w}px`, height: `${ob.h}px`, transform: `rotate(${ob.a}deg)` });
    const ang = obox.querySelector('.ang');
    ang.textContent = `${Math.round(ob.a)}°`;
    ang.hidden = Math.round(ob.a) === 0;
  }
  const local = (e) => {
    const r = pic.getBoundingClientRect(), k = r.width / pic.offsetWidth;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };
  const OMIN = 8;
  layer.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    layer.setPointerCapture(e.pointerId);
    const p0 = local(e), b0 = { ...ob };
    const h = e.target.closest('[data-h]')?.dataset.h;
    const inside = !h && e.target.closest('.enh2-ocrbox');
    const rad = (b0.a * Math.PI) / 180, u = [Math.cos(rad), Math.sin(rad)], v = [-Math.sin(rad), Math.cos(rad)];
    const move = (ev) => {
      const p = local(ev), W = pic.offsetWidth, H = pic.offsetHeight;
      if (h === 'rot') {
        // The handle sits above the box's top edge: the box's angle is the pointer's bearing from the
        // centre, less 90°. Snaps level within 2°.
        let a = (Math.atan2(p.y - b0.cy, p.x - b0.cx) * 180) / Math.PI + 90;
        if (a > 180) a -= 360;
        a = clamp(a, -90, 90);
        ob = { ...b0, a: Math.abs(a) < 2 ? 0 : a };
      } else if (h) {
        // A corner: the opposite corner stays put; the size is measured along the box's own axes.
        const sx = h.includes('w') ? -1 : 1, sy = h.includes('n') ? -1 : 1;
        const ox = b0.cx - sx * (b0.w / 2) * u[0] - sy * (b0.h / 2) * v[0], oy = b0.cy - sx * (b0.w / 2) * u[1] - sy * (b0.h / 2) * v[1];
        const dx = p.x - ox, dy = p.y - oy;
        const w = Math.max(OMIN, sx * (dx * u[0] + dy * u[1])), hh = Math.max(OMIN, sy * (dx * v[0] + dy * v[1]));
        ob = { ...b0, w, h: hh, cx: ox + sx * (w / 2) * u[0] + sy * (hh / 2) * v[0], cy: oy + sx * (w / 2) * u[1] + sy * (hh / 2) * v[1] };
      } else if (inside) {
        ob = { ...b0, cx: clamp(b0.cx + p.x - p0.x, 0, W), cy: clamp(b0.cy + p.y - p0.y, 0, H) };
      } else {
        const x0 = clamp(Math.min(p0.x, p.x), 0, W), x1 = clamp(Math.max(p0.x, p.x), 0, W);
        const y0 = clamp(Math.min(p0.y, p.y), 0, H), y1 = clamp(Math.max(p0.y, p.y), 0, H);
        ob = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.max(OMIN, x1 - x0), h: Math.max(OMIN, y1 - y0), a: 0 };
      }
      paintBox();
    };
    const up = () => { layer.removeEventListener('pointermove', move); layer.removeEventListener('pointerup', up); layer.removeEventListener('pointercancel', up); };
    layer.addEventListener('pointermove', move); layer.addEventListener('pointerup', up); layer.addEventListener('pointercancel', up);
  });
  obox.addEventListener('keydown', (e) => {
    const st = e.shiftKey ? 10 : 1;
    const mv = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
    if (mv) { ob.cx += mv[0]; ob.cy += mv[1]; }
    else if (e.key === '[' || e.key === ']') ob.a = clamp(ob.a + (e.key === '[' ? -1 : 1) * (e.shiftKey ? 5 : 1), -90, 90);
    else if (e.key === '0') ob.a = 0;
    else if (e.key === 'Enter') { $('[data-x=ocr-read]').click(); }
    else return;
    e.preventDefault(); e.stopPropagation();
    paintBox();
  });
  $('[data-x=ocr-cancel]').addEventListener('click', () => ocrMode(false));
  $('[data-x=ocr-read]').addEventListener('click', () => {
    const W = pic.offsetWidth, H = pic.offsetHeight;
    const region = { cx: clamp(ob.cx / W, 0, 1), cy: clamp(ob.cy / H, 0, 1), w: ob.w / W, h: ob.h / H, angle: Math.round(ob.a * 10) / 10 };
    ocrMode(false);
    runOcr(region);
  });

  function detectedText() {
    if (!job) return '—';
    const bits = [];
    if (job.faces != null && (job.mode === 'face' || job.mode === 'auto')) bits.push(job.faces ? `${job.faces} face${job.faces > 1 ? 's' : ''} found` : 'No faces found');
    bits.push(job.roiUsed ? 'region cropped before upscaling, so every output pixel goes to the subject' : 'whole frame');
    bits.push(job.frames > 1 ? `${job.frames} frames fused` : 'single frame');
    // Which models made this — part of the record, like the ENHANCED label (Settings → Enhancement).
    const m = job.models;
    if (m) bits.push(`upscaled with ${m.upscaler}${m.face ? `, faces by ${m.face}` : ''}`);
    return bits.join(' · ') + (m?.note ? `. ${m.note}.` : '');
  }

  const download = (url, name) => { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); };
  $('[data-x=save]').addEventListener('click', () => { if (job?.resultUrl) download(job.resultUrl, `frame_ENHANCED_${job.job_id}.png`); });
  $('[data-x=save-source]').addEventListener('click', () => { if (job) download(job.sourceUrl, `frame_source_${job.job_id}.png`); });

  // ---------------------------------------------------------------- run
  async function run() {
    if (running) return;
    running = true;
    const frames = [...picked].sort((a, b) => a - b);
    job = null;
    $('.enh-steps').innerHTML = stepsHTML(frames.length);
    stepIdx = 0; setStep('decode');
    busyEl.hidden = false; busyEl.querySelector('.msg').textContent = 'Starting…';
    imgSrc.hidden = true; imgRes.hidden = true;
    liveFilter?.stop(); filterCanvas.hidden = true;
    $('[data-x=save]').disabled = true; $('[data-x=save-source]').disabled = true;
    $('.enh2-detected').textContent = '—';
    ocrLast = null; ob = null; ocrMode(false);
    ocrIdle();
    paintSplit();
    try {
      busyEl.querySelector('.msg').textContent = 'Preparing frames…';
      const images = await Promise.all(frames.map((i) => encodePNG(burst[i])));
      const { job_id } = await api.createEnhance({
        channel: opts.channel, at_utc: opts.atUtc || '', mode, images,
        roi: roi ? [roi.x, roi.y, roi.w, roi.h] : null, weight,
      });
      let j = null, failed = null;
      try { j = await poll(job_id, frames.length); } catch (e) { if (!e.sourceReady) throw e; failed = e; }
      job = { job_id, mode, frames: frames.length, roiUsed: !!roi, faces: j?.faces_found ?? null, models: j?.models || null,
        sourceUrl: `/api/enhance/${job_id}/source`, resultUrl: failed ? null : `/api/enhance/${job_id}/result` };
      imgSrc.src = job.sourceUrl;
      imgSrc.onload = () => { pic.style.setProperty('--ar', (imgSrc.naturalWidth / imgSrc.naturalHeight).toFixed(4)); zoom.clampAll(); zoom.apply(); paintSplit(); applyLiveFilter(); };
      imgSrc.hidden = false;
      if (job.resultUrl) { imgRes.src = job.resultUrl; imgRes.hidden = false; imgRes.onload = () => paintSplit(); }
      busyEl.hidden = true;
      $('[data-x=save]').disabled = !job.resultUrl;
      $('[data-x=save-source]').disabled = false;
      $('.enh2-detected').textContent = failed
        ? `Enhancement unavailable (${failed.message}) — showing the unenhanced ${frames.length > 1 ? 'fused ' : ''}frame.`
        : detectedText();
      if (failed) setStep('restore', true); else setStep('done');
      ocrIdle();
      paintSplit();
    } catch (e) {
      busyEl.querySelector('.msg').textContent = e.message || 'Enhancement failed.';
      busyEl.querySelector('.spin')?.remove();
      setStep(STEP_ORDER[stepIdx], true);
    } finally {
      running = false;
      if (step === 'pick') paintPick();
    }
  }

  function poll(jobId, n = 1) {
    // Measured on a Mac GPU: one frame is ~40 s including first-time model load; a 5-frame burst ~100 s.
    // Allow 2 minutes plus 30 s a frame (11 frames: 7.5 min), so a big burst — or one queued behind another
    // job ("Waiting for another enhancement…") — isn't cut off.
    const deadline = Date.now() + 120000 + n * 30000;
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (!root.contains(viewer)) { reject(new Error('closed')); return; }
        if (Date.now() > deadline) { reject(new Error('This is taking much longer than expected — try again with fewer frames.')); return; }
        let j;
        try { j = await api.enhanceStatus(jobId); } catch (e) { reject(e); return; }
        if (j.state === 'error') {
          // Align+fuse can succeed (writing source.png) even when the AI step after it fails — say so, so
          // the caller can still show that frame and offer OCR on it instead of a bare error.
          const err = new Error(j.error || 'Enhancement failed');
          err.sourceReady = !!j.source_ready;
          reject(err);
          return;
        }
        if (j.state === 'done') { resolve(j); return; }
        busyEl.querySelector('.msg').textContent = j.progress || 'Working…';
        setStep(stepFor(j.progress));
        setTimeout(tick, 900);
      };
      tick();
    });
  }

  // ---------------------------------------------------------------- close / back
  const close = () => {
    zoom?.destroy(); ro.disconnect(); liveFilter?.destroy();
    burst.forEach((f) => { try { f.close?.(); } catch { /* already closed */ } });
    document.removeEventListener('keydown', onKey, true);
    if (document.fullscreenElement === viewer) document.exitFullscreen();
    root.innerHTML = '';
  };
  // Back from the result goes to the frames (a run still in flight finishes behind it); back from the
  // frames closes.
  const back = () => (step === 'pick' ? close() : showStep('pick'));
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.body._openPopover) return;
    if (stage.classList.contains('ocr-mode')) { e.preventDefault(); e.stopPropagation(); ocrMode(false); return; }
    if (document.fullscreenElement) return;
    e.preventDefault(); e.stopPropagation();
    back();
  };
  document.addEventListener('keydown', onKey, true);
  $('[data-x=back]').addEventListener('click', back);
  $('[data-x=discard]').addEventListener('click', close);

  showStep('pick');
  // Start on the paused frame: focused, and centred in the strip when it scrolls (a phone shows ~4 of 11).
  const here = root.querySelector(`.enh2-frame[data-i="${paused}"]`), strip = $('.enh2-strip');
  here?.focus({ preventScroll: true });
  if (here) strip.scrollLeft = here.offsetLeft - strip.offsetLeft - (strip.clientWidth - here.offsetWidth) / 2;
}
