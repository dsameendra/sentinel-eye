"""Every WebSocket route must appear in this hardcoded allowlist. HTTP routes fail closed to admin for
anything unmatched in ROUTE_ROLES (see auth_api.py's required_role()), but gate()'s HTTP middleware never
runs for websocket scope, so a WebSocket route is only as authenticated as its own handler remembers to be
(each currently calls _ws_admit() inline). This doesn't verify that check is correct — only that a new
websocket route can't be added without someone consciously touching this allowlist, instead of shipping
silently unauthenticated.

   .venv/bin/python3 tools/test_ws_routes.py
"""
import sys

sys.path.insert(0, "app")
from starlette.routing import WebSocketRoute

import server

KNOWN_WS_ROUTES = {"/api/playback/ws", "/ws"}

PASS = []


def check(name, ok, extra=""):
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def main():
    found = {r.path for r in server.app.routes if isinstance(r, WebSocketRoute)}
    check("WebSocket routes match the known, individually-audited allowlist — if this fails because you "
          "added a new one, give it an explicit auth decision (see _ws_admit in server.py) before adding "
          "its path here", found == KNOWN_WS_ROUTES, found)

    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
