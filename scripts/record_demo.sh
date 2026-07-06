#!/usr/bin/env bash
# Records the README demo GIF. Fully reproducible: Xvfb display + ffmpeg
# x11grab around scripts/demo-session.mjs (which drives the BUILT app —
# run `npm run build` first). Output: .github/assets/demo.gif.
#
# Requirements: Xvfb, ffmpeg, xterm, a built app in out/.
set -euo pipefail
cd "$(dirname "$0")/.."

DISPLAY_NUM="${DEMO_DISPLAY:-:97}"
SIZE=1280x720
WORK="$(mktemp -d)"
export DEMO_READY_FILE="$WORK/ready"
export DEMO_GO_FILE="$WORK/go"
trap 'kill "$FFMPEG_PID" "$NODE_PID" "$XVFB_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

[ -f out/main/index.js ] || { echo "record_demo: run npm run build first" >&2; exit 1; }

# Clear residue from crashed prior runs of THIS pipeline. Only this script ever
# creates /dev/shm/amnesic-browser-demo-* dirs, so removing them is safe and
# keeps the epilogue's residue count honest (it must not count stale sessions).
rm -rf /dev/shm/amnesic-browser-demo-*

Xvfb "$DISPLAY_NUM" -screen 0 "${SIZE}x24" &
XVFB_PID=$!
sleep 1

# Launch the driver first, then wait until it reports the window is up and
# sized (DEMO_READY_FILE) before starting ffmpeg — otherwise the GIF opens on
# a black frame. The driver then waits for DEMO_GO_FILE before the first beat.
DISPLAY="$DISPLAY_NUM" node scripts/demo-session.mjs &
NODE_PID=$!

for _ in $(seq 1 300); do
  [ -f "$DEMO_READY_FILE" ] && break
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "record_demo: demo-session.mjs exited before signalling ready" >&2
    exit 1
  fi
  sleep 0.1
done
[ -f "$DEMO_READY_FILE" ] || { echo "record_demo: timed out waiting for window" >&2; exit 1; }

ffmpeg -loglevel error -y -f x11grab -video_size "$SIZE" -framerate 15 \
  -i "$DISPLAY_NUM" "$WORK/demo.mp4" &
FFMPEG_PID=$!
sleep 0.5
touch "$DEMO_GO_FILE"

wait "$NODE_PID"

# Stop the recording cleanly (ffmpeg finalizes the file on SIGINT).
kill -INT "$FFMPEG_PID"
wait "$FFMPEG_PID" || true
kill "$XVFB_PID" 2>/dev/null || true

# Trim the final ~0.8 s: after the xterm exits there are a few black frames
# before ffmpeg stops, and the looping GIF must not end on black. Cut against
# the source duration (pre-speedup) so the same window is dropped in both passes.
DURATION="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$WORK/demo.mp4")"
CUT="$(awk -v d="$DURATION" 'BEGIN { c = d - 0.8; print (c > 0 ? c : d) }')"

# mp4 -> gif: 1.4x speed to land in the 20–30 s window, two-pass palette,
# 960 px wide to keep the README asset under a few MB.
ffmpeg -loglevel error -y -t "$CUT" -i "$WORK/demo.mp4" \
  -vf "setpts=PTS/1.4,fps=10,scale=960:-1:flags=lanczos,palettegen" "$WORK/palette.png"
ffmpeg -loglevel error -y -t "$CUT" -i "$WORK/demo.mp4" -i "$WORK/palette.png" \
  -lavfi "setpts=PTS/1.4,fps=10,scale=960:-1:flags=lanczos [x]; [x][1:v] paletteuse" \
  .github/assets/demo.gif

echo "record_demo: wrote .github/assets/demo.gif ($(du -h .github/assets/demo.gif | cut -f1))"
