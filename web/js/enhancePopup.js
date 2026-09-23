// AI frame enhancer popup (docs/enhance-ai-spec.md) — grabs a burst of already-decoded frames from a
// paused playback pane, runs them through the server's Real-ESRGAN + GFPGAN pipeline, and shows the
// result in a large zoom/pan/fullscreen viewer with a before/after toggle. Forensic-integrity rules baked
// in here, not just described: the source (pre-AI) frame is always fetched alongside the enhanced one,
// and the "ENHANCED" label is permanent on screen, never something that can be toggled off.
import { esc, icon, toast, openPopover } from './ui.js';
import { ZoomPan } from './zoom.js';
import { api } from './api.js';
import { Enhancer, PRESETS as FILTER_PRESETS } from './enhance.js';
import { enhancePanelHTML, wireEnhancePanel } from './enhancePanel.js';

const MODES = [
  ['auto', 'Auto'],
  ['face', 'Face priority'],
  ['plate', 'Plate & text'],
  ['general', 'General'],
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** @param opts { images: [dataURL,...] (oldest->newest, already grabbed), channel (DVR channel number),
 *  atUtc (ISO string, for the header) } */
export function openEnhancePopup(opts) {
  const root = document.getElementById('modal-root');
  let mode = 'auto';
  // Off by default (spec: multi-frame fusion helps a static/noisy scene but can soften a moving subject
  // even with the motion-adaptive weighting — see app/enhance_ai.py's _align_and_fuse. Single-frame is the
  // safer default; fusion is there to turn on for a specifically noisy, mostly-static frame.
  let fuse = false;
  // Fidelity: a real linear blend between GFPGAN's face restoration and a plain upscale with no face
  // synthesis at all (spec 2d) — NOT GFPGANer's own `weight` argument, which does nothing in the installed
  // package (verified by reading its model code, not assumed). 0.5 is the recommended middle ground.
  let weight = 0.5;
  // Fractions (0-1) of the frame to crop to before enhancing (spec 2c) — null means "whole frame", the
  // original behaviour. Isolating a plate/face this way spends the AI's fixed output resolution on the
  // actual subject instead of mostly on background that was never in question.
  let roi = null;
  let selecting = false;
  // Client-side "wand" live filters (docs/playback-spec.md's L0 section) layered on top of whichever
  // picture is currently shown, purely for on-screen inspection — never touches the server-side AI
  // pipeline or what a download actually saves, so it can't be mistaken for part of the forensic output.
  let filterParams = { ...FILTER_PRESETS.off };
  let filterFlashlight = false;
  let liveFilter = null; // Enhancer instance, created lazily on first use
  let showingSource = false;
  let zoom = null;
  let job = null; // { job_id, resultUrl, sourceUrl, faces_found }
  const burst = opts.images;                 // the full grabbed burst, oldest -> newest
  const single = [burst[Math.floor(burst.length / 2)]]; // the exact paused frame — the middle of an odd-length burst

  const when = opts.atUtc ? new Date(opts.atUtc).toLocaleString(undefined, { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

  root.innerHTML = `<div class="scrim enh-scrim"><div class="enh-viewer" role="dialog" aria-modal="true" aria-label="Frame enhancer">
    <div class="enh-top">
      <div class="enh-title">${icon('scan')} Frame Enhancer <span class="hint enh-frametext"></span></div>
      ${burst.length > 1 ? `<label class="enh-fuse" title="Blend ${burst.length} nearby frames to reduce noise on static content — off by default because it can soften a moving subject even with motion-aware blending.">
        <input type="checkbox" data-x="fuse"> Combine ${burst.length} frames (denoise)
      </label>` : ''}
      <div class="enh-topactions">
        <button class="btn icon sm ghost" data-x="fullscreen" title="Full screen" aria-label="Full screen">${icon('fullscreen')}</button>
        <button class="btn icon sm ghost" data-x="close" title="Close" aria-label="Close">${icon('close')}</button>
      </div>
    </div>
    <div class="enh-top2">
      <div class="seg enh-modes" role="group" aria-label="Mode">${MODES.map(([k, l]) => `<button data-mode="${k}" aria-pressed="${k === mode}">${esc(l)}</button>`).join('')}</div>
      <label class="enh-weight" title="Blends GFPGAN's face restoration against a plain upscale of the same frame with no face synthesis at all. Lower = more restoration (risk of inventing features); higher = closer to the real pixels (risk of staying blurry). 0.5 blends both evenly — the recommended default.">
        Fidelity <input type="range" data-x="weight" min="0" max="1" step="0.05" value="0.5"> <span class="enh-weight-val">0.50</span>
      </label>
      <button class="btn sm" data-x="select-roi" aria-pressed="false" title="Drag a box over the image to isolate a plate or face — the enhancer's full output resolution goes to just that area instead of the whole frame.">${icon('crop')} Select region</button>
      <span class="enh-roi-chip" hidden>Region selected <button class="btn icon sm ghost" data-x="clear-roi" title="Clear region">${icon('close')}</button></span>
      <button class="btn sm" data-x="wand" aria-pressed="false" title="Client-side live filters (dehaze, sharpen, WDR, Retinex, rain/snow reduction, chromatic aberration fix) and a digital flashlight — layered on top of whichever picture is shown here, purely for inspection. Doesn't change the main enhancement above or what downloads actually save.">${icon('wand')} Live filters</button>
    </div>
    <div class="enh-stage">
      <div class="enh-pic"><img class="enh-img" alt="" hidden><canvas class="enh-livefilter-canvas" hidden></canvas></div>
      <div class="hitzone"></div>
      <div class="enh-roi-layer"><div class="enh-roi-box" hidden></div></div>
      <button class="zoomtag" hidden title="Reset zoom">Reset</button>
      <div class="enh-badge">${icon('alert')} ENHANCED — Reconstructed detail, not the original recording. Investigative lead, not evidence.</div>
      <div class="enh-ocr-panel" hidden>
        <div class="enh-ocr-head">${icon('search')} Text read (OCR) <button class="btn icon sm ghost" data-x="ocr-close" title="Close">${icon('close')}</button></div>
        <div class="enh-ocr-body"></div>
        <p class="hint">Tesseract's best guess per line, with its own confidence — verify by eye before relying on any of it.</p>
      </div>
      <div class="enh-loading"><div class="spin"></div><div class="msg">Starting…</div></div>
    </div>
    <div class="enh-bottom">
      <button class="btn sm" data-x="toggle-src" disabled>${icon('eye')} Show original</button>
      <button class="btn sm" data-x="ocr" disabled title="Optional: read any visible text (plates, signs) with OCR — a suggestion to verify, not a determined value">${icon('search')} Read text (OCR)</button>
      <span class="hint enh-status"></span>
      <span class="spacer"></span>
      <button class="btn sm" data-x="dl-source" disabled>${icon('download')} Download source</button>
      <button class="btn sm primary" data-x="dl-result" disabled>${icon('download')} Download enhanced</button>
    </div>
  </div></div>`;

  const stage = root.querySelector('.enh-stage');
  const pic = root.querySelector('.enh-pic');
  const img = root.querySelector('.enh-img');
  const loading = root.querySelector('.enh-loading');
  const statusEl = root.querySelector('.enh-status');
  const toggleBtn = root.querySelector('[data-x=toggle-src]');
  const zoomtag = root.querySelector('.zoomtag');
  const viewer = root.querySelector('.enh-viewer');
  const weightLabel = root.querySelector('.enh-weight');
  const weightInput = root.querySelector('[data-x=weight]');
  const weightVal = root.querySelector('.enh-weight-val');
  const roiLayer = root.querySelector('.enh-roi-layer');
  const roiBox = root.querySelector('.enh-roi-box');
  const roiBtn = root.querySelector('[data-x=select-roi]');
  const roiChip = root.querySelector('.enh-roi-chip');
  const wandBtn = root.querySelector('[data-x=wand]');
  const filterCanvas = root.querySelector('.enh-livefilter-canvas');

  // `stage` (untransformed) is what ZoomPan measures for its pan-clamp math — the CSS zoom transform lives
  // on `pic`, a child of it. Passing `pic` itself here was the bug: an element's own transform inflates
  // what getBoundingClientRect() reports for it, so every clamp computation was using an already-scaled
  // box instead of a stable one, and panning collapsed to near-zero the moment you zoomed in. The .pb-pane
  // pattern (stage=.pb-pane, transform on the child .pb-pic) already gets this right — mirrored here.
  zoom = new ZoomPan(stage, root.querySelector('.hitzone'), {
    dbl: true,
    onChange: (st) => { zoomtag.hidden = st.s <= 1.001; zoomtag.textContent = `${Math.round(st.s * 100)}%`; },
  });
  zoomtag.addEventListener('click', () => zoom.reset());

  const roiResizeObs = new ResizeObserver(() => updateRoiBoxDisplay());
  roiResizeObs.observe(stage);

  const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) close(); };
  const onFs = () => viewer.classList.toggle('is-fs', document.fullscreenElement === viewer);
  const close = () => {
    zoom?.destroy();
    roiResizeObs.disconnect();
    liveFilter?.destroy();
    document.removeEventListener('fullscreenchange', onFs);
    document.removeEventListener('keydown', onKey);
    if (document.fullscreenElement === viewer) document.exitFullscreen();
    root.innerHTML = '';
  };
  root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) close(); });
  root.querySelector('[data-x=close]').addEventListener('click', close);
  root.querySelector('[data-x=fullscreen]').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else viewer.requestFullscreen().catch(() => toast('Full screen was blocked by the browser.', 'bad'));
  });
  document.addEventListener('fullscreenchange', onFs);
  document.addEventListener('keydown', onKey);

  function updateWeightVisibility() {
    weightLabel.hidden = !(mode === 'face' || mode === 'auto');
  }
  updateWeightVisibility();

  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    root.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.mode === mode)));
    updateWeightVisibility();
    run();
  }));

  root.querySelector('[data-x=fuse]')?.addEventListener('change', (e) => {
    fuse = e.target.checked;
    run();
  });

  weightInput.addEventListener('input', () => { weightVal.textContent = Number(weightInput.value).toFixed(2); });
  weightInput.addEventListener('change', () => { weight = Number(weightInput.value); run(); });

  // ---------------------------------------------------------------- region-of-interest crop (spec 2c)
  // Fraction-based (0-1 of the image), not pixel-based — the same box maps correctly onto the original
  // full-resolution frame whether it was drawn over the (smaller) source preview or the (4x-upscaled)
  // result, so redrawing after a mode/fuse switch never needs rescaling.
  function clientToImgFrac(clientX, clientY) {
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return { fx: 0, fy: 0 };
    return { fx: clamp((clientX - r.left) / r.width, 0, 1), fy: clamp((clientY - r.top) / r.height, 0, 1) };
  }
  function drawRoiBoxFromFrac(x, y, w, h) {
    const ir = img.getBoundingClientRect();
    const lr = roiLayer.getBoundingClientRect();
    roiBox.style.left = `${ir.left - lr.left + x * ir.width}px`;
    roiBox.style.top = `${ir.top - lr.top + y * ir.height}px`;
    roiBox.style.width = `${w * ir.width}px`;
    roiBox.style.height = `${h * ir.height}px`;
    roiBox.hidden = false;
  }
  // The currently-displayed image (source or result) is already the cropped content once a run has used
  // `roi` — the server crops before enhancing (spec 2c), so at that point the whole picture IS the
  // selection and drawing a box over it is meaningless (worse, it was drawing the *old* fractional box in
  // the wrong place on the *new*, already-cropped picture — the reported bug). Only ever show the box while
  // still choosing a region against the pre-crop picture, never over a result that already reflects it.
  function updateRoiBoxDisplay() {
    if (!roi || img.hidden || job?.roiUsed) { roiBox.hidden = true; return; }
    drawRoiBoxFromFrac(roi.x, roi.y, roi.w, roi.h);
  }

  function startSelecting() {
    if (img.hidden) return;
    if (zoom.zoomed) zoom.reset(false);
    selecting = true;
    roiLayer.classList.add('active');
    roiBtn.setAttribute('aria-pressed', 'true');
  }
  function stopSelecting() {
    selecting = false;
    roiLayer.classList.remove('active');
    roiBtn.setAttribute('aria-pressed', 'false');
  }
  roiBtn.addEventListener('click', () => { if (selecting) stopSelecting(); else startSelecting(); });
  root.querySelector('[data-x=clear-roi]').addEventListener('click', () => {
    roi = null;
    roiChip.hidden = true;
    roiBox.hidden = true;
    run();
  });

  let dragStart = null;
  roiLayer.addEventListener('pointerdown', (e) => {
    if (!selecting) return;
    e.preventDefault();
    try { roiLayer.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    dragStart = clientToImgFrac(e.clientX, e.clientY);
    drawRoiBoxFromFrac(dragStart.fx, dragStart.fy, 0, 0);
  });
  roiLayer.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const cur = clientToImgFrac(e.clientX, e.clientY);
    drawRoiBoxFromFrac(Math.min(dragStart.fx, cur.fx), Math.min(dragStart.fy, cur.fy), Math.abs(cur.fx - dragStart.fx), Math.abs(cur.fy - dragStart.fy));
  });
  roiLayer.addEventListener('pointerup', (e) => {
    if (!dragStart) return;
    const cur = clientToImgFrac(e.clientX, e.clientY);
    const x = Math.min(dragStart.fx, cur.fx), y = Math.min(dragStart.fy, cur.fy);
    const w = Math.abs(cur.fx - dragStart.fx), h = Math.abs(cur.fy - dragStart.fy);
    dragStart = null;
    stopSelecting();
    if (w < 0.02 || h < 0.02) { updateRoiBoxDisplay(); return; } // too small to be deliberate — keep any existing selection
    roi = { x, y, w, h };
    roiChip.hidden = false;
    run();
  });

  // ---------------------------------------------------------------- "wand" live filters + flashlight
  // Reuses the exact same WebGL engine (enhance.js) and control panel (enhancePanel.js) as the Live/
  // Playback "wand" — the same dehaze/sharpen/CLAHE-style local contrast/WDR/Retinex/rain-snow/chromatic-
  // aberration toolkit and digital flashlight, applied here to a static picture instead of a moving video.
  // A separate Enhancer instance is created lazily and painted with whichever image (source or result) is
  // currently in `img` — WebGL's texImage2D accepts an <img> element directly, and since `source` is kept
  // as the same element throughout, later img.src changes (a mode switch, before/after toggle) are picked
  // up automatically on the next animation frame with no need to recreate anything. This never touches the
  // AI pipeline's own output or what "Download enhanced/source" actually save (spec 6's forensic-integrity
  // rules apply to the real pipeline, not a decorative client-side inspection aid).
  function isFilterOff() {
    const neutral = Object.entries(FILTER_PRESETS.off).every(([k, v]) => k === 'label' || filterParams[k] === v);
    return neutral && !filterFlashlight;
  }
  function applyLiveFilter() {
    wandBtn.setAttribute('aria-pressed', String(!isFilterOff()));
    if (isFilterOff()) {
      liveFilter?.stop();
      filterCanvas.hidden = true;
      return;
    }
    if (!liveFilter) {
      liveFilter = new Enhancer(img, filterCanvas);
      if (!liveFilter.supported) { liveFilter = null; return; }
    }
    liveFilter.setParams(filterParams);
    filterCanvas.hidden = false;
    liveFilter.start();
  }
  wandBtn.addEventListener('click', () => {
    const menu = openPopover(wandBtn, enhancePanelHTML({ flashlight: true }), { className: 'enh-menu enh2-panel' });
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
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    liveFilter.setFlashlight(inside ? clamp((e.clientX - r.left) / r.width, 0, 1) : null, inside ? clamp((e.clientY - r.top) / r.height, 0, 1) : null);
  });
  stage.addEventListener('mouseleave', () => { if (filterFlashlight) liveFilter?.setFlashlight(null); });

  function updateFrameText() {
    const el = root.querySelector('.enh-frametext');
    if (el) el.textContent = when + (fuse ? ` · ${burst.length} frames combined` : ' · single frame') + (roi ? ' · region selected' : '');
  }

  toggleBtn.addEventListener('click', () => {
    showingSource = !showingSource;
    applyImage();
  });

  function applyImage() {
    if (!job) return;
    img.src = showingSource ? job.sourceUrl : job.resultUrl;
    img.onload = () => { pic.style.setProperty('--ar', (img.naturalWidth / img.naturalHeight).toFixed(4)); zoom?.clampAll(); zoom?.apply(); updateRoiBoxDisplay(); applyLiveFilter(); };
    toggleBtn.innerHTML = showingSource ? `${icon('eye')} Show enhanced` : `${icon('eye')} Show original`;
    root.querySelector('.enh-badge').style.display = showingSource ? 'none' : 'flex';
  }

  root.querySelector('[data-x=dl-result]').addEventListener('click', () => {
    if (job?.resultUrl) { const a = document.createElement('a'); a.href = job.resultUrl; a.download = `frame_ENHANCED_${job.job_id}.png`; a.click(); }
  });
  root.querySelector('[data-x=dl-source]').addEventListener('click', () => {
    if (job) { const a = document.createElement('a'); a.href = job.sourceUrl; a.download = `frame_source_${job.job_id}.png`; a.click(); }
  });

  // ---------------------------------------------------------------- OCR (optional, on demand — spec 4a)
  const ocrBtn = root.querySelector('[data-x=ocr]');
  const ocrPanel = root.querySelector('.enh-ocr-panel');
  const ocrBody = root.querySelector('.enh-ocr-body');
  root.querySelector('[data-x=ocr-close]').addEventListener('click', () => { ocrPanel.hidden = true; });
  ocrBtn.addEventListener('click', async () => {
    if (!job) return;
    ocrBtn.disabled = true;
    ocrPanel.hidden = false;
    ocrBody.innerHTML = '<div class="spin"></div>';
    try {
      const { lines } = await api.enhanceOcr(job.job_id, showingSource ? 'source' : 'result');
      ocrBody.innerHTML = lines.length
        ? lines.map((l) => `<div class="enh-ocr-line"><span class="enh-ocr-text">${esc(l.text)}</span><span class="enh-ocr-conf">${l.confidence.toFixed(0)}%</span></div>`).join('')
        : '<p class="hint">No text found on this frame.</p>';
    } catch (e) {
      ocrBody.innerHTML = `<p class="hint">${esc(e.message || 'OCR failed.')}</p>`;
    } finally {
      ocrBtn.disabled = false;
    }
  });

  async function run() {
    stopSelecting();
    updateFrameText();
    loading.hidden = false;
    loading.querySelector('.msg').textContent = 'Starting…';
    img.hidden = true;
    roiBox.hidden = true;
    liveFilter?.stop();
    filterCanvas.hidden = true;
    toggleBtn.disabled = true;
    ocrBtn.disabled = true;
    ocrPanel.hidden = true;
    roiBtn.disabled = true;
    root.querySelector('[data-x=dl-result]').disabled = true;
    root.querySelector('[data-x=dl-source]').disabled = true;
    statusEl.textContent = '';
    showingSource = false;
    try {
      const { job_id } = await api.createEnhance({
        channel: opts.channel, at_utc: opts.atUtc || '', mode, images: fuse ? burst : single,
        roi: roi ? [roi.x, roi.y, roi.w, roi.h] : null, weight,
      });
      let j;
      try {
        j = await poll(job_id);
      } catch (e) {
        if (!e.sourceReady) throw e; // nothing usable came out of this job at all
        // AI enhancement failed (e.g. the model isn't installed/available) but the aligned/fused source
        // frame is real and on disk — show that instead of leaving the operator with just an error,
        // and be explicit that what's showing is the un-enhanced source, not a silently degraded result.
        job = { job_id, resultUrl: null, sourceUrl: `/api/enhance/${job_id}/source`, roiUsed: !!roi };
        showingSource = true;
        loading.hidden = true;
        img.hidden = false;
        img.src = job.sourceUrl;
        img.onload = () => { pic.style.setProperty('--ar', (img.naturalWidth / img.naturalHeight).toFixed(4)); zoom?.clampAll(); zoom?.apply(); updateRoiBoxDisplay(); applyLiveFilter(); };
        root.querySelector('.enh-badge').style.display = 'none';
        toggleBtn.disabled = true; // nothing to toggle to — there is no enhanced result
        ocrBtn.disabled = false;
        roiBtn.disabled = false;
        root.querySelector('[data-x=dl-result]').disabled = true;
        root.querySelector('[data-x=dl-source]').disabled = false;
        statusEl.textContent = `Enhancement unavailable (${e.message}) — showing the unenhanced fused frame.`;
        return;
      }
      job = { job_id, resultUrl: `/api/enhance/${job_id}/result`, sourceUrl: `/api/enhance/${job_id}/source`, roiUsed: !!roi };
      loading.hidden = true;
      img.hidden = false;
      applyImage();
      toggleBtn.disabled = false;
      ocrBtn.disabled = false;
      roiBtn.disabled = false;
      root.querySelector('[data-x=dl-result]').disabled = false;
      root.querySelector('[data-x=dl-source]').disabled = false;
      statusEl.textContent = j.faces_found ? `Done — ${j.faces_found} face${j.faces_found > 1 ? 's' : ''} restored.` : 'Done.';
    } catch (e) {
      loading.querySelector('.msg').textContent = e.message || 'Enhancement failed.';
      roiBtn.disabled = false;
    }
  }

  function poll(jobId) {
    // Measured directly against this Mac's GPU: a single frame is ~40s including first-time model load;
    // a full 5-frame burst is ~100s. 240s leaves real margin for a burst plus a second job queued right
    // behind an already-running one (progress says "Waiting for another enhancement to finish…" while that
    // happens, so the wait is never silent even though it counts against this same deadline).
    const deadline = Date.now() + 240000;
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (Date.now() > deadline) { reject(new Error('This is taking much longer than expected — try again, or a shorter burst (single frame).')); return; }
        let j;
        try { j = await api.enhanceStatus(jobId); } catch (e) { reject(e); return; }
        if (j.state === 'error') {
          // The align+fuse step can succeed (and write source.png) even when the AI step after it fails
          // (e.g. the model isn't available) — attach that so the caller can still fall back to showing
          // the source frame and offering OCR on it, instead of a bare error with nothing to look at.
          const err = new Error(j.error || 'Enhancement failed');
          err.sourceReady = !!j.source_ready;
          reject(err);
          return;
        }
        if (j.state === 'done') { resolve(j); return; }
        loading.querySelector('.msg').textContent = j.progress || 'Working…';
        setTimeout(tick, 900);
      };
      tick();
    });
  }

  run();
}
