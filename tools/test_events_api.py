"""Events search, CSV export, retention and bookmark-edit checks for app/server.py, in-process (Starlette
TestClient, no lifespan: no go2rtc, no recorder; synthetic events in a scratch SENTINEL_DATA). Sign-in is off,
so every request is the admin "Operator" — role and ownership rules are in tools/test_auth_http.py.

   .venv/bin/python3 tools/test_events_api.py
"""
import csv
import datetime
import io
import json
import os
import sys
import tempfile

os.environ["SENTINEL_DATA"] = tempfile.mkdtemp(prefix="se-events-api-")
os.environ.pop("SENTINEL_ADMIN_PASSWORD", None)
sys.path.insert(0, "app")
import auth
import db
import export as exportmod
import server
import settings as cfg
from fastapi.testclient import TestClient

PASS = []
UTC = datetime.timezone.utc
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
T0 = datetime.datetime(2026, 11, 1, 0, 0, tzinfo=UTC)


def check(name, ok, extra=""):
    ok = bool(ok)
    PASS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


class FakeGo2rtc:
    def status(self):
        return {}

    def up(self):
        return True


class FakePlayback:
    def __init__(self):
        self.tz = IST
        self.status = {}
        self.subscriber = None

    def retention(self):
        return {1: {"oldest_utc": "2026-10-01T03:00:00+00:00", "oldest_day": "2026-10-01", "days": 45.0},
                2: {"oldest_utc": None, "oldest_day": None, "days": None}}


server.state["go2rtc"] = FakeGo2rtc()
server.state["playback"] = FakePlayback()
server.state["settings"] = cfg.Settings(channels=[cfg.Channel(id="c1", channel=1, name="Gate"),
                                                  cfg.Channel(id="c2", channel=2, name="Yard")])
db.init()
c = TestClient(server.app, raise_server_exceptions=False)


