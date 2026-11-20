#!/bin/sh
# Builds the tool's three native helpers as fully static x86-64 Linux binaries
# (musl), so they run on the head unit whatever its glibc is:
#
#   bin/airplay-video   H.264 decoder -> mgu-render frame file (libavcodec)
#   bin/airplay-audio   AAC-ELD / AAC-LC / ALAC decoder -> raw PCM on stdout (libavcodec)
#   bin/fairplay        AirPlay FairPlay key unwrap (playfair, GPL-3)
#
# Needs: Linux (or WSL) with gcc, make, musl-tools, nasm, curl, xz.
#   Ubuntu: sudo apt-get install musl-tools nasm
# Run from anywhere:  sh tools/daniel-airplay/native/build.sh
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../bin"
WORK="${AIRPLAY_BUILD_DIR:-$HOME/airplay-build}"
FFVER=7.1.1
FFPREFIX="$WORK/ffmpeg-$FFVER-musl-av"   # -av: H.264 + AAC + ALAC decoders
mkdir -p "$WORK" "$OUT"

if [ ! -f "$FFPREFIX/lib/libavcodec.a" ]; then
  cd "$WORK"
  [ -d "ffmpeg-$FFVER" ] || curl -sSfL "https://ffmpeg.org/releases/ffmpeg-$FFVER.tar.xz" | tar xJ
  cd "ffmpeg-$FFVER"
  if [ -f config.h ]; then make distclean >/dev/null 2>&1 || true; fi
  ./configure --cc=musl-gcc --arch=x86_64 --prefix="$FFPREFIX" \
    --enable-static --disable-shared --disable-programs --disable-doc \
    --disable-everything --enable-decoder=h264,aac,alac --enable-parser=h264 \
    --disable-network --disable-autodetect --disable-avdevice --disable-avformat \
    --disable-swresample --disable-swscale --disable-avfilter >"$WORK/ffconfigure.log" 2>&1
  make -j"$(nproc)" >"$WORK/ffmake.log" 2>&1
  make install >/dev/null
fi

for helper in airplay-video airplay-audio; do
  musl-gcc -O2 -static -s -Wall -Wno-unused-result \
    -I"$FFPREFIX/include" -o "$OUT/$helper" "$HERE/$helper.c" "$HERE/ffmpeg_stubs.c" \
    "$FFPREFIX/lib/libavcodec.a" "$FFPREFIX/lib/libavutil.a" -lm -lpthread
done

musl-gcc -O2 -static -s -w -o "$OUT/fairplay" "$HERE/fairplay_cli.c" \
  "$HERE/playfair/playfair.c" "$HERE/playfair/omg_hax.c" "$HERE/playfair/hand_garble.c" \
  "$HERE/playfair/modified_md5.c" "$HERE/playfair/sap_hash.c"

ls -l "$OUT/airplay-video" "$OUT/airplay-audio" "$OUT/fairplay"
file "$OUT/airplay-video" "$OUT/airplay-audio" "$OUT/fairplay" 2>/dev/null || true
