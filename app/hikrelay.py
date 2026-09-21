"""Decrypting RTSP relay for Hikvision DVRs with stream encryption enabled.

Connects to the DVR over RTSP/TCP, decrypts the encrypted NAL units (AES-128-ECB,
key = verification code zero-padded to 16 bytes, first <=4096 bytes of each NAL in
packets that carry the Hikvision RTP extension), and pushes clean video into go2rtc.

Usage: hikrelay.py [--codec h264|hevc] name:channel_stream ...   e.g. cam1:102 cam2:102
"""
import argparse, hashlib, os, re, socket, struct, subprocess, sys, threading, time
from Crypto.Cipher import AES

MAX_ENC = 4096
START = b"\x00\x00\x00\x01"


def load_env(path):
    env = dict(os.environ)
    for line in open(path):
        if "=" in line and not line.startswith("#"):
            k, v = line.rstrip("\n").split("=", 1)
            env.setdefault(k, v)
    return env


class Depacketizer:
    """RTP -> Annex-B NAL units, decrypting where flagged. H.264 only for now."""

    def __init__(self, aes, codec):
        self.aes, self.codec = aes, codec
        self.cur = None
        self.enc = False

    def _decrypt(self, w):
        hl = 1 if self.codec == "h264" else 2
        if len(w) < hl + 16:
            return w
        n = min((len(w) - hl) // 16 * 16, MAX_ENC)
        # wrapper = [header copy][AES(real NAL from byte 0)][clear tail]: drop the copy
        return self.aes.decrypt(w[hl:hl + n]) + w[hl + n:]

    def feed(self, p):
        """Returns list of Annex-B NAL byte strings."""
        if len(p) < 13:
            return []
        off = 12 + 4 * (p[0] & 0xF)
        ext = bool(p[0] & 0x10)
        if ext:
            off += 4 + 4 * struct.unpack(">H", p[off + 2:off + 4])[0]
        d = p[off:]
        if not d:
            return []
        out = []
        t = d[0] & 0x1F
        if t == 28:  # FU-A
            if d[1] & 0x80:
                self.cur = bytearray([(d[0] & 0xE0) | (d[1] & 0x1F)]) + d[2:]
                self.enc = ext
            elif self.cur is not None:
                self.cur += d[2:]
            if d[1] & 0x40 and self.cur is not None:
                w = bytes(self.cur)
                self.cur = None
                out.append(START + (self._decrypt(w) if self.enc else w))
        elif t == 24:  # STAP-A (never encrypted here)
            i = 1
            while i + 2 <= len(d):
                n = struct.unpack(">H", d[i:i + 2])[0]
                out.append(START + d[i + 2:i + 2 + n])
                i += 2 + n
        elif 0 < t < 24:
            out.append(START + (self._decrypt(d) if ext else d))
        return out


class RtspClient:
    def __init__(self, host, user, pw, path):
        self.host, self.user, self.pw, self.path = host, user, pw, path
        self.url = f"rtsp://{host}:554{path}"
        self.buf = b""
        self.cseq = 0
        self.session = None
        self.auth = None

    def _md5(self, s):
        return hashlib.md5(s.encode()).hexdigest()

    def _send(self, method, url, extra=""):
        self.cseq += 1
        a = ""
        if self.auth:
            r, n = self.auth
            resp = self._md5(f"{self._md5(f'{self.user}:{r}:{self.pw}')}:{n}:{self._md5(f'{method}:{url}')}")
            a = (f'Authorization: Digest username="{self.user}", realm="{r}", nonce="{n}", '
                 f'uri="{url}", response="{resp}"\r\n')
        sid = f"Session: {self.session}\r\n" if self.session else ""
        self.sock.sendall(f"{method} {url} RTSP/1.0\r\nCSeq: {self.cseq}\r\n{sid}{a}{extra}\r\n".encode())

    def _resp(self):
        while b"\r\n\r\n" not in self.buf:
            self._recv()
        h, self.buf = self.buf.split(b"\r\n\r\n", 1)
        h = h.decode(errors="replace")
        m = re.search(r"Content-Length:\s*(\d+)", h, re.I)
        body = b""
        if m:
            n = int(m.group(1))
            while len(self.buf) < n:
                self._recv()
            body, self.buf = self.buf[:n], self.buf[n:]
        return h, body.decode(errors="replace")

    def _recv(self):
        d = self.sock.recv(65536)
        if not d:
            raise ConnectionError("closed")
        self.buf += d

    def open(self):
        self.sock = socket.create_connection((self.host, 554), timeout=10)
        self._send("DESCRIBE", self.url, "Accept: application/sdp\r\n")
        h, b = self._resp()
        if h.startswith("RTSP/1.0 401"):
            self.auth = (re.search(r'realm="([^"]+)"', h).group(1), re.search(r'nonce="([^"]+)"', h).group(1))
            self._send("DESCRIBE", self.url, "Accept: application/sdp\r\n")
            h, b = self._resp()
        if not h.startswith("RTSP/1.0 200"):
            raise ConnectionError(h.split("\r\n")[0])
        self.sdp = b
        ctl = [c for c in re.findall(r"a=control:(\S+)", b) if c != "*"][0]
        turl = ctl if ctl.startswith("rtsp") else self.url + "/" + ctl
        self._send("SETUP", turl, "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n")
        h, _ = self._resp()
        if not h.startswith("RTSP/1.0 200"):
            raise ConnectionError("SETUP " + h.split("\r\n")[0])
        self.session = re.search(r"Session:\s*([^;\r\n]+)", h).group(1)
        self._send("PLAY", self.url, "Range: npt=0.000-\r\n")
        h, _ = self._resp()
        if not h.startswith("RTSP/1.0 200"):
            raise ConnectionError("PLAY " + h.split("\r\n")[0])
        self.sock.settimeout(15)

    def packets(self):
        last_ka = time.time()
        while True:
            while len(self.buf) < 4:
                self._recv()
            if self.buf[0] != 0x24:  # a keep-alive response sneaking in
                if self.buf.startswith(b"RTSP"):
                    self._resp()
                    continue
                raise ConnectionError("desync")
            ch, ln = self.buf[1], struct.unpack(">H", self.buf[2:4])[0]
            while len(self.buf) < 4 + ln:
                self._recv()
            d, self.buf = self.buf[4:4 + ln], self.buf[4 + ln:]
            if ch == 0:
                yield d
            if time.time() - last_ka > 20:
                self._send("OPTIONS", self.url)
                last_ka = time.time()


def run_stream(name, chan, env, codec, go2rtc, fps=12):
    aes = AES.new((env["DVR_KEY"].encode() + b"\0" * 16)[:16], AES.MODE_ECB)
    fmt = "h264" if codec == "h264" else "hevc"
    while True:
        ff = None
        try:
            c = RtspClient(env["DVR_HOST"], env["DVR_USER"], env["DVR_PASS"], f"/Streaming/Channels/{chan}")
            c.open()
            dp = Depacketizer(aes, codec)
            stat_t, stat_p, stat_n = time.time(), 0, 0
            print(f"[{name}] connected ch {chan}, waiting for keyframe", flush=True)
            for p in c.packets():
                stat_p += 1
                if time.time() - stat_t > 10:
                    print(f"[{name}] stats: {stat_p} pkts, {stat_n} nals in 10s, ffmpeg={'up' if ff else 'waiting'}", flush=True)
                    stat_t, stat_p, stat_n = time.time(), 0, 0
                for nal in dp.feed(p):
                    stat_n += 1
                    if ff is None:
                        # start ffmpeg on the first SPS/VPS so it never probes mid-GOP garbage
                        if (nal[4] & 0x1F) != 7 if codec == "h264" else ((nal[4] >> 1) & 0x3F) != 32:
                            continue
                        ff = subprocess.Popen(
                            ["ffmpeg", "-v", "error", "-fflags", "+nobuffer", "-flags", "low_delay",
                             "-probesize", "32768", "-analyzeduration", "0", "-framerate", str(fps),
                             "-f", fmt, "-i", "-", "-c", "copy", "-f", "rtsp", "-rtsp_transport", "tcp",
                             f"rtsp://{go2rtc}/{name}"], stdin=subprocess.PIPE, bufsize=0)
                        print(f"[{name}] streaming ch {chan}", flush=True)
                    ff.stdin.write(nal)  # unbuffered: a buffered pipe stalls ffmpeg on quiet channels
        except Exception as e:
            print(f"[{name}] {type(e).__name__}: {e}; retrying in 3s", flush=True)
        finally:
            if ff:
                try:
                    ff.stdin.close(); ff.kill()
                except Exception:
                    pass
        time.sleep(3)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--codec", default="h264")
    ap.add_argument("--go2rtc", default="127.0.0.1:8554")
    ap.add_argument("--env", default=os.path.join(os.path.dirname(__file__), "..", ".env"))
    ap.add_argument("streams", nargs="+", help="name:channelstream, e.g. cam1:102")
    a = ap.parse_args()
    env = load_env(a.env)
    ts = []
    for s in a.streams:
        n, ch = s.split(":")
        t = threading.Thread(target=run_stream, args=(n, ch, env, a.codec, a.go2rtc), daemon=True)
        t.start(); ts.append(t)
        time.sleep(0.5)  # stagger connections to be gentle on the DVR
    while True:
        time.sleep(3600)
