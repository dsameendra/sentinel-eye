// The "wand" L0 live-enhancement control panel — shared by the Live grid (Tile), Live focus view, and
// Playback panes, since all three previously duplicated their own small preset-only popover. Presets are
// still here as one-click starting points, but every underlying parameter is now an individually
// adjustable, independently stackable slider (docs/SPEC.md's L0 section) — moving one slider
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
const OPEN_KEY = 'sentinel-eye-adjust-open';   // which groups are expanded, remembered per browser
const DEFAULTS = Object.fromEntries(SLIDERS.map((s) => [s.key, PRESETS.off[s.key] ?? 0]));
const fmt = (k, v) => (k === 'brightness' ? `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}` : Number(v).toFixed(2));

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
  let open = {};
  try { open = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); } catch { /* private mode */ }
  return `
    <div class="adj-head"><div><b>Adjust picture</b><span class="enh2-status"></span></div>
      <button class="btn sm ghost" data-x="reset" title="Back to the untouched picture">Reset</button></div>
    <div class="enh2-presets" role="group" aria-label="Presets">${Object.entries(PRESETS).filter(([k]) => k !== 'custom' || hasSavedCustomPreset()).map(([k, p]) =>
    `<button data-preset="${k}" title="${k === 'custom' ? 'Your last custom mix, saved automatically.' : 'Sets every slider below at once — still adjustable after.'}">${esc(p.label)}</button>`).join('')}</div>
    ${GROUPS.map((g, gi) => {
      const isOpen = open[g] ?? gi === 0;
      return `
      <section class="adj-group${isOpen ? ' open' : ''}" data-g="${esc(g)}">
        <button class="adj-group-head" aria-expanded="${isOpen}"><span>${esc(g)}</span><span class="adj-dot" hidden></span>${icon('down')}</button>
        <div class="adj-rows">${SLIDERS.filter((s) => s.group === g).map((s) => `
          <label class="enh2-row" title="Double-click to reset">
            <span class="adj-l">${esc(s.label)}</span><span class="enh2-val" data-kv="${s.key}"></span>
            <input type="range" data-k="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" aria-label="${esc(s.label)}">
          </label>`).join('')}</div>
      </section>`;
    }).join('')}
    ${roi || flashlight ? `
      <div class="enh2-tools">
        ${roi ? `<button data-x="roi" aria-pressed="false" title="Drag a box on the pane — only inside it gets adjusted; everywhere else stays the raw feed.">${icon('crop')}<span>Adjust a region only</span></button>` : ''}
        ${flashlight ? `<button data-x="flashlight" aria-pressed="false" title="Lifts shadows locally around your cursor, like a torch.">${icon('flashlight')}<span>Digital flashlight</span></button>` : ''}
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
  root.querySelectorAll('[data-k]').forEach((inp) => inp.closest('label').addEventListener('dblclick', (e) => {
    e.preventDefault();
    cbs.onParam(inp.dataset.k, DEFAULTS[inp.dataset.k]);
    refreshEnhancePanel(root, cbs.getParams());
  }));
  root.querySelector('[data-x=reset]')?.addEventListener('click', () => { cbs.onPreset('off'); refreshEnhancePanel(root, cbs.getParams()); });
  root.querySelectorAll('.adj-group-head').forEach((h) => h.addEventListener('click', () => {
    const g = h.closest('.adj-group');
    const isOpen = g.classList.toggle('open');
    h.setAttribute('aria-expanded', String(isOpen));
    try {
      const open = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}');
      open[g.dataset.g] = isOpen;
      localStorage.setItem(OPEN_KEY, JSON.stringify(open));
    } catch { /* private mode */ }
  }));
  root.querySelector('[data-x=roi]')?.addEventListener('click', () => cbs.onRoiToggle());
  root.querySelector('[data-x=flashlight]')?.addEventListener('click', () => cbs.onFlashlightToggle());
  refreshEnhancePanel(root, cbs.getParams());
}

export function refreshEnhancePanel(root, params) {
  root.querySelectorAll('[data-k]').forEach((inp) => {
    const v = params[inp.dataset.k] ?? 0;
    inp.value = v;
    // The accent fill runs from the slider's resting value to the thumb (both ways for brightness).
    const min = +inp.min, max = +inp.max, span = max - min;
    const at = ((v - min) / span) * 100, rest = ((DEFAULTS[inp.dataset.k] - min) / span) * 100;
    inp.style.setProperty('--a', `${Math.min(at, rest)}%`);
    inp.style.setProperty('--b', `${Math.max(at, rest)}%`);
    const changed = Math.abs(v - DEFAULTS[inp.dataset.k]) > 1e-6;
    inp.closest('label').classList.toggle('changed', changed);
    root.querySelector(`[data-kv="${inp.dataset.k}"]`).textContent = fmt(inp.dataset.k, v);
  });
  // A dot on a collapsed group's header when something inside it is moved.
  root.querySelectorAll('.adj-group').forEach((g) => { g.querySelector('.adj-dot').hidden = !g.querySelector('.enh2-row.changed'); });
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
