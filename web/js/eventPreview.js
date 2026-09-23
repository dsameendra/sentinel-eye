// Quick event preview (Events page): plays the clip in a small, centered popup without navigating away to
// Playback — for "what actually happened here", not full review (scrubbing, export, enhancement all still
// go through Playback). Reuses the same WebCodecs player Playback and Live's instant replay already use.
import { esc, icon, toast } from './ui.js';
import { WCPlayer } from './wcplayer.js';
import { api } from './api.js';

const EXPORT_SCALE = 16; // must match app/export.py's EXPORT_SCALE — same constant playback.js's own export polling uses

const KIND_LABEL = { motion: 'Motion', line: 'Line cross', tamper: 'Tamper', videoloss: 'Video loss', bookmark: 'Bookmark' };

/** @param opts { ev (event row), cam (channel settings object, or null if not enabled), onOpenPlayback() } */
export function openEventPreview(opts) {
  const { ev, cam } = opts;
  const root = document.getElementById('modal-root');

  // A motion/line/tamper span has a real start/end (already stitched — see events.js's header comment);
  // pad both ends by 2s so the lead-in/lead-out isn't cut off mid-action. A bookmark (or anything else
  // recorded as a single instant) has start === end — there's no span to pad, so centre a wider 4s-either-
  // side window on that one timestamp instead, matching what "a moment", not "a span", actually needs.
  const startMs = new Date(ev.start_utc).getTime(), endMs = new Date(ev.end_utc).getTime();
  const isInstant = endMs - startMs < 1000;
  const playFromEpoch = ((isInstant ? startMs : startMs) - (isInstant ? 4000 : 2000)) / 1000;
  const playToEpoch = ((isInstant ? startMs : endMs) + (isInstant ? 4000 : 2000)) / 1000;

  let attrs = null;
  if (ev.kind === 'bookmark' && ev.attrs_json) { try { attrs = JSON.parse(ev.attrs_json); } catch { /* malformed, skip */ } }
  const camLabel = cam ? cam.name || 'Camera ' + cam.channel : `Channel ${ev.channel}`;

  root.innerHTML = `<div class="scrim evp-scrim"><div class="evp-dialog" role="dialog" aria-modal="true" aria-label="Event preview">
    <div class="evp-top">
      <div class="evp-title"><span class="ev-badge ${ev.kind}">${KIND_LABEL[ev.kind] || ev.kind}</span>
        <b>${esc(camLabel)}</b>${attrs?.title ? `<span class="evp-etitle">${esc(attrs.title)}</span>` : ''}</div>
      <button class="btn icon sm ghost" data-x="close" title="Close (Esc)" aria-label="Close">${icon('close')}</button>
    </div>
    <div class="evp-stage"><canvas></canvas>
      <div class="evp-veil"><div class="spin"></div><div class="msg">Connecting…</div></div></div>
    <div class="evp-bottom"><span class="hint evp-status"></span><span class="spacer"></span>
      <button class="btn sm" data-x="restart">${icon('rewind')} Restart</button>
      <button class="btn sm" data-x="export" ${cam ? '' : 'disabled title="This camera is not enabled"'}>${icon('download')} Download clip</button>
      <button class="btn sm primary" data-x="open">${icon('video')} Open in playback</button>
    </div>
  </div></div>`;

  const canvas = root.querySelector('canvas');
  const veil = root.querySelector('.evp-veil');
  const veilMsg = veil.querySelector('.msg');
  const statusEl = root.querySelector('.evp-status');

  const close = () => {
    player?.destroy();
    document.removeEventListener('keydown', onKey);
    root.innerHTML = '';
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.querySelector('.scrim').addEventListener('click', (e) => { if (e.target.classList.contains('scrim')) close(); });
  root.querySelector('[data-x=close]').addEventListener('click', close);
  root.querySelector('[data-x=open]').addEventListener('click', () => { close(); opts.onOpenPlayback(); });

  let atEnd = false;
  const start = () => {
    atEnd = false;
    veil.hidden = false;
    veilMsg.textContent = 'Connecting…';
    player.connect(cam ? cam.id : String(ev.channel), new Date(playFromEpoch * 1000).toISOString(), '1');
  };
  const player = new WCPlayer(canvas, {
    onFrame: (absTime) => {
      if (!atEnd && absTime >= playToEpoch) { atEnd = true; player.pauseHere(); }
    },
    onState: (s) => {
      veil.hidden = s === 'playing' || s === 'paused';
      statusEl.textContent = atEnd ? 'End of clip' : ({ connecting: 'Connecting…', queued: 'Waiting for a recorder session…', playing: 'Playing', paused: 'Paused', error: 'Error' }[s] || '');
    },
    onError: (msg) => { veil.hidden = false; veilMsg.textContent = msg; toast(`Preview: ${msg}`, 'bad', 6000); },
  });
  root.querySelector('[data-x=restart]').addEventListener('click', start);

  // Quick download: same clip window already computed above (start/end padded by 2s, or ±4s around a
  // single instant) — "what's shown on the video" is exactly the range this exports, not a separate,
  // possibly-different range the operator would have to re-figure-out in Playback's own export dialog.
  const exportBtn = root.querySelector('[data-x=export]');
  let exporting = false;
  exportBtn.addEventListener('click', async () => {
    if (exporting || !cam) return;
    exporting = true;
    const original = exportBtn.innerHTML;
    exportBtn.disabled = true;
    exportBtn.innerHTML = `<span class="spin" style="width:14px;height:14px"></span> Preparing…`;
    try {
      const { job_id } = await api.createExport({
        channels: [cam.id],
        start_utc: new Date(playFromEpoch * 1000).toISOString(),
        end_utc: new Date(playToEpoch * 1000).toISOString(),
        package: 'plain',
      });
      const spanSec = playToEpoch - playFromEpoch;
      const deadline = Date.now() + Math.max(60, (spanSec / EXPORT_SCALE) * 3 + 60) * 1000;
      while (true) {
        if (Date.now() > deadline) throw new Error('Export is taking much longer than expected.');
        const job = await api.exportStatus(job_id);
        if (job.state === 'error') throw new Error(job.error || 'Export failed');
        if (job.state === 'done') break;
        exportBtn.innerHTML = `<span class="spin" style="width:14px;height:14px"></span> ${esc(job.progress || 'Working…')}`;
        await new Promise((r) => setTimeout(r, 1200));
      }
      const a = document.createElement('a');
      a.href = `/api/export/${job_id}/download`;
      a.click();
      exportBtn.innerHTML = `${icon('check')} Downloaded`;
      setTimeout(() => { exportBtn.innerHTML = original; exportBtn.disabled = false; exporting = false; }, 2500);
    } catch (e) {
      toast(e.message || 'Export failed', 'bad', 6000);
      exportBtn.innerHTML = original;
      exportBtn.disabled = false;
      exporting = false;
    }
  });

  if (!player.supported) veilMsg.textContent = "This browser can't play recordings (WebCodecs unavailable).";
  else if (!cam) veilMsg.textContent = 'This camera is not enabled.';
  else start();
}
