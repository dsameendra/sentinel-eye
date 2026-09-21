# Hikvision encrypted RTSP — findings (DS-7208HQHI-K1)
- Encryption is on the RTP payload; packets with RTP extension (profile 0x4000, 8 bytes: 8006000111210201) are encrypted.
- Cipher: AES-128-ECB, key = verification code (DVR_KEY in .env) zero-padded to 16 bytes. Verified on SPS against SDP sprop.
- SPS/PPS/slice NAL in-band = [copy of NAL header byte][AES blocks of real NAL from byte 0][clear tail < 16 bytes].
- Whole-NAL contiguous decrypt works for the first ~4.3KB of a large IDR (rows 0-16 of 30), then breaks. UNSOLVED.
- rtsp_capture.py writes rtp_<ch>.bin (length-prefixed RTP) to cwd; scratch scripts reference an absolute scratch path.
