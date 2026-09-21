#!/bin/zsh
# Stop go2rtc, the relay and their ffmpeg pushers.
pkill -f "[b]in/go2rtc"; pkill -f "[a]pp/hikrelay"; pkill -f "[f]fmpeg.*-f rtsp"; pkill -f "[.]/run[.]sh"
exit 0
