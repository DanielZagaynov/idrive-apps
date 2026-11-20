/*
 * Test-only: writes test/fixtures/tone-eld.bin, a 2 s 1 kHz (left) / 500 Hz
 * (right) stereo tone encoded the way an iPhone sends mirroring audio:
 * AAC-ELD, 44100 Hz, 480 samples per frame, no SBR, raw frames.
 * File format: repeated { u16le length, frame }. Prints the encoder's
 * AudioSpecificConfig, which must equal what airplay-audio builds (f8e85000).
 *
 * Not shipped. Built against Fraunhofer fdk-aac by test/tools/make-fixtures.sh.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "aacenc_lib.h"

int main(int argc, char **argv)
{
    if (argc < 2) { fprintf(stderr, "usage: eld-encoder out.bin\n"); return 2; }
    HANDLE_AACENCODER h;
    if (aacEncOpen(&h, 0, 2) != AACENC_OK) return 1;
    aacEncoder_SetParam(h, AACENC_AOT, AOT_ER_AAC_ELD);
    aacEncoder_SetParam(h, AACENC_SAMPLERATE, 44100);
    aacEncoder_SetParam(h, AACENC_CHANNELMODE, MODE_2);
    aacEncoder_SetParam(h, AACENC_GRANULE_LENGTH, 480);
    aacEncoder_SetParam(h, AACENC_SBR_MODE, 0);
    aacEncoder_SetParam(h, AACENC_TRANSMUX, TT_MP4_RAW);
    aacEncoder_SetParam(h, AACENC_BITRATE, 96000);
    if (aacEncEncode(h, NULL, NULL, NULL, NULL) != AACENC_OK) return 1;
    AACENC_InfoStruct info;
    aacEncInfo(h, &info);
    printf("asc ");
    for (UINT i = 0; i < info.confSize; i++) printf("%02x", info.confBuf[i]);
    printf("\nframeLength %u\n", info.frameLength);

    FILE *out = fopen(argv[1], "wb");
    if (!out) return 1;
    const int total = 44100 * 2;
    int16_t pcm[480 * 2];
    uint8_t outbuf[2048];
    int frames = 0;
    for (int pos = 0; pos < total + 480 * 4; pos += 480) {
        for (int i = 0; i < 480; i++) {
            int n = pos + i;
            double t = (double)n / 44100.0;
            pcm[i * 2] = n < total ? (int16_t)(12000 * sin(2 * M_PI * 1000 * t)) : 0;
            pcm[i * 2 + 1] = n < total ? (int16_t)(12000 * sin(2 * M_PI * 500 * t)) : 0;
        }
        void *inPtr = pcm, *outPtr = outbuf;
        INT inId = IN_AUDIO_DATA, outId = OUT_BITSTREAM_DATA;
        INT inSize = sizeof(pcm), outSize = sizeof(outbuf), inElSize = 2, outElSize = 1;
        AACENC_BufDesc inDesc = { 1, &inPtr, &inId, &inSize, &inElSize };
        AACENC_BufDesc outDesc = { 1, &outPtr, &outId, &outSize, &outElSize };
        AACENC_InArgs inArgs = { 480 * 2, 0 };
        AACENC_OutArgs outArgs;
        memset(&outArgs, 0, sizeof(outArgs));
        if (aacEncEncode(h, &inDesc, &outDesc, &inArgs, &outArgs) != AACENC_OK) return 1;
        if (outArgs.numOutBytes > 0) {
            uint8_t len[2] = { (uint8_t)outArgs.numOutBytes, (uint8_t)(outArgs.numOutBytes >> 8) };
            fwrite(len, 1, 2, out);
            fwrite(outbuf, 1, (size_t)outArgs.numOutBytes, out);
            frames++;
        }
    }
    fclose(out);
    aacEncClose(&h);
    printf("frames %d\n", frames);
    return 0;
}
