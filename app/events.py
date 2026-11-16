"""Event ingest: DVR alarm/exception log backfill (paginated, watermarked, rate-limited) and the live
alertStream subscriber. See docs/SPEC.md section 8."""
import datetime
import re
import threading
import time

import db
import isapi
import recorder_guard

LOG_CAP = 2000  # the DVR silently truncates a logSearch response at this many entries per query
RATE_DELAY = 0.3  # seconds between DVR requests during backfill — gentle, not a hammering scan
KINDS = {  # metaId suffix -> our event kind
    "motionStart": ("motion", "start"), "motionStop": ("motion", "stop"),
    "lineDetectionStart": ("line", "start"), "lineDetectionStop": ("line", "stop"),
    "hideStart": ("tamper", "start"), "hideStop": ("tamper", "stop"),
    "videoLost": ("videoloss", "point"),
}


def tz_local(api: isapi.Isapi):
    """DVR's UTC offset (e.g. +05:30), cached by the caller (and re-read hourly, for daylight saving).
    Raises when the recorder doesn't say: falling back to UTC here used to make a refused or garbled answer
    (a wrong password, a busy recorder) look like a successful read, and every DVR-local time was then off by
    the real offset for as long as the process ran."""
    st, body = api.get("/ISAPI/System/time", timeout=8)
    if st != 200:
        raise isapi.DvrRequestError("clock", st)
    m = re.search(r"<localTime>([^<]+)</localTime>", body)
    if not m:
        raise ValueError("The recorder's clock answer had no localTime")
    dt = datetime.datetime.fromisoformat(m.group(1))
    return dt.tzinfo or datetime.timezone.utc


def _to_utc_iso(dvr_local_str, tz):
    """The DVR labels its local-time strings with a trailing 'Z', which is wrong — reinterpret as `tz`."""
    naive = dvr_local_str.rstrip("Z")
    dt = datetime.datetime.fromisoformat(naive).replace(tzinfo=tz)
    return dt.astimezone(datetime.timezone.utc).isoformat()


def _log_search(api, major, start_iso, end_iso, pos=0, max_results=100):
    body = (
        '<?xml version="1.0" encoding="utf-8"?><CMSearchDescription>'
        f'<searchID>{{{_uuid()}}}</searchID>'
        f'<timeSpanList><timeSpan><startTime>{start_iso}</startTime><endTime>{end_iso}</endTime></timeSpan></timeSpanList>'
        f'<maxResults>{max_results}</maxResults><searchResultPostion>{pos}</searchResultPostion>'
        f'<metaId>log.hikvision.com/{major}</metaId></CMSearchDescription>'
    )
    return api.call("/ISAPI/ContentMgmt/logSearch", "POST", body)


def _uuid():
    import uuid
    return str(uuid.uuid4()).upper()


def fetch_day(api, major, day_start_local, tz, max_results=100):
    """All log entries for one DVR-local day. Returns (entries, hit_cap) where hit_cap means the DVR
    truncated the result at LOG_CAP entries and the day should be re-fetched split by hour instead.
    (The DVR doesn't reliably flag this with `responseStatusStrg=MORE` on the final page — sometimes the
    LOG_CAP'th page comes back marked "OK" even though entries exist beyond it — so capping is judged by
    the total count reaching LOG_CAP, not by trusting the last page's own status.)
    Raises isapi.DvrRequestError on any non-200 page: returning what had arrived so far let the caller mark a
    half-fetched day complete, and its missing events were then never fetched again."""
    day_end_local = day_start_local + datetime.timedelta(days=1) - datetime.timedelta(seconds=1)
    start = day_start_local.strftime("%Y-%m-%dT%H:%M:%SZ")
    end = day_end_local.strftime("%Y-%m-%dT%H:%M:%SZ")
    entries, pos = [], 0
    while True:
        st, out = _log_search(api, major, start, end, pos, max_results)
        if st != 200:
            raise isapi.DvrRequestError("log search", st)
        got = re.findall(r"<logDescriptor>.*?</logDescriptor>", out, re.S)
        entries += got
        m = re.search(r"<responseStatusStrg>(\w+)</responseStatusStrg>", out)
        time.sleep(RATE_DELAY)
        pos += len(got)
        if len(entries) >= LOG_CAP:
            return entries, True
        if not got or not m or m.group(1) != "MORE":
            break
    return entries, False


