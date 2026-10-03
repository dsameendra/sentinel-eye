// How a person appears — the avatar in the bar, the account page, the accounts list. Three styles (stored
// server-side, app/auth.py set_avatar): their initial on a colour, one of twelve designed avatars, or their
// own photo (downscaled to a small JPEG in the browser before it's ever uploaded).
import { esc } from './ui.js';

export const AVATAR_COLORS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff453a', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#8e8e93'];

// Designed avatars: a gradient tile with a simple white glyph (24-unit grid, drawn like the app's icons).
export const AVATAR_PRESETS = {
  p1: ['#0a84ff', '#5e5ce6', '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>'],          // eye
  p2: ['#30d158', '#0a8f6a', '<path d="M6 18c0-7 5-11.5 12-12-0.5 7-5 12-12 12Z"/><path d="M6 18 13 11"/>'],                               // leaf
  p3: ['#ff9f0a', '#ff375f', '<circle cx="12" cy="12" r="4"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"/>'],   // sun
  p4: ['#5e5ce6', '#1c1c4e', '<path d="M16.5 15.5A6.5 6.5 0 0 1 8.5 7.5a6.5 6.5 0 1 0 8 8Z"/>'],                                            // moon
  p5: ['#ffd60a', '#ff9f0a', '<path d="m12 5 2.1 4.3 4.7.7-3.4 3.3.8 4.7L12 15.8 7.8 18l.8-4.7-3.4-3.3 4.7-.7Z"/>'],                          // star
  p6: ['#bf5af2', '#5e5ce6', '<path d="M13 4 6.5 13h5L11 20l6.5-9h-5Z"/>'],                                                                  // bolt
  p7: ['#64d2ff', '#0a84ff', '<path d="m4 18 5.5-8 3.5 5 2-3 5 6Z"/><circle cx="16.5" cy="7.5" r="1.6"/>'],                                  // mountain
  p8: ['#0a84ff', '#64d2ff', '<path d="M4 10c2.7 0 2.7-2.5 5.3-2.5S12 10 14.7 10 17.3 7.5 20 7.5"/><path d="M4 15.5c2.7 0 2.7-2.5 5.3-2.5s2.7 2.5 5.4 2.5 2.6-2.5 5.3-2.5"/>'], // wave
  p9: ['#ff375f', '#bf5af2', '<path d="M12 18.5s-6.5-3.8-6.5-8.3A3.6 3.6 0 0 1 12 8.1a3.6 3.6 0 0 1 6.5 2.1c0 4.5-6.5 8.3-6.5 8.3Z"/>'],      // heart
  p10: ['#ff9f0a', '#a2662d', '<circle cx="5.8" cy="10.6" r="1.5"/><circle cx="9.4" cy="6" r="1.5"/><circle cx="14.6" cy="6" r="1.5"/><circle cx="18.2" cy="10.6" r="1.5"/><path d="M7.6 17c0-3 2-5.4 4.4-5.4s4.4 2.4 4.4 5.4c0 1.6-1.6 2.3-4.4 2.3s-4.4-.7-4.4-2.3Z"/>'], // paw
  p11: ['#8e8e93', '#3a3a3c', '<circle cx="12" cy="12" r="4.5"/><path d="M4.5 14.5c4-3.5 11-6 15-5.5"/>'],                                  // planet
  p12: ['#30d158', '#64d2ff', '<circle cx="12" cy="12" r="2.2"/><circle cx="12" cy="6.6" r="3.2"/><circle cx="17.1" cy="10.3" r="3.2"/><circle cx="15.2" cy="16.4" r="3.2"/><circle cx="8.8" cy="16.4" r="3.2"/><circle cx="6.9" cy="10.3" r="3.2"/>'], // flower
};

export const AVATAR_COLOR_NAMES = ['Blue', 'Indigo', 'Purple', 'Pink', 'Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Graphite'];

export const defaultColor = (name = '') => AVATAR_COLORS[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

/** White on a dark colour, near-black on a light one (yellow, teal): the initial always reads. */
export function inkOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#1c1c1e' : '#fff';
}

/** The avatar's inner HTML (fills its container, which sets the size and the round shape). */
export function avatarInner(user, override) {
  const a = override !== undefined ? override : user?.avatar;
  const name = user?.username || '?';
  if (a?.kind === 'photo' && user?.id != null) return `<img class="av-photo" src="/api/auth/avatar/${user.id}?v=${a.v || 0}" alt="">`;
  if (a?.kind === 'preset' && AVATAR_PRESETS[a.id]) {
    const [c1, c2, glyph] = AVATAR_PRESETS[a.id];
    return `<span class="av-fill" style="background:linear-gradient(145deg, ${c1}, ${c2})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg></span>`;
  }
  const color = a?.kind === 'initial' ? a.color : defaultColor(name);
  return `<span class="av-fill av-initial" style="background:${esc(color)};color:${inkOn(color)}">${esc(name.slice(0, 1).toUpperCase())}</span>`;
}

/** Downscale a picked image to a square JPEG (centre crop) small enough to load instantly everywhere. */
export async function compressPhoto(file, size = 256, quality = 0.82) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error("That file isn't an image this browser can read.");
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  bmp.close?.();
  return c.toDataURL('image/jpeg', quality);
}
