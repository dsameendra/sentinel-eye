"""Event ingest: DVR alarm/exception log backfill (paginated, watermarked, rate-limited) and the live
alertStream subscriber. See docs/playback-spec.md section 8."""
import datetime
import re
import threading
import time

import db
import isapi

LOG_CAP = 2000  # the DVR silently truncates a logSearch response at this many entries per query
RATE_DELAY = 0.3  # seconds between DVR requests during backfill — gentle, not a hammering scan
KINDS = {  # metaId suffix -> our event kind
    "motionStart": ("motion", "start"), "motionStop": ("motion", "stop"),
    "lineDetectionStart": ("line", "start"), "lineDetectionStop": ("line", "stop"),
    "hideStart": ("tamper", "start"), "hideStop": ("tamper", "stop"),
    "videoLost": ("videoloss", "point"),
}


def tz_local(api: isapi.Isapi):
    """DVR's UTC offset (e.g. +05:30), read once and cached by the caller."""
    _, body = api.get("/ISAPI/System/time", timeout=8)
    m = re.search(r"<localTime>([^<]+)</localTime>", body)
    if not m:
        return datetime.timezone.utc
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
    the total count reaching LOG_CAP, not by trusting the last page's own status.)"""
    day_end_local = day_start_local + datetime.timedelta(days=1) - datetime.timedelta(seconds=1)
    start = day_start_local.strftime("%Y-%m-%dT%H:%M:%SZ")
    end = day_end_local.strftime("%Y-%m-%dT%H:%M:%SZ")
    entries, pos = [], 0
    while True:
        st, out = _log_search(api, major, start, end, pos, max_results)
        if st != 200:
            break
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
    hour_end_local = hour_start_local + datetime.timedelta(hours=1) - datetime.timedelta(seconds=1)
    start = hour_start_local.strftime("%Y-%m-%dT%H:%M:%SZ")
    end = hour_end_local.strftime("%Y-%m-%dT%H:%M:%SZ")
    entries, pos = [], 0
    while True:
        st, out = _log_search(api, major, start, end, pos, max_results)
        if st != 200:
            break
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


def stitch(pairs):
    """[(kind, edge, ch, utc_iso), ...] -> [(kind, ch, start_utc, end_utc), ...], matching start/stop by
    channel+kind in time order; an unmatched start is closed at its own instant (a zero-length marker,
    clearly distinguishable from a real span) rather than guessed."""
    pairs = sorted(pairs, key=lambda x: x[3])
    open_starts = {}
    spans = []
    for kind, edge, ch, ts in pairs:
        key = (kind, ch)
        if edge == "point":
            spans.append((kind, ch, ts, ts))
        elif edge == "start":
            open_starts[key] = ts
        elif edge == "stop":
            s = open_starts.pop(key, None)
            spans.append((kind, ch, s or ts, ts))
    for (kind, ch), s in open_starts.items():
        spans.append((kind, ch, s, s))  # never closed in this window; zero-length, will extend on next ingest
    return spans


def ingest_spans(source, spans):
    for kind, ch, s, e in spans:
        db.upsert_event(source, ch, kind, s, e)


def backfill_major(api, major, tz, since_day=None, stop_event=None):
    """Walk forward day by day from the watermark (or `since_day`, or the DVR's earliest recording) to
    yesterday, splitting into hourly queries on any day that hits the 2000-entry cap. Resumable: the
    watermark advances only after a day is fully ingested."""
    wm = db.get_watermark(major)
    start_day = None
    if wm:
        start_day = datetime.date.fromisoformat(wm) + datetime.timedelta(days=1)
    elif since_day:
        start_day = since_day
    if start_day is None:
        return {"error": "no starting day known"}
    today = datetime.datetime.now(tz).date()
    day = start_day
    days_done = 0
    while day < today:  # today is left for the trailing re-check, not marked complete
        if stop_event and stop_event.is_set():
            break
        day_start = datetime.datetime.combine(day, datetime.time(0, 0), tzinfo=tz)
        entries, capped = fetch_day(api, major, day_start, tz)
        if capped:
            entries = []
            for h in range(24):
                entries += fetch_hour(api, major, day_start + datetime.timedelta(hours=h), tz)
        spans = stitch(parse_entries(entries, tz))
        ingest_spans("dvr-log", spans)
        db.set_watermark(major, day.isoformat())
        days_done += 1
        day += datetime.timedelta(days=1)
    return {"days_ingested": days_done, "through": (day - datetime.timedelta(days=1)).isoformat() if days_done else None}


