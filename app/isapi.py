"""Minimal Hikvision ISAPI client (HTTP digest auth, XML). Used for events, logs, coverage and channel info."""
import re
import urllib.error
import urllib.request

WS = re.compile(r"\s+")


def squeeze(xml, n=4000):
    """Collapse whitespace and drop the default xmlns for readability/logging."""
    return WS.sub(" ", re.sub(r'\sxmlns="[^"]+"', "", xml))[:n]


class Isapi:
    def __init__(self, host, user, pw, http_port=80, timeout=15):
        self.host, self.user, self.pw, self.port, self.timeout = host, user, pw, http_port, timeout
        base = f"http://{host}:{http_port}"
        mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        mgr.add_password(None, base, user, pw)
        self.opener = urllib.request.build_opener(urllib.request.HTTPDigestAuthHandler(mgr))
        self.base = base

    def call(self, path, method="GET", body=None, timeout=None):
        """Returns (status, text). Never raises for HTTP error status; raises only on connection failure."""
        req = urllib.request.Request(
            self.base + path, method=method,
            data=body.encode() if isinstance(body, str) else body,
            headers={"Content-Type": "application/xml"} if body else {},
        )
        try:
            with self.opener.open(req, timeout=timeout or self.timeout) as r:
                return r.status, r.read().decode(errors="replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(errors="replace")

    def get(self, path, **kw):
        return self.call(path, "GET", **kw)

    def put(self, path, body, **kw):
        return self.call(path, "PUT", body, **kw)

    def picture(self, channel, timeout=None):
        """Raw JPEG bytes of a channel's current snapshot, or None on failure."""
        req = urllib.request.Request(self.base + f"/ISAPI/Streaming/channels/{channel}/picture")
        try:
            with self.opener.open(req, timeout=timeout or self.timeout) as r:
                return r.read()
        except (urllib.error.HTTPError, OSError):
            return None
