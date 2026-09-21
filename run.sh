#!/bin/zsh
# Starts go2rtc (web UI + WebRTC/MSE) and the decrypting relay for all 8 channels.
cd "$(dirname "$0")"; set -a; source .env; set +a
trap 'kill $(jobs -p) 2>/dev/null; pkill -f "ffmpeg.*-f rtsp"' EXIT INT TERM
./bin/go2rtc -config config/go2rtc.yaml > go2rtc.log 2>&1 &
sleep 2
.venv/bin/python app/hikrelay.py cam1:102 cam2:202 cam3:302 cam4:402 cam5:502 cam6:602 cam7:702 cam8:802 > relay.log 2>&1 &
wait