def seed():
    """Events with deliberately colliding start times (same second, several rows) so paging must use the id."""
    rows = []
    for i in range(130):
        t = T0 + datetime.timedelta(seconds=(i // 3) * 7)   # three rows share each start time
        ch, kind = (1 if i % 2 else 2), ("motion", "line", "tamper")[i % 3]
        db.upsert_event("dvr-log", ch, kind, t.isoformat(), (t + datetime.timedelta(seconds=4)).isoformat())
    return rows


def ev(params):
    r = c.get("/api/timeline/events", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def paging():
    seed()
    everything = ev({"limit": 5000})
    ids = [r["id"] for r in everything]
    check("events: default order is newest first", everything == sorted(everything, key=lambda r: (r["start_utc"], r["id"]), reverse=True))
    pages, cursor = [], ""
    while True:
        p = {"limit": 17}
        if cursor:
            p["before"] = cursor
        page = ev(p)
        pages.append(page)
        if len(page) < 17:
            break
        cursor = f"{page[-1]['start_utc']},{page[-1]['id']}"
    got = [r["id"] for pg in pages for r in pg]
    check("paging: pages join up to exactly the full result (no gaps, no repeats)", got == ids, (len(got), len(ids)))
    # A new event arriving while paging (newer than everything) doesn't shift later pages.
    first = ev({"limit": 10})
    db.upsert_event("dvr-live", 1, "motion", (T0 + datetime.timedelta(days=2)).isoformat(),
                    (T0 + datetime.timedelta(days=2, seconds=3)).isoformat())
    nxt = ev({"limit": 10, "before": f"{first[-1]['start_utc']},{first[-1]['id']}"})
    check("paging: a newly arrived event doesn't shift the next page", [r["id"] for r in nxt] == ids[10:20])
    check("paging: a cursor in Z form works like +00:00",
          ev({"limit": 10, "before": f"{first[-1]['start_utc'].replace('+00:00', 'Z')},{first[-1]['id']}"}) == nxt)
    r = c.get("/api/timeline/events", params={"before": "nonsense"})
    check("paging: a malformed cursor is refused (422)", r.status_code == 422, r.status_code)
    r = c.get("/api/timeline/events", params={"start_utc": "yesterday"})
    check("events: a malformed time is refused (422)", r.status_code == 422, r.status_code)
    asc = ev({"order": "asc", "limit": 4, "after": f"{(T0 + datetime.timedelta(seconds=14)).isoformat()},0"})
    check("events: order=asc + after gives the next events after a time, oldest first",
          [r["start_utc"] for r in asc] == [(T0 + datetime.timedelta(seconds=14)).isoformat()] * 3
          + [(T0 + datetime.timedelta(seconds=21)).isoformat()], [r["start_utc"] for r in asc])
    everything = ev({"limit": 5000})
    two = ev({"kind": ["motion", "tamper"], "limit": 5000})
    check("events: several kinds in one query", two and {r["kind"] for r in two} == {"motion", "tamper"}
          and len(two) == sum(1 for r in everything if r["kind"] in ("motion", "tamper")), len(two))
    check("events: an empty kind means every kind (existing callers)", len(ev({"kind": "", "limit": 5000})) == len(everything))
    one = ev({"channel": 1, "kind": "line", "limit": 5000})
    check("events: channel + kind filters combine", one and all(r["channel"] == 1 and r["kind"] == "line" for r in one))


def csv_export():
    bid = db.create_bookmark([1], (T0 + datetime.timedelta(seconds=3)).isoformat(), "=HYPERLINK(\"http://x\")",
                             "+1 note, with \"quotes\"\nand a newline", "critical", "@ops")
    r = c.get("/api/timeline/events.csv", params={"channel": 1})
    check("csv: served as a download", r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
          and "attachment" in r.headers.get("content-disposition", ""), r.headers)
    rows = list(csv.reader(io.StringIO(r.text)))
    head = rows[0]
    check("csv: columns", head == ["start_local", "end_local", "start_utc", "end_utc", "duration_s", "camera", "channel",
                                   "kind", "source", "bookmark_title", "bookmark_severity", "bookmark_note",
                                   "bookmark_author"], head)
    body = rows[1:]
    check("csv: every matching row, not just a page", len(body) == len(ev({"channel": 1, "limit": 5000})), len(body))
    bm = next(x for x in body if x[7] == "bookmark")
    check("csv: formula-looking cells are neutralised", bm[9].startswith("'=") and bm[11].startswith("'+") and bm[12] == "'@ops", bm)
    check("csv: commas, quotes and newlines survive quoting", bm[11] == "'+1 note, with \"quotes\"\nand a newline", bm[11])
    check("csv: recorder-local time", bm[0] == "2026-11-01 05:30:03" and bm[2].startswith("2026-11-01T00:00:03"), bm[:3])
    check("csv: camera name and duration", bm[5] == "Gate" and bm[4] == "0.0" and body[-1][4] == "4.0", (bm[5], bm[4]))
    r = c.get("/api/timeline/events.csv", params={"kind": ["line", "tamper"]})
    kinds = {x[7] for x in list(csv.reader(io.StringIO(r.text)))[1:]}
    check("csv: kind filters apply", kinds == {"line", "tamper"}, kinds)
    old = server.CSV_MAX_ROWS
    server.CSV_MAX_ROWS = 25
    try:
        rows = list(csv.reader(io.StringIO(c.get("/api/timeline/events.csv").text)))
    finally:
        server.CSV_MAX_ROWS = old
    check("csv: capped, and says so in the file", len(rows) == 1 + 25 + 1 and rows[-1][0].startswith("# Stopped at 25"), rows[-1])
    audit = auth.audit_list(5)
    check("csv: audited", any(a["action"] == "events.export_csv" for a in audit), [a["action"] for a in audit])
    server.state["playback"].tz = None
    try:
        r = c.get("/api/timeline/events.csv")
    finally:
        server.state["playback"].tz = IST
    check("csv: 503 until the recorder's clock is known", r.status_code == 503, r.status_code)
    return bid


def cell_escaping():
    check("csv cell: plain", server._csv_cell("Gate") == "Gate")
    check("csv cell: = - + @ tab prefixed", all(server._csv_cell(v).lstrip('"').startswith("'") for v in ("=1", "-1", "+1", "@a", "\tx")))
    check("csv cell: numbers untouched", server._csv_cell(-3) == "-3" and server._csv_cell(None) == "")


def retention_route():
    r = c.get("/api/timeline/retention")
    j = r.json()
    check("retention: per channel, unknown stays null", r.status_code == 200 and j["channels"]["1"]["days"] == 45.0
          and j["channels"]["2"]["oldest_utc"] is None, j)


def bookmark_edit(bid):
    r = c.patch(f"/api/bookmarks/{bid}", json={"title": "Gate left open", "note": "seen twice", "severity": "warning"})
    b = r.json()
    check("bookmark PATCH: updates title/note/severity", r.status_code == 200 and b["title"] == "Gate left open"
          and b["severity"] == "warning" and b["edited_by"] == "Operator" and b["edited_utc"], r.text)
    mirror = json.loads(db.one("SELECT attrs_json FROM events WHERE kind='bookmark' AND json_extract(attrs_json,'$.bookmark_id')=?", (bid,))["attrs_json"])
    check("bookmark PATCH: the timeline row follows", mirror["title"] == "Gate left open" and mirror["severity"] == "warning"
          and mirror["note"] == "seen twice", mirror)
    r = c.patch(f"/api/bookmarks/{bid}", json={"title": "Gate left open again"})
    b = r.json()
    check("bookmark PATCH: a field left out keeps its value", r.status_code == 200 and b["title"] == "Gate left open again"
          and b["note"] == "seen twice" and b["severity"] == "warning", r.text)
    r = c.patch(f"/api/bookmarks/{bid}", json={"title": "x" * 201})
    check("bookmark PATCH: same validation as create (422)", r.status_code == 422, r.status_code)
    r = c.patch(f"/api/bookmarks/{bid}", json={"severity": "apocalyptic"})
    check("bookmark PATCH: bad severity refused", r.status_code == 422, r.status_code)
    r = c.patch("/api/bookmarks/99999", json={"title": "x"})
    check("bookmark PATCH: unknown -> 404", r.status_code == 404, r.status_code)
    check("bookmark PATCH: audited", any(a["action"] == "bookmark.update" for a in auth.audit_list(5)))
    # Two bookmarks at the very same instant on the same camera both get their own timeline row.
    t = (T0 + datetime.timedelta(hours=3)).isoformat()
    a = c.post("/api/bookmarks", json={"channels": ["c1"], "time_utc": t, "title": "A"}).json()["id"]
    b2 = c.post("/api/bookmarks", json={"channels": ["c1"], "time_utc": t, "title": "B"}).json()["id"]
    marks = db.query("SELECT json_extract(attrs_json,'$.bookmark_id') AS b FROM events WHERE kind='bookmark' AND channel=1 AND start_utc LIKE ?",
                     (t[:19] + "%",))
    check("bookmarks: two at the same instant both appear on the timeline", {r["b"] for r in marks} == {a, b2}, [dict(r) for r in marks])
    listed = c.get("/api/bookmarks", params={"channel": 2}).json()
    check("bookmarks: channel filter applied before the limit", all(2 in x["channels"] for x in listed))


def manifest_bookmarks():
    t = T0 + datetime.timedelta(days=5)
    inside = db.create_bookmark([1, 2], (t + datetime.timedelta(seconds=10)).isoformat(), "Inside", "n", "info", "Opal")
    db.create_bookmark([2], (t + datetime.timedelta(seconds=11)).isoformat(), "Other camera", "", "info", "Opal")
    db.create_bookmark([1], (t + datetime.timedelta(seconds=90)).isoformat(), "After", "", "info", "Opal")
    chans = [{"channel": 1, "name": "Gate", "_tz_offset_min": 330}]
    got = exportmod.bookmarks_for_manifest(chans, t.isoformat(), (t + datetime.timedelta(seconds=60)).isoformat())
    check("manifest: bookmarks on the exported cameras inside the range only", [b["title"] for b in got] == ["Inside"], got)
    check("manifest: bookmark carries local time and camera names",
          got and got[0]["time_local"].startswith("2026-11-06T05:30:10") and got[0]["cameras"] == ["Gate"], got)
    job = tempfile.mkdtemp(prefix="se-manifest-")
    from pathlib import Path
    exportmod.EXPORT_DIR = Path(tempfile.mkdtemp(prefix="se-exports-"))
    jd = exportmod.EXPORT_DIR / "job1"
    jd.mkdir()
    exportmod._package_signed(jd, "job1", [], "Opal", t.isoformat(), t.isoformat(), None, bookmarks=got)
    m = json.loads((jd / "manifest.json").read_text())
    check("manifest: bookmarks are signed with it (additive to v2)", m["manifest_version"] == 2 and m["bookmarks"][0]["id"] == inside, m.get("bookmarks"))
    exportmod._package_signed(jd, "job2", [], "Opal", t.isoformat(), t.isoformat(), None, bookmarks=[])
    check("manifest: no bookmarks key when there are none", "bookmarks" not in json.loads((jd / "manifest.json").read_text()))
    del job


def main():
    paging()
    bid = csv_export()
    cell_escaping()
    retention_route()
    bookmark_edit(bid)
    manifest_bookmarks()
    print(f"\n{sum(PASS)}/{len(PASS)} passed")
    sys.exit(0 if all(PASS) else 1)


if __name__ == "__main__":
    main()
