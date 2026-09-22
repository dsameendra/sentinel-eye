"""Hikvision RTSP relay: decrypts encrypted streams, measures fps, feeds go2rtc.

Hikvision "stream encryption" scrambles the RTP payload with AES-128-ECB. The key is
the verification code zero-padded to 16 bytes. Only NAL units carried in packets that
have the Hikvision RTP header extension are encrypted, and only their first 4096 bytes:

  H.264: wrapper = [1-byte header copy][AES(NAL from byte 0)][clear tail]
  H.265: wrapper = [2-byte NAL header][AES(NAL body)][clear tail]

CLI (all take --settings path/to/settings.json):
  stream   --channel-id ID --kind main|sub --out RTSP_URL   pull, decrypt, push (go2rtc exec source)
  probe    --channel-id ID --kind main|sub                  print a JSON report
"""
import argparse, base64, hashlib, json, os, re, signal, socket, statistics, struct, subprocess, sys, tempfile, threading, time
import urllib.request
import xml.etree.ElementTree as ET
from Crypto.Cipher import AES

MAX_ENC = 4096
START = b"\x00\x00\x00\x01"


class RelayError(Exception):
    """An error with a message that is safe to show to the user."""


def make_aes(key):
    return AES.new((key.encode() + b"\0" * 16)[:16], AES.MODE_ECB) if key else None


def stream_path(channel, kind, override=""):
    return override or f"/Streaming/Channels/{channel}{'01' if kind == 'main' else '02'}"


def load_settings(path):
    with open(path) as f:
        return json.load(f)


# --------------------------------------------------------------------------- RTSP

