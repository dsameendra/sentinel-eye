#!/usr/bin/env bash
# Kept for muscle memory: same as ./run.sh stop (pass --native/--docker to pick the mode).
exec "$(dirname "$0")/run.sh" "$@" stop
