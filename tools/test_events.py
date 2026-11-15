"""Event-ingest checks for app/events.py and the event parts of app/db.py, against a fake recorder (no device):

- a refused log request raises instead of returning a partial day, and the watermark stays put
- today is re-fetched on every backfill pass (events from while the server was off appear), never watermarked
- an event crossing midnight stays one span, within a pass and across passes (persisted carry)
- a capped day fetched hour by hour is stitched as one window (no split at hour boundaries)
- the same DVR event arriving live and from the log is stored once, and old duplicates are cleaned up once
- the alertStream subscriber keeps an event's start across repeated "active" notifications, closes a stale one
  at its last-seen time, and doesn't log in while the lockout breaker is tripped
- tz_local raises on a refused or garbled clock answer instead of assuming UTC

   .venv/bin/python3 tools/test_events.py
"""
import datetime
import os
import re
import sys
import tempfile
import threading
import time

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-events-")
sys.path.insert(0, "app")
import db
import events
import isapi
import recorder_guard

PASS = []
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
UTC = datetime.timezone.utc
events.RATE_DELAY = 0


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


class FakeLogDvr:
    """Answers logSearch like the recorder: filters by the (DVR-local, 'Z'-mislabelled) window, pages by
    maxResults/searchResultPostion, and silently truncates any one query at LOG_CAP entries."""

    def __init__(self, entries=(), fail_on=None):
        self.entries = list(entries)   # (local naive datetime, major, name, channel)
        self.fail_on = fail_on          # callable(call_no, body) -> HTTP status to fail with, or None
        self.calls = 0
        self.fp = "fake"

    def call(self, path, method="GET", body=None, timeout=None):
        self.calls += 1
        if self.fail_on:
            st = self.fail_on(self.calls, body)
            if st:
                return st, "<ResponseStatus><statusCode>4</statusCode></ResponseStatus>"
        g = lambda tag: re.search(f"<{tag}>(.*?)</{tag}>", body).group(1)
        t0 = datetime.datetime.fromisoformat(g("startTime").rstrip("Z"))
        t1 = datetime.datetime.fromisoformat(g("endTime").rstrip("Z"))
        major = re.search(r"log\.hikvision\.com/(\w+)</metaId>", body).group(1)
        pos, n = int(g("searchResultPostion")), int(g("maxResults"))
        match = sorted(e for e in self.entries if e[1] == major and t0 <= e[0] <= t1)[:events.LOG_CAP]
        page = match[pos:pos + n]
        more = pos + n < len(match)
        xml = "".join(f"<logDescriptor><metaId>log.hikvision.com/{m}/{name}/{ch}</metaId>"
                      f"<StartDateTime>{t.strftime('%Y-%m-%dT%H:%M:%SZ')}</StartDateTime></logDescriptor>"
                      for t, m, name, ch in page)
        status = "MORE" if more else ("OK" if page else "NO MATCHES")
        return 200, f"<CMSearchResult><responseStatusStrg>{status}</responseStatusStrg><matchList>{xml}</matchList></CMSearchResult>"

    def get(self, path, **kw):
        return self.call(path, "GET", **kw)


def reset():
    for t in ("events", "backfill_watermark", "backfill_open"):
        db.write(f"DELETE FROM {t}")


def rows(where="1=1", params=()):
    return [dict(r) for r in db.query(f"SELECT * FROM events WHERE {where} ORDER BY start_utc, id", params)]


def utc_iso(local_naive):
    return local_naive.replace(tzinfo=IST).astimezone(UTC).isoformat()


def today_ist():
    return datetime.datetime.now(IST).date()


def at(day, h, m=0, s=0):
    return datetime.datetime.combine(day, datetime.time(h, m, s))


# --------------------------------------------------------------------------- tz

