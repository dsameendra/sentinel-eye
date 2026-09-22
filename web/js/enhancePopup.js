// AI frame enhancer popup (docs/enhance-ai-spec.md) — grabs a burst of already-decoded frames from a
// paused playback pane, runs them through the server's Real-ESRGAN + GFPGAN pipeline, and shows the
// result in a large zoom/pan/fullscreen viewer with a before/after toggle. Forensic-integrity rules baked
// in here, not just described: the source (pre-AI) frame is always fetched alongside the enhanced one,
// and the "ENHANCED" label is permanent on screen, never something that can be toggled off.
import { esc, icon, toast } from './ui.js';
import { ZoomPan } from './zoom.js';
import { api } from './api.js';

const MODES = [
  ['auto', 'Auto'],
  ['face', 'Face priority'],
  ['plate', 'Plate & text'],
  ['general', 'General'],
];

/** @param opts { images: [dataURL,...] (oldest->newest, already grabbed), channel (DVR channel number),
 *  atUtc (ISO string, for the header) } */
export function openEnhancePopup(opts) {
  const root = document.getElementById('modal-root');
  let mode = 'auto';
  let showingSource = false;
  let zoom = null;
  let job = null; // { job_id, resultUrl, sourceUrl, faces_found }

  const when = opts.atUtc ? new Date(opts.atUtc).toLocaleString(undefined, { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

  root.innerHTML = `<div class="scrim enh-scrim"><div class="enh-viewer" role="dialog" aria-modal="true" aria-label="Frame enhancer">
    <div class="enh-top">
      <div class="enh-title">${icon('scan')} Frame Enhancer <span class="hint">${esc(when)}${opts.images.length > 1 ? ` · ${opts.images.length} frames fused` : ''}</span></div>
      <div class="seg enh-modes" role="group" aria-label="Mode">${MODES.map(([k, l]) => `<button data-mode="${k}" aria-pressed="${k === mode}">${esc(l)}</button>`).join('')}</div>
      <div class="enh-topactions">
        <button class="btn sm" data-x="fullscreen" title="Full screen">${icon('fullscreen')}</button>
        <button class="btn icon sm ghost" data-x="close" title="Close" aria-label="Close">${icon('close')}</button>
      </div>
    </div>
    <div class="enh-stage">
      <div class="enh-pic"><img class="enh-img" alt="" hidden></div>
      <div class="hitzone"></div>
      <button class="zoomtag" hidden title="Reset zoom">Reset</button>
      <div class="enh-badge">${icon('alert')} ENHANCED — AI-reconstructed detail, not the original recording. Investigative lead, not evidence.</div>
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

  const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) close(); };
  const onFs = () => viewer.classList.toggle('is-fs', document.fullscreenElement === viewer);
  const close = () => {
    zoom?.destroy();
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

  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    root.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.mode === mode)));
    run();
  }));

  toggleBtn.addEventListener('click', () => {
    showingSource = !showingSource;
    applyImage();
  });

  function applyImage() {
    if (!job) return;
    img.src = showingSource ? job.sourceUrl : job.resultUrl;
    img.onload = () => { pic.style.setProperty('--ar', (img.naturalWidth / img.naturalHeight).toFixed(4)); zoom?.clampAll(); zoom?.apply(); };
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
    loading.hidden = false;
    loading.querySelector('.msg').textContent = 'Starting…';
    img.hidden = true;
    toggleBtn.disabled = true;
    ocrBtn.disabled = true;
    ocrPanel.hidden = true;
    root.querySelector('[data-x=dl-result]').disabled = true;
    root.querySelector('[data-x=dl-source]').disabled = true;
    statusEl.textContent = '';
    showingSource = false;
    try {
      const { job_id } = await api.createEnhance({ channel: opts.channel, at_utc: opts.atUtc || '', mode, images: opts.images });
      let j;
      try {
        j = await poll(job_id);
      } catch (e) {
        if (!e.sourceReady) throw e; // nothing usable came out of this job at all
        // AI enhancement failed (e.g. the model isn't installed/available) but the aligned/fused source
        // frame is real and on disk — show that instead of leaving the operator with just an error,
        // and be explicit that what's showing is the un-enhanced source, not a silently degraded result.
        job = { job_id, resultUrl: null, sourceUrl: `/api/enhance/${job_id}/source` };
        showingSource = true;
        loading.hidden = true;
        img.hidden = false;
        img.src = job.sourceUrl;
        img.onload = () => { pic.style.setProperty('--ar', (img.naturalWidth / img.naturalHeight).toFixed(4)); zoom?.clampAll(); zoom?.apply(); };
        root.querySelector('.enh-badge').style.display = 'none';
        toggleBtn.disabled = true; // nothing to toggle to — there is no enhanced result
        ocrBtn.disabled = false;
        root.querySelector('[data-x=dl-result]').disabled = true;
        root.querySelector('[data-x=dl-source]').disabled = false;
        statusEl.textContent = `AI enhancement unavailable (${e.message}) — showing the unenhanced fused frame.`;
        return;
      }
      job = { job_id, resultUrl: `/api/enhance/${job_id}/result`, sourceUrl: `/api/enhance/${job_id}/source` };
      loading.hidden = true;
      img.hidden = false;
      applyImage();
      toggleBtn.disabled = false;
      ocrBtn.disabled = false;
      root.querySelector('[data-x=dl-result]').disabled = false;
      root.querySelector('[data-x=dl-source]').disabled = false;
      statusEl.textContent = j.faces_found ? `Done — ${j.faces_found} face${j.faces_found > 1 ? 's' : ''} restored.` : 'Done.';
    } catch (e) {
      loading.querySelector('.msg').textContent = e.message || 'Enhancement failed.';
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
