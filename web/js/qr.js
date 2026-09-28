// QR codes as inline SVG (TV pairing, 2FA setup). Always dark-on-white with a quiet zone, whatever the
// theme: phone cameras read a light-on-dark QR poorly.
import qrcode from '../vendor/qrcode.js';

export function qrSvg(text, label = 'QR code') {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return `<div class="qr" role="img" aria-label="${label.replace(/"/g, '&quot;')}">${qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })}</div>`;
}