class RtspClient:
    """Minimal RTSP/TCP client (digest auth, interleaved RTP) for one video track."""

    def __init__(self, host, port, user, pw, path, timeout=10):
        self.host, self.port, self.user, self.pw, self.path = host, int(port), user, pw, path
        self.url = f"rtsp://{host}:{self.port}{path}"
        self.timeout = timeout
        self.buf = b""
        self.cseq = 0
        self.session = None
        self.auth = None
        self.codec = None
        self.sdp = ""

    @staticmethod
    def _md5(s):
        return hashlib.md5(s.encode()).hexdigest()

    def _send(self, method, url, extra=""):
        self.cseq += 1
        a = ""
        if self.auth:
            realm, nonce = self.auth
            resp = self._md5(f"{self._md5(f'{self.user}:{realm}:{self.pw}')}:{nonce}:{self._md5(f'{method}:{url}')}")
            a = (f'Authorization: Digest username="{self.user}", realm="{realm}", nonce="{nonce}", '
                 f'uri="{url}", response="{resp}"\r\n')
        sid = f"Session: {self.session}\r\n" if self.session else ""
        self.sock.sendall(f"{method} {url} RTSP/1.0\r\nCSeq: {self.cseq}\r\n{sid}{a}{extra}\r\n".encode())

    def _recv(self):
        d = self.sock.recv(65536)
        if not d:
            raise ConnectionError("connection closed by the recorder")
        self.buf += d

    def _resp(self):
        while b"\r\n\r\n" not in self.buf:
            self._recv()
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        head = head.decode(errors="replace")
        m = re.search(r"Content-Length:\s*(\d+)", head, re.I)
        body = b""
        if m:
            n = int(m.group(1))
            while len(self.buf) < n:
                self._recv()
            body, self.buf = self.buf[:n], self.buf[n:]
        return head, body.decode(errors="replace")

    def _describe(self):
        self._send("DESCRIBE", self.url, "Accept: application/sdp\r\n")
        return self._resp()

    def open(self, play_range="npt=0.000-", scale=None, idle_timeout=8):
        """Connect, DESCRIBE, SETUP and PLAY. `play_range` is `npt=0.000-` for live, or
        `clock=<start>-[<end>]` (Hikvision playback, UTC compact form `YYYYMMDDTHHMMSSZ`) for a recording.
        `scale` sends an RTSP `Scale:` header (DVR playback speed; ignored/irrelevant for live)."""
        try:
            self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as e:
            raise RelayError(f"Cannot reach {self.host}:{self.port} ({e.strerror or e})")
        try:
            head, body = self._describe()
            if head.startswith("RTSP/1.0 401"):
                m = re.search(r'realm="([^"]+)".*?nonce="([^"]+)"', head, re.S)
                if not m:
                    raise RelayError("Recorder requires an unsupported authentication method")
                self.auth = (m.group(1), m.group(2))
                head, body = self._describe()
            status = head.split("\r\n")[0]
            if status.startswith("RTSP/1.0 401"):
                raise RelayError("Authentication failed: check the username and password")
            if status.startswith("RTSP/1.0 404"):
                raise RelayError(f"Stream not found ({self.path})")
            if not status.startswith("RTSP/1.0 200"):
                raise RelayError(f"Unexpected response: {status}")
            self.sdp = body
            video = next((s for s in re.split(r"\r?\n(?=m=)", body) if s.startswith("m=video")), None)
            if video is None:
                raise RelayError("The stream has no video track")
            if re.search(r"rtpmap:\d+ H265", video, re.I):
                self.codec = "hevc"
            elif re.search(r"rtpmap:\d+ H264", video, re.I):
                self.codec = "h264"
            else:
                raise RelayError("Unsupported video codec (only H.264 and H.265 are supported)")
            ctl = re.search(r"a=control:(\S+)", video)
            ctl = ctl.group(1) if ctl else "trackID=video"
            turl = ctl if ctl.startswith("rtsp") else self.url.rstrip("/") + "/" + ctl
            self._send("SETUP", turl, "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n")
            head, _ = self._resp()
            if not head.startswith("RTSP/1.0 200"):
                raise RelayError("SETUP failed: " + head.split("\r\n")[0])
            self.session = re.search(r"Session:\s*([^;\r\n]+)", head).group(1)
            status = self.play(play_range, scale)
            if not status.startswith("RTSP/1.0 200"):
                if "453" in status:
                    raise RelayError("The recorder has no free playback session (its own limit — try again shortly)")
                raise RelayError("PLAY failed: " + status)
        except (ConnectionError, OSError) as e:
            self.close()
            raise RelayError(f"Connection problem: {e}")
        except RelayError:
            self.close()
            raise
        self.sock.settimeout(idle_timeout)
        return self

    def play(self, range_="npt=0.000-", scale=None):
        """(Re)issue PLAY on an already-set-up session — used to seek within a playback session.
        Returns the RTSP status line."""
        extra = f"Range: {range_}\r\n" + (f"Scale: {scale}\r\n" if scale else "")
        self._send("PLAY", self.url, extra)
        head, _ = self._resp()
        return head.split("\r\n")[0]

    def pause(self):
        self._send("PAUSE", self.url)
        head, _ = self._resp()
        return head.split("\r\n")[0]

    def packets(self):
        """Yield interleaved RTP packets on channel 0 (video)."""
        last_ka = time.time()
        while True:
            while len(self.buf) < 4:
                self._recv()
            if self.buf[0] != 0x24:  # a keep-alive reply between media packets
                if self.buf.startswith(b"RTSP"):
                    self._resp()
                    continue
                raise ConnectionError("lost RTSP framing")
            ch, ln = self.buf[1], struct.unpack(">H", self.buf[2:4])[0]
            while len(self.buf) < 4 + ln:
                self._recv()
            d, self.buf = self.buf[4:4 + ln], self.buf[4 + ln:]
            if ch == 0:
                yield d
            if time.time() - last_ka > 20:
                self._send("OPTIONS", self.url)
                last_ka = time.time()

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


# --------------------------------------------------------------------------- depacketizer

