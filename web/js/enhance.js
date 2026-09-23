// L0 live enhancement (spec: "on-the-fly gamma/sharpen/contrast, haze/shadow clean-up", WebGL shader chain,
// tier L0 — real-time, client-side, never touches the original frame). Originally just brightness/contrast/
// gamma/shadow-lift/a crude 4-tap sharpen; extended with a wider, still-real-time set of techniques
// (edge-aware sharpen, a fast dehaze approximation, CLAHE-inspired local contrast, chromatic-aberration
// correction, Reinhard-style digital WDR tone-mapping, single-scale Retinex illumination correction, and
// temporal-median rain/snow-streak reduction), all independently strength-adjustable and stackable in one
// pass — see docs/playback-spec.md's L0 section for what each one really is and isn't.
//
// Renders a source <video> or <canvas> through a WebGL fragment shader chain into a target <canvas>, once
// per animation frame while active. Bypassed entirely (source painted through untouched) when off, so
// "off" has zero cost and never risks being mistaken for a decode/render path change.
//
// Deliberately NOT implemented: blind-deconvolution motion-deblur. A misestimated blur kernel produces
// confident-looking but fabricated structure — the exact failure mode CCSR's diffusion denoising was
// rejected for elsewhere in this app (docs/enhance-ai-spec.md 2a). A classical, non-blind technique here
// would carry the same risk without the AI-pipeline's explicit "reconstructed, not evidence" framing, so
// it's left out rather than shipped half-trustworthy.

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Separable Gaussian blur, one direction per draw call (horizontal then vertical) — the shared "wide,
// low-frequency" reference several effects below need (local contrast, Retinex) but a plain 4-tap cross
// average is too tight a radius for. Run at half resolution (see _ensureSized) since none of its consumers
// need pixel-accurate detail from it, only a smooth illumination/base estimate — halves the cost per axis.
const BLUR_FRAG_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 sum = texture2D(uTex, vUv).rgb * 0.227027;
  sum += texture2D(uTex, vUv + uDir * 1.0).rgb * 0.1945946;
  sum += texture2D(uTex, vUv - uDir * 1.0).rgb * 0.1945946;
  sum += texture2D(uTex, vUv + uDir * 2.0).rgb * 0.1216216;
  sum += texture2D(uTex, vUv - uDir * 2.0).rgb * 0.1216216;
  sum += texture2D(uTex, vUv + uDir * 3.0).rgb * 0.0540541;
  sum += texture2D(uTex, vUv - uDir * 3.0).rgb * 0.0540541;
  gl_FragColor = vec4(sum, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;    // current frame, full detail
uniform sampler2D uBlur;   // wide low-frequency reference (see BLUR_FRAG_SRC above) — uTex again when unused
uniform sampler2D uPrev1;  // previous frame (rain/snow) — uTex again when unused
uniform sampler2D uPrev2;  // frame before that (rain/snow) — uTex again when unused
uniform vec2 uTexel;
uniform float uBrightness; // -1..1, additive
uniform float uContrast;   // 0..2, 1 = neutral
uniform float uGamma;      // 0.3..3, 1 = neutral
uniform float uShadowLift; // 0..1, 0 = neutral
uniform float uSharpen;    // 0..2, 0 = neutral
uniform float uDehaze;         // 0..1
uniform float uLocalContrast;  // 0..1.5
uniform float uCaFix;          // 0..1
uniform float uWdr;            // 0..1
uniform float uRetinex;        // 0..1
uniform float uRainSnow;       // 0..1
uniform vec2 uFlashPos;        // UV, top-left origin to match vUv
uniform float uFlashRadius;
uniform float uFlashStrength;  // 0 = off

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 uv = vUv;

  // Chromatic aberration correction: sample R and B slightly offset radially from center, undoing the
  // outward colour-fringe cheap CCTV lenses add at high-contrast edges — a real, standard technique, cheap
  // as a single extra pair of texture fetches.
  vec3 c;
  if (uCaFix > 0.0) {
    vec2 d = uv - 0.5;
    float amt = uCaFix * 0.004;
    c = vec3(texture2D(uTex, uv - d * amt).r, texture2D(uTex, uv).g, texture2D(uTex, uv + d * amt).b);
  } else {
    c = texture2D(uTex, uv).rgb;
  }

  // Fast single-pass dehaze: approximates the "dark channel" locally as the minimum over an 8-sample ring
  // around this pixel, treats that as an estimate of the haze veil, and removes it. Real Dark Channel Prior
  // dehazing does a per-patch min over the whole image plus a separate atmospheric-light estimate and a
  // guided-filter refinement pass — this is the same core idea (haze lifts the black point uniformly; find
  // the local black point, subtract it) at real-time, single-pass cost, not the full algorithm.
  if (uDehaze > 0.0) {
    vec3 mn = c;
    for (int i = 0; i < 8; i++) {
      float a = 6.283185 * float(i) / 8.0;
      mn = min(mn, texture2D(uTex, uv + vec2(cos(a), sin(a)) * uTexel * 3.0).rgb);
    }
    float veil = min(min(mn.r, mn.g), mn.b);
    vec3 dehazed = (c - veil) / max(1.0 - veil * 0.9, 0.15);
    c = mix(c, clamp(dehazed, 0.0, 1.0), uDehaze);
  }

  // Rain/snow streak reduction: a pixel that's much brighter than both its temporal neighbours (last
  // frame, frame before that) is very likely a falling raindrop/snowflake catching IR light mid-frame, not
  // real scene content — replace it with the temporal median of the three, which is always a real pixel
  // value from an actual frame, never an invented one (same "pick a real value, don't synthesize" principle
  // as the AI frame-enhancer's median-stacking — docs/enhance-ai-spec.md 2d). Static/slow content, present
  // in all three frames, is left untouched.
  if (uRainSnow > 0.0) {
    vec3 p1 = texture2D(uPrev1, uv).rgb, p2 = texture2D(uPrev2, uv).rgb;
    float lc = luma(c), l1 = luma(p1), l2 = luma(p2);
    float lo = min(lc, min(l1, l2)), hi = max(lc, max(l1, l2));
    float med = lc + l1 + l2 - lo - hi;
    if (lc > med + 0.12 && lc > l1 + 0.08 && lc > l2 + 0.08) {
      vec3 tmed = (l1 > l2) ? p1 : p2; // whichever neighbour isn't the streak's own extreme
      c = mix(c, tmed, uRainSnow);
    }
  }

  vec3 blurred = texture2D(uBlur, uv).rgb;

  // Local contrast (CLAHE-inspired adaptive contrast — not literal per-tile histogram equalization, which
  // needs a histogram pass this single-shader-stage pipeline doesn't build): boosts the difference between
  // each pixel and its own wide blurred reference, with the boost itself reduced near black/white the way
  // CLAHE's clip limit exists to hold back exactly there, so this lifts mid-tone structure without the
  // shadow/highlight noise explosion a flat contrast boost would cause.
  if (uLocalContrast > 0.0) {
    float gain = clamp(1.0 - abs(luma(blurred) - 0.5) * 1.4, 0.0, 1.0);
    c += (c - blurred) * uLocalContrast * gain;
  }

  // Single-scale Retinex illumination correction (Retinex-inspired — real Multi-Scale Retinex with Colour
  // Restoration averages several blur radii; this uses the one wide blur pass already computed above, a
  // deliberate real-time trade-off, not a claim of full MSRCR). In the log domain, reflectance ≈
  // log(image) - log(illumination estimate); the blur stands in for the illumination estimate, so this
  // strips out a smooth uneven-lighting field (a single bright lamp against a dark scene) while keeping
  // local detail, which a flat brightness/contrast adjustment structurally cannot do.
  if (uRetinex > 0.0) {
    vec3 refl = log(c + 0.01) - log(blurred + 0.01);
    vec3 normed = clamp(refl * 0.25 + 0.5, 0.0, 1.0);
    vec3 restored = c * (luma(normed) / max(luma(c), 0.001)); // keep real hue ratios, replace overall luminance
    c = mix(c, clamp(restored, 0.0, 1.0), uRetinex);
  }

  // Edge-aware unsharp mask: gated by local contrast (against the same wide blur), so flat/noisy regions
  // (sky, walls, sensor grain, compression blocks) are left alone and only pixels near a real edge get
  // sharpened — avoids the halo/noise-amplification a plain unsharp mask produces on compressed CCTV
  // footage, which is what a naive sharpen slider does.
  if (uSharpen > 0.0) {
    vec3 detail = c - blurred;
    float edge = smoothstep(0.04, 0.12, length(detail));
    c += detail * uSharpen * edge;
  }

  // Digital WDR / tone mapping: a Reinhard-style highlight rolloff (keeps a bright streetlight or daytime
  // sky from clipping to flat white) combined with the shadow lift below (keeps a dark doorway's detail
  // visible) — software tone-remapping of an already-encoded single frame, the "digital" reading of WDR,
  // not true multi-exposure sensor WDR (which needs multiple exposures at capture time, not available
  // after the fact). Still the same practical goal: both ends of a high-contrast scene visible at once.
  c = c + uShadowLift * (1.0 - c) * (1.0 - c);
  if (uWdr > 0.0) {
    c = mix(c, (c / (c + vec3(0.6))) * 1.6, uWdr);
  }

  // Digital flashlight: a localized shadow-lift + gamma boost in a soft radius around the operator's
  // cursor (Playback only — see playback.js) — like shining a light into one dark corner of a paused frame
  // without brightening the whole image and losing everything else's exposure.
  if (uFlashStrength > 0.0) {
    float f = (1.0 - smoothstep(0.0, 1.0, distance(uv, uFlashPos) / max(uFlashRadius, 0.001))) * uFlashStrength;
    c = c + f * (1.0 - c) * 0.6;
    c = pow(clamp(c, 0.001, 1.0), vec3(1.0 - f * 0.4));
  }

  c = (c - 0.5) * uContrast + 0.5;
  c = c + uBrightness;
  c = pow(clamp(c, 0.0, 1.0), vec3(1.0 / uGamma));

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const NEUTRAL = {
  brightness: 0, contrast: 1, gamma: 1, shadowLift: 0, sharpen: 0,
  dehaze: 0, localContrast: 0, caFix: 0, wdr: 0, retinex: 0, rainSnow: 0,
};

export const PRESETS = {
  off: { label: 'Off', ...NEUTRAL },
  night: { label: 'Night lift', ...NEUTRAL, brightness: 0.12, contrast: 1.05, gamma: 1.35, shadowLift: 0.35, sharpen: 0.15 },
  haze: { label: 'Shadow & haze lift', ...NEUTRAL, brightness: 0.02, contrast: 1.3, gamma: 1.1, shadowLift: 0.25, sharpen: 0.1, dehaze: 0.4 },
  sharpen: { label: 'Sharpen', ...NEUTRAL, contrast: 1.08, sharpen: 0.6, localContrast: 0.3 },
  wdr: { label: 'Backlight / WDR', ...NEUTRAL, shadowLift: 0.3, wdr: 0.6, contrast: 1.05 },
  retinex: { label: 'Extreme lighting (Retinex)', ...NEUTRAL, retinex: 0.55, shadowLift: 0.15 },
  rainsnow: { label: 'Rain / snow reduction', ...NEUTRAL, rainSnow: 0.7, sharpen: 0.2 },
  custom: { label: 'Custom', ...NEUTRAL },
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
    this._roi = null;       // {x,y,w,h} fractions (top-left origin), Playback only — null = whole frame
    this._flash = { x: -1, y: -1, radius: 0.18, strength: 0 };
    this._szW = 0; this._szH = 0;
    this._initGL();
  }

  get supported() { return !!this.gl; }

  _initGL() {
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true })
      || this.canvas.getContext('experimental-webgl');
    if (!gl) return; // caller falls back to leaving the plain source visible — never a hard failure
    this.gl = gl;
    this.prog = this._link(VERT_SRC, FRAG_SRC);
    this.blurProg = this._link(VERT_SRC, BLUR_FRAG_SRC);
    // A shader that fails to compile/link still lets createProgram/linkProgram run without throwing, and a
    // program with LINK_STATUS false renders nothing — checked directly (not assumed) after finding
    // readPixels come back zero during earlier verification. Without this check, that failure mode is a
    // canvas that silently covers the live picture with nothing, not a caught error.
    if (!this.prog || !this.blurProg) { this.gl = null; return; }
    gl.useProgram(this.prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this._vbuf = buf;
    // WebGL's texture-coordinate origin is bottom-left; uploading a <video>/<canvas> (row 0 = top, DOM
    // convention) without this flips the picture vertically once sampled — the reported "upside down"
    // bug, reproduced and fixed here rather than papered over by flipping the vertex UVs (this is the
    // standard, correct fix and keeps the shader itself working in normal texture-space).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.tex = this._plainTexture();
    this.uniforms = {};
    for (const name of ['uTex', 'uBlur', 'uPrev1', 'uPrev2', 'uTexel', 'uBrightness', 'uContrast', 'uGamma',
      'uShadowLift', 'uSharpen', 'uDehaze', 'uLocalContrast', 'uCaFix', 'uWdr', 'uRetinex', 'uRainSnow',
      'uFlashPos', 'uFlashRadius', 'uFlashStrength']) {
      this.uniforms[name] = gl.getUniformLocation(this.prog, name);
    }
    this.blurUniforms = { uTex: gl.getUniformLocation(this.blurProg, 'uTex'), uDir: gl.getUniformLocation(this.blurProg, 'uDir') };
  }

  _link(vertSrc, fragSrc) {
    const gl = this.gl;
    const vs = this._shader(gl.VERTEX_SHADER, vertSrc);
    const fs = this._shader(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs || !gl.getShaderParameter(vs, gl.COMPILE_STATUS) || !gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
  }

  _shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  _plainTexture(w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  _fbo(w, h) {
    const gl = this.gl;
    const tex = this._plainTexture(w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb };
  }

  // (Re)allocates the wide-blur FBO pair (half resolution — see BLUR_FRAG_SRC) and the two rain/snow
  // history textures (full resolution) whenever the source's actual pixel size changes (first frame, an
  // SD/HD stream swap, a window resize). Cheap to skip when unchanged, which is every other frame.
  _ensureSized(w, h) {
    if (this._szW === w && this._szH === h) return;
    this._szW = w; this._szH = h;
    const gl = this.gl;
    const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    this._blurW = bw; this._blurH = bh;
    if (this.blurA) { gl.deleteTexture(this.blurA.tex); gl.deleteFramebuffer(this.blurA.fb); }
    if (this.blurB) { gl.deleteTexture(this.blurB.tex); gl.deleteFramebuffer(this.blurB.fb); }
    this.blurA = this._fbo(bw, bh);
    this.blurB = this._fbo(bw, bh);
    this.prevTexA = this._plainTexture(w, h);
    this.prevTexB = this._plainTexture(w, h);
  }

  _bindQuad(prog) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbuf);
    const loc = gl.getAttribLocation(prog, 'aPos'); // not guaranteed the same index across separately-linked programs
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  _runBlurPass(w, h) {
    const gl = this.gl;
    this._bindQuad(this.blurProg);
    gl.viewport(0, 0, this._blurW, this._blurH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurA.fb);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.blurUniforms.uTex, 0);
    gl.uniform2f(this.blurUniforms.uDir, 1 / this._blurW, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurB.fb);
    gl.bindTexture(gl.TEXTURE_2D, this.blurA.tex);
    gl.uniform2f(this.blurUniforms.uDir, 0, 1 / this._blurH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
  }

  setPreset(name) { this.setParams(PRESETS[name] || PRESETS.off); }
  setParams(p) { this.params = { ...this.params, ...p }; }

  /** rect: {x,y,w,h} fractions (0-1, top-left origin) or null for whole-frame. Playback only. */
  setRoi(rect) { this._roi = rect; }

  /** x,y: fractions (0-1, top-left origin — normal DOM/CSS convention) of the pane, or null to turn the
   * flashlight off. Playback only. Y is flipped before storing: vUv (what the shader compares uFlashPos
   * against) is bottom-left origin — aPos*0.5+0.5 puts vUv=(0,0) at NDC's bottom-left, and window/NDC space
   * has y=-1 at the bottom, not the top. Passing a top-based y straight through put the flashlight exactly
   * mirrored vertically from the real cursor position — confirmed directly, not a hypothetical: with the
   * cursor at the top of a pane the glow rendered at the bottom, and vice versa. */
  setFlashlight(x, y, strength = 0.8, radius = 0.18) {
    this._flash = x == null ? { x: -1, y: -1, radius, strength: 0 } : { x, y: 1 - y, radius, strength };
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
    // videoWidth/Height: <video>. naturalWidth/Height: <img> (its .width/.height reflect CSS/attribute
    // sizing, not the real pixel size, which is what the shader actually needs). .width/.height: <canvas>.
    const w = src.videoWidth || src.naturalWidth || src.width || 0, h = src.videoHeight || src.naturalHeight || src.height || 0;
    if (!w || !h) return;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this._ensureSized(w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch { return; } // a mid-teardown frame (0x0 video, detached canvas) — skip, try again next frame

    const p = this.params;
    const needBlur = p.localContrast > 0 || p.retinex > 0 || p.sharpen > 0;
    if (needBlur) this._runBlurPass(w, h);

    this._bindQuad(this.prog);
    gl.viewport(0, 0, w, h);
    const u = this.uniforms;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(u.uTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, needBlur ? this.blurB.tex : this.tex); gl.uniform1i(u.uBlur, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, p.rainSnow > 0 ? this.prevTexA : this.tex); gl.uniform1i(u.uPrev1, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, p.rainSnow > 0 ? this.prevTexB : this.tex); gl.uniform1i(u.uPrev2, 3);
    gl.uniform2f(u.uTexel, 1 / w, 1 / h);
    gl.uniform1f(u.uBrightness, p.brightness);
    gl.uniform1f(u.uContrast, p.contrast);
    gl.uniform1f(u.uGamma, p.gamma);
    gl.uniform1f(u.uShadowLift, p.shadowLift);
    gl.uniform1f(u.uSharpen, p.sharpen);
    gl.uniform1f(u.uDehaze, p.dehaze);
    gl.uniform1f(u.uLocalContrast, p.localContrast);
    gl.uniform1f(u.uCaFix, p.caFix);
    gl.uniform1f(u.uWdr, p.wdr);
    gl.uniform1f(u.uRetinex, p.retinex);
    gl.uniform1f(u.uRainSnow, p.rainSnow);
    gl.uniform2f(u.uFlashPos, this._flash.x, this._flash.y);
    gl.uniform1f(u.uFlashRadius, this._flash.radius);
    gl.uniform1f(u.uFlashStrength, this._flash.strength);

    // ROI: everything above still ran full-frame (the shader itself has no notion of a crop — simpler and
    // correct, since several passes above sample neighbouring pixels) but the scissor test below means only
    // fragments *inside* the box are actually rasterized/written; the canvas is cleared to transparent
    // first so everywhere else shows the raw pane underneath, completely untouched, through the gap. This
    // is a real GPU cost reduction, not just a visual crop — the rasterizer skips work outside the
    // scissor rect at the hardware level (spec 2c's ROI note in playback-spec.md).
    if (this._roi) {
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const sx = Math.round(this._roi.x * w), sw = Math.max(1, Math.round(this._roi.w * w));
      const shPx = Math.max(1, Math.round(this._roi.h * h));
      const sy = h - Math.round(this._roi.y * h) - shPx; // gl.scissor's origin is bottom-left; ours is top-left
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(sx, sy, sw, shPx);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (this._roi) gl.disable(gl.SCISSOR_TEST);

    // Roll the rain/snow history: rotate the two texture handles, then capture what's now on screen as the
    // new "1 frame ago" for next tick (so next tick's "2 frames ago" becomes what's currently "1 frame
    // ago" here) — always maintained, not just while rainSnow > 0, so there's no stale/undefined texture
    // moment right after the feature is turned on.
    const t = this.prevTexA; this.prevTexA = this.prevTexB; this.prevTexB = t;
    gl.bindTexture(gl.TEXTURE_2D, this.prevTexA);
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, w, h, 0);
  }

  destroy() {
    this.stop();
    this.gl = null;
  }
}
