// TV mode: spatial navigation for a remote (or a keyboard's arrows). A TV browser has no pointer and its
// D-pad doesn't move focus by itself (Tizen's included), so arrows move focus to the nearest visible
// control in that direction — tiles, bar buttons, menus, dialogs, Settings rows — on every screen, and OK
// (Enter) presses it. Screens can claim keys first (they run on document; this listens on window and skips
// anything already handled), mark a starting point with [data-tv-default], and hear about a press with
// nowhere to go via a 'tvnav-edge' event (Live turns the page).

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function visible(el) {
  if (el.closest('[hidden], [inert]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none' || +cs.opacity <= 0.05) return false;
  }
  return true;
}

/** The layer a remote is currently in: an open popover, else a modal, else the page. */
function scope() {
  return document.body._openPopover || document.querySelector('.ev-side.open') || document.querySelector('#modal-root > *') || [...document.querySelectorAll('[data-tv-scope]')].pop()
    || document.fullscreenElement || document.body;
}

// The picture in Focus is the thing being watched, not a control to land on.
function candidates() {
  return [...scope().querySelectorAll(FOCUSABLE)].filter((el) => !el.matches('.focus .hit, [data-tv-skip]') && visible(el));
}

function centre(el) { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r]; }

/** Nearest candidate in direction [dx, dy] from `from`. Left/right stay in the row: only controls that
 * overlap it vertically count, so the end of a row is an edge (Live turns the page there) rather than a
 * jump up into the header. Up/down prefer the column, but may cross to whatever's nearest above or below. */
export function nearest(from, [dx, dy], list = candidates()) {
  const [fx, fy, fr] = centre(from);
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === from || from.contains(el) || el.contains(from)) continue;
    const [x, y, r] = centre(el);
    const ahead = dx ? (x - fx) * dx : (y - fy) * dy;
    if (ahead <= 4) continue;
    // Edge-to-edge gap along the direction, so a wide neighbour isn't skipped for a narrow far one.
    const gap = Math.max(0, dx ? (dx > 0 ? r.left - fr.right : fr.left - r.right) : (dy > 0 ? r.top - fr.bottom : fr.top - r.bottom));
    const overlap = dx ? r.top < fr.bottom - 2 && r.bottom > fr.top + 2 : r.left < fr.right - 2 && r.right > fr.left + 2;
    if (dx && !overlap) continue;
    const side = dx ? Math.abs(y - fy) : Math.abs(x - fx);
    const score = gap + side * (overlap ? 0.5 : 2) + (overlap ? 0 : 10000);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

const isTextish = (el) => el?.matches?.('input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, select');

export function installTvNav() {
  window.addEventListener('keydown', (e) => {
    if (!document.documentElement.classList.contains('tv-mode')) return;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const d = DIRS[e.key];
    if (!d) return;
    const active = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    // Let text fields keep left/right for the caret, and sliders for their value.
    if (active && (isTextish(active) || active.matches('input[type=range]')) && d[0] !== 0) return;
    const list = candidates();
    if (!list.length) return;
    e.preventDefault();
    if (!active || !list.includes(active) && !scope().contains(active)) {
      const start = scope().querySelector('[data-tv-default]');
      (start && visible(start) ? start : list[0]).focus({ preventScroll: false });
      return;
    }
    const next = nearest(active, d, list);
    if (next) { next.focus({ preventScroll: false }); next.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
    else document.dispatchEvent(new CustomEvent('tvnav-edge', { detail: { dx: d[0], dy: d[1], from: active } }));
  });
}