def tz_local_checks():
    class Api:
        def __init__(self, st, body):
            self.st, self.body = st, body

        def get(self, path, **kw):
            return self.st, self.body
    try:
        events.tz_local(Api(401, "Unauthorized"))
        check("tz_local: a refused answer raises (no UTC guess)", False)
    except isapi.DvrRequestError:
        check("tz_local: a refused answer raises (no UTC guess)", True)
    try:
        events.tz_local(Api(200, "<Time>garbled</Time>"))
        check("tz_local: an answer without localTime raises", False)
    except ValueError:
        check("tz_local: an answer without localTime raises", True)
    tz = events.tz_local(Api(200, "<Time><localTime>2026-11-15T10:00:00+05:30</localTime></Time>"))
    check("tz_local: reads the recorder's offset", tz.utcoffset(None) == datetime.timedelta(hours=5, minutes=30))


# --------------------------------------------------------------------------- backfill

def failed_request_keeps_watermark():
    reset()
    day = today_ist() - datetime.timedelta(days=3)
    entries = [(at(day, 1, i // 60, i % 60), "Alarm", "motionStart", 1) for i in range(150)]
    api = FakeLogDvr(entries, fail_on=lambda n, body: 503 if n == 2 else None)   # page 2 of the first day fails
    db.set_watermark("Alarm", (day - datetime.timedelta(days=1)).isoformat())
    try:
        events.fetch_day(FakeLogDvr(entries, fail_on=lambda n, b: 503 if n == 2 else None), "Alarm",
                         datetime.datetime.combine(day, datetime.time(0), tzinfo=IST), IST)
        check("fetch_day: a refused page raises", False)
    except isapi.DvrRequestError as e:
        check("fetch_day: a refused page raises", "503" in str(e), e)
    try:
        events.backfill_major(api, "Alarm", IST)
        check("backfill: a refused page raises", False)
    except isapi.DvrRequestError:
        check("backfill: a refused page raises", True)
    check("backfill: watermark not advanced past the half-fetched day", db.get_watermark("Alarm") == (day - datetime.timedelta(days=1)).isoformat(),
          db.get_watermark("Alarm"))
    try:
        events.fetch_hour(FakeLogDvr(entries, fail_on=lambda n, b: 500), "Alarm",
                          datetime.datetime.combine(day, datetime.time(1), tzinfo=IST), IST)
        check("fetch_hour: a refused page raises", False)
    except isapi.DvrRequestError:
        check("fetch_hour: a refused page raises", True)


def today_is_rechecked_not_watermarked():
    reset()
    today = today_ist()
    now = datetime.datetime.now(IST).replace(tzinfo=None)
    early = min(now - datetime.timedelta(minutes=2), at(today, 0, 0, 30)) if now > at(today, 0, 1) else None
    y = today - datetime.timedelta(days=1)
    entries = [(at(y, 9), "Alarm", "motionStart", 2), (at(y, 9, 0, 20), "Alarm", "motionStop", 2)]
    if early:
        entries += [(early, "Alarm", "lineDetectionStart", 4), (early + datetime.timedelta(seconds=5), "Alarm", "lineDetectionStop", 4)]
    api = FakeLogDvr(entries)
    db.set_watermark("Alarm", (y - datetime.timedelta(days=1)).isoformat())
    r = events.backfill_major(api, "Alarm", IST)
    check("backfill: yesterday completed and watermarked", db.get_watermark("Alarm") == y.isoformat() and r["days_ingested"] == 1, r)
    check("backfill: today was fetched too", r["today_rechecked"] is True, r)
    if early:
        check("backfill: today's events are ingested (server-off gap filled)", len(rows("kind='line'")) == 1, rows("kind='line'"))
    n = len(rows())
    api.entries.append((now - datetime.timedelta(seconds=30), "Alarm", "motionStart", 7))
    r = events.backfill_major(api, "Alarm", IST)
    check("backfill: next pass re-checks today, idempotently", len(rows()) == n + 1 and r["days_ingested"] == 0
          and db.get_watermark("Alarm") == y.isoformat(), (len(rows()), n, r))


def midnight_crossing_is_one_span():
    reset()
    today = today_ist()
    d = today - datetime.timedelta(days=2)
    api = FakeLogDvr([(at(d, 23, 59, 50), "Alarm", "motionStart", 3),
                      (at(d + datetime.timedelta(days=1), 0, 0, 5), "Alarm", "motionStop", 3)])
    db.set_watermark("Alarm", (d - datetime.timedelta(days=1)).isoformat())
    events.backfill_major(api, "Alarm", IST)
    got = rows("kind='motion' AND channel=3")
    check("midnight: an event crossing midnight is one span (same pass)",
          len(got) == 1 and got[0]["start_utc"] == utc_iso(at(d, 23, 59, 50))
          and got[0]["end_utc"] == utc_iso(at(d + datetime.timedelta(days=1), 0, 0, 5)), got)

    # Across passes: yesterday ends with a start still open; the stop only appears today, in a later pass.
    reset()
    y = today - datetime.timedelta(days=1)
    api = FakeLogDvr([(at(y, 23, 59, 50), "Alarm", "motionStart", 5)])
    db.set_watermark("Alarm", (y - datetime.timedelta(days=1)).isoformat())
    events.backfill_major(api, "Alarm", IST)
    check("midnight: the open start is persisted with the watermark", db.get_open_starts("Alarm") == {("motion", 5): utc_iso(at(y, 23, 59, 50))},
          db.get_open_starts("Alarm"))
    if datetime.datetime.now(IST).replace(tzinfo=None) > at(today, 0, 0, 6):
        api.entries.append((at(today, 0, 0, 5), "Alarm", "motionStop", 5))
        events.backfill_major(api, "Alarm", IST)
        got = rows("kind='motion' AND channel=5")
        check("midnight: ...and matched by the next pass's stop (still one span)",
              len(got) == 1 and got[0]["end_utc"] == utc_iso(at(today, 0, 0, 5)), got)


def capped_day_hours_are_stitched_together():
    reset()
    d = today_ist() - datetime.timedelta(days=2)
    # > LOG_CAP entries that day (videoloss points), plus one motion spanning the 10:00 hour boundary.
    entries = [(at(d, 0) + datetime.timedelta(seconds=30 * i), "Alarm", "videoLost", 8) for i in range(events.LOG_CAP + 50)]
    entries += [(at(d, 10, 59, 55), "Alarm", "motionStart", 6), (at(d, 11, 0, 10), "Alarm", "motionStop", 6)]
    api = FakeLogDvr(entries)
    db.set_watermark("Alarm", (d - datetime.timedelta(days=1)).isoformat())
    events.backfill_major(api, "Alarm", IST)
    got = rows("kind='motion' AND channel=6")
    check("capped day: hourly fetches are stitched as one window (no split at 11:00)",
          len(got) == 1 and got[0]["end_utc"] == utc_iso(at(d, 11, 0, 10)), got)
    check("capped day: nothing lost past the cap", len(rows("kind='videoloss'")) == events.LOG_CAP + 50, len(rows("kind='videoloss'")))


def stitch_checks():
    a = lambda k, e, ch, t: (k, e, ch, t)
    carry = {("motion", 1): "2026-01-01T23:59:00+00:00"}
    spans = events.stitch([a("motion", "stop", 1, "2026-01-02T00:00:10+00:00"),
                           a("motion", "start", 2, "2026-01-02T23:59:59+00:00")], carry)
    check("stitch: a carried start is matched", ("motion", 1, "2026-01-01T23:59:00+00:00", "2026-01-02T00:00:10+00:00") in spans, spans)
    check("stitch: the carry is refilled with this window's open starts", carry == {("motion", 2): "2026-01-02T23:59:59+00:00"}, carry)
    spans = events.stitch([a("motion", "start", 1, "2026-01-02T01:00:00+00:00"), a("motion", "start", 1, "2026-01-02T01:05:00+00:00"),
                           a("motion", "stop", 1, "2026-01-02T01:05:30+00:00")])
    check("stitch: a start without its stop isn't silently dropped by the next start",
          ("motion", 1, "2026-01-02T01:00:00+00:00", "2026-01-02T01:00:00+00:00") in spans
          and ("motion", 1, "2026-01-02T01:05:00+00:00", "2026-01-02T01:05:30+00:00") in spans, spans)


# --------------------------------------------------------------------------- live/log duplicates

def live_and_log_merge():
    reset()
    s = "2026-03-01T10:00:00+00:00"
    db.upsert_event("dvr-live", 1, "motion", s, "2026-03-01T10:00:05+00:00")
    db.upsert_event("dvr-log", 1, "motion", "2026-03-01T10:00:01+00:00", "2026-03-01T10:00:09+00:00")
    got = rows()
    check("merge: a log copy of a live event is the same row, extended", len(got) == 1 and got[0]["source"] == "dvr-live"
          and got[0]["start_utc"] == s and got[0]["end_utc"] == "2026-03-01T10:00:09+00:00", got)
    db.upsert_event("dvr-live", 1, "motion", s, "2026-03-01T10:00:07+00:00")
    check("merge: a later live stop never shortens the merged span", rows()[0]["end_utc"] == "2026-03-01T10:00:09+00:00")
    db.upsert_event("dvr-log", 1, "motion", "2026-03-01T10:00:01.500000+00:00", "2026-03-01T10:00:09+00:00")
    check("merge: stored formats with/without microseconds still match", len(rows()) == 1, rows())
    db.upsert_event("dvr-log", 2, "line", "2026-03-01T11:00:00+00:00", "2026-03-01T11:00:00+00:00")
    db.upsert_event("dvr-live", 2, "line", "2026-03-01T10:59:59+00:00", "2026-03-01T11:00:04+00:00")
    check("merge: ...and the other way round (log first)", len(rows("channel=2")) == 1 and rows("channel=2")[0]["end_utc"] == "2026-03-01T11:00:04+00:00",
          rows("channel=2"))
    db.upsert_event("dvr-live", 1, "motion", "2026-03-01T10:00:04+00:00", "2026-03-01T10:00:04+00:00")
    check("merge: an event starting more than 2 s later is a separate row", len(rows("channel=1")) == 2)
    db.upsert_event("dvr-live", 1, "line", s, s)
    check("merge: a different kind is never merged", len(rows("channel=1")) == 3)
    db.upsert_event("manual", 1, "bookmark", s, s, attrs={"bookmark_id": 1})
    db.upsert_event("manual", 1, "bookmark", "2026-03-01T10:00:01+00:00", "2026-03-01T10:00:01+00:00", attrs={"bookmark_id": 2})
    check("merge: bookmarks (manual) are never merged", len(rows("kind='bookmark'")) == 2)


def old_duplicates_cleaned_once():
    reset()
    ins = ("INSERT INTO events(source, channel, kind, start_utc, end_utc, snapshot_path, created_utc) VALUES (?,?,?,?,?,?,?)")
    now = "2026-03-02T00:00:00+00:00"
    db.write(ins, ("dvr-live", 1, "motion", "2026-03-01T10:00:00+00:00", "2026-03-01T10:00:00+00:00", "/x/thumb.jpg", now))
    db.write(ins, ("dvr-log", 1, "motion", "2026-03-01T10:00:01+00:00", "2026-03-01T10:00:20+00:00", None, now))
    db.write(ins, ("dvr-live", 2, "line", "2026-03-01T12:00:00+00:00", "2026-03-01T12:00:03+00:00", None, now))
    db.write(ins, ("dvr-log", 2, "line", "2026-03-01T12:00:00.400000+00:00", "2026-03-01T12:00:09+00:00", None, now))
    db.write(ins, ("dvr-log", 2, "line", "2026-03-01T13:00:00+00:00", "2026-03-01T13:00:09+00:00", None, now))
    db.write(ins, ("manual", 2, "bookmark", "2026-03-01T13:00:00+00:00", "2026-03-01T13:00:00+00:00", None, now))
    db.write("PRAGMA user_version=0")
    db.init()
    got = rows()
    one = [r for r in got if r["channel"] == 1]
    check("cleanup: the copy with a thumbnail is kept, stretched to the longest end",
          len(one) == 1 and one[0]["snapshot_path"] == "/x/thumb.jpg" and one[0]["end_utc"] == "2026-03-01T10:00:20+00:00", one)
    two = [r for r in got if r["channel"] == 2 and r["kind"] == "line"]
    check("cleanup: otherwise the longest copy is kept; distinct events stay", len(two) == 2 and two[0]["end_utc"] == "2026-03-01T12:00:09+00:00", two)
    check("cleanup: bookmarks untouched", len(rows("kind='bookmark'")) == 1)
    db.write(ins, ("dvr-live", 3, "motion", "2026-03-01T10:00:00+00:00", "2026-03-01T10:00:00+00:00", None, now))
    db.write(ins, ("dvr-log", 3, "motion", "2026-03-01T10:00:00+00:00", "2026-03-01T10:00:05+00:00", None, now))
    db.init()
    check("cleanup: runs once per database (PRAGMA user_version), not on every start", len(rows("channel=3")) == 2)


# --------------------------------------------------------------------------- live subscriber

def note(kind, ch, state, when):
    return (f"<EventNotificationAlert><channelID>{ch}</channelID><dateTime>{when.isoformat()}</dateTime>"
            f"<eventType>{kind}</eventType><eventState>{state}</eventState></EventNotificationAlert>")


def subscriber_checks():
    reset()
    sub = events.AlertStreamSubscriber(api=type("A", (), {"fp": "fake"})(), tz=IST)
    t0 = datetime.datetime(2026, 3, 1, 15, 0, 0, tzinfo=IST)
    sec = lambda n: t0 + datetime.timedelta(seconds=n)
    sub._handle(note("VMD", 1, "active", sec(0)))
    for n in (1, 2, 3):
        sub._handle(note("VMD", 1, "active", sec(n)))
    got = rows()
    check("live: repeated 'active' keeps one row and its original start",
          len(got) == 1 and got[0]["start_utc"] == sec(0).astimezone(UTC).isoformat(), got)
    check("live: ...and extends its provisional end", got[0]["end_utc"] == sec(3).astimezone(UTC).isoformat(), got)
    sub._handle(note("VMD", 1, "inactive", sec(6)))
    got = rows()
    check("live: 'inactive' closes the same row", len(got) == 1 and got[0]["end_utc"] == sec(6).astimezone(UTC).isoformat(), got)

    sub._handle(note("linedetection", 2, "active", sec(100)))
    sub._handle(note("linedetection", 2, "active", sec(104)))
    sub._handle(note("videoloss", 0, "inactive", sec(104 + events.STALE_OPEN_S + 5)))   # the recorder's heartbeat
    check("live: a stale open event is closed at its last-seen active", ("line", 2) not in sub._open_starts
          and rows("kind='line'")[0]["end_utc"] == sec(104).astimezone(UTC).isoformat(), rows("kind='line'"))
    check("live: the heartbeat itself is never stored", not rows("channel=0"))
    sub._handle(note("linedetection", 2, "inactive", sec(300)))
    got = rows("kind='line'")
    check("live: a late 'inactive' still ends that same event", len(got) == 1 and got[0]["end_utc"] == sec(300).astimezone(UTC).isoformat(), got)
    sub._handle(note("linedetection", 2, "active", sec(400)))
    check("live: a new 'active' after it is a new event", len(rows("kind='line'")) == 2)


def subscriber_waits_while_tripped():
    class Api:
        fp = recorder_guard.fingerprint("10.0.0.9", "admin", "bad")
        opened = 0

        def open_stream(self, *a, **k):
            Api.opened += 1
            raise OSError("should not be called")
    recorder_guard.trip(Api.fp, "test")
    try:
        sub = events.AlertStreamSubscriber(Api(), IST)
        sub.start()
        time.sleep(0.3)
        sub.stop()
        check("live: no alertStream login while the breaker is tripped", Api.opened == 0 and sub.last_error == recorder_guard.MESSAGE,
              (Api.opened, sub.last_error))
    finally:
        recorder_guard.clear()


def main():
    db.init()
    tz_local_checks()
    failed_request_keeps_watermark()
    today_is_rechecked_not_watermarked()
    midnight_crossing_is_one_span()
    capped_day_hours_are_stitched_together()
    stitch_checks()
    live_and_log_merge()
    old_duplicates_cleaned_once()
    subscriber_checks()
    subscriber_waits_while_tripped()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
