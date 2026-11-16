"""Coverage index: which time ranges the DVR actually has recordings for, per channel per day.
Built from ContentMgmt/search (merged spans, not per-second) and cached in the DB (section 8/2.1)."""
import datetime
import time
import json
import re
import uuid

import db
import isapi


def _search(api: isapi.Isapi, track, start_iso, end_iso, max_results=200, pos=0):
    body = (
        '<?xml version="1.0" encoding="utf-8"?><CMSearchDescription>'
        f'<searchID>{{{str(uuid.uuid4()).upper()}}}</searchID>'
        f'<trackList><trackID>{track}</trackID></trackList>'
        f'<timeSpanList><timeSpan><startTime>{start_iso}</startTime><endTime>{end_iso}</endTime></timeSpan></timeSpanList>'
        f'<maxResults>{max_results}</maxResults><searchResultPostion>{pos}</searchResultPostion></CMSearchDescription>'
    )
    return api.call("/ISAPI/ContentMgmt/search", "POST", body)


def spans_for_day(api, channel, day_start_local, tz):
    """Merged recorded spans (UTC ISO pairs) for one DVR-local day on a channel's main track. Raises
    isapi.DvrRequestError on any non-200 page: returning what had arrived so far let refresh_day overwrite a
    day's good cached coverage with a partial (often empty) list — the timeline then showed no recordings."""
    track = channel * 100 + 1
    day_end_local = day_start_local + datetime.timedelta(days=1)
    start = day_start_local.strftime("%Y-%m-%dT%H:%M:%SZ")
    end = day_end_local.strftime("%Y-%m-%dT%H:%M:%SZ")
    spans, pos = [], 0
    while True:
        st, out = _search(api, track, start, end, pos=pos)
        if st != 200:
            raise isapi.DvrRequestError("recording search", st)
        items = re.findall(r"<searchMatchItem>.*?</searchMatchItem>", out, re.S)
        for it in items:
            s = re.search(r"<startTime>(.*?)</startTime>", it)
            e = re.search(r"<endTime>(.*?)</endTime>", it)
            if s and e:
                spans.append((_to_utc(s.group(1), tz), _to_utc(e.group(1), tz)))
        n = re.search(r"<numOfMatches>(\d+)</numOfMatches>", out)
        total = int(n.group(1)) if n else len(items)
        pos += len(items)
        if not items or pos >= total:
            break
    return spans


def _to_utc(dvr_iso, tz):
    """DVR search results are already UTC ('Z' really means UTC here, unlike logSearch's local-mislabelled-Z)."""
    return datetime.datetime.fromisoformat(dvr_iso.rstrip("Z")).replace(tzinfo=datetime.timezone.utc).isoformat()


def refresh_day(api, channel, day, tz):
    """day: date object, DVR-local. Fetches and caches that day's coverage; returns the spans. On a failed
    request (raised) the cached row is left as it was."""
    day_start = datetime.datetime.combine(day, datetime.time(0, 0), tzinfo=tz)
    spans = spans_for_day(api, channel, day_start, tz)
    db.write(
        "INSERT INTO coverage_days(channel, day, spans_json, refreshed_utc) VALUES (?,?,?,?) "
        "ON CONFLICT(channel, day) DO UPDATE SET spans_json=excluded.spans_json, refreshed_utc=excluded.refreshed_utc",
        (channel, day.isoformat(), json.dumps(spans), datetime.datetime.now(datetime.timezone.utc).isoformat()),
    )
    return spans


def cached_range(channel, day_from, day_to):
    """Cached coverage for [day_from, day_to] inclusive, from the DB (no DVR call)."""
    rows = db.query(
        "SELECT day, spans_json FROM coverage_days WHERE channel=? AND day>=? AND day<=? ORDER BY day",
        (channel, day_from.isoformat(), day_to.isoformat()),
    )
    return {r["day"]: json.loads(r["spans_json"]) for r in rows}


def refresh_all(api, channels, tz, day_from, day_to, stop_event=None):
    """Refresh coverage for every channel over [day_from, day_to] inclusive; raises on the first failure.
    (PlaybackService indexes day by day itself, so one bad day doesn't stop the rest — see _coverage_pass.)"""
    day = day_from
    n = 0
    while day <= day_to:
        if stop_event and stop_event.is_set():
            return n
        for ch in channels:
            refresh_day(api, ch, day, tz)
            n += 1
        day += datetime.timedelta(days=1)
    return n


def earliest_recorded_day(api, channel, tz, probe_months=6):
    """Walk back month by month (dailyDistribution) to find the first day with any recording."""
    return earliest_recorded_day_checked(api, channel, tz, probe_months)["day"]


def earliest_recorded_day_checked(api, channel, tz, probe_months=6):
    """{"day": first recorded day or None, "certain": bool}. `certain` only when every month asked about answered
    (a refused month reads as "nothing recorded" and would make the answer too late) and the first day isn't in
    the oldest month probed (recordings may go back further than the probe). Pruning and the roll-off estimate
    act on a certain answer only — a too-late day would discard events whose footage still exists."""
    today = datetime.datetime.now(tz).date()
    y, m = today.year, today.month
    earliest, all_ok, oldest_month = None, True, None
    for _ in range(probe_months):
        body = f'<?xml version="1.0" encoding="utf-8"?><trackDailyParam><year>{y}</year><monthOfYear>{m}</monthOfYear></trackDailyParam>'
        st, out = api.call(f"/ISAPI/ContentMgmt/record/tracks/{channel * 100 + 1}/dailyDistribution", "POST", body)
        if st == 200:
            days = [int(d) for d, r in re.findall(r"<dayOfMonth>(\d+)</dayOfMonth>\s*<record>(\w+)</record>", out) if r == "true"]
            if days:
                earliest = datetime.date(y, m, min(days))
        else:
            all_ok = False
        oldest_month = (y, m)
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    certain = bool(earliest and all_ok and (earliest.year, earliest.month) != oldest_month)
    return {"day": earliest, "certain": certain}


def not_recorded(channel, at_utc, tz):
    """True when the cached coverage index says `at_utc` is not inside any recorded span (False when it is, or
    when that day's coverage isn't cached — not knowing is not a refusal). Today's index trails the recorder,
    so only footage older than two hours is judged."""
    if time.time() - at_utc.timestamp() < 7200:
        return False
    day = at_utc.astimezone(tz).date()
    try:
        cached = cached_range(channel, day - datetime.timedelta(days=1), day + datetime.timedelta(days=1))
    except Exception:
        return False
    if day.isoformat() not in cached:
        return False
    for spans in cached.values():
        for s, e in spans:
            if datetime.datetime.fromisoformat(s) <= at_utc <= datetime.datetime.fromisoformat(e):
                return False
    return True
