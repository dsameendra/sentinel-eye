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

## Steering a playback session (measured 2026-11-15, read-only, ch 1/2, footage ~15 min old)
- Speed change: `PLAY` with `Range: clock=<current>-` restarts at the keyframe before it (the picture jumped back
  7.9 s). `PLAY` with `Range: npt=now-` and the new `Scale:` carries on from the very next frame — no repeat, no gap,
  200 OK at every speed from 1/8x to 16x, picture held at most ~0.8 s; after four of them a `clock=` seek still lands
  and TEARDOWN is answered. `Scale:` alone and PAUSE then PLAY also carry on, but held 3.8 s and 2.3 s. The reply's
  `Range:` header after `npt=now-` is nonsense (19:50:34 for footage at 21:58): ignore it.
- The stream keeps flowing while a mid-session request is answered: up to 241 RTP packets arrived ahead of a PLAY
  reply. Dropping them (as the client used to, harmless before a seek) breaks every frame to the next keyframe after
  a speed change: hikrelay keeps them (`RtspClient.pending`) unless the request was a seek.
- Back-pressure: PAUSE, OPTIONS every 5-10 s, then `PLAY npt=now-` resumed exactly where it stopped after 30 s and
  90 s. Just not reading the socket: fine for 20 s, two frames lost after 60 s. A paused session accepts a `clock=`
  PLAY (a seek) and plays from there.
- Delivery is bursty and not always Scale x real time. The keyframe pre-roll comes at the playing speed (6.3 s of
  it took 6.0 s at 1x). Asked for 4/8/16x, ch 1 ran ~4.3x for 2 s, ~1x for a few seconds, then caught up — about
  3-3.5x on average — while ch 2 delivered 7-8x steadily at 8x. Rates swing 0.5-1.5x around 1x too. 16x was refused
  (453) with 17 live streams open from this Mac, and served with 9: the speed budget shares the recorder with live.
- Labels are good to about a second (single calibration readings scatter +/-0.5 s): a session asked for T sometimes
  starts at a keyframe labelled up to ~1.2 s after T. Every channel's calibrations agree (no channel more than 0.3 s
  off on average), so they are pooled per round (`playback_session.pooled_history`).

## Other
- ISAPI `GET /ISAPI/System/Video/inputs/channels` (HTTP digest) returns camera names.
- Repeated wrong logins lock the account: the tools stop at the first authentication failure.
