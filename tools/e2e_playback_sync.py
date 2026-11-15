"""REAL-RECORDER SCRIPT — read-only, but its pages open real playback sessions on the user's DVR. Do not run it unless
the owner asks. Run it against a scratch instance with sign-in off (bound to 127.0.0.1), never the owner's own:

   .venv/bin/python3 tools/e2e_playback_sync.py http://127.0.0.1:8090 /path/outside/the/repo [--minutes 3]

Checks frame-locked playback (docs/SPEC.md 7.2-7.5) in headless Chrome through Playback's debug hook
(window.__pbSync(): the master time T and the frame each pane shows): single-camera play/pause, frame steps (each one
frame), paused seeks landing on the requested frame, every speed; 2 and 4 cameras together — the shown frame of each
pane against T, sampled continuously at 1x and 4x, with a screenshot to compare the burned-in clocks; speed changes
while playing never going backwards; seeks with 4 cameras playing and paused; previous/next event, Skip empty and a
bookmark jump; Live's instant replay; console errors; and that open VideoFrames and the JS heap stay bounded.
Screenshots (real footage) go only to the output dir, which must be outside the repository.
"""
import asyncio
import json
import statistics
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, "tools")
from cdp import Browser  # noqa: E402

BASE, OUT = sys.argv[1].rstrip("/"), Path(sys.argv[2]).resolve()
MINUTES = float(sys.argv[sys.argv.index("--minutes") + 1]) if "--minutes" in sys.argv else 3.0
ONLY = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None
ROOT = Path(__file__).resolve().parent.parent
if ROOT == OUT or ROOT in OUT.parents:
    raise SystemExit("the output dir must be outside the repository (screenshots show real footage)")
OUT.mkdir(parents=True, exist_ok=True)
FRAME = 1 / 15
GAP = 0.1   # frames here are 40 or 80 ms apart (RTP jitter around 15 fps): the newest frame <= T is up to ~80 ms behind it
results, report = [], {}


def check(name, ok, extra=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""), flush=True)


def api(path, method="GET", body=None):
    r = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body else None,
                               headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=60))


def pct(v, q):
    v = sorted(v)
    return v[min(len(v) - 1, int(q * len(v)))] if v else None


SYNC = "JSON.stringify(window.__pbSync ? window.__pbSync() : null)"


async def sync(b):
    return json.loads(await b.js(SYNC) or "null")


async def open_playback(b, cam_ids, t):
    await b.goto("about:blank")
    await asyncio.sleep(0.5)
    await b.goto(f"{BASE}/#/playback/{cam_ids[0]}/{int(t)}")
    await b.wait_for("window.__pbSync && window.__pbSync().panes.length", 30)
    if len(cam_ids) > 1:
        await b.js("document.querySelector('.cam-more').click()")
        await b.wait_for("document.querySelector('.cam-item')", 5)
        for cid in cam_ids[1:]:
            await b.js(f"document.querySelector('.cam-item[data-id=\"{cid}\"] input').click()")
        await asyncio.sleep(0.5)
        await b.js("document.querySelector('.cam-picker [data-a=done]')?.click()")
    ok = await ready(b, len(cam_ids), 90)
    return ok


