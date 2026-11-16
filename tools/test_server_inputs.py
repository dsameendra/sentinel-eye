"""Input validation, recorder-clock, lockout-breaker and audit checks for app/server.py, in-process (Starlette
TestClient, no lifespan: no go2rtc, no recorder; the playback service and its reader are faked). Sign-in is off,
so every request is the admin "Operator".

   .venv/bin/python3 tools/test_server_inputs.py
"""
import datetime
import json
import os
import queue
import struct
import sys
import tempfile
import time

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-server-inputs-")
os.environ.pop("SENTINEL_ADMIN_PASSWORD", None)
sys.path.insert(0, "app")
import auth
import recorder_guard
import server
import settings as cfg
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

PASS = []
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


class FakeGo2rtc:
    synced = 0

    def status(self):
        return {}

    def up(self):
        return True

    def sync(self):
        FakeGo2rtc.synced += 1


class FakePlayback:
    def __init__(self):
        self.tz = None
        self.status = {"calibration": {}}
        self.subscriber = None
        self.reloads = []

    def reload(self, connection_changed=True):
        self.reloads.append(connection_changed)

    def health(self):
        return {"reachable": True, "error": None, "live_events": {"connected": False}}

    def wake(self):
        pass


class FakeReader:
    instances = []

    def __init__(self, conn, channel, path, a_const, start_utc, tz, speed="1", adaptive_speeds=None):
        self.args = {"path": path, "start": start_utc, "speed": speed, "adaptive": adaptive_speeds}
        self.speed = speed
        self.calls = []
        self.q = queue.Queue()
        self.waiting_for_slot = False
        FakeReader.instances.append(self)

    def start(self):
        pass

    def seek(self, t, speed=None):
        self.calls.append(("seek", t, speed))

    def set_speed(self, s):
        self.calls.append(("speed", s))

    def hold(self):
        self.calls.append(("hold",))

    def resume(self):
        self.calls.append(("resume",))

    def stop(self):
        self.q.put(None)


PW = "s3cret-recorder-pw"
server.state["go2rtc"] = FakeGo2rtc()
server.state["playback"] = pb = FakePlayback()
server.state["settings"] = cfg.Settings(
    connection=cfg.Connection(host="10.0.0.9", username="admin", password=PW),
    channels=[cfg.Channel(id="c1", channel=1, main_path="/live/hd", playback_path="/custom/tracks/101"),
              cfg.Channel(id="c2", channel=2)])
server.db.init()
c = TestClient(server.app, follow_redirects=False, raise_server_exceptions=False)


def audit_actions():
    return [a["action"] for a in c.get("/api/auth/admin/audit?limit=1000").json()]


def last_audit(action):
    return next((a for a in c.get("/api/auth/admin/audit?limit=1000").json() if a["action"] == action), None)


def ws_close(url):
    try:
        with c.websocket_connect(url) as ws:
            m = ws.receive()
            if m.get("type") == "websocket.send":
                return json.loads(m["text"])
            return m.get("code")
    except WebSocketDisconnect as e:
        return e.code


def now_iso(sec_ago=600):
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=sec_ago)).isoformat().replace("+00:00", "Z")


# --------------------------------------------------------------------------- item 1: playback WebSocket

