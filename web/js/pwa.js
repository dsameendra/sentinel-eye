// Loaded synchronously in every entry point, before the first paint. Home Screen apps can omit Safari's
// version token and misreport display-mode, so neither an OS-version gate nor that query alone is enough.
(() => {
  const root = document.documentElement;
  const appleTouch = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  const installed = navigator.standalone === true || (appleTouch && matchMedia('(display-mode: standalone)').matches);
  root.classList.toggle('ios-pwa', installed);
  const revision = 'ios-headers-v10';
  root.dataset.pwaRevision = revision;

  function syncTheme() {
    const color = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  }

  // Explicit, local diagnostics for device verification; contains no account, recorder or video data.
  window.SentinelPWA = {
    syncTheme,
    diagnostics() {
      const style = getComputedStyle(root);
      return {
        revision, htmlRevision: document.querySelector('meta[name="sentinel-shell"]')?.content,
        cssRevision: style.getPropertyValue('--shell-revision').trim(), installed,
        standalone: navigator.standalone === true, displayMode: matchMedia('(display-mode: standalone)').matches,
        viewport: { width: innerWidth, height: innerHeight, visualHeight: window.visualViewport?.height },
        safeTop: style.getPropertyValue('--safe-top').trim(),
        headers: [...document.querySelectorAll('.topbar, .focus-bar')].map((bar) => {
          const s = getComputedStyle(bar), r = bar.getBoundingClientRect();
          return { top: r.top, height: r.height, paddingTop: s.paddingTop, background: s.backgroundColor,
            backdropFilter: s.backdropFilter || s.webkitBackdropFilter, position: s.position };
        }),
      };
    },
  };

  function start() {
    syncTheme();
    if (!installed) return;
    const bars = new Map();
    const selector = '.topbar, .focus-bar';
    const size = (bar) => {
      const space = bars.get(bar);
      if (!space) return; // Focus/replay intentionally float over video; no layout space to reserve.
      const height = `${bar.getBoundingClientRect().height}px`;
      if (space.style.height !== height) space.style.height = height;
    };
    const resize = new ResizeObserver((entries) => entries.forEach(({ target }) => size(target)));
    function reconcile() {
      for (const [bar, space] of bars) {
        if (!bar.isConnected) { resize.unobserve(bar); space?.remove(); bars.delete(bar); }
      }
      document.querySelectorAll(selector).forEach((bar) => {
        if (bars.has(bar)) return;
        bar.classList.add('pwa-header');
        let space = null;
        if (bar.matches('.topbar')) {
          space = document.createElement('div');
          space.className = 'pwa-header-space';
          space.setAttribute('aria-hidden', 'true');
          bar.after(space);
        }
        bars.set(bar, space);
        resize.observe(bar);
        size(bar);
      });
    }
    // Only header subtree changes matter; video-frame updates and unrelated controls do not trigger scans.
    const observer = new MutationObserver((records) => {
      if (records.some((r) => [...r.addedNodes, ...r.removedNodes].some((n) =>
        n.nodeType === 1 && (n.matches(selector) || n.querySelector(selector))))) reconcile();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    reconcile();
    document.addEventListener('fullscreenchange', () => bars.forEach((_, bar) => size(bar)));
    addEventListener('pageshow', () => { reconcile(); bars.forEach((_, bar) => size(bar)); syncTheme(); });
    // Theme/TV appearance changes are explicit state, not colors sampled from video or a single pixel.
    new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  }
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', syncTheme);
  document.addEventListener('DOMContentLoaded', start, { once: true });
})();