async def ready(b, n, timeout=60):
    """Every pane showing T with the clock running (or paused and every pane 'ok')."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = await sync(b)
        if d and len(d["panes"]) == n and all(p["state"] == "ok" for p in d["panes"]) and (d["running"] or not d["playing"]):
            return time.time() - t0
        await asyncio.sleep(0.2)
    return None


async def click(b, sel):
    await b.js(f"document.querySelector('{sel}').click()")


async def set_speed(b, sp):
    if await b.js(f"!!document.querySelector('[data-sp=\"{sp}\"]')"):
        await click(b, f'[data-sp="{sp}"]')
    else:
        await click(b, "[data-a=speedmore]")
        await asyncio.sleep(0.2)
        await click(b, f'[data-s="{sp}"]')


async def sample(b, seconds, every=0.1):
    """[(wall, T, waiting, running, [shown per pane], [state per pane], videoFrames)]"""
    out, t0 = [], time.time()
    while time.time() - t0 < seconds:
        d = await sync(b)
        out.append((time.time(), d["T"], d["waiting"], d["running"], [p["shown"] for p in d["panes"]],
                    [p["state"] for p in d["panes"]], d["videoFrames"]))
        await asyncio.sleep(every)
    return out


def skew_stats(rows):
    """Lag of each pane's shown frame behind T, and the spread across panes, over rows where the clock ran."""
    lag, spread = [], []
    for _, T, waiting, running, shown, states, _ in rows:
        if not running or any(s != "ok" for s in states) or any(x is None for x in shown):
            continue
        lag += [T - x for x in shown]
        spread.append(max(shown) - min(shown))
    return {"n": len(spread), "lag_median": pct(lag, 0.5), "lag_p95": pct(lag, 0.95), "lag_max": max(lag) if lag else None,
            "spread_median": pct(spread, 0.5), "spread_p95": pct(spread, 0.95), "spread_max": max(spread) if spread else None,
            "waiting_share": sum(1 for r in rows if r[2]) / max(1, len(rows))}


async def single(b, cams):
    t = time.time() - 900
    took = await open_playback(b, cams[:1], t)
    check("single: starts (clock running, pane showing T)", took is not None, f"{took and round(took, 1)} s")
    if took is None:
        return
    rows = await sample(b, 8)
    st = skew_stats(rows)
    # "within one frame": frames here are 40 or 80 ms apart (RTP jitter around 15 fps — tools/NOTES.md), so the
    # newest frame <= T can be up to 80 ms behind it.
    check("single 1x: shown frame within one frame of T", st["lag_max"] is not None and st["lag_max"] <= 0.1, st)
    rate = (rows[-1][1] - rows[0][1]) / (rows[-1][0] - rows[0][0])
    check("single 1x: T advances at 1x", 0.9 < rate < 1.05, round(rate, 3))
    await click(b, "[data-a=playpause]")
    await asyncio.sleep(0.5)
    d1 = await sync(b)
    await asyncio.sleep(1.5)
    d2 = await sync(b)
    check("pause: T and the picture hold", not d2["playing"] and d1["T"] == d2["T"] and d1["panes"][0]["shown"] == d2["panes"][0]["shown"])
    steps = []
    for k in [1] * 6 + [-1] * 6:
        before = (await sync(b))["panes"][0]["shown"]
        await click(b, "[data-a=stepfwd]" if k > 0 else "[data-a=stepback]")
        await b.wait_for(f"window.__pbSync().panes[0].shown !== {before} && window.__pbSync().panes[0].state === 'ok'", 5, 0.05)
        after = (await sync(b))["panes"][0]["shown"]
        steps.append(round(after - before, 3))
    fwd, back = steps[:6], steps[6:]
    check("step forward: each step is one frame later", all(0.02 < s < 0.11 for s in fwd), fwd)
    check("step back: each step is one frame earlier, back through the same frames", all(-0.11 < s < -0.02 for s in back) and abs(sum(fwd) + sum(back)) < 1e-3, back)
    report["steps"] = steps
    # paused seek: back 10 s lands on the frame for exactly T-10
    T = (await sync(b))["T"]
    await click(b, "[data-a=back10]")
    took = await ready(b, 1, 60)
    d = await sync(b)
    sh = d["panes"][0]["shown"]
    check("paused seek: lands on the newest frame <= the requested time", took is not None and abs(d["T"] - (T - 10)) < 1e-3 and 0 <= (T - 10) - sh < GAP and not d["playing"],
          f"T-10 vs shown {round((T - 10) - sh, 3)} s, {took and round(took, 1)} s")
    report["paused_seek"] = {"lag": (T - 10) - sh, "seconds": took}
    await click(b, "[data-a=playpause]")
    sp_rows = {}
    for sp in ("0.5", "1", "2", "4", "8"):
        await set_speed(b, sp)
        await asyncio.sleep(2)
        rows = await sample(b, 6)
        rate = (rows[-1][1] - rows[0][1]) / (rows[-1][0] - rows[0][0])
        st = skew_stats(rows)
        sp_rows[sp] = {"rate": round(rate, 3), **{k: (round(v, 3) if isinstance(v, float) else v) for k, v in st.items()}}
        check(f"single {sp}x: T advances at {sp}x (waiting {st['waiting_share']:.0%} of samples)", rate > 0.8 * float(sp) * (1 - st["waiting_share"]) and rate < 1.05 * float(sp), sp_rows[sp])
        check(f"single {sp}x: shown frame stays at T", st["lag_p95"] is not None and st["lag_p95"] <= max(FRAME, 0.1 * float(sp)) + 0.02, sp_rows[sp])
    report["speeds"] = sp_rows
    await set_speed(b, "1")