def playback_ws_inputs():
    pb.tz = None
    start = now_iso()
    check("ws: an unknown speed is refused at connect (1008)", ws_close(f"/api/playback/ws?channel=c1&start={start}&speed=3") == 1008)
    check("ws: a header-injection speed is refused (1008)",
          ws_close(f"/api/playback/ws?channel=c1&start={start}&speed=1%0D%0AX-Evil:%201") == 1008)
    check("ws: a non-ISO start is refused (1008)", ws_close("/api/playback/ws?channel=c1&start=yesterday&speed=1") == 1008)
    check("ws: valid inputs get past validation (uncalibrated here: 4409)",
          ws_close(f"/api/playback/ws?channel=c1&start={start}&speed=0.125") == 4409)

    orig = (server.psess.PlaybackReader, server.psess.calibration_for_time)
    server.psess.PlaybackReader = FakeReader
    server.psess.calibration_for_time = lambda ch, t: 1.0
    pb.tz = IST
    try:
        FakeReader.instances.clear()
        with c.websocket_connect(f"/api/playback/ws?channel=c1&start={start}&speed=2") as ws:
            t_ok = now_iso(1200)
            for msg in ({"type": "seek", "t": "not a time"}, {"type": "seek", "t": t_ok, "scale": "1\r\nX: y"},
                        {"type": "seek", "t": t_ok}, {"type": "seek", "t": t_ok, "scale": "4"},
                        {"type": "speed", "scale": "3"}, {"type": "speed"}, {"type": "speed", "scale": "8"},
                        {"type": "speed", "scale": 0.5}, {"type": "hold"}, {"type": "resume"}, ["not", "an", "object"]):
                ws.send_text(json.dumps(msg))
            time.sleep(0.4)
        r = FakeReader.instances[0]
        norm = datetime.datetime.fromisoformat(t_ok.replace("Z", "+00:00")).isoformat()
        check("ws: playback uses the channel's playback_path override, not the live main_path", r.args["path"] == "/custom/tracks/101", r.args)
        check("ws: start handed on normalised", r.args["start"] == datetime.datetime.fromisoformat(start.replace("Z", "+00:00")).isoformat(), r.args)
        check("ws: messages validated (bad time ignored, bad scale dropped, bad speed ignored, numbers canonical)",
              r.calls == [("seek", norm, None), ("seek", norm, None), ("seek", norm, "4"), ("speed", "8"), ("speed", "0.5"), ("hold",), ("resume",)], r.calls)
        check("ws: a feed faster than 1x is asked for adaptively (the fastest the budget allows, down to 1x)",
              r.args["adaptive"] == ["1", "2"], r.args)
        c2 = cfg.Settings(**server.state["settings"].model_dump())
        c2.channels[1].playback_path = ""
        FakeReader.instances.clear()
        with c.websocket_connect(f"/api/playback/ws?channel=c2&start={start}&speed=1"):
            pass
        check("ws: no override -> the standard recording track", FakeReader.instances[0].args["path"] == "/Streaming/tracks/201",
              FakeReader.instances[0].args)

        # Segment metadata: "playing" before the first frame (codec, where the times come from, display_from),
        # "segment" before the first frame after a seek; frame headers unchanged (byte 0 = keyframe, then time).
        FakeReader.instances.clear()
        seg1 = {"codec": "h264", "time_source": "calibration", "approx": False, "display_from": 1000.0,
                "first_utc": 990.5, "bound_s": 1.6, "target": 1000.0, "_a": 1.0, "_offset": 0.0}
        seg2 = dict(seg1, time_source="anchor", approx=True, display_from=2000.0, first_utc=2000.0, bound_s=None)
        with c.websocket_connect(f"/api/playback/ws?channel=c1&start={start}&speed=1") as ws:
            q = FakeReader.instances[0].q
            for f in (server.psess.Frame(990.5, True, b"\x00\x00\x00\x01\x65", seg1, True),
                      server.psess.Frame(990.5 + 1 / 15, False, b"\x00\x00\x00\x01\x41", seg1, True),
                      server.psess.Frame(2000.0, True, b"\x00\x00\x00\x01\x65", seg2, False)):
                q.put(f)
            q.put(("feed", {"scale": "2", "hold": True}))
            m1, b1, b2, m2, b3, m3 = (ws.receive_json(), ws.receive_bytes(), ws.receive_bytes(), ws.receive_json(),
                                      ws.receive_bytes(), ws.receive_json())
        check("ws: 'playing' carries the segment (no private fields) and the feed speed the session got",
              m1 == {"type": "playing", "codec": "h264", "time_source": "calibration", "approx": False,
                     "display_from": 1000.0, "first_utc": 990.5, "bound_s": 1.6, "scale": "1"}, m1)
        check("ws: a feed change is passed on as a 'feed' message", m3 == {"type": "feed", "scale": "2", "hold": True}, m3)
        check("ws: frame header unchanged (keyframe flag, then the recorded time)",
              b1[0] == 1 and struct.unpack(">d", b1[1:9])[0] == 990.5 and b1[9:] == b"\x00\x00\x00\x01\x65" and b2[0] == 0, b1[:9])
        check("ws: a new segment is announced before its first frame",
              m2.get("type") == "segment" and m2.get("approx") is True and m2.get("display_from") == 2000.0 and b3[0] == 1, m2)

        recorder_guard.trip(recorder_guard.fingerprint("10.0.0.9", "admin", PW), "test")
        FakeReader.instances.clear()
        got = ws_close(f"/api/playback/ws?channel=c1&start={start}&speed=1")
        check("ws: breaker tripped -> a clear error, no reader (no login)",
              isinstance(got, dict) and got.get("message") == recorder_guard.MESSAGE and not FakeReader.instances, got)
    finally:
        recorder_guard.clear()
        server.psess.PlaybackReader, server.psess.calibration_for_time = orig


