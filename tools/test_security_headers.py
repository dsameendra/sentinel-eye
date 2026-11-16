"""Security headers on every response, and the Content-Security-Policy in particular: pages may only load from
and talk to this server (the project's no-off-LAN rule, enforced by the browser). Offline: no recorder, scratch
data dir.   .venv/bin/python3 tools/test_security_headers.py
"""
import base64
import hashlib
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

SCRATCH = tempfile.mkdtemp(prefix="sentinel-headers-")
os.environ["SENTINEL_DATA"] = SCRATCH
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))

from fastapi.testclient import TestClient   # noqa: E402

import server   # noqa: E402

PASS = []


def check(name, ok, extra=""):
    PASS.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def directives(csp):
    return {d.split()[0]: d.split()[1:] for d in csp.split("; ")}


def main():
    try:
        c = TestClient(server.app, follow_redirects=False, raise_server_exceptions=False)
        for path in ("/", "/login", "/api/auth/me", "/js/main.js", "/api/no-such-route"):
            h = c.get(path).headers
            check(f"{path}: carries the policy and the other security headers",
                  h.get("content-security-policy") == server.CSP and h.get("x-frame-options") == "DENY"
                  and h.get("x-content-type-options") == "nosniff" and h.get("referrer-policy") == "same-origin", dict(h))
        d = directives(server.CSP)
        check("everything defaults to this origin only", d["default-src"] == ["'self'"])
        check("connections (fetch, WebSocket) only to this origin", d["connect-src"] == ["'self'"])
        check("no framing by other sites", d["frame-ancestors"] == ["'none'"])
        check("no plugins; forms and <base> stay on this origin", d["object-src"] == ["'none'"] and d["form-action"] == ["'self'"] and d["base-uri"] == ["'self'"])
        check("scripts: no unsafe-inline, no eval, no remote hosts",
              "'unsafe-inline'" not in d["script-src"] and "'unsafe-eval'" not in d["script-src"]
              and all(s == "'self'" or s.startswith("'sha256-") for s in d["script-src"]), d["script-src"])
        check("no directive names a remote host or a wildcard",
              not re.search(r"https?:|\*|\bwss?:", server.CSP), server.CSP)
        check("pictures and video may also be page-built data:/blob: URLs", "blob:" in d["img-src"] and "data:" in d["img-src"] and "blob:" in d["media-src"])

        # Every inline script in the served pages is allowed by its hash — and nothing else is.
        inline = set()
        for page in sorted((ROOT / "web").glob("*.html")):
            html = page.read_text()
            for body in server.INLINE_SCRIPT.findall(html):
                inline.add("'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'")
            check(f"{page.name}: no inline event handlers or javascript: URLs (the policy would block them)",
                  not re.search(r"\son[a-z]+\s*=|javascript:", html, re.I))
            check(f"{page.name}: loads nothing from another host",
                  not re.search(r"""(?:src|href)\s*=\s*["'](?:https?:)?//""", html, re.I))
        find = server.INLINE_SCRIPT.findall
        check("inline-script pattern: plain, upper-case, with attributes, and '</script >' all match",
              find("<script>a()</script>") == ["a()"] and find("<SCRIPT>b()</SCRIPT>") == ["b()"]
              and find('<script type="text/javascript" nonce="x">c()</script >') == ["c()"]
              and find("<script>\nd()\n</script\n>") == ["\nd()\n"])
        check("inline-script pattern: a script with src= is not inline",
              find('<script src="js/pwa.js"></script>') == [] and find('<script type="module" SRC = "js/main.js"></script>') == []
              and find('<script src="a.js"></script><script>e()</script>') == ["e()"])
        check("inline-script pattern: other tags don't match", find("<scripted>x</scripted>") == [] and find("<style>x</style>") == [])
        check("the pages do carry an inline bootstrap script", len(inline) >= 1, len(inline))
        check("every inline script's hash is in script-src, and no stale ones", set(d["script-src"]) - {"'self'"} == inline,
              (d["script-src"], inline))
    finally:
        shutil.rmtree(SCRATCH, ignore_errors=True)
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
