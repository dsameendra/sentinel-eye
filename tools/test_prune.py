"""Pruning, retention and recorder-health checks for app/playback_service.py, with the recorder faked out (no
real device; a scratch SENTINEL_DATA).

Pruning drops recorder events (dvr-live / dvr-log), their thumbnails and cached coverage from before the oldest
recording minus a margin — but only once a full coverage pass has established that oldest day for certain, never
bookmarks or other sources, and never calibration_history (timebase.regimes needs all of it).

   .venv/bin/python3 tools/test_prune.py
"""
import datetime
import json
import os
import sys
import tempfile
import time
import urllib.error

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-prune-")
sys.path.insert(0, "app")
import coverage
import db
import playback_service
import settings as cfg
import thumbnails

PASS = []
UTC = datetime.timezone.utc
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


class Patch:
    def __init__(self, *triples):
        self.triples, self.saved = triples, []

    def __enter__(self):
        for mod, name, val in self.triples:
            self.saved.append((mod, name, getattr(mod, name)))
            setattr(mod, name, val)
        return self

    def __exit__(self, *a):
        for mod, name, val in reversed(self.saved):
            setattr(mod, name, val)


def service(channels=(1, 2)):
    s = cfg.Settings(connection=cfg.Connection(host="10.0.0.9", username="admin", password="pw"),
                     channels=[cfg.Channel(id=f"c{n}", channel=n) for n in channels])
    svc = playback_service.PlaybackService(lambda: s)
    svc.tz = IST
    return svc


def iso(dt):
    return dt.astimezone(UTC).isoformat()


def reset_db():
    for t in ("events", "coverage_days", "bookmarks", "calibration_history"):
        db.write(f"DELETE FROM {t}")


def seed(today):
    """Events on channels 1 and 2 at several ages; returns {name: id}."""
    ids = {}
    day = lambda n, h=12: datetime.datetime.combine(today - datetime.timedelta(days=n), datetime.time(h), tzinfo=IST)
    for name, src, ch, n in (("old1", "dvr-log", 1, 50), ("old_live", "dvr-live", 1, 46), ("margin1", "dvr-log", 1, 41),
                             ("new1", "dvr-log", 1, 10), ("old2", "dvr-log", 2, 50), ("ai_old", "live-ai", 1, 50)):
        t = day(n)
        db.upsert_event(src, ch, "motion", iso(t), iso(t + datetime.timedelta(seconds=20)))
        ids[name] = db.one("SELECT id FROM events WHERE channel=? AND start_utc=? AND source=?", (ch, iso(t), src))["id"]
    bid = db.create_bookmark([1], iso(day(55)), "Old gate", "", "info", "Operator")
    ids["bookmark"] = bid
    for ch in (1, 2):
        for n in (60, 50, 44, 42, 41, 5):
            db.write("INSERT OR REPLACE INTO coverage_days(channel, day, spans_json, refreshed_utc) VALUES (?,?,?,?)",
                     (ch, (today - datetime.timedelta(days=n)).isoformat(), "[]", iso(datetime.datetime.now(UTC))))
    db.write("INSERT INTO calibration_history(channel, a_const, measured_utc) VALUES (1, 100.0, ?)", (iso(day(80)),))
    return ids


def make_thumb(event_id, age_s):
    thumbnails.THUMB_DIR.mkdir(parents=True, exist_ok=True)
    p = thumbnails.THUMB_DIR / f"{event_id}.jpg"
    p.write_bytes(b"\xff\xd8synthetic")
    t = time.time() - age_s
    os.utime(p, (t, t))
    db.write("UPDATE events SET snapshot_path=? WHERE id=?", (str(p), event_id))
    return p


def remaining():
    return {r["id"] for r in db.query("SELECT id FROM events")}


def prune_waits_for_a_full_pass():
    reset_db()
    today = datetime.datetime.now(IST).date()
    ids = seed(today)
    s = service()
    s._cov["earliest"] = {1: today - datetime.timedelta(days=43)}
    s._cov["certain"] = {1: True}
    check("prune: nothing before a full coverage pass", s.prune_pass() is False and len(remaining()) == len(ids) + 0,
          s.status["prune"])
    check("prune: says why it waits", "waiting" in s.status["prune"])


