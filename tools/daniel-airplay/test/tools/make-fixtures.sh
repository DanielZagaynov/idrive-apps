#!/bin/sh
# Test-only: rebuilds test/fixtures/tone-eld.bin with Fraunhofer fdk-aac's
# AAC-ELD encoder (FFmpeg has no ELD encoder). The fixture is committed, so
# this only needs running to change it.
#   FDK=<fdk-aac source checkout> sh tools/daniel-airplay/test/tools/make-fixtures.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
FDK="${FDK:?set FDK to an fdk-aac source checkout}"
WORK="${AIRPLAY_BUILD_DIR:-$HOME/airplay-build}/fdk-eld"
mkdir -p "$WORK"
INC=""
for d in "$FDK"/lib*/include; do INC="$INC -I$d"; done
if [ ! -f "$WORK/libfdk.a" ]; then
  cd "$WORK"
  for f in "$FDK"/lib*/src/*.cpp; do
    g++ -O1 -w $INC -c "$f" -o "$(basename "$f" .cpp).o"
  done
  ar rcs libfdk.a ./*.o
fi
g++ -O1 -w -x c++ $INC -o "$WORK/eld-encoder" "$HERE/eld-encoder.c" "$WORK/libfdk.a" -lm
"$WORK/eld-encoder" "$HERE/../fixtures/tone-eld.bin"
