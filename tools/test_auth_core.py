"""Unit checks for app/auth.py (users, passwords, TOTP, sessions, pairing, config, rate limits, bypass, CLI),
against a scratch data dir — never touches data/.

   .venv/bin/python3 tools/test_auth_core.py
"""
import os
import subprocess
import sys
import tempfile
import time

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-auth-")
sys.path.insert(0, "app")
import auth

PASS = []


def check(name, ok, extra=""):
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def raises(status, fn, *a, **kw):
    try:
        fn(*a, **kw)
    except auth.AuthError as e:
        return e.status == status
    return False


class Clock:
    """Replaces auth._now so expiries can be tested without sleeping."""
    def __init__(self):
        self.t = time.time()
        auth._now = lambda: self.t


def users_and_passwords():
    check("fresh data dir: sign-in off", auth.enabled() is False)
    admin = auth.create_user("root", "correct horse battery", "admin")
    check("first user turns sign-in on", auth.enabled() is True)
    check("user record hides secrets", "pw_hash" not in admin and "totp_secret" not in admin, admin)

    h = auth.hash_password("correct horse battery")
    check("hash format", h.startswith("scrypt$32768$8$1$"), h[:20])
    check("verify ok", auth.verify_password("correct horse battery", h))
    check("verify wrong", not auth.verify_password("wrong horse battery", h))
    check("verify garbage stored value", not auth.verify_password("x", "nonsense"))

    check("authenticate ok", (auth.authenticate("ROOT", "correct horse battery") or {}).get("id") == admin["id"])
    check("authenticate wrong password", auth.authenticate("root", "nope nope nope") is None)
    t0 = time.perf_counter(); auth.authenticate("root", "nope nope nope"); real = time.perf_counter() - t0
    t0 = time.perf_counter(); r = auth.authenticate("ghost", "nope nope nope"); ghost = time.perf_counter() - t0
    check("unknown user: None, same scrypt work", r is None and ghost >= real * 0.5, f"{ghost:.3f}s vs {real:.3f}s")

    check("duplicate username (other case) -> 409", raises(409, auth.create_user, "Root", "0123456789", "viewer"))
    check("short password -> 422", raises(422, auth.create_user, "shorty", "123", "viewer"))
    check("bad role -> 422", raises(422, auth.create_user, "badrole", "0123456789", "god"))
    check("bad username -> 422", raises(422, auth.create_user, "a b", "0123456789", "viewer"))
    check("device: prefix reserved", raises(422, auth.create_user, "device:tv", "0123456789", "viewer"))

    v = auth.create_user("vera", "0123456789", "viewer")
    auth.update_user(v["id"], disabled=True)
    check("disabled user can't sign in", auth.authenticate("vera", "0123456789") is None)
    auth.update_user(v["id"], disabled=False)

    check("last admin: demote -> 409", raises(409, auth.update_user, admin["id"], role="viewer"))
    check("last admin: disable -> 409", raises(409, auth.update_user, admin["id"], disabled=True))
    check("last admin: delete -> 409", raises(409, auth.delete_user, admin["id"]))
    a2 = auth.create_user("second", "0123456789", "admin")
    check("with two admins one can be demoted", auth.update_user(a2["id"], role="operator")["role"] == "operator")

    check("auth.db is 0600", oct(os.stat(auth.DB_FILE).st_mode & 0o777) == "0o600",
          oct(os.stat(auth.DB_FILE).st_mode & 0o777))
    return admin