def prune_removes_only_unplayable_dvr_events():
    reset_db()
    today = datetime.datetime.now(IST).date()
    ids = seed(today)
    old_thumb = make_thumb(ids["old1"], 7200)
    keep_thumb = make_thumb(ids["new1"], 7200)
    orphan_old = thumbnails.THUMB_DIR / "999999.jpg"
    orphan_old.write_bytes(b"x")
    os.utime(orphan_old, (time.time() - 7200,) * 2)
    orphan_fresh = thumbnails.THUMB_DIR / "999998.jpg"
    orphan_fresh.write_bytes(b"x")   # just written; its row may be about to point at it
    outside = thumbnails.THUMB_DIR.parent / "not-a-thumb.jpg"
    outside.write_bytes(b"x")
    s = service()
    earliest = today - datetime.timedelta(days=43)
    s._cov.update({"earliest": {1: earliest, 2: earliest}, "certain": {1: True, 2: False}, "pass_ok": True})
    done = s.prune_pass()
    left = remaining()
    check("prune: runs after a full pass", done is True, s.status["prune"])
    check("prune: dvr-log older than oldest day - 2 removed", ids["old1"] not in left)
    check("prune: dvr-live older than the cut-off removed", ids["old_live"] not in left)
    check("prune: within the 2-day margin kept", ids["margin1"] in left)
    check("prune: newer events kept", ids["new1"] in left)
    check("prune: a channel whose oldest day isn't certain is left alone", ids["old2"] in left)
    check("prune: other sources (live-ai) never pruned", ids["ai_old"] in left)
    bm_rows = db.query("SELECT id FROM events WHERE kind='bookmark'")
    check("prune: bookmarks and their timeline rows kept", db.get_bookmark(ids["bookmark"]) and len(bm_rows) == 1)
    check("prune: pruned event's thumbnail removed", not old_thumb.exists())
    check("prune: kept event's thumbnail kept", keep_thumb.exists())
    check("prune: old orphan thumbnail removed", not orphan_old.exists())
    check("prune: fresh orphan thumbnail kept (may be mid-write)", orphan_fresh.exists())
    check("prune: never touches files outside data/thumbnails", outside.exists())
    days1 = [r["day"] for r in db.query("SELECT day FROM coverage_days WHERE channel=1 ORDER BY day")]
    cut = (earliest - datetime.timedelta(days=2)).isoformat()
    check("prune: coverage before the cut-off removed (certain channel)", all(d >= cut for d in days1) and len(days1) == 4, days1)
    check("prune: coverage kept for the uncertain channel",
          len(db.query("SELECT day FROM coverage_days WHERE channel=2")) == 6)
    check("prune: calibration_history never pruned", len(db.query("SELECT id FROM calibration_history")) == 1)
    st = s.status["prune"]
    check("prune: counts reported", st["events_removed"] == 2 and st["thumbnails_removed"] == 2
          and st["coverage_days_removed"] == 2 and st["skipped_channels"] == [2], st)


def prune_after_reload_waits_again():
    s = service()
    s._cov.update({"earliest": {1: datetime.date.today()}, "certain": {1: True}, "pass_ok": True})
    s.reload(connection_changed=True)
    check("prune: a different recorder resets what's known (waits for a new pass)", s.prune_pass() is False)


def earliest_checked():
    class Api:
        def __init__(self, answers):
            self.answers = answers   # (year, month) -> (status, days)

        def call(self, path, method, body):
            import re
            y = int(re.search(r"<year>(\d+)", body).group(1))
            m = int(re.search(r"<monthOfYear>(\d+)", body).group(1))
            st, days = self.answers.get((y, m), (200, []))
            out = "".join(f"<day><dayOfMonth>{d}</dayOfMonth><record>true</record></day>" for d in days)
            return st, out
    today = datetime.datetime.now(IST).date()
    prev = (today.replace(day=1) - datetime.timedelta(days=1))
    r = coverage.earliest_recorded_day_checked(Api({(prev.year, prev.month): (200, [3, 4])}), 1, IST)
    check("earliest: found and certain", r == {"day": prev.replace(day=3), "certain": True}, r)
    two = (prev.replace(day=1) - datetime.timedelta(days=1))
    r = coverage.earliest_recorded_day_checked(Api({(prev.year, prev.month): (200, [3]), (two.year, two.month): (500, [])}), 1, IST)
    check("earliest: a refused month makes it uncertain", r["day"] == prev.replace(day=3) and r["certain"] is False, r)
    m = today.replace(day=1)
    for _ in range(5):
        m = (m - datetime.timedelta(days=1)).replace(day=1)
    r = coverage.earliest_recorded_day_checked(Api({(m.year, m.month): (200, [9])}), 1, IST)
    check("earliest: a first day in the oldest month probed is uncertain", r["day"] == m.replace(day=9) and not r["certain"], r)


