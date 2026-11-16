// web/js/codecs.js: the WebCodecs decoder config for the recorder's H.265 and H.264 streams, without a browser.
//    node tools/test_codecs.mjs
import { HEVC_CODEC, annexBNals, avcCodecFromAnnexB, decoderConfig } from '../web/js/codecs.js';

let passed = 0, failed = 0;
const check = (name, ok, extra = '') => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `  [${extra}]` : ''}`);
};
const u8 = (...a) => new Uint8Array(a.flat());
const SC4 = [0, 0, 0, 1], SC3 = [0, 0, 1];

// An access unit as the server sends it: AUD, SPS (High 4.0: 64 00 28), PPS, IDR slice — mixed start codes.
const sps = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78];
const au = u8(SC4, [0x09, 0xf0], SC4, sps, SC3, [0x68, 0xeb, 0xe3, 0xcb], SC3, [0x65, 0x88, 0x84, 0x00, 0x33]);
const nals = annexBNals(au);
check('annexBNals splits 3- and 4-byte start codes', nals.length === 4 && nals[1][0] === 0x67 && nals[3][0] === 0x65, nals.map((n) => n[0].toString(16)).join(','));
check('High@4.0 SPS -> avc1.640028', avcCodecFromAnnexB(au) === 'avc1.640028', avcCodecFromAnnexB(au));

const base = u8(SC4, [0x67, 0x42, 0xe0, 0x1e, 0x8d, 0x68], SC4, [0x68, 0xce, 0x3c, 0x80], SC4, [0x65, 0xb8]);
check('Constrained Baseline@3.0 -> avc1.42E01E (upper-case hex)', avcCodecFromAnnexB(base) === 'avc1.42E01E', avcCodecFromAnnexB(base));

// Emulation prevention: 00 00 03 xx in the NAL is 00 00 xx in the RBSP the profile/level bytes come from.
const epb = u8(SC4, [0x67, 0x00, 0x00, 0x03, 0x01, 0x1f, 0x22]);
check('emulation-prevention byte removed', avcCodecFromAnnexB(epb) === 'avc1.000001', avcCodecFromAnnexB(epb));

check('no SPS -> null', avcCodecFromAnnexB(u8(SC4, [0x41, 0x9a, 0x02])) === null);
check('truncated SPS -> null', avcCodecFromAnnexB(u8(SC4, [0x67, 0x64])) === null);
check('empty input -> null', avcCodecFromAnnexB(new Uint8Array(0)) === null);

const hevcCfg = decoderConfig('hevc', u8(SC4, [0x40, 0x01, 0x0c]));
check('hevc config is the verified hvc1 string', hevcCfg.codec === HEVC_CODEC && HEVC_CODEC === 'hvc1.1.6.L153.B0');
check('no description (Annex-B input)', !('description' in hevcCfg));
check('unknown/missing codec defaults to hevc (older server)', decoderConfig(undefined, au).codec === HEVC_CODEC);
const avcCfg = decoderConfig('h264', au);
check('h264 config from the keyframe SPS', avcCfg && avcCfg.codec === 'avc1.640028' && !('description' in avcCfg));
check('h264 without an SPS -> null (the player reports it)', decoderConfig('h264', u8(SC4, [0x65, 0x88])) === null);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
