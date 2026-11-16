"""Minimal Hikvision ISAPI client (HTTP digest auth, XML). Used for events, logs, coverage and channel info."""
import re
import urllib.error
import urllib.request

import recorder_guard

WS = re.compile(r"\s+")


def squeeze(xml, n=4000):
    """Collapse whitespace and drop the default xmlns for readability/logging."""
    return WS.sub(" ", re.sub(r'\sxmlns="[^"]+"', "", xml))[:n]


class DvrRequestError(Exception):
    """The recorder answered, but not with 200. Raised where a partial answer would otherwise be saved as if it
    were complete (a day's log, a day's coverage), so the caller's watermark/cache stay untouched and it retries
    later. The message is user-safe."""

    def __init__(self, what, status):
        super().__init__(f"The recorder refused a {what} request (HTTP {status})")
        self.status = status


class _DigestOnce(urllib.request.HTTPDigestAuthHandler):
    """Answers the recorder's digest challenge once per request, never again.

    The stdlib handler re-answers every 401 up to ~6 times per request (each answer carries a new cnonce, so its
    "same header twice" stop never fires): with a wrong password, ONE call cost the account six failed logins,
    which on a Hikvision recorder is a lockout on its own. Here a 401 that comes back after credentials were
    sent is final, and marked on the request (`credentials_rejected`) so callers can tell it apart from the
    normal unauthenticated challenge that precedes every successful request. A `stale=true` challenge (expired
    nonce, credentials fine) still gets its one retry."""

    def http_error_401(self, req, fp, code, msg, headers):
        if req.get_header("Authorization"):
            challenge = (headers.get("www-authenticate", "") or "").lower().replace(" ", "")
            if "stale=true" not in challenge or getattr(req, "_se_stale_retried", False):
                req.credentials_rejected = True
                return None
            req._se_stale_retried = True
        # The parent's retry counter is shared by every request on this opener (and every thread); it is only
        # reset after a success, so failed requests would ratchet it until even the first challenge is refused
        # unanswered — forever, on a long-lived opener like the alertStream's. Each request starts from zero.
        self.retried = 0
        return super().http_error_401(req, fp, code, msg, headers)


def digest_opener(base, user, pw):
    mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    mgr.add_password(None, base, user, pw)
    return urllib.request.build_opener(_DigestOnce(mgr))


class Isapi:
    """`guarded` (the default — every current user is a background job): honour and trip the lockout breaker
    (recorder_guard), so a rejected password stops every automatic login instead of locking the account."""

    def __init__(self, host, user, pw, http_port=80, timeout=15, guarded=True):
        self.host, self.user, self.pw, self.port, self.timeout = host, user, pw, http_port, timeout
        base = f"http://{host}:{http_port}"
        self.opener = digest_opener(base, user, pw)
        self.base = base
        self.guarded = guarded
        self.fp = recorder_guard.fingerprint(host, user, pw)

    def _admit(self):
        if self.guarded:
            recorder_guard.check(self.fp)

    def _rejected(self, req, what):
        """Raise RecorderAuthBlocked (tripping the breaker) if `req` failed because the credentials were refused."""
        if getattr(req, "credentials_rejected", False):
            if self.guarded:
                recorder_guard.trip(self.fp, f"isapi {what}")
            raise recorder_guard.RecorderAuthBlocked()

    def call(self, path, method="GET", body=None, timeout=None):
        """Returns (status, text) for any HTTP answer except a credential rejection. Raises on connection
        failure, and RecorderAuthBlocked when the recorder rejects the credentials (or the breaker is already
        tripped for them)."""
        self._admit()
        req = urllib.request.Request(
            self.base + path, method=method,
            data=body.encode() if isinstance(body, str) else body,
            headers={"Content-Type": "application/xml"} if body else {},
        )
        try:
            r = self._open(req, timeout)
        except urllib.error.HTTPError as e:
            self._rejected(req, path.split("?")[0])
            return e.code, e.read().decode(errors="replace")
        with r:
            return r.status, r.read().decode(errors="replace")

    def _open(self, req, timeout):
        """opener.open under the cross-process login lock (recorder_guard.login_lock), held only until the
        response headers say whether the credentials were accepted — not while a body is read."""
        with recorder_guard.login_lock(self.fp if self.guarded else None):
            return self.opener.open(req, timeout=timeout or self.timeout)

    def get(self, path, **kw):
        return self.call(path, "GET", **kw)

    def put(self, path, body, **kw):
        return self.call(path, "PUT", body, **kw)

    def open_stream(self, path, timeout=None):
        """An open response for a long-lived GET (the alertStream). Same breaker rules as call(); any other HTTP
        error status is raised as urllib's HTTPError."""
        self._admit()
        req = urllib.request.Request(self.base + path)
        try:
            return self._open(req, timeout)
        except urllib.error.HTTPError:
            self._rejected(req, path)
            raise

    def picture(self, channel, timeout=None):
        """Raw JPEG bytes of a channel's current snapshot, or None on failure (a credential rejection still
        trips the breaker and raises, like call())."""
        self._admit()
        req = urllib.request.Request(self.base + f"/ISAPI/Streaming/channels/{channel}/picture")
        try:
            with self._open(req, timeout) as r:
                return r.read()
        except recorder_guard.RecorderAuthBlocked:
            raise
        except urllib.error.HTTPError:
            self._rejected(req, "picture")
            return None
        except OSError:
            return None
