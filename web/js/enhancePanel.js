// The "wand" L0 live-enhancement control panel — shared by the Live grid (Tile), Live focus view, and
// Playback panes, since all three previously duplicated their own small preset-only popover. Presets are
// still here as one-click starting points, but every underlying parameter is now an individually
// adjustable, independently stackable slider (docs/playback-spec.md's L0 section) — moving one slider
// after picking a preset just keeps tweaking from there, it doesn't reset to "custom" or lose the rest.
import { esc, icon } from './ui.js';
import { PRESETS, saveCustomPreset, hasSavedCustomPreset } from './enhance.js';

const SLIDERS = [
  { group: 'Look', key: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01 },
  { group: 'Look', key: 'contrast', label: 'Contrast', min: 0.5, max: 2, step: 0.01 },
  { group: 'Look', key: 'gamma', label: 'Gamma', min: 0.4, max: 2.5, step: 0.01 },
  { group: 'Clarity', key: 'denoise', label: 'Noise reduction', min: 0, max: 1, step: 0.01 },
  { group: 'Clarity', key: 'sharpen', label: 'Sharpen (edge-aware)', min: 0, max: 1.5, step: 0.01 },
  { group: 'Clarity', key: 'localContrast', label: 'Local contrast', min: 0, max: 1.5, step: 0.01 },
  { group: 'Conditions', key: 'shadowLift', label: 'Shadow lift', min: 0, max: 1, step: 0.01 },
  { group: 'Conditions', key: 'dehaze', label: 'Dehaze', min: 0, max: 1, step: 0.01 },
  { group: 'Conditions', key: 'wdr', label: 'WDR (backlight)', min: 0, max: 1, step: 0.01 },
  { group: 'Conditions', key: 'retinex', label: 'Extreme lighting (Retinex)', min: 0, max: 1, step: 0.01 },
  { group: 'Conditions', key: 'rainSnow', label: 'Rain / snow reduction', min: 0, max: 1, step: 0.01 },
  { group: 'Color & lens', key: 'whiteBalance', label: 'Auto white balance', min: 0, max: 1, step: 0.01 },
  { group: 'Color & lens', key: 'caFix', label: 'Chromatic aberration fix', min: 0, max: 1, step: 0.01 },
];
const GROUPS = [...new Set(SLIDERS.map((s) => s.group))];

/** "Off", a preset's own label if params match it exactly, or "Custom (N)" — the one place that decides
 * what to call the current mix, used both for the panel's own status line and for the small pill shown on
 * the tile/pane itself wherever this panel is used. */
export function summarizeEnhParams(params) {
  const neutral = (p) => Object.entries(PRESETS.off).every(([k, v]) => k === 'label' || p[k] === v);
  if (neutral(params)) return { label: 'Off', active: false };
  for (const [k, p] of Object.entries(PRESETS)) {
    if (k === 'off' || k === 'custom') continue;
    if (Object.entries(p).every(([pk, pv]) => pk === 'label' || params[pk] === pv)) return { label: p.label, active: true };
  }
  const n = Object.entries(PRESETS.off).filter(([k, v]) => k !== 'label' && params[k] !== v).length;
  return { label: `Custom (${n} adjustment${n > 1 ? 's' : ''})`, active: true };
}

/** opts: { roi, flashlight } — which interactive tools to show. Playback panes get both (drag-select and
 * cursor-follow only make sense on an inspectable, steppable pane); the AI frame enhancer (enhancePopup.js)
 * gets flashlight only — it already has its own, differently-scoped region crop (crops before the AI
 * pipeline runs, not a live GPU-scissor preview), so this doesn't duplicate that with a second, confusingly
 * similar "select region" control. Live grid tiles/focus view get neither (a live, moving picture isn't
 * something you inspect at a fixed cursor position or draw a stable box over). */
export function enhancePanelHTML(opts = {}) {
  const { roi = false, flashlight = false } = opts;
  return `
    <div class="enh2-status"></div>
    <div class="enh2-presets">${Object.entries(PRESETS).filter(([k]) => k !== 'custom' || hasSavedCustomPreset()).map(([k, p]) =>
    `<button data-preset="${k}" title="${k === 'custom' ? 'Your last custom mix, saved automatically — apply it here too.' : 'Fills in every slider below at once — still freely adjustable after.'}">${esc(p.label)}</button>`).join('')}</div>
    ${GROUPS.map((g) => `
      <div class="enh2-group">
        <div class="enh2-group-label">${esc(g)}</div>
        ${SLIDERS.filter((s) => s.group === g).map((s) => `
          <label class="enh2-row">
            <span>${esc(s.label)}</span>
            <input type="range" data-k="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}">
            <span class="enh2-val" data-kv="${s.key}"></span>
          </label>`).join('')}
      </div>`).join('')}
    ${roi || flashlight ? `
      <div class="enh2-group">
        <div class="enh2-group-label">Tools</div>
        <div class="enh2-tools">
          ${roi ? `<button class="btn sm" data-x="roi" aria-pressed="false" title="Drag a box on the pane — the picture above only gets enhanced inside it, everywhere else stays the untouched raw feed (and costs nothing extra to render).">${icon('crop')} Select region</button>` : ''}
          ${flashlight ? `<button class="btn sm" data-x="flashlight" aria-pressed="false" title="Move your cursor over the picture to locally lift shadows around it, like a torch — everywhere else keeps its own exposure.">${icon('flashlight')} Digital flashlight</button>` : ''}
        </div>
      </div>` : ''}`;
}

/** root: the element enhancePanelHTML() was written into. cbs: { getParams(), onPreset(name),
 * onParam(key, value), onRoiToggle(), onFlashlightToggle() } — the last two only fire if the corresponding
 * button was included via enhancePanelHTML's opts. */
export function wireEnhancePanel(root, cbs) {
  root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    cbs.onPreset(b.dataset.preset);
    refreshEnhancePanel(root, cbs.getParams());
  }));
  root.querySelectorAll('[data-k]').forEach((inp) => {
    inp.addEventListener('input', () => {
      cbs.onParam(inp.dataset.k, Number(inp.value));
      // Moving any slider can change what the mix now matches (a preset exactly, or nothing — "Custom"),
      // same as picking a preset outright does above — the status line and preset highlighting need the
      // same refresh either way, not just the one slider's own readout.
      refreshEnhancePanel(root, cbs.getParams());
    });
  });
  root.querySelector('[data-x=roi]')?.addEventListener('click', () => cbs.onRoiToggle());
  root.querySelector('[data-x=flashlight]')?.addEventListener('click', () => cbs.onFlashlightToggle());
  refreshEnhancePanel(root, cbs.getParams());
}

export function refreshEnhancePanel(root, params) {
  root.querySelectorAll('[data-k]').forEach((inp) => {
    const v = params[inp.dataset.k] ?? 0;
    inp.value = v;
    root.querySelector(`[data-kv="${inp.dataset.k}"]`).textContent = Number(v).toFixed(2);
  });
  const { label, active } = summarizeEnhParams(params);
  // Moving a slider after picking a preset (or from scratch) no longer matches any built-in mix — that's
  // exactly "Custom", and it's saved right here, automatically, the moment it's detected: PRESETS.custom
  // is updated in place (so a different tile/pane's panel picks it up the next time it's opened) and
  // persisted to localStorage (so it survives a reload) — no separate "save" action to remember to press.
  if (label.startsWith('Custom')) saveCustomPreset(params);
  const status = root.querySelector('.enh2-status');
  if (status) { status.textContent = label; status.classList.toggle('active', active); }
  root.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === label)));
}
