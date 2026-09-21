"""Server-side load test on the real recorder: N concurrent HD consumers, per-stream arrival gaps."""
import sys, threading, time, urllib.request, statistics, subprocess
N, SECS = int(sys.argv[1]) if len(sys.argv) > 1 else 8, int(sys.argv[2]) if len(sys.argv) > 2 else 60
KIND = sys.argv[3] if len(sys.argv) > 3 else "main_h264"
res = {}
def run(i):
    name = f"c{i}_{KIND}"
    t0 = time.time(); ts = []; total = 0
    try:
        r = urllib.request.urlopen(f"http://127.0.0.1:1984/api/stream.mp4?src={name}", timeout=40)
        while time.time() - t0 < SECS:
            d = r.read1(65536)
            if not d: break
            ts.append(time.time() - t0); total += len(d)
        r.close()
    except Exception as e:
        res[name] = f"ERROR {e}"; return
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    res[name] = (ts[0] if ts else None, total / SECS / 1024, max(gaps) if gaps else None, sum(g > 1.0 for g in gaps), len(ts))
threads = [threading.Thread(target=run, args=(i,)) for i in range(1, N + 1)]
for t in threads: t.start(); time.sleep(0.3)
time.sleep(SECS / 2)
print("CPU (mid-test):", subprocess.run("top -l 2 -n 14 -o cpu -stats command,cpu | tail -15", shell=True, capture_output=True, text=True).stdout.replace("\n", " | ")[:330])
for t in threads: t.join()
bad = 0
for k in sorted(res):
    v = res[k]
    if isinstance(v, str): print(k, v); bad += 1; continue
    first, kbs, mx, big, n = v
    flag = "" if (mx is not None and mx < 3 and first is not None and first < 15) else "   <-- PROBLEM"
    bad += bool(flag)
    print(f"{k:14s} first data {first:5.1f}s  {kbs:6.0f} KB/s  max gap {mx:4.1f}s  gaps>1s: {big}{flag}")
print("RESULT:", "all streams steady" if not bad else f"{bad} stream(s) with problems")
