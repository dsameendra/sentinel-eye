// WebCodecs decoder configuration for the recorder's two codecs. DOM-free, so it's unit-tested in Node
// (tools/test_codecs.mjs). Playback sends Annex-B access units (start codes, parameter sets in-band), so the
// config carries no `description` — that is what makes VideoDecoder expect Annex-B rather than avcC/hvcC.

// H.265: the string this recorder's footage was verified with (docs/SPEC.md section 2.6 / 7.2).
export const HEVC_CODEC = 'hvc1.1.6.L153.B0';

/** The NAL units of an Annex-B byte stream (without start codes). */
export function annexBNals(bytes) {
  const out = [];
  let i = 0, start = -1;
  while (i + 2 < bytes.length) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1))) {
      const sc = bytes[i + 2] === 1 ? 3 : 4;
      if (start >= 0) out.push(bytes.subarray(start, i));
      i += sc;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < bytes.length) out.push(bytes.subarray(start));
  return out;
}

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/** 'avc1.PPCCLL' from the first H.264 SPS in an Annex-B access unit (profile_idc, constraint flags, level_idc —
 * the three bytes after the NAL header, with emulation-prevention bytes removed), or null when there is none. */
export function avcCodecFromAnnexB(bytes) {
  for (const nal of annexBNals(bytes)) {
    if (nal.length < 4 || (nal[0] & 0x1f) !== 7) continue;
    const rbsp = [];
    for (let i = 1, zeros = 0; i < nal.length && rbsp.length < 3; i++) {
      if (zeros >= 2 && nal[i] === 3) { zeros = 0; continue; }
      zeros = nal[i] === 0 ? zeros + 1 : 0;
      rbsp.push(nal[i]);
    }
    if (rbsp.length < 3) return null;
    return `avc1.${hex2(rbsp[0])}${hex2(rbsp[1])}${hex2(rbsp[2])}`;
  }
  return null;
}

/** A VideoDecoder config for `codec` ("hevc" | "h264", as the server's "playing" message names it), using the
 * first keyframe's access unit where the codec string depends on it; null when it can't be derived. */
export function decoderConfig(codec, keyAccessUnit) {
  if (codec === 'h264') {
    const s = avcCodecFromAnnexB(keyAccessUnit);
    return s ? { codec: s, hardwareAcceleration: 'no-preference' } : null;
  }
  return { codec: HEVC_CODEC, hardwareAcceleration: 'no-preference' };
}
