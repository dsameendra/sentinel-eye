"""Recorder account-lockout breaker, shared by every part of the app that logs in to the recorder on its own.

Hikvision recorders lock the account after a handful of failed logins. Left alone, a wrong password in Settings
used to be retried by everything at once: the alertStream subscriber every 3 s, the calibration / backfill /
coverage loops, every thumbnail and playback pane, and each live relay go2rtc re-spawns — so the account locked
within seconds and stayed locked for as long as the app ran. This module is the one switch they all check: the
first time the recorder rejects credentials that were actually sent (not the normal digest challenge that comes
before them), the breaker trips and every automatic caller fails fast with MESSAGE instead of trying again.

Logins themselves are serialised across processes too (login_lock): saving a wrong password restarts go2rtc, and
every watched stream re-spawns its relay at the same moment — without the lock each would send the wrong password
before any had written the marker. With it, the first rejection trips the breaker and the rest never log in.

It is a marker file in the data directory, not process memory, because the live relays are separate processes
(go2rtc runs `hikrelay.py stream --settings <data>/settings.json`): they configure() it from the settings file's
own directory, so nothing here imports the server's state. The interactive admin tools (/api/test, /api/discover)
never check or trip it — that's how the admin finds the right password. It is cleared when settings are saved
and by the admin's explicit retry (POST /api/recorder/retry).

The marker also records a short fingerprint of the credentials that were rejected, so a rejection of credentials
that are no longer the saved ones (a request still in flight when the admin saved new ones, or a settings file
edited by hand) never blocks the new ones. The fingerprint is a truncated SHA-256 and lives next to
settings.json, which holds the password itself in clear anyway — so, like settings.json, the marker is
readable by the owner only (0600); the password is never written here or logged.
"""
import contextlib
import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path

MESSAGE = "The recorder rejected the username or password — fix it in Settings → Connection"
MARKER_NAME = "recorder_auth_failed.json"
LOCK_NAME = "recorder_login.lock"

_dir: Path | None = None
_lock = threading.Lock()


class RecorderAuthBlocked(Exception):
    """The breaker is tripped (or has just been tripped): don't contact the recorder. The message is user-safe."""

    def __init__(self, msg: str = MESSAGE):
        super().__init__(msg)


def configure(data_dir) -> None:
    """Use this directory for the marker (the relay process: its --settings file's directory)."""
    global _dir
    _dir = Path(data_dir)


def _data_dir() -> Path:
    # Same derivation as settings.DATA, read at call time and without importing settings (pydantic) — the relay
    # process stays light, and tests that point SENTINEL_DATA at a scratch dir are honoured.
    if _dir is not None:
        return _dir
    return Path(os.environ.get("SENTINEL_DATA", Path(__file__).resolve().parent.parent / "data"))


def marker_path() -> Path:
    return _data_dir() / MARKER_NAME


def fingerprint(host, user, pw) -> str:
    return hashlib.sha256(f"{host}\0{user}\0{pw}".encode()).hexdigest()[:16]


def info() -> dict | None:
    """The marker's contents ({ts, source, fp}), or None when the breaker is clear."""
    try:
        return json.loads(marker_path().read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        # A torn or unreadable marker still means "something was rejected": fail safe (treat as tripped for
        # whatever credentials are asked about) rather than resume logging in.
        return {"fp": None}


def tripped(fp: str | None = None) -> bool:
    """True while the breaker blocks these credentials (or, with no fp, any credentials)."""
    m = info()
    if m is None:
        return False
    return fp is None or m.get("fp") in (None, fp)


def check(fp: str | None = None) -> None:
    """Raise RecorderAuthBlocked if the breaker blocks these credentials."""
    if tripped(fp):
        raise RecorderAuthBlocked()


def trip(fp: str | None, source: str) -> None:
    """Record a credential rejection. Idempotent; the first rejection's time and source are kept."""
    with _lock:
        if tripped(fp):
            return
        path = marker_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{os.getpid()}.tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps({"ts": time.time(), "source": source, "fp": fp}))
            os.replace(tmp, path)
        except OSError as e:
            print(f"recorder_guard: couldn't write {path}: {e}", file=sys.stderr, flush=True)
            return
    print(f"recorder_guard: the recorder rejected the saved credentials ({source}); "
          "pausing every automatic login until Settings are saved or the admin retries", file=sys.stderr, flush=True)


@contextlib.contextmanager
def login_lock(fp: str | None):
    """Hold around a guarded login (from sending credentials until the recorder's answer to them is known):
    one login at a time across every process sharing this data dir, and none at all once the breaker is
    tripped for `fp` — re-checked after the wait, so logins queued behind a rejection raise RecorderAuthBlocked
    instead of sending the same wrong password. A no-op for fp=None (unguarded callers), and where file locks
    aren't available (it is a lockout safeguard, not a correctness requirement)."""
    if fp is None:
        yield
        return
    try:
        import fcntl
        path = _data_dir() / LOCK_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    except (ImportError, OSError):
        check(fp)
        yield
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        check(fp)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def clear() -> bool:
    """Lift the breaker. True when it was tripped."""
    with _lock:
        try:
            marker_path().unlink()
            return True
        except FileNotFoundError:
            return False
