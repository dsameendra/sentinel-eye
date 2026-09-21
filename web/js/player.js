// <cam-player>: go2rtc's VideoRTC without native controls (a click must never pause a live camera).
import { VideoRTC } from '../vendor/video-rtc.js';

class CamPlayer extends VideoRTC {
  constructor() {
    super();
    this.mode = 'webrtc,mse';
    this.RECONNECT_TIMEOUT = 3000;
    this.DISCONNECT_TIMEOUT = 1000;
    this.info = { mode: '', error: '' };
    this.onstatechange = () => {};
    // Tearing a player down empties its <video> src, which fires an 'error' event that the base class logs
    // and reacts to. Swallow it (capture phase, before the <video>'s own listener) once we are disposing.
    this.addEventListener('error', (e) => { if (this.disposed) e.stopImmediatePropagation(); }, true);
  }

  oninit() {
    super.oninit();
    const v = this.video;
    v.controls = false;
    v.muted = true;
    v.autoplay = true;
    v.disablePictureInPicture = true;
    v.setAttribute('disableremoteplayback', '');
    v.tabIndex = -1;
    v.addEventListener('contextmenu', (e) => e.preventDefault());
    // A live feed is never "paused" by the user: if the browser pauses it (autoplay policy, tab switch), resume.
    v.addEventListener('pause', () => { if (!this.disposed && !v.ended && v.isConnected) setTimeout(() => this.play(), 50); });
  }

  onopen() {
    // the socket can finish opening after the tile was disposed (page change, layout switch): ignore it
    if (this.disposed || !this.ws) return [];
    const modes = super.onopen();
    this.info.error = '';
    this.onmessage.app = (msg) => {
      if (msg.type === 'error') this.info.error = String(msg.value || 'stream error');
      else if (['mse', 'hls', 'mp4', 'mjpeg'].includes(msg.type)) this.info.mode = msg.type === 'mse' ? 'MSE' : msg.type.toUpperCase();
      this.onstatechange();
    };
    return modes;
  }

  onpcvideo(v) {
    super.onpcvideo(v);
    if (this.pcState !== WebSocket.CLOSED) { this.info.mode = 'WebRTC'; this.onstatechange(); }
  }

  onclose() {
    const r = super.onclose();
    this.onstatechange();
    return r;
  }

  /** Force a fresh connection (used by the stall watchdog). */
  reconnect() {
    if (this.disposed) return;
    this.info.error = '';
    if (this.reconnectTID) { clearTimeout(this.reconnectTID); this.reconnectTID = 0; }
    this.ondisconnect();
    this.onconnect();
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTID) { clearTimeout(this.reconnectTID); this.reconnectTID = 0; }
    if (this.disconnectTID) { clearTimeout(this.disconnectTID); this.disconnectTID = 0; }
    try { this.ondisconnect(); } catch { /* already closed */ }
    if (this.video) { this.video.removeAttribute('src'); this.video.srcObject = null; }
    this.remove();
  }
}
customElements.define('cam-player', CamPlayer);

export const wsUrl = (stream) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?src=${encodeURIComponent(stream)}`;

export function createPlayer(stream) {
  const p = document.createElement('cam-player');
  p.src = wsUrl(stream);   // src is a property, not an attribute
  return p;
}
