#!/usr/bin/env bash
# Extract ALL sprite frames from sprite.png for verification.
# Usage: extract-sprite-frames.sh [SRC] [OUT_DIR] [GRID]
#   GRID = 8x8 (default, 128x128) or 4x8 (256x128)
# Sheet: 1024x1024.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$ROOT/app/public/images/sprite.png}"
OUT="${2:-$ROOT/app/public/images/sprite-frames}"
GRID="${3:-8x8}"

case "$GRID" in
  8x8)  W=128; H=128; COLS=8; ROWS=8 ;;
  4x8)  W=256; H=128; COLS=4; ROWS=8 ;;
  *)    echo "GRID must be 8x8 or 4x8" >&2; exit 1 ;;
esac

mkdir -p "$OUT"
echo "Extracting ${COLS}x${ROWS} grid (${W}x${H} each) from $(basename "$SRC") -> $OUT (grid $GRID)..."
for row in $(seq 0 $((ROWS-1))); do
  for col in $(seq 0 $((COLS-1))); do
    x=$(( col * W ))
    y=$(( row * H ))
    outname="r${row}c${col}.png"
    magick "$SRC" -crop "${W}x${H}+${x}+${y}" +repage "$OUT/$outname"
  done
done
echo "Extracted $((COLS*ROWS)) frames to $OUT/"
ls "$OUT" | wc -l
