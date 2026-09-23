// The "wand" L0 live-enhancement control panel — shared by the Live grid (Tile), Live focus view, and
// Playback panes, since all three previously duplicated their own small preset-only popover. Presets are
// still here as one-click starting points, but every underlying parameter is now an individually
// adjustable, independently stackable slider (docs/playback-spec.md's L0 section) — moving one slider
// after picking a preset just keeps tweaking from there, it doesn't reset to "custom" or lose the rest.
import { esc, icon } from './ui.js';
import { PRESETS } from './enhance.js';

const SLIDERS = [
  { group: 'Look', key: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01 },
  { group: 'Look', key: 'contrast', label: 'Contrast', min: 0.5, max: 2, step: 0.01 },
  { group: 'Look', key: 'gamma', label: 'Gamma', min: 0.4, max: 2.5, step: 0.01 },
  { group: 'Clarity', key: 'sharpen', label: 'Sharpen (edge-aware)', min: 0, max: 1.5, step: 0.01 },
  { group: 'Clarity', key: 'localContrast', label: 'Local contrast', min: 0, max: 1.5, step: 0.01 },
  { group: 'Conditions', key: 'shadowLift', label: 'Shadow lift', min: 0, max: 1, step: 0.01 },
  { group: 'Conditions', key: 'dehaze', label: 'Dehaze', min: 0, max: 1, step: 0.01 },
  { group: 'Conditions', key: 'wdr', label: 'WDR (backlight)', min: 0, max: 1, step: 0.01 },
  { group: 'Conditions', key: 'retinex', label: 'Extreme lighting (Retinex)', min: 0, max: 1, step: 0.01 },
  { group: 'Conditions', key: 'rainSnow', label: 'Rain / snow reduction', min: 0, max: 1, step: 0.01 },
  { group: 'Lens', key: 'caFix', label: 'Chromatic aberration fix', min: 0, max: 1, step: 0.01 },
];
const GROUPS = [...new Set(SLIDERS.map((s) => s.group))];

/** opts: { roi, flashlight } — which interactive tools to show. Playback panes get both (drag-select and
 * cursor-follow only make sense on an inspectable, steppable pane); the AI frame enhancer (enhancePopup.js)
 * gets flashlight only — it already has its own, differently-scoped region crop (crops before the AI
 * pipeline runs, not a live GPU-scissor preview), so this doesn't duplicate that with a second, confusingly
 * similar "select region" control. Live grid tiles/focus view get neither (a live, moving picture isn't
 * something you inspect at a fixed cursor position or draw a stable box over). */
export function enhancePanelHTML(opts = {}) {
  const { roi = false, flashlight = false } = opts;
  return `
    <div class="enh2-presets">${Object.entries(PRESETS).filter(([k]) => k !== 'custom').map(([k, p]) =>
    `<button data-preset="${k}" title="Fills in every slider below at once — still freely adjustable after.">${esc(p.label)}</button>`).join('')}</div>
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
      const v = Number(inp.value);
      root.querySelector(`[data-kv="${inp.dataset.k}"]`).textContent = v.toFixed(2);
      cbs.onParam(inp.dataset.k, v);
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
}
