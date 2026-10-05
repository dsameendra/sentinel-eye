// Presentation only: never creates a player, changes playback time or opens a recorder session.
import { disableInteraction } from './interaction.js';
const controllers = new WeakMap();
const CONTROL = 'button,a,input,select,textarea,[role=slider],[role=checkbox],[contenteditable],.menu,.dialog,.editing,.ocr-mode,.pb-roi-layer';
const isTV = () => document.documentElement.classList.contains('tv-mode');
export const immersive = (el) => !!el && (el.classList.contains('immersive') || document.fullscreenElement === el);
function syncButtons(el) {
  const label = document.fullscreenElement === el ? 'Exit full screen' : immersive(el) ? 'Exit immersive view' : 'Full screen';
  el.querySelectorAll('[data-a=wallfs],[data-a=tvfs],[data-a=fs],[data-a=pbfs],[data-x=fullscreen]').forEach(button => {
    if (button.closest('[data-viewer]') !== el) return;
    button.setAttribute('aria-label', label); button.title = label;
    button.setAttribute('aria-pressed', String(immersive(el)));
    if (button.dataset.a === 'tvfs') button.querySelector('span')?.replaceChildren(label);
  });
}

export async function toggleViewer(el) {
  if (!el) return;
  if (immersive(el)) { leaveViewer(el); return; }
  el.classList.add('immersive');
  controllers.get(el)?.show();
  document.dispatchEvent(new Event('viewerchange'));
  // Unsupported/rejected browser fullscreen still has the same useful app-level composition.
  if (document.documentElement.classList.contains('ios-pwa') || document.fullscreenEnabled === false) return;
  try {
    await el.requestFullscreen?.();
    // A second tap/route teardown may have left the view while native entry was pending.
    if (!el.classList.contains('immersive') && document.fullscreenElement === el) await document.exitFullscreen();
  } catch { /* keep app immersive */ }
}
export function leaveViewer(el) {
  if (!el) return;
  el.classList.remove('immersive');
  if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
  controllers.get(el)?.exited();
  controllers.get(el)?.show();
  document.dispatchEvent(new Event('viewerchange'));
}