# --------------------------------------------------------------------------- items 7, 9: clock, limits, bodies

def thumbnails_and_clock():
    pb.tz = None
    server.db.upsert_event("dvr-live", 1, "motion", "2026-03-01T10:00:00+00:00", "2026-03-01T10:00:05+00:00")
    eid = server.db.query("SELECT id FROM events ORDER BY id DESC LIMIT 1")[0]["id"]
    r = c.get(f"/api/timeline/events/{eid}/thumbnail")
    check("thumbnail: unknown recorder clock -> 503, never a guessed offset", r.status_code == 503 and r.json()["detail"] == server.TZ_UNKNOWN, r.text)
    pb.tz = IST
    recorder_guard.trip(recorder_guard.fingerprint("10.0.0.9", "admin", PW), "test")
    r = c.get(f"/api/timeline/events/{eid}/thumbnail")
    check("thumbnail: breaker tripped -> 503 with the fix-it message", r.status_code == 503 and r.json()["detail"] == recorder_guard.MESSAGE, r.text)
    snap = os.path.join(os.environ["SENTINEL_DATA"], "thumb.jpg")
    with open(snap, "wb") as f:
        f.write(b"\xff\xd8\xff\xe0fakejpeg")
    server.db.write("UPDATE events SET snapshot_path=? WHERE id=?", (snap, eid))
    r = c.get(f"/api/timeline/events/{eid}/thumbnail")
    check("thumbnail: a cached one is still served while blocked", r.status_code == 200, r.status_code)
    check("thumbnail: Cache-Control is private", r.headers.get("cache-control") == "private, max-age=604800", r.headers.get("cache-control"))
    recorder_guard.clear()
    check("tz endpoint: ready with the recorder's offset", c.get("/api/timeline/tz").json() == {"offset_minutes": 330, "ready": True})
    pb.tz = None
    check("tz endpoint: not ready -> says so", c.get("/api/timeline/tz").json()["ready"] is False)


def limits_and_bookmarks():
    for url in ("/api/timeline/events?limit=999999", "/api/timeline/events?limit=-3", "/api/bookmarks?limit=999999",
                "/api/bookmarks?limit=0", "/api/auth/admin/audit?limit=999999", "/api/auth/admin/audit?limit=-1"):
        r = c.get(url)
        check(f"limit clamped, not an error: {url}", r.status_code == 200, r.status_code)
    for i in range(3):
        server.db.upsert_event("dvr-log", 9, "line", f"2026-04-0{i + 1}T00:00:00+00:00", f"2026-04-0{i + 1}T00:00:00+00:00")
    check("limit: 0 still returns at least one row", len(c.get("/api/timeline/events?channel=9&limit=0").json()) == 1)

    base = {"channels": ["c1"], "time_utc": "2026-09-28T10:00:00.000Z"}
    for name, extra in (("unknown severity", {"severity": "urgent"}), ("non-ISO time", {"time_utc": "next tuesday"}),
                        ("title over 200", {"title": "x" * 201}), ("note over 4000", {"note": "x" * 4001})):
        r = c.post("/api/bookmarks", json={**base, **extra})
        check(f"bookmark: {name} -> 422", r.status_code == 422, r.status_code)
    r = c.post("/api/bookmarks", json={**base, "title": "Gate", "severity": "critical"})
    check("bookmark: valid one created", r.status_code == 200, r.text)
    bid = r.json()["id"]
    stored = c.get("/api/bookmarks").json()[0]
    check("bookmark: time stored normalised to UTC +00:00", stored["time_utc"] == "2026-09-28T10:00:00+00:00", stored["time_utc"])
    a = last_audit("bookmark.create")
    check("audit: bookmark created (by whom, which)", a and a["target"] == str(bid) and a["actor"] == "Operator"
          and a["detail"]["severity"] == "critical", a)
    c.delete(f"/api/bookmarks/{bid}")
    check("audit: bookmark deleted", (last_audit("bookmark.delete") or {}).get("target") == str(bid))


