# Hikvision encrypted RTSP: findings (DS-7208HQHI-K1, firmware V4.25)

## Encryption (reverse-engineered; nothing public documents it)
- RTP payload is encrypted; RTP packets of encrypted NAL units carry a Hikvision header extension
  (profile 0x4000, 8 bytes `8006000111210201`). Packets without it are clear.
- AES-128-ECB, key = the "verification code" zero-padded to 16 bytes. Only the first 4096 bytes of each NAL.
- H.264: wrapper = [1-byte NAL header copy][AES(NAL from byte 0)][clear tail < 16 bytes]
- H.265: wrapper = [2-byte NAL header][AES(NAL body)][clear tail]
- Verified with known plaintext (H.264 sprop in the SDP; H.265 VPS/SPS structure), and by decoding.
- A 4096-byte cap was found by scanning the decrypt length until the first keyframe decoded cleanly.

## Timing (this bit us)
- SDP has no frame rate. RTP timestamps (90 kHz) are exact over seconds but jitter by tens of ms per
  frame, so: measure over ~3 s and snap to a standard rate (a 6% error drifts 3-4 s per minute).
  Real rates here: SD 12 fps, HD 15 fps.
- ffmpeg reading bare H.265 from a pipe ignores `-framerate` (stamps 30 fps) -> `setts` bsf (copy) or
  `setpts` + `-r` (transcode). H.264 honours `-framerate`.
- `-fflags nobuffer -flags low_delay` make the raw H.265 parser output nothing.
- A buffered Python pipe stalls ffmpeg on quiet channels: write unbuffered.
- VideoToolbox H.265 *decoding* errors on this DVR's stream (stalls until the next keyframe, ~5 s):
  decode in software, encode with h264_videotoolbox. Chrome's HEVC passthrough stutters for the same reason.
- HD keyframe interval was ~5 s when first measured, so a cold HD stream took ~3-4 s; the UI shows SD until HD
  is ready. Re-measured on recordings 2026-11-15: 14-20 s on ch 1/4 and 50 s on ch 2 (a camera/recorder setting,
  so it can change). Playback starts at the keyframe before the requested time, so up to that much early.
- Recordings keep their recording-time RTP timestamps, and the recorder resets its RTP base for every channel at
  once now and then: a clock calibration is only valid within its own regime (docs/SPEC.md 2.4).
- Asked to play a time it has no recording of, the recorder answers 200 OK and serves the next recording it has.
- go2rtc: `exec:` sources are only accepted from its config file (not its API); it drops RTSP pushes to
  undefined stream names; on-demand starters time out after ~5 s.

## Other
- ISAPI `GET /ISAPI/System/Video/inputs/channels` (HTTP digest) returns camera names.
- Repeated wrong logins lock the account: the tools stop at the first authentication failure.