def totp_and_recovery(admin):
    s = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"   # RFC 6238 appendix B secret ("12345678901234567890")
    check("RFC 6238 T=59", auth.totp_at(s, 59 // 30) == "287082")
    check("RFC 6238 T=1111111109", auth.totp_at(s, 1111111109 // 30) == "081804")

    clock = Clock()
    secret, uri = auth.totp_begin(admin["id"])
    check("otpauth uri", uri.startswith("otpauth://totp/Sentinel%20Eye%3Aroot?secret=" + secret), uri)
    check("wrong confirm code rejected", raises(400, auth.totp_confirm, admin["id"], "000000")
          if auth.totp_at(secret, int(clock.t // 30)) != "000000" else True)
    codes = auth.totp_confirm(admin["id"], auth.totp_at(secret, int(clock.t // 30)))
    check("confirm returns 10 unique recovery codes", len(set(codes)) == 10, codes[:2])
    check("has_totp", auth.get_user(admin["id"])["has_totp"])

    clock.t += 90
    step = int(clock.t // 30)
    check("code from the confirm step can't be replayed later", not auth.totp_check(admin["id"], auth.totp_at(secret, step - 3)))
    check("previous step accepted", auth.totp_check(admin["id"], auth.totp_at(secret, step - 1)))
    check("same code twice rejected", not auth.totp_check(admin["id"], auth.totp_at(secret, step - 1)))
    check("current step accepted", auth.totp_check(admin["id"], auth.totp_at(secret, step)))
    check("next step accepted", auth.totp_check(admin["id"], auth.totp_at(secret, step + 1)))
    check("+2 steps rejected", not auth.totp_check(admin["id"], auth.totp_at(secret, step + 2)))
    check("non-numeric rejected", not auth.totp_check(admin["id"], "abcdef"))

    check("recovery code works", auth.use_recovery_code(admin["id"], codes[0].upper().replace("-", " ")))
    check("recovery code single use", not auth.use_recovery_code(admin["id"], codes[0]))
    fresh = auth.new_recovery_codes(admin["id"])
    check("regenerating invalidates old codes", not auth.use_recovery_code(admin["id"], codes[1])
          and auth.use_recovery_code(admin["id"], fresh[1]))
    auth.totp_disable(admin["id"])
    check("disable clears TOTP", not auth.get_user(admin["id"])["has_totp"] and not auth.use_recovery_code(admin["id"], fresh[2]))
    auth._now = time.time


def bootstrap():
    before = auth.enabled()
    auth.bootstrap_from_env({"SENTINEL_ADMIN_PASSWORD": "from-env-password"})
    check("bootstrap does nothing once users exist", before and auth.get_user_by_name("admin") is None)


def sessions():
    clock = Clock()
    u = auth.create_user("sam", "0123456789", "operator")
    tok = auth.create_session(u["id"], ip="10.0.0.5", ua="test")
    got = auth.lookup_session(tok)
    check("session lookup", got is not None and got[1]["id"] == u["id"] and got[0]["kind"] == "browser")
    check("random token -> None", auth.lookup_session("x" * 43) is None)

    # Read the files from another process: closing an fd here would drop SQLite's POSIX locks on them.
    found = subprocess.run(["grep", "-rlF", tok, os.environ["SENTINEL_DATA"]], capture_output=True, text=True)
    check("raw token never stored", found.stdout == "", found.stdout)

    clock.t += 11 * 3600
    got = auth.lookup_session(tok)
    check("sliding: used at 11h, extended", got is not None and got[0]["slid"])
    clock.t += 11 * 3600
    check("still alive 22h after login", auth.lookup_session(tok) is not None)
    clock.t += 13 * 3600
    check("expires after 12h idle", auth.lookup_session(tok) is None)

    rem = auth.create_session(u["id"], remember=True)
    clock.t += 20 * 86400
    check("remember-me survives 20 days", auth.lookup_session(rem) is not None)

    revoked = []
    auth.on_revoke(revoked.extend)
    a, b = auth.create_session(u["id"]), auth.create_session(u["id"])
    auth.set_password(u["id"], "new-password-123", except_hash=auth.token_hash(a))
    check("password change keeps caller's session", auth.lookup_session(a) is not None)
    check("password change revokes the others", auth.lookup_session(b) is None and auth.lookup_session(rem) is None)
    check("on_revoke got the revoked hashes", auth.token_hash(b) in revoked and auth.token_hash(a) not in revoked)

    auth.update_user(u["id"], disabled=True)
    check("disabling revokes sessions", auth.lookup_session(a) is None)
    auth.update_user(u["id"], disabled=False)

    c = auth.challenge_new(u["id"], True)
    check("challenge take", auth.challenge_take(c) == (u["id"], True))
    check("challenge single use", auth.challenge_take(c) is None)
    c = auth.challenge_new(u["id"], False)
    clock.t += 301
    check("challenge expires", auth.challenge_take(c) is None)
    auth._now = time.time


def pairing(admin):
    clock = Clock()
    p = auth.pair_start("192.168.1.50")
    check("user code format", len(p["user_code"]) == 9 and p["user_code"][4] == "-"
          and all(ch in auth.PAIR_ALPHABET for ch in p["user_code"].replace("-", "")), p["user_code"])
    check("poll pending", auth.pair_poll(p["device_code"]) is None)
    check("device can't be admin", raises(422, auth.pair_approve, p["user_code"], role="admin", label="TV", approver_id=admin["id"]))
    auth.pair_approve(p["user_code"].lower().replace("-", ""), role="viewer", label="Living room TV", approver_id=admin["id"])
    tok = auth.pair_poll(p["device_code"], ip="192.168.1.50", ua="Tizen")
    got = auth.lookup_session(tok) if isinstance(tok, str) and tok != "expired" else None
    check("poll after approval -> device session", got is not None and got[0]["kind"] == "device"
          and got[1]["kind"] == "device" and got[1]["role"] == "viewer" and got[1]["label"] == "Living room TV", got)
    check("pairing consumed", auth.pair_poll(p["device_code"]) == "expired")
    check("device isn't a person: listed apart", all(u["kind"] == "person" for u in auth.list_users())
          and any(u["kind"] == "device" for u in auth.list_users("device")))
    clock.t += 300 * 86400
    check("device session lasts ~a year", auth.lookup_session(tok) is not None)

    q = auth.pair_start("192.168.1.51")
    clock.t += 601
    check("expired code -> 404", raises(404, auth.pair_approve, q["user_code"], role="viewer", label="x", approver_id=admin["id"]))
    check("expired poll", auth.pair_poll(q["device_code"]) == "expired")
    for _ in range(5):
        auth.pair_start("192.168.1.52")
    check("max 5 pending codes per IP", raises(429, auth.pair_start, "192.168.1.52"))
    auth._now = time.time


def config():
    check("defaults", auth.get_config()["bypass_role"] == "viewer" and auth.get_config()["bypass_cidrs"] == [])
    check("invalid CIDR -> 422", raises(422, auth.set_config, {"bypass_cidrs": ["nope"]}))
    check("bypass admin -> 422", raises(422, auth.set_config, {"bypass_role": "admin"}))
    check("unknown key -> 422", raises(422, auth.set_config, {"foo": 1}))
    c = auth.set_config({"bypass_cidrs": "192.168.1.7/24\n10.0.0.0/8", "bypass_role": "operator"})
    check("cidrs normalised", c["bypass_cidrs"] == ["192.168.1.0/24", "10.0.0.0/8"] and c["bypass_role"] == "operator", c)
    check("no warning for LAN", auth.config_warnings(c) == [])
    check("warning for loopback", auth.config_warnings({**c, "bypass_cidrs": ["127.0.0.1/32"]}) != [])
    auth.set_config({"bypass_cidrs": [], "bypass_role": "viewer"})


def rate_limiter():
    clock = Clock()
    rl = auth.RateLimiter()
    for _ in range(5):
        rl.fail(("ip", "1.2.3.4"))
    check("5 failures free", rl.check(("ip", "1.2.3.4")) == 0)
    rl.fail(("ip", "1.2.3.4"))
    check("6th -> wait >= 1s", rl.check(("ip", "1.2.3.4")) >= 1)
    for _ in range(30):
        rl.fail(("ip", "1.2.3.4"))
    check("capped at 900s", 0 < rl.check(("ip", "1.2.3.4")) <= 900)
    check("other keys unaffected", rl.check(("ip", "5.6.7.8")) == 0)
    check("max over keys", rl.check(("ip", "5.6.7.8"), ("ip", "1.2.3.4")) > 0)
    rl.ok(("ip", "1.2.3.4"))
    check("ok resets", rl.check(("ip", "1.2.3.4")) == 0)
    auth._now = time.time


def ip_and_bypass():
    cfg = {"bypass_cidrs": ["192.168.1.0/24"], "bypass_role": "viewer"}
    check("LAN peer bypasses", auth.bypass_role("192.168.1.20", {}, cfg) == "viewer")
    check("LAN peer + X-Forwarded-For: no bypass", auth.bypass_role("192.168.1.20", {"X-Forwarded-For": "1.2.3.4"}, cfg) is None)
    check("loopback listed + CF-Connecting-IP: no bypass",
          auth.bypass_role("127.0.0.1", {"cf-connecting-ip": "1.2.3.4"}, {**cfg, "bypass_cidrs": ["127.0.0.0/8"]}) is None)
    check("loopback not listed: no bypass", auth.bypass_role("127.0.0.1", {}, cfg) is None)
    check("IPv4-mapped IPv6 matches", auth.bypass_role("::ffff:192.168.1.20", {}, cfg) == "viewer")
    check("empty list: no bypass", auth.bypass_role("192.168.1.20", {}, {"bypass_cidrs": [], "bypass_role": "viewer"}) is None)
    check("role admin coerced to viewer", auth.bypass_role("192.168.1.20", {}, {**cfg, "bypass_role": "admin"}) == "viewer")

    check("untrusted peer ignores XFF", auth.client_ip("8.8.8.8", {"x-forwarded-for": "1.1.1.1"}, []) == "8.8.8.8")
    tp = ["127.0.0.0/8", "10.0.0.0/8"]
    check("trusted chain -> first untrusted from the right",
          auth.client_ip("127.0.0.1", {"X-Forwarded-For": "6.6.6.6, 9.9.9.9, 10.0.0.2"}, tp) == "9.9.9.9")
    check("CF-Connecting-IP from trusted peer", auth.client_ip("127.0.0.1", {"CF-Connecting-IP": "2.2.2.2"}, tp) == "2.2.2.2")
    check("garbage XFF -> peer", auth.client_ip("127.0.0.1", {"x-forwarded-for": "garbage"}, tp) == "127.0.0.1")
    check("https only from trusted proxy",
          auth.effective_scheme("http", "127.0.0.1", {"x-forwarded-proto": "https"}, tp) == "https"
          and auth.effective_scheme("http", "8.8.8.8", {"x-forwarded-proto": "https"}, tp) == "http")


def cli():
    env = {**os.environ}
    run = lambda *a, inp="": subprocess.run([sys.executable, "app/auth.py", *a], input=inp, capture_output=True,
                                            text=True, env=env)
    auth.create_user("cliuser", "0123456789", "viewer")
    r = run("reset-password", "cliuser", inp="brand-new-password\n")
    check("CLI reset-password via stdin", r.returncode == 0 and auth.authenticate("cliuser", "brand-new-password") is not None,
          r.stderr.strip())
    check("CLI unknown user fails", run("reset-password", "nobody", inp="brand-new-password\n").returncode == 1)
    u = auth.get_user_by_name("cliuser")
    auth.totp_begin(u["id"])
    auth._totp_pending[u["id"]] = ("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", time.time() + 60)
    auth.totp_confirm(u["id"], auth.totp_at("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", int(time.time() // 30)))
    r = run("disable-2fa", "cliuser")
    check("CLI disable-2fa", r.returncode == 0 and not auth.get_user(u["id"])["has_totp"], r.stderr.strip())
    check("CLI list-users", "cliuser" in run("list-users").stdout)
    check("CLI disable-auth needs DELETE", run("disable-auth", inp="nope\n").returncode == 1 and auth.enabled())
    r = run("disable-auth", inp="DELETE\n")
    check("CLI disable-auth", r.returncode == 0 and not auth.enabled(), r.stderr.strip())
    auth.bootstrap_from_env({"SENTINEL_ADMIN_PASSWORD": "from-env-password"})
    check("bootstrap creates admin when empty", (auth.authenticate("admin", "from-env-password") or {}).get("role") == "admin")
    auth.bootstrap_from_env({"SENTINEL_ADMIN_PASSWORD": "another-password!"})
    check("second bootstrap changes nothing", auth.authenticate("admin", "another-password!") is None)


def main():
    admin = users_and_passwords()
    totp_and_recovery(admin)
    bootstrap()
    sessions()
    pairing(admin)
    config()
    rate_limiter()
    ip_and_bypass()
    cli()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
