// AI Frame Enhancer (docs/SPEC.md section 7.8; Enhance board) — a full screen in two steps:
//   1. Pick frames: the burst grabbed around the paused frame, shown as a strip. Choose 1–7 (more means
//      multi-frame fusion — denoise, at the risk of softening a moving subject), and optionally drag a box on
//      any frame to crop to a plate or face first.
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

const MODES = [['auto', 'Auto'], ['face', 'Face'], ['plate', 'Plate'], ['general', 'General']];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad2 = (n) => String(n).padStart(2, '0');

/** @param opts { images: [dataURL,...] (oldest->newest), pausedIndex (which one is on screen), camName,
 *  channel (DVR channel number), atUtc (ISO), tzOffsetMin, defaultMode, defaultFidelity } */
export function openEnhancePopup(opts) {
  const root = document.getElementById('modal-root');
  const burst = opts.images;
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
      <div><h2>Select frames to enhance</h2><p class="enh2-cap"></p></div>
      <div class="enh2-frames">${burst.map((src, i) => `<div class="enh2-frame" data-i="${i}" role="checkbox" tabindex="0" aria-label="Frame ${i + 1}${i === paused ? ', the paused frame' : ''}">
        <img src="${src}" alt="" draggable="false"><span class="ck">${icon('check')}</span>${i === paused ? '<span class="enh2-here">Paused</span>' : ''}<span class="enh2-roi" hidden></span></div>`).join('')}</div>
      <div class="enh2-tip">${icon('crop')}<span class="t"></span>
        <button class="btn sm ghost" data-x="clear-roi" hidden>Whole frame</button>
        <button class="btn sm glass-btn" data-x="edit-roi">Select region…</button></div>
      <div><button class="btn primary enh2-go" data-x="go"></button></div>
    </section>
    <section class="enh2-crop" hidden>
      <div><h2>Select a region</h2><p class="enh2-cap">Drag the box, or its corners, to fit a plate or a face. Only this part of the frame is enhanced — every output pixel goes to it. Drag anywhere outside the box to draw a new one.</p></div>
      <div class="enh2-crop-stage"><div class="enh2-crop-wrap"><img src="${burst[paused]}" alt="The paused frame" draggable="false">
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
          </div>
          <div class="hitzone"></div>
          <span class="enh2-tag l">Before</span><span class="enh2-tag r">After</span>
          <div class="enh2-split" role="slider" tabindex="0" aria-label="Before and after divider" aria-valuemin="0" aria-valuemax="100"><span>${icon('left')}${icon('right')}</span></div>
          <button class="zoomtag" hidden title="Reset zoom">Reset</button>
          <div class="enh2-badge">${icon('alert')} ENHANCED — reconstructed detail, not the original recording. An investigative lead, not evidence.</div>
          <div class="enh2-busy"><span class="spin"></span><span class="msg">Starting…</span></div>
        </div>
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
  // Thumbnails take each frame's own shape (object-fit: fill on a box of the same aspect), so the region
  // preview drawn over them in fractions lines up exactly with what the server crops.
  root.querySelectorAll('.enh2-frame img, .enh2-crop-wrap img').forEach((img) => {
    const set = () => { if (img.naturalWidth) img.parentElement.style.setProperty('--ar', (img.naturalWidth / img.naturalHeight).toFixed(4)); };
    if (img.complete) set(); else img.addEventListener('load', set);
  });
  const paintPick = () => {
    const n = picked.size;
    $('.enh2-cap').textContent = `1–${burst.length} frames, oldest to newest — more frames means better fusion, but only while the subject barely moves between them. ${n} selected.`;
    root.querySelectorAll('.enh2-frame').forEach((el) => {
      const on = picked.has(+el.dataset.i);
      el.classList.toggle('on', on);
      el.setAttribute('aria-checked', String(on));
      const box = el.querySelector('.enh2-roi');
      box.hidden = !roi;
      if (roi) Object.assign(box.style, { left: `${roi.x * 100}%`, top: `${roi.y * 100}%`, width: `${roi.w * 100}%`, height: `${roi.h * 100}%` });
    });
    $('[data-x=clear-roi]').hidden = !roi;
    $('[data-x=edit-roi]').textContent = roi ? 'Edit region…' : 'Select region…';
    $('.enh2-tip .t').textContent = roi
      ? `Region set — ${Math.round(roi.w * 100)}% × ${Math.round(roi.h * 100)}% of the frame. Only this part is enhanced, so all the detail goes to it.`
      : 'Optionally select a region first — a plate or a face — so every output pixel goes to that subject instead of the whole scene.';
    $('.enh2-go').textContent = `Enhance ${n} frame${n === 1 ? '' : 's'}`;
    $('.enh2-go').disabled = n === 0 || running;
  };
  const toggleFrame = (i) => { if (picked.has(i)) picked.delete(i); else picked.add(i); paintPick(); };
  root.querySelectorAll('.enh2-frame').forEach((el) => {
    const i = +el.dataset.i;
    el.addEventListener('click', () => toggleFrame(i));
    el.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleFrame(i); } });
  });
  $('[data-x=clear-roi]').addEventListener('click', () => { roi = null; paintPick(); });
  $('[data-x=edit-roi]').addEventListener('click', () => openCrop());

  // ---------------------------------------------------------------- the region editor
  // The paused frame, large, with a box to move (drag inside), resize (drag a corner) or redraw (drag
  // outside). Fractions are of the image's own box, which the wrapper hugs exactly.
  const MIN = 0.03;
  let draft = null;
  const wrap = $('.enh2-crop-wrap'), cbox = $('.enh2-crop-box');
  const paintCrop = () => {
    Object.assign(cbox.style, { left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` });
    const img = wrap.querySelector('img');
    const W = img.naturalWidth || 0, H = img.naturalHeight || 0;
    cbox.querySelector('.dims').textContent = W ? `${Math.round(draft.w * W)} × ${Math.round(draft.h * H)} px` : '';
  };
  const openCrop = () => {
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
    const sr = stage.getBoundingClientRect(), ir = imgSrc.getBoundingClientRect();
    splitEl.style.left = `${split}%`;
    splitEl.setAttribute('aria-valuenow', String(Math.round(split)));
    const x = sr.left + (split / 100) * sr.width;
    const f = ir.width ? clamp((x - ir.left) / ir.width, 0, 1) : split / 100;
    after.style.clipPath = `inset(0 0 0 ${(f * 100).toFixed(2)}%)`;
    $('.enh2-badge').hidden = f >= 0.999;
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

  const ocrEl = $('.enh2-ocr');
  const ocrIdle = () => {
    ocrEl.innerHTML = `<p class="enh2-note">A read, not a guess at what should be there — Tesseract on the ${job?.resultUrl ? 'result' : 'original'}. Verify by eye; it can still misread real footage.</p>
      <button class="btn sm ghost enh2-link" data-x="ocr" ${job ? '' : 'disabled'}>${icon('search')} Run OCR on ${job?.resultUrl ? 'result' : 'original'}</button>`;
    ocrEl.querySelector('[data-x=ocr]').addEventListener('click', runOcr);
  };
  async function runOcr() {
    if (!job) return;
    ocrEl.innerHTML = '<p class="enh2-note"><span class="spin sm"></span> Reading…</p>';
    try {
      const { lines } = await api.enhanceOcr(job.job_id, job.resultUrl ? 'result' : 'source');
      ocrEl.innerHTML = lines.length
        ? `${lines.map((l) => `<div class="enh2-ocrline"><span>${esc(l.text)}</span><span class="pill ${l.confidence >= 80 ? 'ok' : ''}">${l.confidence.toFixed(0)}%</span></div>`).join('')}
           <p class="enh2-note">Tesseract's best read per line, with its own confidence — verify by eye before acting on it.</p>`
        : '<p class="enh2-note">No text found on this frame.</p>';
    } catch (e) {
      ocrEl.innerHTML = `<p class="enh2-note">${esc(e.message || 'OCR failed.')}</p>`;
    }
  }

  function detectedText() {
    if (!job) return '—';
    const bits = [];
    if (job.faces != null && (job.mode === 'face' || job.mode === 'auto')) bits.push(job.faces ? `${job.faces} face${job.faces > 1 ? 's' : ''} found` : 'No faces found');
    bits.push(job.roiUsed ? 'region cropped before upscaling, so every output pixel goes to the subject' : 'whole frame');
    bits.push(job.frames > 1 ? `${job.frames} frames fused` : 'single frame');
    return bits.join(' · ');
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
    ocrIdle();
    paintSplit();
    try {
      const { job_id } = await api.createEnhance({
        channel: opts.channel, at_utc: opts.atUtc || '', mode, images: frames.map((i) => burst[i]),
        roi: roi ? [roi.x, roi.y, roi.w, roi.h] : null, weight,
      });
      let j = null, failed = null;
      try { j = await poll(job_id); } catch (e) { if (!e.sourceReady) throw e; failed = e; }
      job = { job_id, mode, frames: frames.length, roiUsed: !!roi, faces: j?.faces_found ?? null,
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

  function poll(jobId) {
    // Measured on a Mac GPU: one frame is ~40 s including first-time model load; a 5-frame burst ~100 s.
    // 240 s leaves margin for a burst plus a job queued behind another ("Waiting for another enhancement…").
    const deadline = Date.now() + 240000;
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
    document.removeEventListener('keydown', onKey, true);
    if (document.fullscreenElement === viewer) document.exitFullscreen();
    root.innerHTML = '';
  };
  // Back from the result goes to the frames (a run still in flight finishes behind it); back from the
  // frames closes.
  const back = () => (step === 'pick' ? close() : showStep('pick'));
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.fullscreenElement || document.body._openPopover) return;
    e.preventDefault(); e.stopPropagation();
    back();
  };
  document.addEventListener('keydown', onKey, true);
  $('[data-x=back]').addEventListener('click', back);
  $('[data-x=discard]').addEventListener('click', close);

  showStep('pick');
  root.querySelector(`.enh2-frame[data-i="${paused}"]`)?.focus({ preventScroll: true });
}