class Depacketizer:
    """RTP -> NAL units (without start code). Decrypts NALs flagged by the RTP extension."""

    def __init__(self, codec, aes):
        self.codec, self.aes = codec, aes
        self.cur = None
        self.enc = False
        self.saw_ext = False

    def _decrypt(self, w):
        if not self.aes:
            return w
        if self.codec == "h264":
            hl = 1
            if len(w) < hl + 16:
                return w
            n = min((len(w) - hl) // 16 * 16, MAX_ENC)
            return self.aes.decrypt(w[hl:hl + n]) + w[hl + n:]  # header copy dropped: it is inside the cipher
        hl = 2
        if len(w) < hl + 16:
            return w
        n = min((len(w) - hl) // 16 * 16, MAX_ENC)
        return w[:hl] + self.aes.decrypt(w[hl:hl + n]) + w[hl + n:]

    def feed(self, p):
        """Returns a list of (rtp_timestamp, nal_bytes)."""
        if len(p) < 13:
            return []
        ts = struct.unpack(">I", p[4:8])[0]
        off = 12 + 4 * (p[0] & 0x0F)
        ext = bool(p[0] & 0x10)
        if ext:
            self.saw_ext = True
            off += 4 + 4 * struct.unpack(">H", p[off + 2:off + 4])[0]
        d = p[off:]
        if len(d) < 2:
            return []
        out = []

        def emit(nal, enc):
            out.append((ts, self._decrypt(nal) if enc else nal))

        if self.codec == "h264":
            t = d[0] & 0x1F
            if t == 28:  # FU-A
                if d[1] & 0x80:
                    self.cur = bytearray([(d[0] & 0xE0) | (d[1] & 0x1F)]) + d[2:]
                    self.enc = ext
                elif self.cur is not None:
                    self.cur += d[2:]
                if d[1] & 0x40 and self.cur is not None:
                    emit(bytes(self.cur), self.enc)
                    self.cur = None
            elif t == 24:  # STAP-A
                i = 1
                while i + 2 <= len(d):
                    n = struct.unpack(">H", d[i:i + 2])[0]
                    out.append((ts, d[i + 2:i + 2 + n]))
                    i += 2 + n
            elif 0 < t < 24:
                emit(d, ext)
        else:
            t = (d[0] >> 1) & 0x3F
            if t == 49:  # FU
                if len(d) < 3:
                    return []
                if d[2] & 0x80:
                    hdr = bytes([(d[0] & 0x81) | ((d[2] & 0x3F) << 1), d[1]])
                    self.cur = bytearray(hdr) + d[3:]
                    self.enc = ext
                elif self.cur is not None:
                    self.cur += d[3:]
                if d[2] & 0x40 and self.cur is not None:
                    emit(bytes(self.cur), self.enc)
                    self.cur = None
            elif t == 48:  # AP
                i = 2
                while i + 2 <= len(d):
                    n = struct.unpack(">H", d[i:i + 2])[0]
                    out.append((ts, d[i + 2:i + 2 + n]))
                    i += 2 + n
            elif t < 48:
                emit(d, ext)
        return out


def is_start_nal(codec, nal):
    """First NAL of a decodable sequence: SPS (H.264) or VPS (H.265)."""
    return (nal[0] & 0x1F) == 7 if codec == "h264" else ((nal[0] >> 1) & 0x3F) == 32


def is_param_nal(codec, nal):
    """VPS/SPS/PPS."""
    return (nal[0] & 0x1F) in (7, 8) if codec == "h264" else ((nal[0] >> 1) & 0x3F) in (32, 33, 34)


def is_key_nal(codec, nal):
    """An IDR/IRAP picture."""
    return (nal[0] & 0x1F) == 5 if codec == "h264" else 16 <= ((nal[0] >> 1) & 0x3F) <= 21


def sdp_param_sets(sdp, codec):
    """Parameter sets (SPS/PPS or VPS/SPS/PPS) advertised in the SDP, for cameras that do not repeat them in-band."""
    out = []
    try:
        if codec == "h264":
            m = re.search(r"sprop-parameter-sets=([^;\s]+)", sdp)
            out = [base64.b64decode(x) for x in m.group(1).split(",")] if m else []
        else:
            for key in ("sprop-vps", "sprop-sps", "sprop-pps"):
                m = re.search(key + r"=([^;\s]+)", sdp)
                if m:
                    out.append(base64.b64decode(m.group(1)))
    except ValueError:
        return []
    return [n for n in out if n]


class StartGate:
    """Decides where a stream can start being decoded: at an in-band SPS/VPS, or at a keyframe (using the SDP's sets)."""

    def __init__(self, codec, sdp):
        self.codec = codec
        self.params = sdp_param_sets(sdp, codec)
        self.started = False

    def feed(self, nal):
        """Returns the NAL units to pass on (empty while still waiting)."""
        if self.started:
            return [nal]
        if is_start_nal(self.codec, nal):
            self.started = True
            return [nal]
        if is_key_nal(self.codec, nal) and self.params:
            self.started = True
            return self.params + [nal]
        return []


NICE_FPS = (1, 2, 3, 4, 5, 6, 8, 10, 12, 12.5, 15, 20, 24, 25, 30, 50, 60)


def measure_fps(timestamps):
    """Frame rate from RTP timestamps (90 kHz clock). The camera's frame timestamps jitter by tens of ms,
    so average over a multi-second window and snap to the nearest standard rate. The rate has to be
    accurate to well under 1%: ffmpeg stamps every frame from it, and an error shows up as drift."""
    ts = sorted(set(timestamps))
    if len(ts) < 4:
        return None
    span = ts[-1] - ts[0]
    if not 0 < span < 90000 * 30:
        return None
    fps = 90000 * (len(ts) - 1) / span
    nearest = min(NICE_FPS, key=lambda n: abs(n - fps))
    return nearest if abs(nearest - fps) / nearest < 0.03 else round(fps, 3)


def fmt_fps(fps):
    return f"{fps:g}"


# --------------------------------------------------------------------------- ffmpeg helpers

def ffmpeg_push_cmd(codec, fps, out, transcode=False):
    """ffmpeg reads bare Annex-B from stdin, which carries no timestamps, so we stamp the frames ourselves.

    Raw H.265 ignores -framerate (it always assumes 30 fps), which made HD play at double speed. So:
      copy path      : `setts` bitstream filter numbers every packet from the measured fps
      transcode path : `setpts` renumbers decoded frames, `-r` fixes the output rate
    No -fflags nobuffer / -flags low_delay either: they make ffmpeg's raw H.265 parser output nothing."""
    f = fmt_fps(fps)
    cmd = ["ffmpeg", "-v", os.environ.get("HIKRELAY_FFLOG", "error")]
    # software decode on purpose: VideoToolbox's H.265 decoder fails on this DVR's stream ("Decoding error"),
    # which stalls the output until the next keyframe (~5 s). The hardware *encoder* is fine.
    cmd += ["-probesize", "32768", "-analyzeduration", "0", "-framerate", f, "-bsf:v", f"setts=ts=N/{f}/TB",
            "-f", codec, "-i", "-"]
    if transcode:   # H.265 -> H.264 for browsers that cannot play H.265
        cmd += ["-vf", f"setpts=N/({f}*TB)", "-r", f]
        if sys.platform == "darwin":
            cmd += ["-c:v", "h264_videotoolbox", "-b:v", "5M", "-profile:v", "high", "-realtime", "1"]
        else:
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-b:v", "5M"]
        cmd += ["-g", str(max(int(fps) * 2, 1)), "-bf", "0", "-an"]
    else:
        cmd += ["-c", "copy"]
    return cmd + ["-f", "rtsp", "-rtsp_transport", "tcp", out]


def collect(client, dp, max_seconds, want_frames, start_wait=12):
    """Gather NAL units from the start of a decodable sequence, until enough distinct frames or time is up.
    Streams that start on demand may need a few seconds before the first keyframe, so waiting for the start
    (up to start_wait) is separate from the sampling time (max_seconds)."""
    gate = StartGate(client.codec, client.sdp)
    nals, stamps = [], []
    t0 = time.time()
    t_start = None
    for p in client.packets():
        for ts, nal in dp.feed(p):
            for n in gate.feed(nal):
                if t_start is None:
                    t_start = time.time()
                nals.append(n)
                stamps.append(ts)
        if t_start is not None and (len(set(stamps)) >= want_frames or time.time() - t_start > max_seconds):
            break
        if t_start is None and time.time() - t0 > start_wait:
            break
    return nals, stamps


# --------------------------------------------------------------------------- commands

def conn_of(settings):
    c = settings["connection"]
    return dict(host=c["host"], port=c.get("rtsp_port", 554), http_port=c.get("http_port", 80), user=c["username"],
                pw=c["password"], encrypted=bool(c.get("encrypted")), key=c.get("key", ""))


def run_stream(conn, path, out, fps_override=None, transcode=False):
    aes = make_aes(conn["key"]) if conn["encrypted"] else None
    client = RtspClient(conn["host"], conn["port"], conn["user"], conn["pw"], path).open()
    dp = Depacketizer(client.codec, aes)
    gate = StartGate(client.codec, client.sdp)
    ff = None
    pending, stamps = [], []
    t0 = time.time()

    def shutdown(*_):
        if ff and ff.poll() is None:
            ff.kill()
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    ppid = os.getppid()

    def watch_parent():  # exit if go2rtc (our parent) disappears
        while True:
            time.sleep(2)
            if os.getppid() != ppid:
                shutdown()

    threading.Thread(target=watch_parent, daemon=True).start()

    for p in client.packets():
        for ts, nal in dp.feed(p):
            if ff is None:
                got = gate.feed(nal)
                pending += got
                stamps += [ts] * len(got)
                if not pending:
                    continue
                fps = fps_override
                if fps is None and len(set(stamps)) >= 20 and max(stamps) - min(stamps) >= 270000:  # >= 3 s of video
                    fps = measure_fps(stamps)
                if fps is None and time.time() - t0 > 7:
                    fps = measure_fps(stamps) or 12
                if fps is None:
                    continue
                ff = subprocess.Popen(ffmpeg_push_cmd(client.codec, fps, out, transcode), stdin=subprocess.PIPE, bufsize=0)
                print(f"streaming {path} as {client.codec} at {fmt_fps(fps)} fps", flush=True)
                for n in pending:
                    ff.stdin.write(START + n)
                pending = []
            else:
                ff.stdin.write(START + nal)  # unbuffered: a buffered pipe stalls ffmpeg on quiet channels
        if ff is not None and ff.poll() is not None:
            raise RelayError("ffmpeg exited")


def probe(conn, path, seconds=8):
    """Connect, sample the stream and report what it is. Never raises; returns a dict."""
    res = {"ok": False}
    client = None
    try:
        client = RtspClient(conn["host"], conn["port"], conn["user"], conn["pw"], path).open()
        res["codec"] = "H.265" if client.codec == "hevc" else "H.264"
        aes = make_aes(conn["key"]) if conn["encrypted"] else None
        dp = Depacketizer(client.codec, aes)
        nals, stamps = collect(client, dp, seconds, 50)
        res["stream_encrypted"] = dp.saw_ext
        res["fps"] = measure_fps(stamps)
        if not nals:
            raise RelayError("Connected, but no video arrived (the camera may be idle)")
        while nals and is_param_nal(client.codec, nals[-1]):   # a cut-off next keyframe header is not an error
            nals.pop()
        with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f:
            f.write(b"".join(START + n for n in nals))
            tmp = f.name
        try:
            r = subprocess.run(["ffprobe", "-v", "error", "-f", client.codec, "-show_entries",
                                "stream=width,height", "-of", "json", tmp], capture_output=True, text=True, timeout=20)
            info = (json.loads(r.stdout or "{}").get("streams") or [{}])[0]
            d = subprocess.run(["ffmpeg", "-v", "error", "-f", client.codec, "-i", tmp, "-frames:v", "8",
                                "-f", "null", "-"], capture_output=True, text=True, timeout=30)
            decode_errors = len([l for l in d.stderr.splitlines() if l.strip() and "missing picture in access unit" not in l])
        finally:
            os.unlink(tmp)
        res["width"], res["height"] = info.get("width"), info.get("height")
        decodes = bool(res["width"]) and decode_errors == 0
        res["decodes"] = decodes
        if decodes:
            res["ok"] = True
            res["message"] = "Stream is readable" + (" (decrypted)" if dp.saw_ext and aes else "")
        elif dp.saw_ext and not conn["encrypted"]:
            res["message"] = "This stream is encrypted. Turn on stream encryption and enter the verification code"
        elif dp.saw_ext and conn["encrypted"]:
            res["message"] = "This stream is encrypted and the verification code is wrong"
        else:
            res["message"] = "The stream arrived but could not be decoded"
    except RelayError as e:
        res["message"] = str(e)
    except (ConnectionError, OSError) as e:
        res["message"] = f"Connection problem: {e}"
    finally:
        if client:
            client.close()
    return res


def isapi_channels(conn, timeout=5):
    """Camera names from a Hikvision recorder's ISAPI (HTTP, digest auth): {channel_number: name}. {} if unavailable."""
    url = f"http://{conn['host']}:{conn.get('http_port', 80)}/ISAPI/System/Video/inputs/channels"
    mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    mgr.add_password(None, url, conn["user"], conn["pw"])
    opener = urllib.request.build_opener(urllib.request.HTTPDigestAuthHandler(mgr))
    try:
        root = ET.fromstring(opener.open(url, timeout=timeout).read())
    except (OSError, ET.ParseError, ValueError):
        return {}
    out = {}
    for ch in root.iter():
        if ch.tag.endswith("VideoInputChannel"):
            kid = {c.tag.split("}")[-1]: (c.text or "").strip() for c in ch}
            if kid.get("id", "").isdigit() and kid.get("videoInputEnabled", "true") != "false":
                out[int(kid["id"])] = kid.get("name", "")
    return out


def discover(conn, max_channel=16):
    """Which channels exist (and what are they called)? Returns [{"channel": n, "name": str}].
    Uses the recorder's ISAPI when available; otherwise probes RTSP. Stops at once if the login is
    rejected (repeated bad logins can lock the account)."""
    names = isapi_channels(conn)
    found = []
    for n in range(1, max_channel + 1):
        c = RtspClient(conn["host"], conn["port"], conn["user"], conn["pw"], stream_path(n, "sub"), timeout=5)
        try:
            c.open()
            found.append({"channel": n, "name": names.get(n, "")})
        except RelayError as e:
            if "Authentication" in str(e) or "Cannot reach" in str(e):
                raise
        finally:
            c.close()
    return found


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("stream", "probe"):
        sp = sub.add_parser(name)
        sp.add_argument("--settings", required=True)
        sp.add_argument("--channel-id", required=True)
        sp.add_argument("--kind", choices=("main", "sub"), required=True)
        if name == "stream":
            sp.add_argument("--out", required=True)
            sp.add_argument("--transcode", action="store_true", help="re-encode to H.264")
    a = ap.parse_args()
    s = load_settings(a.settings)
    ch = next((c for c in s["channels"] if c["id"] == a.channel_id), None)
    if ch is None:
        sys.exit(f"unknown channel {a.channel_id}")
    conn = conn_of(s)
    path = stream_path(ch["channel"], a.kind, ch.get(f"{a.kind}_path", ""))
    if a.cmd == "probe":
        print(json.dumps(probe(conn, path)))
        return
    fps = ch.get(f"{a.kind}_fps")
    try:
        run_stream(conn, path, a.out, float(fps) if fps not in (None, "", "auto") else None, a.transcode)
    except (RelayError, ConnectionError, OSError) as e:
        print(f"relay stopped: {e}", file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