class AlertStreamSubscriber:
    """Persistent connection to /ISAPI/Event/notification/alertStream: pushes each event straight into the
    events table (source='dvr-live') as it happens. Auto-reconnects."""

    def __init__(self, api: isapi.Isapi, tz):
        self.api, self.tz = api, tz
        self._stop = threading.Event()
        self._thread = None
        self.last_event_utc = None
        self.connected = False
        # (kind, channel) -> start ts, persisted across live notifications — unlike stitch()'s own dict,
        # which is scoped to one call and built for batch backfill (a whole day's entries at once, where a
        # start and its stop are both present in the same call). Each alertStream notification is its own
        # separate _handle() call, one edge at a time, so stitch() could never actually match a start with
        # its stop here — every live event was landing as its own zero-length row instead of a real span,
        # confirmed directly against the DB (every dvr-live row had start_utc == end_utc), not assumed.
        self._open_starts = {}

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        import urllib.request
        while not self._stop.is_set():
            try:
                req = urllib.request.Request(self.api.base + "/ISAPI/Event/notification/alertStream")
                with self.api.opener.open(req, timeout=60) as r:
                    self.connected = True
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
            except Exception:
                pass
            self.connected = False
            if not self._stop.is_set():
                time.sleep(3)

    def _handle(self, xml):
        et = re.search(r"<eventType>([^<]+)</eventType>", xml)
        ch = re.search(r"<channelID>([^<]+)</channelID>", xml)
        state = re.search(r"<eventState>([^<]+)</eventState>", xml)
        dt = re.search(r"<dateTime>([^<]+)</dateTime>", xml)
        if not (et and dt):
            return
        # The DVR also posts a system heartbeat on this same stream — channelID 0, eventType videoloss,
        # eventState inactive, roughly every 9s (~9k/day) — that is not a real per-channel event. Verified
        # against the raw notification body directly (not inferred from the DB): a channelID of 0 or a
        # missing channelID never carries a real event in practice, so skip ingesting either case rather
        # than defaulting to a fake "channel 0" that matches no camera and pollutes search/badges.
        if not ch or not ch.group(1).isdigit() or int(ch.group(1)) == 0:
            return
        name = et.group(1)
        kind_map = {"motion": "motion", "linedetection": "line", "shelteralarm": "tamper", "videoloss": "videoloss"}
        kind = kind_map.get(name.lower())
        if not kind:
            return
        try:
            utc = datetime.datetime.fromisoformat(dt.group(1)).astimezone(datetime.timezone.utc).isoformat()
        except ValueError:
            return
        channel = int(ch.group(1))
        edge = "start" if (not state or state.group(1) == "active") else "stop"
        self.last_event_utc = utc
        key = (kind, channel)
        if edge == "start":
            self._open_starts[key] = utc
            ingest_spans("dvr-live", [(kind, channel, utc, utc)])  # provisional row, visible immediately
        else:
            s = self._open_starts.pop(key, None)
            # Same start_utc as the provisional row above (when there was one) — upsert_event's own
            # conflict key is (source, channel, kind, start_utc), so this extends that row's end_utc in
            # place instead of inserting a second, disconnected one.
            ingest_spans("dvr-live", [(kind, channel, s or utc, utc)])