def fetch_hour(api, major, hour_start_local, tz, max_results=100):
    """One DVR-local hour's log entries (a capped day is fetched this way). Raises isapi.DvrRequestError on a
    non-200 page, same as fetch_day."""
    hour_end_local = hour_start_local + datetime.timedelta(hours=1) - datetime.timedelta(seconds=1)
    start = hour_start_local.strftime("%Y-%m-%dT%H:%M:%SZ")
    end = hour_end_local.strftime("%Y-%m-%dT%H:%M:%SZ")
    entries, pos = [], 0
    while True:
        st, out = _log_search(api, major, start, end, pos, max_results)
        if st != 200:
            raise isapi.DvrRequestError("log search", st)
        got = re.findall(r"<logDescriptor>.*?</logDescriptor>", out, re.S)
        entries += got
        m = re.search(r"<responseStatusStrg>(\w+)</responseStatusStrg>", out)
        time.sleep(RATE_DELAY)
        if not got or not m or m.group(1) != "MORE":
            break
        pos += len(got)
    return entries


def parse_entries(entries, tz):
    """logDescriptor XML fragments -> [(kind, edge, channel, utc_iso)], edge in {start,stop,point}."""
    out = []
    for e in entries:
        m = re.search(r"<metaId>log\.hikvision\.com/(?:Alarm|Exception)/(\w+?)(?:/(\d+))?</metaId>", e)
        t = re.search(r"<StartDateTime>([^<]+)</StartDateTime>", e)
        if not m or not t:
            continue
        name, ch = m.group(1), int(m.group(2)) if m.group(2) else 0
        if name not in KINDS:
            continue
        kind, edge = KINDS[name]
        out.append((kind, edge, ch, _to_utc_iso(t.group(1), tz)))
    return out


def stitch(pairs, carry=None):
    """[(kind, edge, ch, utc_iso), ...] -> [(kind, ch, start_utc, end_utc), ...], matching start/stop by
    channel+kind in time order; an unmatched start is closed at its own instant (a zero-length marker,
    clearly distinguishable from a real span) rather than guessed.

    `carry`, when given, is {(kind, ch): start_utc} of starts left open by the previous window (the day
    before): they are matched first, and the dict is refilled with this window's own still-open starts, so an
    event that crosses midnight stays one span (its zero-length marker from the day before is extended in
    place by upsert) instead of splitting into two zero-length rows. A capped day fetched hour by hour is
    concatenated before stitching, so hour boundaries never split an event."""
    pairs = sorted(pairs, key=lambda x: x[3])
    open_starts = dict(carry) if carry else {}
    spans = []
    for kind, edge, ch, ts in pairs:
        key = (kind, ch)
        if edge == "point":
            spans.append((kind, ch, ts, ts))
        elif edge == "start":
            prev = open_starts.get(key)
            if prev is not None:
                # A second start before any stop (the stop was never logged): keep the earlier one as its own
                # marker rather than silently dropping it.
                spans.append((kind, ch, prev, prev))
            open_starts[key] = ts
        elif edge == "stop":
            s = open_starts.pop(key, None)
            spans.append((kind, ch, s or ts, ts))
    for (kind, ch), s in open_starts.items():
        spans.append((kind, ch, s, s))  # never closed in this window; zero-length, will extend on next ingest
    if carry is not None:
        carry.clear()
        carry.update(open_starts)
    return spans


CARRY_MAX_S = 24 * 3600  # an open start older than this is a lost stop, not an ongoing event: stop carrying it


def _prune_carry(carry, now_utc):
    for key, s in list(carry.items()):
        if (now_utc - datetime.datetime.fromisoformat(s)).total_seconds() > CARRY_MAX_S:
            del carry[key]


def ingest_spans(source, spans):
    for kind, ch, s, e in spans:
        db.upsert_event(source, ch, kind, s, e)


def _fetch_whole_day(api, major, day, tz, now_local):
    day_start = datetime.datetime.combine(day, datetime.time(0, 0), tzinfo=tz)
    entries, capped = fetch_day(api, major, day_start, tz)
    if capped:
        entries = []
        hours = 24 if day < now_local.date() else now_local.hour + 1   # no point asking about future hours
        for h in range(hours):
            entries += fetch_hour(api, major, day_start + datetime.timedelta(hours=h), tz)
    return entries