def enhance_body_caps():
    orig = server.MAX_ENHANCE_BODY
    server.MAX_ENHANCE_BODY = 4096
    try:
        r = c.post("/api/enhance", json={"channel": 1, "images": ["A" * 5000]})
        check("enhance: an oversized body is refused with 413", r.status_code == 413, r.status_code)

        def chunks():
            for _ in range(10):
                yield b"A" * 1000
        r = c.post("/api/enhance", content=chunks(), headers={"Content-Type": "application/json"})
        check("enhance: ...also when streamed without a Content-Length", r.status_code == 413, r.status_code)
    finally:
        server.MAX_ENHANCE_BODY = orig
    r = c.post("/api/enhance", json={"channel": 1, "images": ["x"] * 12})
    check("enhance: more than 11 frames -> 422", r.status_code == 422, r.status_code)
    r = c.post("/api/enhance", content=b"{not json", headers={"Content-Type": "application/json"})
    check("enhance: malformed JSON -> 422", r.status_code == 422, r.status_code)
    r = c.post("/api/enhance", json={"channel": "one", "images": "nope"})
    check("enhance: wrong shape -> 422 with field errors", r.status_code == 422 and isinstance(r.json()["detail"], list), r.text[:200])
    f = server.EnhanceRequest.model_fields["images"]
    check("enhance: each frame is capped (~25 MB of base64)", "max_length=26214400" in repr(f.annotation) or "26214400" in repr(f), repr(f)[:200])


def exports():
    started = []
    orig = server.exportmod.start_export
    server.exportmod.start_export = lambda *a: started.append(a)
    try:
        body = {"channels": ["c1"], "start_utc": "2026-05-01T10:00:00", "end_utc": "2026-05-01T10:05:00Z"}
        pb.tz = None
        r = c.post("/api/export", json=body)
        check("export: naive vs aware times don't 500", r.status_code != 500, r.status_code)
        check("export: unknown recorder clock -> 503", r.status_code == 503 and r.json()["detail"] == server.TZ_UNKNOWN, r.text)
        pb.tz = IST
        recorder_guard.trip(recorder_guard.fingerprint("10.0.0.9", "admin", PW), "test")
        r = c.post("/api/export", json=body)
        check("export: breaker tripped -> 503 with the fix-it message", r.status_code == 503 and r.json()["detail"] == recorder_guard.MESSAGE)
        recorder_guard.clear()
        r = c.post("/api/export", json=body)
        check("export: accepted", r.status_code == 200, r.text)
        job_id, chans, start, end, package = started[0][0], started[0][1], started[0][2], started[0][3], started[0][4]
        check("export: times normalised to aware UTC (naive taken as UTC)",
              (start, end) == ("2026-05-01T10:00:00+00:00", "2026-05-01T10:05:00+00:00"), (start, end))
        check("export: the recorder's real offset is passed, with the playback path override",
              chans[0]["_tz_offset_min"] == 330 and chans[0]["playback_path"] == "/custom/tracks/101", chans[0])
        a = last_audit("export.create")
        check("audit: export created (channels, range, package)", a and a["target"] == job_id and a["detail"]["channels"] == [1]
              and a["detail"]["package"] == "signed" and a["detail"]["start_utc"] == start, a)
        r = c.post("/api/export", json={**body, "end_utc": "2026-05-01T09:00:00Z"})
        check("export: end before start -> 422", r.status_code == 422)
    finally:
        server.exportmod.start_export = orig

    server.exportmod.EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    (server.exportmod.EXPORT_DIR / "job1.zip").write_bytes(b"PK")
    orig_get = server.exportmod.get_job
    server.exportmod.get_job = lambda jid: {"state": "done", "download": "job1.zip", "package": "signed"}
    try:
        r = c.get("/api/export/job1/download")
        check("export download served", r.status_code == 200)
        check("audit: export downloaded", (last_audit("export.download") or {}).get("target") == "job1")
    finally:
        server.exportmod.get_job = orig_get

    # Cancel: running -> 200 + audited; finished -> 409; unknown -> 404. The signing key route is not swallowed by
    # /api/export/{job_id} (declared first).
    orig_cancel = server.exportmod.cancel_job
    server.exportmod.cancel_job = lambda jid: {"run1": "cancelling", "done1": "done"}.get(jid)
    try:
        r = c.delete("/api/export/run1")
        check("export cancel: running job -> 200 cancelling", r.status_code == 200 and r.json()["state"] == "cancelling", r.text)
        check("audit: export cancelled", (last_audit("export.cancel") or {}).get("target") == "run1")
        check("export cancel: finished job -> 409", c.delete("/api/export/done1").status_code == 409)
        check("export cancel: unknown job -> 404", c.delete("/api/export/nope").status_code == 404)
    finally:
        server.exportmod.cancel_job = orig_cancel
    r = c.get("/api/export/signing-key")
    k = r.json() if r.status_code == 200 else {}
    check("export signing key: hex + fingerprint (not treated as a job id)", r.status_code == 200 and len(k.get("public_key_hex", "")) == 64
          and k.get("fingerprint") == server.exportmod.key_fingerprint(k["public_key_hex"]), r.text[:200])


