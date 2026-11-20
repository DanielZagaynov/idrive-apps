/*
 * airplay-audio: decode the AirPlay audio stream (AAC-ELD while mirroring,
 * AAC-LC or ALAC otherwise) to raw PCM on stdout: signed 16-bit little-endian,
 * interleaved stereo, at the stream's rate (44100 Hz from an iPhone).
 *
 *   airplay-audio | <player reading raw PCM on stdin>
 *
 * stdin carries messages from lib/audio-sink.js (little-endian):
 *   u8 type, u32 length, payload
 *   1 config: u8 ct, u8 channels, u16 samples per frame, u32 sample rate
 *             ct: 2 = ALAC, 4 = AAC-LC, 8 = AAC-ELD (AirPlay's "compression type")
 *   2 packet: one decrypted audio frame (raw, no ADTS)
 *   3 volume: float32 linear gain 0..1
 *   4 flush:  drop decoder state (the phone paused or seeked)
 *
 * It parses data that came off the network, so it runs as nobody. Built
 * fully static (musl) against the same minimal libavcodec as airplay-video:
 * see native/build.sh.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>

#define MAX_MSG (1024u * 1024u)
#define MAX_SAMPLES 8192
#define OUT_CHANNELS 2

static AVCodecContext *g_ctx;
static AVPacket *g_pkt;
static AVFrame *g_frame;
static float g_gain = 1.0f;
static unsigned g_packets, g_errors;
static time_t g_last_stats;
static int16_t g_out[MAX_SAMPLES * OUT_CHANNELS];

static void logmsg(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void logmsg(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    fflush(stderr);
}

static int read_full(void *buf, size_t len)
{
    uint8_t *p = buf;
    while (len) {
        ssize_t n = read(0, p, len);
        if (n == 0) return 0;
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        p += n;
        len -= (size_t)n;
    }
    return 1;
}

static int write_full(const void *buf, size_t len)
{
    const uint8_t *p = buf;
    while (len) {
        ssize_t n = write(1, p, len);
        if (n < 0) { if (errno == EINTR) continue; return -1; }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

static void put_be32(uint8_t *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
static void put_be16(uint8_t *p, uint16_t v) { p[0] = v >> 8; p[1] = v; }

struct bits { uint8_t buf[8]; int n; };
static void put_bits(struct bits *b, unsigned v, int width)
{
    for (int i = width - 1; i >= 0; i--) {
        if ((v >> i) & 1) b->buf[b->n >> 3] |= (uint8_t)(0x80 >> (b->n & 7));
        b->n++;
    }
}

/*
 * AudioSpecificConfig (ISO 14496-3 1.6.2.1). AAC-LC: object type 2.
 * AAC-ELD: object type 39 (escaped as 31 + 6 bits), ELDSpecificConfig with
 * frameLengthFlag = 1 for 480 samples, no resilience, no SBR. For an iPhone's
 * 44.1 kHz stereo stream this gives F8 E8 50 00, the config other receivers use.
 */
static int aac_asc(uint8_t *out, int aot, int rate, int channels, int spf)
{
    static const int rates[] = { 96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350 };
    unsigned idx = 4;
    for (unsigned i = 0; i < 13; i++) if (rates[i] == rate) idx = i;
    struct bits b = { { 0 }, 0 };
    if (aot < 31) {
        put_bits(&b, (unsigned)aot, 5); put_bits(&b, idx, 4); put_bits(&b, (unsigned)channels, 4);
        put_bits(&b, 0, 3); /* GASpecificConfig: 1024 samples, no core coder, no extension */
    } else {
        put_bits(&b, 31, 5); put_bits(&b, (unsigned)(aot - 32), 6); put_bits(&b, idx, 4); put_bits(&b, (unsigned)channels, 4);
        put_bits(&b, spf == 480 ? 1 : 0, 1); /* frameLengthFlag */
        put_bits(&b, 0, 3);                  /* section/scalefactor/spectral resilience */
        put_bits(&b, 0, 1);                  /* ldSbrPresentFlag */
        put_bits(&b, 0, 4);                  /* ELDEXT_TERM */
    }
    int len = (b.n + 7) / 8;
    memcpy(out, b.buf, (size_t)len);
    return len;
}

/* ALAC magic cookie (ALACSpecificConfig after the 12-byte atom header FFmpeg expects). */
static int alac_cookie(uint8_t *out, int spf, int rate, int channels)
{
    memset(out, 0, 36);
    put_be32(out, 36);
    memcpy(out + 4, "alac", 4);
    put_be32(out + 12, (uint32_t)spf);        /* frameLength */
    out[17] = 16;                             /* bitDepth */
    out[18] = 40; out[19] = 10; out[20] = 14; /* pb, mb, kb */
    out[21] = (uint8_t)channels;
    put_be16(out + 22, 255);                  /* maxRun */
    put_be32(out + 32, (uint32_t)rate);       /* maxFrameBytes, avgBitRate = 0; sampleRate */
    return 36;
}

static void close_codec(void) { if (g_ctx) avcodec_free_context(&g_ctx); }