def backfill_major(api, major, tz, since_day=None, stop_event=None):
    """Walk forward day by day from the watermark (or `since_day`, or the DVR's earliest recording) through
    today, splitting into hourly queries on any day that hits the 2000-entry cap. Resumable: the watermark
    advances only after a day is fully ingested, and any failed DVR request raises (isapi.DvrRequestError)
    before it does. Today is fetched on every pass but never marked complete — its entries are still arriving,
    and re-ingesting them is idempotent — so events from while the server was off show up within the hour.
    Starts still open at the end of a day are handed to the next (stitch's `carry`, persisted alongside the
    watermark), so an event crossing midnight stays one span."""
    wm = db.get_watermark(major)
    start_day = None
    if wm:
        start_day = datetime.date.fromisoformat(wm) + datetime.timedelta(days=1)
    elif since_day:
        start_day = since_day
    if start_day is None:
        return {"error": "no starting day known"}
    now_local = datetime.datetime.now(tz)
    today = now_local.date()
    carry = db.get_open_starts(major) if wm else {}
    day = start_day
    days_done = 0
    today_checked = False
    while day <= today:
        if stop_event and stop_event.is_set():
            break
        entries = _fetch_whole_day(api, major, day, tz, now_local)
        spans = stitch(parse_entries(entries, tz), carry)
        ingest_spans("dvr-log", spans)
        day_end = datetime.datetime.combine(day + datetime.timedelta(days=1), datetime.time(0, 0), tzinfo=tz)
        _prune_carry(carry, min(day_end, now_local))
        if day == today:
            today_checked = True   # re-fetched next pass too; its watermark and carry are never saved
            break
        db.advance_watermark(major, day.isoformat(), carry)
        days_done += 1
        day += datetime.timedelta(days=1)
    return {"days_ingested": days_done, "today_rechecked": today_checked,
            "through": (start_day + datetime.timedelta(days=days_done - 1)).isoformat() if days_done else None}


STALE_OPEN_S = 120  # an ongoing event repeats "active" about every second; this long without one, it has ended