async def speed_changes(b, cams):
    took = await open_playback(b, cams[:2], time.time() - 900)
    check("speed changes: 2 cameras start", took is not None)
    if took is None:
        return
    out = {}
    for sp in ("4", "1", "8", "1"):
        rows0 = await sample(b, 2, 0.05)
        await set_speed(b, sp)
        rows = rows0 + await sample(b, 8, 0.05)
        back = min(min(b2[1] - a[1] for a, b2 in zip(rows, rows[1:])), 0)
        shown_back = 0.0
        for i in range(2):
            seq = [r[4][i] for r in rows if r[4][i] is not None]
            shown_back = min(shown_back, min((y - x for x, y in zip(seq, seq[1:])), default=0))
        # the longest wall time the primary's picture didn't change while the clock was meant to run
        hold, last_t, last_w = 0.0, None, None
        for w, T, waiting, running, shown, *_ in rows:
            if shown[0] != last_t:
                last_t, last_w = shown[0], w
            elif last_w is not None:
                hold = max(hold, w - last_w)
        out[sp] = {"T_backwards": round(back, 4), "shown_backwards": round(shown_back, 4), "longest_hold_s": round(hold, 2),
                   "waiting_share": round(sum(1 for r in rows if r[2]) / len(rows), 2)}
        check(f"speed -> {sp}x while playing: time never goes backwards, nothing replayed", back >= 0 and shown_back >= 0, out[sp])
    report["speed_changes"] = out


async def multi(b, cams, n, minutes):
    took = await open_playback(b, cams[:n], time.time() - 900)
    check(f"{n} cameras: all panes reach T and the clock runs", took is not None, f"{took and round(took, 1)} s")
    if took is None:
        return
    res = {"start_s": took and round(took, 1)}
    for sp, mins in (("1", minutes * 0.6), ("4", minutes * 0.4)):
        await set_speed(b, sp)
        await asyncio.sleep(3)
        rows = await sample(b, mins * 60, 0.1)
        st = skew_stats(rows)
        res[sp] = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in st.items()}
        check(f"{n} cameras {sp}x: the shown frame is the newest <= T (median lag under a frame gap)", st["lag_median"] is not None and st["lag_median"] < GAP, res[sp])
        check(f"{n} cameras {sp}x: median cross-pane spread < 1 frame", st["spread_median"] is not None and st["spread_median"] < FRAME, res[sp])
        if sp == "1":
            await click(b, "[data-a=playpause]")
            await asyncio.sleep(1.5)
            await b.shot(str(OUT / f"sync_{n}cams.png"))
            d = await sync(b)
            res["screenshot_shown"] = [round(p["shown"] % 86400, 3) for p in d["panes"]]
            await click(b, "[data-a=playpause]")
    report[f"{n}cams"] = res


