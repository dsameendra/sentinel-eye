// Grid layouts. Each layout is a cols x rows grid plus a list of cells; `big` cells get the HD stream in Auto quality.
const grid = (cols, rows) => ({
  cols, rows,
  cells: Array.from({ length: cols * rows }, (_, i) => ({ c: (i % cols) + 1, r: Math.floor(i / cols) + 1, w: 1, h: 1, big: cols * rows <= 2 })),
});

// one large cell + the rest around it
const focusLayout = (cols, rows, bigSize) => {
  const cells = [{ c: 1, r: 1, w: bigSize, h: bigSize, big: true }];
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) if (c > bigSize || r > bigSize) cells.push({ c, r, w: 1, h: 1, big: false });
  return { cols, rows, cells };
};

const twoBig = () => {
  const cells = [{ c: 1, r: 1, w: 2, h: 2, big: true }, { c: 3, r: 1, w: 2, h: 2, big: true }];
  for (let r = 3; r <= 4; r++) for (let c = 1; c <= 4; c++) cells.push({ c, r, w: 1, h: 1, big: false });
  return { cols: 4, rows: 4, cells };
};

export const LAYOUTS = {
  '1x1': { label: '1 × 1', ...grid(1, 1) },
  '2x2': { label: '2 × 2', ...grid(2, 2) },
  '3x2': { label: '3 × 2', ...grid(3, 2) },
  '3x3': { label: '3 × 3', ...grid(3, 3) },
  '4x3': { label: '4 × 3', ...grid(4, 3) },
  '4x4': { label: '4 × 4', ...grid(4, 4) },
  '1+5': { label: '1 + 5', ...focusLayout(3, 3, 2) },
  '1+7': { label: '1 + 7', ...focusLayout(4, 4, 3) },
  '2+8': { label: '2 + 8', ...twoBig() },
};

export const layoutIds = Object.keys(LAYOUTS);
export const slotsOf = (id) => LAYOUTS[id].cells.length;

/** Small SVG preview of a layout (used by the pickers). */
export function layoutIcon(id, size = 30) {
  const { cols, rows, cells } = LAYOUTS[id];
  const g = 1, w = (size - g * (cols - 1)) / cols, h = (size * 0.66 - g * (rows - 1)) / rows;
  const rects = cells.map(({ c, r, w: cw, h: ch }) =>
    `<rect x="${((c - 1) * (w + g)).toFixed(2)}" y="${((r - 1) * (h + g)).toFixed(2)}" width="${(cw * w + (cw - 1) * g).toFixed(2)}" height="${(ch * h + (ch - 1) * g).toFixed(2)}" rx="1"/>`).join('');
  return `<svg class="layout-icon" width="${size}" height="${(size * 0.66).toFixed(1)}" viewBox="0 0 ${size} ${(size * 0.66).toFixed(1)}" fill="currentColor" aria-hidden="true">${rects}</svg>`;
}