class AlertStreamSubscriber:
    """Persistent connection to /ISAPI/Event/notification/alertStream: pushes each event straight into the
    events table (source='dvr-live') as it happens. Auto-reconnects (backing off while the recorder is
    unreachable), and doesn't log in at all while the lockout breaker is tripped (recorder_guard)."""

    def __init__(self, api: isapi.Isapi, tz, open_starts=None):
        self.api, self.tz = api, tz
        self._stop = threading.Event()
        self._thread = None
        self.last_event_utc = None
        self.last_error = None
        self.last_error_at = None            # epoch seconds of last_error
        self.last_error_unreachable = False   # last_error was a failure to reach the recorder at all
        self.connected = False
        # (kind, channel) -> [start ts, last "active" seen], persisted across live notifications — unlike
        # stitch()'s own dict, which is scoped to one call and built for batch backfill (a whole day's entries at
        # once, where a start and its stop are both present in the same call). Each alertStream notification is
        # its own separate _handle() call, one edge at a time, so stitch() could never actually match a start
        # with its stop here — every live event was landing as its own zero-length row instead of a real span,
        # confirmed directly against the DB (every dvr-live row had start_utc == end_utc), not assumed.
        # Passed in by PlaybackService.reload() so events in progress survive a settings change.
        self._open_starts = open_starts if open_starts is not None else {}
        self._stale_closed = {}   # (kind, channel) -> start of an event closed by the stale sweep

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        delay = 3
        while not self._stop.is_set():
            if recorder_guard.tripped(self.api.fp):
                self.connected = False
                self.last_error = recorder_guard.MESSAGE
                self._stop.wait(5)
                continue
            try:
                with self.api.open_stream("/ISAPI/Event/notification/alertStream", timeout=60) as r:
                    self.connected = True
                    self.last_error = None
                    delay = 3
                    buf = b""
                    while not self._stop.is_set():
                        chunk = r.read1(4096)
                        if not chunk:
                            break
                        buf += chunk
                        while b"</EventNotificationAlert>" in buf:
                            end = buf.index(b"</EventNotificationAlert>") + len(b"</EventNotificationAlert>")
                            start = buf.rfind(b"<EventNotificationAlert", 0, end)
                            if start == -1:
                                buf = buf[end:]
                                continue
                            self._handle(buf[start:end].decode(errors="replace"))
                            buf = buf[end:]
            except recorder_guard.RecorderAuthBlocked as e:
                self.last_error = str(e)   # the breaker is tripped now; the top of the loop waits it out
                self.last_error_at, self.last_error_unreachable = time.time(), False
            except Exception as e:
                self.last_error = f"{type(e).__name__}: {e}"
                self.last_error_at = time.time()
                # Not an HTTP answer (the recorder is there): refused, timed out, no route.
                self.last_error_unreachable = isinstance(e, (OSError, TimeoutError)) and not hasattr(e, "code")
            self.connected = False
            if self._stop.wait(delay):
                break
            delay = min(delay * 2, 60)   # an unreachable recorder isn't asked again every 3 s forever

    def _sweep_stale(self, now_dt):
        """Close events whose "active" notifications stopped without an "inactive" (a dropped connection, a
        lost notification): ended at the last active seen — the end their row already has."""
        for key, (s, seen) in list(self._open_starts.items()):
            if (now_dt - datetime.datetime.fromisoformat(seen)).total_seconds() > STALE_OPEN_S:
                del self._open_starts[key]
                self._stale_closed[key] = s
                ingest_spans("dvr-live", [(key[0], key[1], s, seen)])

    def _handle(self, xml):
        et = re.search(r"<eventType>([^<]+)</eventType>", xml)
        ch = re.search(r"<channelID>([^<]+)</channelID>", xml)
        state = re.search(r"<eventState>([^<]+)</eventState>", xml)
        dt = re.search(r"<dateTime>([^<]+)</dateTime>", xml)
        if not (et and dt):
            return
        try:
            when = datetime.datetime.fromisoformat(dt.group(1)).astimezone(datetime.timezone.utc)
        except ValueError:
            return
        # Before the heartbeat filter below on purpose: that ~9 s heartbeat is what keeps this sweep running.
        self._sweep_stale(when)
        # The DVR also posts a system heartbeat on this same stream — channelID 0, eventType videoloss,
        # eventState inactive, roughly every 9s (~9k/day) — that is not a real per-channel event. Verified
        # against the raw notification body directly (not inferred from the DB): a channelID of 0 or a
        # missing channelID never carries a real event in practice, so skip ingesting either case rather
        # than defaulting to a fake "channel 0" that matches no camera and pollutes search/badges.
        if not ch or not ch.group(1).isdigit() or int(ch.group(1)) == 0:
            return
        name = et.group(1)
        # ISAPI names motion detection "VMD" on the alertStream (its log calls it motionStart/Stop); "motion" is
        # kept for firmware that says it that way.
        kind_map = {"vmd": "motion", "motion": "motion", "linedetection": "line", "shelteralarm": "tamper",
                    "videoloss": "videoloss"}
        kind = kind_map.get(name.lower())
        if not kind:
            return
        utc = when.isoformat()
        channel = int(ch.group(1))
        edge = "start" if (not state or state.group(1) == "active") else "stop"
        self.last_event_utc = utc
        key = (kind, channel)
        if edge == "start":
            cur = self._open_starts.get(key)
            if cur:
                # The recorder repeats "active" about every second while an event goes on. That is the same
                # event, not a new one: keep its original start (a new start here made a fresh row per second)
                # and extend its provisional end, so an event in progress shows how long it has run so far.
                cur[1] = utc
                ingest_spans("dvr-live", [(kind, channel, cur[0], utc)])
            else:
                self._stale_closed.pop(key, None)
                self._open_starts[key] = [utc, utc]
                ingest_spans("dvr-live", [(kind, channel, utc, utc)])  # provisional row, visible immediately
        else:
            cur = self._open_starts.pop(key, None)
            s = cur[0] if cur else self._stale_closed.pop(key, None)
            # Same start_utc as the provisional row above (when there was one) — upsert_event finds that row by
            # it, so this extends that row's end_utc in place instead of inserting a second, disconnected one.
            ingest_spans("dvr-live", [(kind, channel, s or utc, utc)])
