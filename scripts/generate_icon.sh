#!/usr/bin/env bash
# Rasterizes build/icon.svg (the icon's source of truth) into the PNGs
# electron-builder and the .desktop entry consume. Requires rsvg-convert
# (librsvg). Run after any edit to icon.svg and commit the results.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p build/icons
rsvg-convert -w 512 -h 512 build/icon.svg -o build/icons/512x512.png
rsvg-convert -w 256 -h 256 build/icon.svg -o build/icons/256x256.png
rsvg-convert -w 128 -h 128 build/icon.svg -o build/icons/128x128.png

echo "regenerated:"
ls -la build/icons/
