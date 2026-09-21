#!/bin/zsh
# Isolated test rig: a fake UNENCRYPTED camera (go2rtc test pattern) + a second Sentinel Eye instance
# with its own settings/ports, so UI tests can edit settings without touching the real recorder.
#   tools/test_rig.sh start   -> app on http://127.0.0.1:8081 (3 fake channels)
#   tools/test_rig.sh stop
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
RIG=/tmp/sentinel-rig
case "$1" in
start)
  "$0" stop >/dev/null 2>&1; rm -rf $RIG; mkdir -p $RIG/data
  cat > $RIG/fake.yaml <<'YAML'
api: {listen: "127.0.0.1:1990"}
rtsp: {listen: "127.0.0.1:8654"}
webrtc: {listen: ":8656"}
streams:
  cam_sub: "ffmpeg:virtual?video=testsrc&size=960x480&fps=12#video=h264"
  cam_main: "ffmpeg:virtual?video=testsrc2&size=1920x1080&fps=15#video=h265"
YAML
  (nohup ./bin/go2rtc -config $RIG/fake.yaml > $RIG/fake.log 2>&1 &)
  # settings for the scratch app: unencrypted, pointing at the fake camera (never at the real DVR)
  .venv/bin/python - <<PY
import json
chans=[dict(id=f"t{i}",channel=i,name=f"Fake {c}",enabled=True,sub_fps="auto",main_fps="auto",sub_path="/cam_sub",main_path="/cam_main") for i,c in enumerate("ABC",1)]
json.dump(dict(connection=dict(host="127.0.0.1",rtsp_port=8654,http_port=80,username="u",password="p",encrypted=False,key=""),
  channels=chans,display=dict(layout="3x3",quality="auto",main_codec="h264",fit="contain",rotate_seconds=0,theme="auto",order=[c["id"] for c in chans])),open("$RIG/data/settings.json","w"))
PY
  (SENTINEL_DATA=$RIG/data SENTINEL_API_PORT=1994 SENTINEL_RTSP_PORT=8664 SENTINEL_WEBRTC_PORT=8665 \
    nohup .venv/bin/uvicorn --app-dir app server:app --host 127.0.0.1 --port 8081 > $RIG/app.log 2>&1 &)
  sleep 6; echo "rig up: http://127.0.0.1:8081";;
stop)
  pkill -f "[u]vicorn --app-dir app server:app --host 127.0.0.1 --port 8081"; pkill -f "[g]o2rtc -config $RIG"
  pkill -f "[b]in/go2rtc -config $RIG"; true;;
*) echo "usage: $0 start|stop";;
esac