def export_module_requires_offset():
    import export as exportmod
    orig = exportmod.psess.calibration_for_time
    exportmod.psess.calibration_for_time = lambda ch, t: 1.0
    try:
        exportmod._export_one_channel(None, {"channel": 1}, "2026-05-01T10:00:00+00:00", "2026-05-01T10:01:00+00:00",
                                      server.state["settings"].connection.model_dump())
        check("export.py: a missing recorder offset is refused (no +05:30 default)", False)
    except RuntimeError as e:
        check("export.py: a missing recorder offset is refused (no +05:30 default)", "clock" in str(e), e)
    finally:
        exportmod.psess.calibration_for_time = orig


# --------------------------------------------------------------------------- items 2, 10: breaker routes, audit

def breaker_routes_and_settings_audit():
    st = c.get("/api/status").json()
    check("status: recorder_auth_failed false normally", st.get("recorder_auth_failed") is False, st)
    recorder_guard.trip(recorder_guard.fingerprint("10.0.0.9", "admin", PW), "test")
    check("status: recorder_auth_failed true while tripped", c.get("/api/status").json()["recorder_auth_failed"] is True)
    pb.reloads.clear()
    r = c.post("/api/recorder/retry")
    check("retry: clears the breaker and reloads the playback service",
          r.status_code == 200 and r.json()["was_blocked"] is True and not recorder_guard.tripped() and pb.reloads == [False], (r.text, pb.reloads))
    check("audit: retry recorded", (last_audit("recorder.retry") or {}).get("detail", {}).get("was_blocked") is True)

    recorder_guard.trip(recorder_guard.fingerprint("10.0.0.9", "admin", PW), "test")
    s = c.get("/api/settings").json()
    s["connection"]["password"] = "a-new-pw-value"
    s["channels"][1]["name"] = "Back gate"
    pb.reloads.clear()
    r = c.put("/api/settings", json=s)
    check("settings save: ok", r.status_code == 200, r.text[:200])
    check("settings save: clears the breaker", not recorder_guard.tripped())
    check("settings save: reloads the playback service (a new password: same recorder, index kept)", pb.reloads == [False], pb.reloads)
    a = last_audit("settings.update")
    check("audit: settings saved, naming the sections and connection fields changed",
          a and {"connection", "channels"} <= set(a["detail"]["sections"]) and a["detail"]["connection_fields"] == ["password"], a)
    dump = json.dumps(c.get("/api/auth/admin/audit?limit=1000").json())
    check("audit: never a password value", "a-new-pw-value" not in dump and PW not in dump)
    pb.reloads.clear()
    s = c.get("/api/settings").json()
    s["connection"]["host"] = "10.0.0.10"
    c.put("/api/settings", json=s)
    check("settings save: another recorder (host) starts the coverage index over", pb.reloads == [True], pb.reloads)
    s["connection"]["host"] = "10.0.0.9"
    s["connection"]["password"] = PW
    c.put("/api/settings", json=s)
    pb.reloads.clear()
    s = c.get("/api/settings").json()
    s["display"]["fit"] = "cover"
    c.put("/api/settings", json=s)
    check("settings save: display-only change doesn't reload the service", pb.reloads == [], pb.reloads)
    s["channels"][0]["playback_path"] = "bad path"
    check("settings: a playback path must start with /", c.put("/api/settings", json=s).status_code == 422)
    s["channels"][0]["playback_path"] = "/tracks/1 RTSP/1.0"
    check("settings: no spaces in a stream path", c.put("/api/settings", json=s).status_code == 422)


def model_download_audit():
    em = server.enhance_models
    orig = (em._engine_ready, em.download_in_background)
    em._engine_ready = lambda kind, mid: (True, "")
    em.download_in_background = lambda kind, mid: None
    try:
        mid = next(iter(em.UPSCALERS))
        r = c.post("/api/enhance/models/download", json={"kind": "upscaler", "id": mid})
        check("model download started", r.status_code == 200, r.text)
        check("audit: model download recorded", (last_audit("model.download") or {}).get("target") == f"upscaler:{mid}")
    finally:
        em._engine_ready, em.download_in_background = orig


def main():
    playback_ws_inputs()
    thumbnails_and_clock()
    limits_and_bookmarks()
    enhance_body_caps()
    exports()
    export_module_requires_offset()
    breaker_routes_and_settings_audit()
    model_download_audit()
    recorder_guard.clear()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
