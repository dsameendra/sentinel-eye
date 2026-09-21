#!/bin/zsh
# Stop the server, go2rtc and any relay/ffmpeg it started.
pkill -f "[u]vicorn --app-dir app"; pkill -f "[b]in/go2rtc"; pkill -f "[a]pp/hikrelay.py"; pkill -f "[f]fmpeg.*-f rtsp"
exit 0
