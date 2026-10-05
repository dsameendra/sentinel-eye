// Exercise the real presentation controller with deterministic time and input, without a recorder.
import assert from 'node:assert/strict';

class Classes {
  constructor(...items) { this.items = new Set(items); }
  contains(v) { return this.items.has(v); }
  add(v) { this.items.add(v); }
  remove(v) { this.items.delete(v); }
  toggle(v, on = !this.contains(v)) { on ? this.add(v) : this.remove(v); return on; }
}
class Node extends EventTarget {
  constructor(kind) { super(); this.kind = kind; this.classList = new Classes(kind); this.dataset = {}; this.attrs = new Map(); this.isConnected = true; this.children = []; }
  hasAttribute(k) { return this.attrs.has(k); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  setAttribute(k,v) { this.attrs.set(k,v); }
  removeAttribute(k) { this.attrs.delete(k); }
  closest(selector) { return selector.includes(this.kind) || this.tagName && selector.includes(this.tagName.toLowerCase()) ? this : this.parent?.closest(selector) || null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector) { return selector === '.chrome' ? this.children.filter(n => n.kind === '.chrome') : this.children.flatMap(n => [n,...n.children]).filter(n => n.kind === 'button'); }
  querySelector(selector) { return selector === ':scope > .viewer-exit' ? this.children.find(n => n.kind === '.viewer-exit') || null : this.querySelectorAll(selector)[0]; }
  focus() { document.activeElement = this; this.dispatchEvent(new Event('focusin')); }
}
const doc = new EventTarget();
Object.assign(doc, { documentElement: { classList: new Classes() }, body: {}, activeElement: null,
  querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, hidden: false, fullscreenElement: null });
globalThis.document = doc;
globalThis.window = new EventTarget();
globalThis.addEventListener = (...args) => window.addEventListener(...args);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.ResizeObserver = globalThis.MutationObserver = class { observe() {} unobserve() {} };
globalThis.requestAnimationFrame = () => 0;
let now = 0, id = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true });
globalThis.CustomEvent = class extends Event {};
const timers = new Map();
globalThis.setTimeout = (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; };
globalThis.clearTimeout = key => timers.delete(key);
const advance = ms => {
  const end = now + ms;
  while (true) {
    const entry = [...timers].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
    if (!entry) break;
    now = entry[1].at; timers.delete(entry[0]); entry[1].fn();
  }
  now = end;
};
const { ViewerControls, toggleViewer, leaveViewer, bindViewerToggle } = await import('../web/js/viewer.js');
const el = new Node('viewer'), chrome = new Node('.chrome'), button = new Node('button'), exit = new Node('.viewer-exit');
exit.tagName = 'BUTTON'; el.children = [chrome, exit]; chrome.parent = el; chrome.children = [button]; button.parent = chrome; exit.parent = el;
let paused = false, held = false, enabled = true;
const controls = new ViewerControls(el, { chrome: '.chrome', background: 'viewer', paused: () => paused, held: () => held, enabled: () => enabled, delay: () => 1000 });
let checks = 0;
const check = (label, value) => { assert.ok(value,label); checks++; };
const toggleRoot = new Node('viewer'), toggleButton = new Node('button');
toggleRoot.children = [toggleButton]; toggleButton.parent = toggleRoot;
bindViewerToggle(toggleButton, toggleRoot);
check('fullscreen action has its enter state from the first render', toggleButton.getAttribute('aria-label') === 'Full screen' && toggleButton.getAttribute('aria-pressed') === 'false');
const pointerActivate = () => { const e=new Event('pointerup'); Object.assign(e,{isPrimary:true,pointerType:'touch',button:0}); toggleButton.dispatchEvent(e); };
pointerActivate(); check('fullscreen pointer action enters immersion', toggleRoot.classList.contains('immersive'));
check('fullscreen action announces its exit state immediately', toggleButton.getAttribute('aria-label') === 'Exit full screen' && toggleButton.getAttribute('aria-pressed') === 'true');
const synthesizedClick = new Event('click'); Object.defineProperty(synthesizedClick,'detail',{value:1}); toggleButton.dispatchEvent(synthesizedClick);
check('pointer and synthesized click do not double-toggle', toggleRoot.classList.contains('immersive'));
pointerActivate(); check('fullscreen pointer action exits immersion', !toggleRoot.classList.contains('immersive'));
check('fullscreen action returns to its enter state after exit', toggleButton.getAttribute('aria-label') === 'Full screen' && toggleButton.getAttribute('aria-pressed') === 'false');
const keyboardClick = new Event('click'); Object.defineProperty(keyboardClick,'detail',{value:0}); toggleButton.dispatchEvent(keyboardClick);
check('keyboard click enters immersion', toggleRoot.classList.contains('immersive'));
leaveViewer(toggleRoot);
check('starts visible', controls.visible);
advance(1000); check('idle hides', !controls.visible);
check('hidden chrome inert', chrome.hasAttribute('inert'));
check('legacy focus fallback', button.tabIndex === -1);
controls.toggle(); check('background reveal', controls.visible);
check('restores focusability', !chrome.hasAttribute('inert') && !button.hasAttribute('tabindex'));
controls.toggle(); check('background hides manually', !controls.visible);
paused = true; controls.show(); advance(2500); check('paused default held', controls.visible);
controls.toggle(); check('paused manual hiding allowed', !controls.visible);
controls.show(); paused = false; advance(1000); check('resume idle hides', !controls.visible);
held = true; controls.show(); advance(1200); check('editor holds', controls.visible);
controls.toggle(); check('editor resists manual hiding', controls.visible);
held = false; document.body._openPopover = {}; advance(1200); check('popover holds', controls.visible);
document.body._openPopover = null; advance(1000); check('closed popover releases hold', !controls.visible);
controls.input = 'keyboard'; document.activeElement = button; controls.show(); advance(1200); check('keyboard focus held', controls.visible);
document.activeElement = el; advance(1000); check('focus exit releases hold', !controls.visible);
document.documentElement.classList.add('tv-mode'); controls.input = 'remote'; document.activeElement = button; controls.show(); advance(1000);
check('remote idle hides despite old action focus', !controls.visible);
check('remote focus moves to watching surface', document.activeElement === el);
const key = new Event('keydown', { cancelable: true }); Object.defineProperty(key,'key',{ value:'Enter' }); document.dispatchEvent(key);
check('remote wake consumes activation', key.defaultPrevented && controls.visible);
check('remote restores prior action', document.activeElement === button);
document.documentElement.classList.remove('tv-mode'); document.activeElement = el;
enabled = false; controls.show(); advance(3000); check('normal review never auto hides', controls.visible);
enabled = true; controls.show(); doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); advance(3000); check('background cancels timer', controls.visible);
doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')); advance(1000); check('resume reconciles timer', !controls.visible);
await toggleViewer(el); check('unsupported fullscreen has immersive fallback', el.classList.contains('immersive'));
leaveViewer(el); check('explicit immersive exit', !el.classList.contains('immersive'));
el.requestFullscreen = () => Promise.reject(new Error('blocked'));
await toggleViewer(el); check('rejected fullscreen keeps fallback', el.classList.contains('immersive'));
leaveViewer(el);
let nativeRequests = 0;
el.requestFullscreen = async () => { nativeRequests++; document.fullscreenElement = el; };
document.documentElement.classList.add('ios-pwa');
await toggleViewer(el);
check('installed iOS uses app expansion without native request', nativeRequests === 0 && el.classList.contains('immersive'));
leaveViewer(el); document.documentElement.classList.remove('ios-pwa');
await toggleViewer(el);
check('desktop still requests native fullscreen', nativeRequests === 1 && document.fullscreenElement === el);
document.exitFullscreen = async () => { document.fullscreenElement = null; };
leaveViewer(el);
check('explicit exit leaves native and app expansion', !document.fullscreenElement && !el.classList.contains('immersive'));
await toggleViewer(el); document.dispatchEvent(new Event('fullscreenchange'));
await toggleViewer(el);
check('same fullscreen button returns to normal in one action', !document.fullscreenElement && !el.classList.contains('immersive'));
await toggleViewer(el); document.dispatchEvent(new Event('fullscreenchange'));
document.fullscreenElement = null; document.dispatchEvent(new Event('fullscreenchange'));
check('browser fullscreen exit also restores normal composition', !el.classList.contains('immersive'));
let completeNative;
el.requestFullscreen = () => new Promise(resolve => { completeNative = () => { document.fullscreenElement = el; resolve(); }; });
const pendingNative = toggleViewer(el);
leaveViewer(el); completeNative(); await pendingNative;
check('leaving during pending native entry cannot reopen fullscreen', !document.fullscreenElement && !el.classList.contains('immersive'));
controls.input = 'touch'; document.activeElement = el; controls.show(); advance(1000);
const pointer = new Event('pointerdown'); Object.assign(pointer,{pointerType:'touch',pointerId:9,clientX:1,clientY:1});
Object.defineProperty(pointer,'target',{value:exit}); el.dispatchEvent(pointer);
check('exit pointerdown wakes hidden chrome', controls.visible && !el.classList.contains('exit-hidden'));
const cancel = new Event('pointercancel'); Object.assign(cancel,{pointerId:9}); Object.defineProperty(cancel,'target',{value:exit}); el.dispatchEvent(cancel);
advance(1000); check('exit control auto hides independently', el.classList.contains('exit-hidden'));
controls.input = 'keyboard'; const focus = new Event('focusin'); Object.defineProperty(focus,'target',{value:exit}); el.dispatchEvent(focus);
check('keyboard focus wakes hidden exit control', !el.classList.contains('exit-hidden'));
document.activeElement = el; controls.input = 'touch'; controls.hide();
const surfaceDown = new Event('pointerdown'); Object.assign(surfaceDown,{pointerType:'touch',pointerId:10,clientX:2,clientY:2}); Object.defineProperty(surfaceDown,'target',{value:el}); el.dispatchEvent(surfaceDown);
check('a touch wakes hidden controls immediately', controls.visible);
const surfaceUp = new Event('pointerup'); Object.assign(surfaceUp,{pointerId:10}); Object.defineProperty(surfaceUp,'target',{value:el}); el.dispatchEvent(surfaceUp);
controls.destroy(); check('teardown removes immersion', !el.classList.contains('immersive'));
check('teardown restores interaction', !chrome.hasAttribute('inert'));
check('teardown clears timers', timers.size === 0);
// Exercise the actual gesture recognizer too: only a confirmed single tap toggles chrome.
const { ZoomPan } = await import('../web/js/zoom.js');
const hit = new Node('.hitzone'); let taps = 0, gestures = 0, zooms = 0;
hit.addEventListener('viewer-tap', () => taps++);
hit.addEventListener('viewer-gesture', () => gestures++);
const z = { hit, ptrs: new Map(), moved: 0, pinched: false, dbl: true, toggleAt: () => zooms++ };
const finish = (cancelled = false) => { z.ptrs.set(1,{}); ZoomPan.prototype.up.call(z,{pointerId:1,clientX:20,clientY:20},cancelled); };
finish(); advance(319); check('single tap waits for double tap window', taps === 0);
advance(1); check('confirmed single tap emitted once', taps === 1);
advance(1000); finish(); advance(150); finish(); advance(400);
check('double tap zooms without chrome toggle', zooms === 1 && taps === 1 && gestures === 1);
finish(); advance(150); finish(true); advance(400);
check('pointer cancellation cancels pending single tap', taps === 1);
z.moved = 12; finish(); advance(400);
check('pan emits gesture without chrome toggle', gestures === 2 && taps === 1);
z.moved = 0; z.pinched = true; finish(); advance(400);
check('pinch cannot become tap', gestures === 3 && taps === 1);
z.pinched = false; z.dbl = false; finish(); advance(400);
check('ordinary grid clicks retain their existing ownership', taps === 1);
for (let i=0;i<5;i++) {
  const c = new ViewerControls(el,{chrome:'.chrome',background:'viewer'}); c.destroy();
}
check('repeated mounts leave no idle timers', timers.size === 0);
console.log(`${checks}/${checks} viewer behavior checks passed`);