def coverage_pass_tracks_oldest_and_reprobes():
    reset_db()
    s = service(channels=(1,))
    today = datetime.datetime.now(IST).date()
    first = today - datetime.timedelta(days=3)
    probes = []
    spans_by_day = {first: [], first + datetime.timedelta(days=1): [["2026-01-01T00:00:05+00:00", "2026-01-01T01:00:00+00:00"]]}

    def checked(api, ch, tz, probe_months=6):
        probes.append(ch)
        return {"day": first if len(probes) == 1 else first + datetime.timedelta(days=1), "certain": True}

    def refresh(api, ch, day, tz):
        return spans_by_day.get(day, [["2026-01-02T00:00:00+00:00", "2026-01-02T00:10:00+00:00"]])

    with Patch((coverage, "earliest_recorded_day_checked", checked), (coverage, "refresh_day", refresh)):
        s._coverage_pass()
    check("coverage: an emptied oldest day re-probes the first recorded day", len(probes) == 2, probes)
    check("coverage: pass marks the oldest day as established", s._cov["pass_ok"])
    with Patch((coverage, "earliest_recorded_day_checked", checked), (coverage, "refresh_day", refresh)):
        s._coverage_pass()
    ret = s.retention()
    check("retention: oldest instant from the oldest day's own spans",
          ret[1]["oldest_utc"] == "2026-01-01T00:00:05+00:00" and ret[1]["days"] > 100, ret)
    s._cov["certain"][1] = False
    check("retention: unknown unless certain", s.retention()[1] == {"oldest_utc": None, "oldest_day": None, "days": None})


def health_summary():
    reset_db()
    s = service(channels=(1, 2))
    h = s.health()
    check("health: unknown before any contact", h["reachable"] is None, h)
    s._note_fail(urllib.error.URLError(ConnectionRefusedError(61, "Connection refused")))
    h = s.health()
    check("health: a refused connection reads as unreachable, with why", h["reachable"] is False and "refused" in (h["error"] or ""), h)
    s._note_fail(urllib.error.HTTPError("http://x", 503, "busy", {}, None))
    check("health: an HTTP error answer is not 'unreachable'", s._contact["error"] and "HTTPError" not in s._contact["error"])
    time.sleep(0.01)
    s._note_ok()
    check("health: a later answer makes it reachable again", s.health()["reachable"] is True)
    db.set_calibration(1, 1000.0, 0.15, "osd_tick")
    db.set_calibration(2, 1000.0, 0.15, "fallback_requested_time")
    s.status["calibration"][1] = {}
    h = s.health()
    check("health: calibration in plain states", h["calibration"][1]["state"] == "ok"
          and h["calibration"][2]["state"] == "approximate", h["calibration"])
    s.status["calibration"][1] = {"last_error": "no tick"}
    db.write("UPDATE calibration SET measured_utc=? WHERE channel=1",
             (iso(datetime.datetime.now(UTC) - datetime.timedelta(hours=20)),))
    check("health: an old calibration that keeps failing reads as failed", s.health()["calibration"][1]["state"] == "failed")
    check("health: recorder UTC offset in minutes", s.health()["utc_offset_minutes"] == 330)
    db.set_watermark("Alarm", "2026-11-10")
    db.set_watermark("Exception", "2026-11-12")
    check("health: event history synced through the earlier watermark", s.health()["history"]["through_day"] == "2026-11-10")
    check("health: never includes credentials", "pw" not in json.dumps(s.health()).replace("approximate", ""), s.health())


def main():
    db.init()
    prune_waits_for_a_full_pass()
    prune_removes_only_unplayable_dvr_events()
    prune_after_reload_waits_again()
    earliest_checked()
    coverage_pass_tracks_oldest_and_reprobes()
    health_summary()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
