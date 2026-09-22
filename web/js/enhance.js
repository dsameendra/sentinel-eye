// L0 live enhancement (spec: "on-the-fly gamma/sharpen/contrast, haze/shadow clean-up", WebGL shader chain,
// tier L0 — real-time, client-side, never touches the original frame). The spec references a dedicated
// "section 7" for the L0/L1 tiers that the document itself never actually wrote (checked directly, not
// assumed) — built here from the fragments that do exist: the feature table (row 13), section 9.5/11.5
// ("presets on any tile; snapshot saves the enhanced or the original frame, your choice"), and the M5
// milestone row. "Haze/shadow clean-up" is implemented as a levels-style shadow lift + contrast stretch —
// a real, well-understood technique — not a dark-channel-prior dehaze, which would need multi-pixel
// neighborhood sampling; the UI names it accordingly rather than overclaiming.
//
// Renders a source <video> or <canvas> through a WebGL fragment shader chain into a target <canvas>, once
// per animation frame while active. Bypassed entirely (source painted through untouched) when off, so
// "off" has zero cost and never risks being mistaken for a decode/render path change.

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;       // 1/width, 1/height, for the sharpen kernel
uniform float uBrightness; // -1..1, additive
uniform float uContrast;   // 0..2, 1 = neutral
uniform float uGamma;      // 0.3..3, 1 = neutral
uniform float uShadowLift; // 0..1, 0 = neutral
uniform float uSharpen;    // 0..2, 0 = neutral

void main() {
  vec3 c = texture2D(uTex, vUv).rgb;

  // unsharp mask: blend in (center - blurred-neighborhood)
  if (uSharpen > 0.0) {
    vec3 n = texture2D(uTex, vUv + vec2(-uTexel.x, 0.0)).rgb + texture2D(uTex, vUv + vec2(uTexel.x, 0.0)).rgb +
             texture2D(uTex, vUv + vec2(0.0, -uTexel.y)).rgb + texture2D(uTex, vUv + vec2(0.0, uTexel.y)).rgb;
    vec3 blur = n * 0.25;
    c += (c - blur) * uSharpen;
  }

  // shadow lift + contrast stretch (the "haze/shadow clean-up" preset): raises black point, then
  // re-applies contrast around midpoint so the lift doesn't just wash the image out
  c = c + uShadowLift * (1.0 - c) * (1.0 - c);
  c = (c - 0.5) * uContrast + 0.5;
  c = c + uBrightness;
  c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / uGamma));

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export const PRESETS = {
  off: { label: 'Off', brightness: 0, contrast: 1, gamma: 1, shadowLift: 0, sharpen: 0 },
  night: { label: 'Night lift', brightness: 0.12, contrast: 1.05, gamma: 1.35, shadowLift: 0.35, sharpen: 0.15 },
  haze: { label: 'Shadow & haze lift', brightness: 0.02, contrast: 1.3, gamma: 1.1, shadowLift: 0.25, sharpen: 0.1 },
  sharpen: { label: 'Sharpen', brightness: 0, contrast: 1.08, gamma: 1, shadowLift: 0, sharpen: 0.6 },
  custom: { label: 'Custom', brightness: 0, contrast: 1, gamma: 1, shadowLift: 0, sharpen: 0 },
};

export class Enhancer {
  /** @param source a <video> or <canvas> element to read frames from
   *  @param target a <canvas> to render the processed result into (its size is kept in sync with source) */
  constructor(source, target) {
    this.source = source;
    this.canvas = target;
    this.params = { ...PRESETS.off };
    this.active = false;
    this._raf = null;
    this.gl = null;
    this._initGL();
  }

  get supported() { return !!this.gl; }

  _initGL() {
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true })
      || this.canvas.getContext('experimental-webgl');
    if (!gl) return; // caller falls back to leaving the plain source visible — never a hard failure
    this.gl = gl;
    const vs = this._shader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = this._shader(gl.FRAGMENT_SHADER, FRAG_SRC);
    // A shader that fails to compile still lets createProgram/linkProgram run, and LINK_STATUS can pass
    // with a program that renders nothing — checked directly (not assumed) after finding readPixels come
    // back zero during verification. Without this check, that failure mode is a canvas that silently
    // covers the live picture with nothing, not a caught error.
    if (!vs || !fs || !gl.getShaderParameter(vs, gl.COMPILE_STATUS) || !gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      this.gl = null;
      return;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.gl = null; return; }
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    // WebGL's texture-coordinate origin is bottom-left; uploading a <video>/<canvas> (row 0 = top, DOM
    // convention) without this flips the picture vertically once sampled — the reported "upside down"
    // bug, reproduced and fixed here rather than papered over by flipping the vertex UVs (this is the
    // standard, correct fix and keeps the shader itself working in normal texture-space).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.uniforms = {};
    for (const name of ['uTex', 'uTexel', 'uBrightness', 'uContrast', 'uGamma', 'uShadowLift', 'uSharpen']) {
      this.uniforms[name] = gl.getUniformLocation(prog, name);
    }
  }

  _shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  setPreset(name) { this.setParams(PRESETS[name] || PRESETS.off); }

  setParams(p) {
    this.params = { ...this.params, ...p };
  }

  start() {
    if (this.active || !this.gl) return;
    this.active = true;
    const tick = () => {
      if (!this.active) return;
      this._draw();
      this._raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    this.active = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _draw() {
    const gl = this.gl, src = this.source;
    const w = src.videoWidth || src.width || 0, h = src.videoHeight || src.height || 0;
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; gl.viewport(0, 0, w, h); }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch { return; } // a mid-teardown frame (0x0 video, detached canvas) — skip, try again next frame
    const p = this.params;
    gl.uniform1i(this.uniforms.uTex, 0);
    gl.uniform2f(this.uniforms.uTexel, 1 / w, 1 / h);
    gl.uniform1f(this.uniforms.uBrightness, p.brightness);
    gl.uniform1f(this.uniforms.uContrast, p.contrast);
    gl.uniform1f(this.uniforms.uGamma, p.gamma);
    gl.uniform1f(this.uniforms.uShadowLift, p.shadowLift);
    gl.uniform1f(this.uniforms.uSharpen, p.sharpen);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  destroy() {
    this.stop();
    this.gl = null;
  }
}