static int configure(int ct, int channels, int spf, int rate)
{
    close_codec();
    if (channels < 1 || channels > 2) channels = 2;
    if (rate < 8000 || rate > 96000) rate = 44100;
    if (spf <= 0 || spf > 4096) spf = ct == 8 ? 480 : ct == 2 ? 352 : 1024;
    enum AVCodecID id;
    uint8_t extra[64];
    int extra_len;
    const char *name;
    switch (ct) {
    case 8: id = AV_CODEC_ID_AAC; extra_len = aac_asc(extra, 39, rate, channels, spf); name = "AAC-ELD"; break;
    case 4: id = AV_CODEC_ID_AAC; extra_len = aac_asc(extra, 2, rate, channels, spf); name = "AAC-LC"; break;
    case 2: id = AV_CODEC_ID_ALAC; extra_len = alac_cookie(extra, spf, rate, channels); name = "ALAC"; break;
    default: logmsg("unsupported audio type ct=%d", ct); return -1;
    }
    const AVCodec *codec = avcodec_find_decoder(id);
    if (!codec) { logmsg("no decoder for %s", name); return -1; }
    g_ctx = avcodec_alloc_context3(codec);
    if (!g_ctx) return -1;
    g_ctx->extradata = av_mallocz((size_t)extra_len + AV_INPUT_BUFFER_PADDING_SIZE);
    memcpy(g_ctx->extradata, extra, (size_t)extra_len);
    g_ctx->extradata_size = extra_len;
    g_ctx->sample_rate = rate;
    av_channel_layout_default(&g_ctx->ch_layout, channels);
    if (avcodec_open2(g_ctx, codec, NULL) < 0) { logmsg("decoder open failed (%s)", name); close_codec(); return -1; }
    logmsg("%s %d Hz, %d ch, %d samples/frame", name, rate, channels, spf);
    return 0;
}

static inline int16_t clip16(float v)
{
    if (v >= 32767.0f) return 32767;
    if (v <= -32768.0f) return -32768;
    return (int16_t)v;
}

/* Sample i of channel c, in 16-bit range (mono is copied to both outputs). */
static float sample_at(const AVFrame *f, int c, int i)
{
    int ch = f->ch_layout.nb_channels;
    if (c >= ch) c = ch - 1;
    int planar = av_sample_fmt_is_planar(f->format);
    int idx = planar ? i : i * ch + c;
    const uint8_t *d = planar ? f->extended_data[c] : f->extended_data[0];
    switch (av_get_packed_sample_fmt(f->format)) {
    case AV_SAMPLE_FMT_FLT: return ((const float *)d)[idx] * 32768.0f;
    case AV_SAMPLE_FMT_S16: return ((const int16_t *)d)[idx];
    case AV_SAMPLE_FMT_S32: return ((const int32_t *)d)[idx] / 65536.0f;
    default: return 0.0f;
    }
}

static int emit_frame(const AVFrame *f)
{
    int n = f->nb_samples;
    if (n > MAX_SAMPLES) n = MAX_SAMPLES;
    for (int i = 0; i < n; i++)
        for (int c = 0; c < OUT_CHANNELS; c++)
            g_out[i * OUT_CHANNELS + c] = clip16(sample_at(f, c, i) * g_gain);
    return write_full(g_out, (size_t)n * OUT_CHANNELS * sizeof(int16_t));
}

static int decode(uint8_t *data, size_t len)
{
    if (!g_ctx || !len) return 0;
    g_pkt->data = data;
    g_pkt->size = (int)len;
    g_packets++;
    if (avcodec_send_packet(g_ctx, g_pkt) < 0) { g_errors++; return 0; }
    while (avcodec_receive_frame(g_ctx, g_frame) == 0)
        if (emit_frame(g_frame) < 0) return -1; /* the player went away */
    return 0;
}

int main(void)
{
    signal(SIGPIPE, SIG_IGN);
    av_log_set_level(AV_LOG_ERROR);
    g_pkt = av_packet_alloc();
    g_frame = av_frame_alloc();
    uint8_t *buf = av_malloc(MAX_MSG + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!g_pkt || !g_frame || !buf) return 1;
    g_last_stats = time(NULL);
    for (;;) {
        uint8_t head[5];
        if (read_full(head, 5) <= 0) break;
        uint32_t len = (uint32_t)head[1] | (uint32_t)head[2] << 8 | (uint32_t)head[3] << 16 | (uint32_t)head[4] << 24;
        if (len > MAX_MSG) { logmsg("message too large (%u)", len); break; }
        if (len && read_full(buf, len) <= 0) break;
        memset(buf + len, 0, AV_INPUT_BUFFER_PADDING_SIZE);
        if (head[0] == 1 && len >= 8) {
            configure(buf[0], buf[1], buf[2] | buf[3] << 8, (int)(buf[4] | buf[5] << 8 | buf[6] << 16 | (uint32_t)buf[7] << 24));
        } else if (head[0] == 2) {
            if (decode(buf, len) < 0) { logmsg("output closed"); break; }
        } else if (head[0] == 3 && len >= 4) {
            float g;
            memcpy(&g, buf, 4);
            g_gain = (g >= 0.0f && g <= 1.0f) ? g : 1.0f;
        } else if (head[0] == 4) {
            if (g_ctx) avcodec_flush_buffers(g_ctx);
        }
        time_t now = time(NULL);
        if (now - g_last_stats >= 10) {
            if (g_packets) logmsg("%u packets, %u errors in %lds", g_packets, g_errors, (long)(now - g_last_stats));
            g_packets = g_errors = 0;
            g_last_stats = now;
        }
    }
    close_codec();
    return 0;
}
