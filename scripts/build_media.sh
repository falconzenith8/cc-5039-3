#!/usr/bin/env bash
# Regenerate the 60s VP9/Opus test asset as separate video/audio WebM chunks.
# The headless Chromium used for E2E ships only open codecs (VP9/Opus); the
# kernel itself is container-agnostic — only these test assets change.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FF="$ROOT/tools/ffmpeg"
OUT="$ROOT/public/media"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DURATION=60

mkdir -p "$WORK/v" "$WORK/a"

# Video: moving test pattern, closed GOP every 30 frames (1s keyframes).
"$FF" -y -f lavfi -i "testsrc2=size=640x360:rate=30:duration=${DURATION}" \
  -map 0:v -c:v libvpx-vp9 -b:v 400k -g 30 -keyint_min 30 -cpu-used 5 -deadline good \
  -f webm_chunk -header "$WORK/v/init.webm" -chunk_start_index 1 \
  "$WORK/v/chunk-%05d.webm" >/dev/null 2>&1

# Audio: 440Hz tone as Opus; ~1s chunks (encoder decides exact frame boundaries).
"$FF" -y -f lavfi -i "sine=frequency=440:duration=${DURATION}:sample_rate=48000" \
  -map 0:a -c:a libopus -b:a 48k \
  -f webm_chunk -header "$WORK/a/init.webm" -chunk_start_index 1 -audio_chunk_duration 1000 \
  "$WORK/a/chunk-%05d.webm" >/dev/null 2>&1

rm -rf "$OUT"
mkdir -p "$OUT/video" "$OUT/audio"
cp "$WORK/v/init.webm" "$OUT/video/init.webm"
cp "$WORK/a/init.webm" "$OUT/audio/init.webm"
cp "$WORK"/v/chunk-*.webm "$OUT/video/"
cp "$WORK"/a/chunk-*.webm "$OUT/audio/"
for f in "$OUT/video"/chunk-*.webm; do mv "$f" "${f/chunk-/video-}"; done
for f in "$OUT/audio"/chunk-*.webm; do mv "$f" "${f/chunk-/audio-}"; done

VCOUNT=$(ls "$OUT/video" | grep -c '\.webm$')
ACOUNT=$(ls "$OUT/audio" | grep -c '\.webm$')

node "$ROOT/scripts/write_manifest.mjs"
echo "built $VCOUNT video + $ACOUNT audio WebM segments (${DURATION}s target; real timeline in manifest)"