export class ViewerControls {
  constructor(el, { chrome, background, enabled = () => true, paused = () => false, delay = () => 2600, held = () => false, exited = () => {} } = {}) {
    controllers.get(el)?.destroy();
    Object.assign(this, { el, chrome, background, enabled, paused, delay, held, exited });
    this.visible = true; this.points = new Map(); this.input = 'touch'; this.hover = false;
    this.saved = new Map(); this.listeners = [];
    controllers.set(el, this);
    el.dataset.viewer = ''; el.tabIndex = -1;
    const on = (node, name, fn, options) => { node.addEventListener(name, fn, options); this.listeners.push([node, name, fn, options]); };
    on(el, 'pointerdown', e => {
      if (!this.active()) return;
      this.input = e.pointerType; this.hover = e.pointerType === 'mouse' && !!e.target.closest(this.chrome);
      const plain = this.plain(e.target);
      this.points.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), plain, dismiss: this.overlay(), moved: false });
      if (this.points.size > 1) for (const p of this.points.values()) p.moved = true;
      clearTimeout(this.timer);
      if (!plain && !e.target.closest('.viewer-exit')) this.show();
    });
    on(el, 'pointermove', e => {
      if (!this.active()) return;
      const p = this.points.get(e.pointerId);
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) { p.moved = true; this.show(); }
      if (e.pointerType === 'mouse' && !this.points.size) {
        if (e.target.closest('.viewer-exit')) return;
        this.input = 'mouse'; this.hover = !!e.target.closest(this.chrome); this.show();
      }
    });
    const up = (e, cancel = false) => {
      const p = this.points.get(e.pointerId); this.points.delete(e.pointerId);
      if (!this.active()) return;
      if (p?.dismiss) { this.suppressTapUntil = performance.now() + 350; this.show(); return; }
      // ZoomPan owns tap/double-tap decisions on picture hit zones and emits viewer-tap instead.
      if (p?.plain && !cancel && !p.moved && performance.now() - p.t < 450 && !e.target.closest('.hit,.hitzone')) {
        if (this.tapTimer) { clearTimeout(this.tapTimer); this.tapTimer = null; this.show(); }
        else this.tapTimer = setTimeout(() => { this.tapTimer = null; this.toggle(); }, 320);
      } else this.schedule();
    };
    on(el, 'pointerup', up); on(el, 'pointercancel', e => up(e, true));
    on(el, 'pointerleave', () => { this.hover = false; this.schedule(); });
    on(el, 'viewer-tap', e => { if (this.active() && this.plain(e.target) && performance.now() > (this.suppressTapUntil || 0)) this.toggle(); });
    on(el, 'viewer-gesture', () => this.show());
    on(el, 'click', e => { if (e.detail === 0 && e.target.closest(CONTROL)) { this.input = isTV() ? 'remote' : 'keyboard'; this.show(); } });
    on(el, 'focusin', e => { if (!this.hiding && !e.target.closest('.viewer-exit') && (this.input === 'keyboard' || isTV())) this.show(); });
    on(el, 'focusout', () => this.schedule());
    on(document, 'keydown', e => {
      if (!this.active() || e.metaKey || e.ctrlKey || e.altKey) return;
      this.input = isTV() ? 'remote' : 'keyboard';
      if (e.key === 'Escape' && !document.fullscreenElement && el.classList.contains('immersive') && !this.overlay()) {
        e.preventDefault(); e.stopImmediatePropagation(); leaveViewer(el); return;
      }
      if (isTV() && !this.visible && /^(Enter|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation(); this.show();
        const action = this.lastFocus?.isConnected ? this.lastFocus : el.querySelector(`${this.chrome} button`);
        action?.focus({ preventScroll: true }); return;
      }
      this.show();
    }, true);
    this.native = document.fullscreenElement === el;
    on(document, 'fullscreenchange', () => {
      const native = document.fullscreenElement === el;
      if (this.native && !native) { el.classList.remove('immersive'); this.exited(); }
      this.native = native; this.show(); document.dispatchEvent(new Event('viewerchange'));
    });
    on(document, 'visibilitychange', () => { clearTimeout(this.timer); if (!document.hidden) this.show(); });
    on(window, 'resize', () => this.show());
    this.show();
  }
  active() {
    if (!this.el.isConnected || !this.enabled()) return false;
    const layers = [...document.querySelectorAll('.focus,.replay-overlay,.enh2,.xp')];
    const top = layers.at(-1);
    return !top || top === this.el || this.el.contains(top) && !top.matches('[data-viewer]');
  }
  overlay() { const modal = document.querySelector('#modal-root > *'); return !!document.body._openPopover || !!modal && !modal.contains(this.el); }
  plain(target) { return !!target.closest(this.background) && !target.closest(CONTROL); }
  locked(manual = false) {
    const focus = document.activeElement;
    return this.overlay() || this.held() || this.points.size > 0 || this.hover && this.input === 'mouse'
      || this.input === 'keyboard' && !!focus?.closest(this.chrome) && this.el.contains(focus)
      || (!manual && this.paused());
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.visible || !this.active() || document.hidden) return;
    this.timer = setTimeout(() => { if (this.locked()) this.schedule(); else this.hide(); }, Math.max(500, this.delay()));
  }
  show() { this.setVisible(true); this.schedule(); }
  hide(manual = false) { if (this.locked(manual)) { this.show(); return; } this.setVisible(false); }
  toggle() { this.visible ? this.hide(true) : this.show(); }
  setVisible(on) {
    syncButtons(this.el);
    this.hiding = !on;
    this.visible = on; clearTimeout(this.timer);
    this.el.classList.toggle('show', on);
    for (const node of this.el.querySelectorAll(this.chrome)) {
      node.classList.toggle('show', on);
      if (on) {
        if (this.saved.has(node)) { this.saved.get(node)(); this.saved.delete(node); }
        node.removeAttribute('data-chrome-hidden');
      } else {
        if (node.contains(document.activeElement)) {
          this.lastFocus = document.activeElement;
          this.el.focus({ preventScroll: true });
        }
        if (!this.saved.has(node)) this.saved.set(node, disableInteraction(node));
        node.dataset.chromeHidden = '';
      }
    }
    this.hiding = false;
  }
  destroy() {
    clearTimeout(this.timer); clearTimeout(this.tapTimer);
    this.listeners.forEach(([node, name, fn, options]) => node.removeEventListener(name, fn, options));
    this.setVisible(true); controllers.delete(this.el); leaveViewer(this.el);
  }
}
