"""Log rotation checks for app/go2rtc.py (temp dir only, never data/).

   .venv/bin/python3 tools/test_log_rotation.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "app")
import go2rtc

PASS = []


def check(name, ok, extra=""):
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def main():
    with tempfile.TemporaryDirectory() as d:
        log = Path(d) / "go2rtc.log"
        old = Path(d) / "go2rtc.log.1"

        go2rtc.rotate_log(log, 100)
        check("missing log is a no-op", not log.exists() and not old.exists())

        log.write_bytes(b"x" * 100)
        go2rtc.rotate_log(log, 100)
        check("log at the cap is left alone", log.exists() and not old.exists())

        log.write_bytes(b"a" * 101)
        go2rtc.rotate_log(log, 100)
        check("log over the cap moves to .1", not log.exists() and old.read_bytes() == b"a" * 101)

        log.write_bytes(b"b" * 150)
        go2rtc.rotate_log(log, 100)
        check("only one generation is kept", not log.exists() and old.read_bytes() == b"b" * 150
              and sorted(p.name for p in Path(d).iterdir()) == ["go2rtc.log.1"])

        check("default cap is ~10 MB", go2rtc.LOG_MAX_BYTES == 10 * 1024 * 1024)

    sys.exit(0 if all(PASS) else 1)


main()