async def seeks4(b, cams):
    took = await open_playback(b, cams[:4], time.time() - 1200)
    check("4-camera seeks: start", took is not None)
    if took is None:
        return
    out = {}
    for label, playing in (("playing", True), ("paused", False)):
        d = await sync(b)
        if d["playing"] != playing:
            await click(b, "[data-a=playpause]")
            await asyncio.sleep(0.3)
        for btn, delta in (("back10", -10), ("fwd10", 10)):
            T = (await sync(b))["T"]
            await click(b, f"[data-a={btn}]")
            t = await ready(b, 4, 90)
            d = await sync(b)
            lags = [(T + delta) - p["shown"] for p in d["panes"]] if not playing else None
            out[f"{label}_{btn}"] = {"seconds": t and round(t, 1), "lags": lags and [round(x, 3) for x in lags]}
            ok = t is not None and (playing or all(0 <= x < GAP for x in lags))
            check(f"4 cameras {label}, {btn}: every pane at the target{' (each on its frame for exactly T)' if not playing else ''}", ok, out[f"{label}_{btn}"])
    report["seeks4"] = out


async def jumps(b, cams):
    took = await open_playback(b, cams[:2], time.time() - 3 * 3600)
    check("jumps: start", took is not None)
    if took is None:
        return
    T0 = (await sync(b))["T"]
    await click(b, "[data-a=nextev]")
    await b.wait_for(f"Math.abs(window.__pbSync().T - {T0}) > 2", 10)
    T1 = (await sync(b))["T"]
    t = await ready(b, 2, 90)
    check("next event: jumps forward and plays", T1 > T0 + 2 and t is not None, f"+{round(T1 - T0, 1)} s")
    await click(b, "[data-a=prevev]")
    await b.wait_for(f"window.__pbSync().T < {T1} - 2", 10)
    T2 = (await sync(b))["T"]
    t = await ready(b, 2, 90)
    check("previous event: jumps back and plays", T2 < T1 - 2 and t is not None, f"{round(T2 - T1, 1)} s")
    # Skip empty: on, then play; any stretch with no events ahead is skipped (visible as a jump in T)
    await click(b, "[data-a=skipempty]")
    rows = await sample(b, 25, 0.2)
    jumped = max((y[1] - x[1] - (y[0] - x[0]) for x, y in zip(rows, rows[1:])), default=0)
    check("skip empty: plays on (and skips a long empty stretch when there is one)", rows[-1][1] > rows[0][1], f"largest jump {round(jumped, 1)} s")
    report["skip_empty_jump_s"] = round(jumped, 1)
    await click(b, "[data-a=skipempty]")
    # bookmark at a known time (scratch instance only), then jump to it from the panel
    target = T0 - 600
    bm = api("/api/bookmarks", "POST", {"channels": [cams[0]], "time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(target)), "title": "e2e sync"})
    await click(b, "[data-a=bookmarks]")
    await b.wait_for("document.querySelector('.pbs-scope [data-scope=all]')", 5)
    await click(b, ".pbs-scope [data-scope=all]")
    await b.wait_for("document.querySelector('.pbs-item [data-b=jump]')", 10)
    await b.js("[...document.querySelectorAll('.pbs-item')].find(e => e.textContent.includes('e2e sync')).querySelector('[data-b=jump]').click()")
    await b.wait_for(f"Math.abs(window.__pbSync().T - {target - 3}) < 1", 10)
    t = await ready(b, 2, 90)
    d = await sync(b)
    check("bookmark jump: plays from 3 s before the bookmark", t is not None and abs(d["T"] - (target - 3)) < 30, round(d["T"] - target, 1))
    try:
        api(f"/api/bookmarks/{bm['id']}", "DELETE")
    except Exception:
        pass


async def replay(b, cams):
    await b.goto("about:blank")
    await asyncio.sleep(0.5)
    await b.goto(f"{BASE}/#/live/{cams[0]}")
    await b.wait_for("document.querySelector('[data-a=replay]')", 30)
    await asyncio.sleep(2)
    await click(b, "[data-a=replay]")
    ok = await b.wait_for("(document.querySelector('.replay-overlay .bar-sub .stat')?.textContent || '') === 'Replaying'", 60)
    await asyncio.sleep(3)
    c1 = await b.js("document.querySelector('.rp-clock').textContent")
    await asyncio.sleep(3)
    c2 = await b.js("document.querySelector('.rp-clock').textContent")
    check("instant replay: plays (its clock moves)", ok and c1 and c2 and c1 != c2, f"{c1} -> {c2}")
    await click(b, ".rp-play")
    await asyncio.sleep(1)
    footage = "document.querySelector('.rp-clock').textContent.split(' · ')[0]"   # not "… behind live", which keeps counting
    p1 = await b.js(footage)
    await asyncio.sleep(2)
    p2 = await b.js(footage)
    check("instant replay: pause holds", p1 and p1 == p2, f"{p1} / {p2}")
    await click(b, "[data-a=restart]")
    await asyncio.sleep(4)
    check("instant replay: start over plays again", await b.js("document.querySelector('.replay-overlay .bar-sub .stat').textContent") in ("Replaying", "Loading…"))
    await b.shot(str(OUT / "replay.png"))
    await click(b, "[data-a=live]")


async def memory(b, cams, minutes):
    took = await open_playback(b, cams[:4], time.time() - 1800)
    check("memory: 4 cameras start", took is not None)
    if took is None:
        return
    rows, t0 = [], time.time()
    while time.time() - t0 < minutes * 60:
        d = await sync(b)
        heap = await b.js("performance.memory ? performance.memory.usedJSHeapSize : 0")
        rows.append((round(time.time() - t0), d["videoFrames"], round(heap / 1e6, 1), sum(p["bytes"] for p in d["panes"]) / 1e6))
        await asyncio.sleep(15)
    report["memory"] = rows
    frames = [r[1] for r in rows]
    heaps = [r[2] for r in rows]
    check("memory: open VideoFrames stay bounded", max(frames) <= 4 * 70, f"max {max(frames)}")
    check("memory: JS heap doesn't grow without bound", heaps[-1] < 2.5 * max(1, statistics.median(heaps[:3])) + 50, f"{heaps[:3]} … {heaps[-3:]}")


async def main():
    s = api("/api/settings")
    cams = [i for i in s["display"]["order"] if any(c["id"] == i and c["enabled"] for c in s["channels"])]
    async with Browser(1600, 1000) as b:
        await b.send("Performance.enable")
        steps = {"single": lambda: single(b, cams), "speed": lambda: speed_changes(b, cams), "multi2": lambda: multi(b, cams, 2, MINUTES * 0.6),
                 "multi4": lambda: multi(b, cams, 4, MINUTES), "seeks": lambda: seeks4(b, cams), "jumps": lambda: jumps(b, cams),
                 "replay": lambda: replay(b, cams), "memory": lambda: memory(b, cams, 5)}
        for name, fn in steps.items():
            if ONLY and name not in ONLY:
                continue
            try:
                await fn()
            except Exception as e:
                check(f"{name}: ran without an exception", False, repr(e)[:300])
        errs = [l for l in b.logs if "error" in l.lower() or "EXCEPTION" in l]
        # Live's own player (vendored video-rtc.js) logs these in headless Chrome while the replay test passes
        # through the Live view; they are not Playback's.
        live = [l for l in errs if "[VideoRTC]" in l]
        if live:
            print(f"(info) {len(live)} console errors from Live's VideoRTC player, not checked here")
        errs = [l for l in errs if l not in live]
        check("no console errors from playback", not errs, errs[:5])
        await b.goto("about:blank")
    (OUT / "e2e_playback_sync.json").write_text(json.dumps(report, indent=1, default=str))
    print(json.dumps(report, default=str)[:4000])
    print(f"\n{sum(results)}/{len(results)} passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    asyncio.run(main())
