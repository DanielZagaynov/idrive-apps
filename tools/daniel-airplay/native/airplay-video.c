/*
 * airplay-video: decode the AirPlay mirroring H.264 stream and publish frames
 * to mgu-render's video frame file (native/mgu-render/PROTOCOL.md, "Video").
 *
 *   airplay-video /dev/shm/mgu-video-<name>
 *
 * stdin carries messages from lib/video-sink.js (little-endian):
 *   u8 type, u32 length, payload
 *   1 config: u16 width, u16 height, avcC
 *   2 frame:  AVCC access unit (4-byte length-prefixed NAL units)
 *   3 blank:  no payload
 *
 * Frame file: 64-byte header ("MGVF", version 1, w, h, seq, slot, nslot,
 * matrix, range, format=0 I420), then NSLOT frames of w*h*3/2 bytes.
 *
 * Built fully static (musl) against a minimal libavcodec (H.264 decoder only):
 * see native/build.sh.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>

#define MAGIC 0x4656474du
#define NSLOT 3
#define MAX_DIM 2048
#define MAX_MSG (16u * 1024u * 1024u)

static const char *g_path;
static int g_fd = -1;
static uint8_t *g_map;
static size_t g_map_len;
static int g_w, g_h;
static uint32_t g_seq;
static AVCodecContext *g_ctx;
static AVPacket *g_pkt;
static AVFrame *g_frame;
static unsigned g_decoded, g_errors;
static time_t g_last_stats;

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

static uint32_t *hdr(void) { return (uint32_t *)g_map; }

/* (Re)create the frame file for a w x h picture. */
static int open_frame_file(int w, int h)
{
    size_t frame = (size_t)w * h * 3 / 2;
    size_t len = 64 + NSLOT * frame;
    if (g_map && w == g_w && h == g_h) return 0;
    if (g_map) { munmap(g_map, g_map_len); g_map = NULL; }
    if (g_fd < 0) {
        g_fd = open(g_path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0644);
        if (g_fd < 0) { logmsg("open %s: %s", g_path, strerror(errno)); return -1; }
        fchmod(g_fd, 0644);
    }
    if (ftruncate(g_fd, (off_t)len) < 0) { logmsg("ftruncate: %s", strerror(errno)); return -1; }
    g_map = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, g_fd, 0);
    if (g_map == MAP_FAILED) { g_map = NULL; logmsg("mmap: %s", strerror(errno)); return -1; }
    g_map_len = len;
    g_w = w;
    g_h = h;
    memset(g_map, 0, 64);
    hdr()[0] = MAGIC;
    hdr()[1] = 1;
    hdr()[2] = (uint32_t)w;
    hdr()[3] = (uint32_t)h;
    hdr()[4] = g_seq;
    hdr()[5] = 0;
    hdr()[6] = NSLOT;
    hdr()[9] = 0; /* I420 */
    logmsg("frame file %dx%d, %zu bytes", w, h, len);
    return 0;
}

static void publish(const uint8_t *const planes[3], const int strides[3], int w, int h, int matrix, int range)
{
    if (open_frame_file(w, h) < 0) return;
    uint32_t slot = (hdr()[5] + 1) % NSLOT;
    uint8_t *dst = g_map + 64 + (size_t)slot * ((size_t)w * h * 3 / 2);
    for (int y = 0; y < h; y++) memcpy(dst + (size_t)y * w, planes[0] + (size_t)y * strides[0], (size_t)w);
    dst += (size_t)w * h;
    for (int p = 1; p <= 2; p++) {
        for (int y = 0; y < h / 2; y++) memcpy(dst + (size_t)y * (w / 2), planes[p] + (size_t)y * strides[p], (size_t)(w / 2));
        dst += (size_t)(w / 2) * (h / 2);
    }
    hdr()[7] = (uint32_t)matrix;
    hdr()[8] = (uint32_t)range;
    __sync_synchronize();
    hdr()[5] = slot;
    __sync_synchronize();
    hdr()[4] = ++g_seq;
}

static void publish_black(void)
{
    if (!g_map) return;
    int w = g_w, h = g_h;
    uint8_t *y = malloc((size_t)w * h), *uv = malloc((size_t)w * h / 4);
    if (!y || !uv) { free(y); free(uv); return; }
    memset(y, 16, (size_t)w * h);
    memset(uv, 128, (size_t)w * h / 4);
    const uint8_t *planes[3] = { y, uv, uv };
    const int strides[3] = { w, w / 2, w / 2 };
    publish(planes, strides, w, h, 0, 0);
    free(y);
    free(uv);
}

static void drain_frames(void)
{
    for (;;) {
        int r = avcodec_receive_frame(g_ctx, g_frame);
        if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return;
        if (r < 0) { g_errors++; return; }
        int fmt = g_frame->format;
        if (fmt != AV_PIX_FMT_YUV420P && fmt != AV_PIX_FMT_YUVJ420P) {
            if (g_errors++ < 5) logmsg("unsupported pixel format %d", fmt);
            av_frame_unref(g_frame);
            continue;
        }
        int w = g_frame->width & ~1, h = g_frame->height & ~1;
        if (w < 16 || h < 16 || w > MAX_DIM || h > MAX_DIM) {
            if (g_errors++ < 5) logmsg("frame size %dx%d out of range", g_frame->width, g_frame->height);
            av_frame_unref(g_frame);
            continue;
        }
        int range = (fmt == AV_PIX_FMT_YUVJ420P || g_frame->color_range == AVCOL_RANGE_JPEG) ? 1 : 0;
        int matrix = (g_frame->colorspace == AVCOL_SPC_BT709) ? 1 : 0;
        const uint8_t *planes[3] = { g_frame->data[0], g_frame->data[1], g_frame->data[2] };
        const int strides[3] = { g_frame->linesize[0], g_frame->linesize[1], g_frame->linesize[2] };
        publish(planes, strides, w, h, matrix, range);
        g_decoded++;
        av_frame_unref(g_frame);
    }
}

static int configure(const uint8_t *avcc, size_t len, int w, int h)
{
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_H264);
    if (!codec) { logmsg("no H.264 decoder"); return -1; }
    if (g_ctx) avcodec_free_context(&g_ctx);
    g_ctx = avcodec_alloc_context3(codec);
    g_ctx->extradata = av_mallocz(len + AV_INPUT_BUFFER_PADDING_SIZE);
    memcpy(g_ctx->extradata, avcc, len);
    g_ctx->extradata_size = (int)len;
    g_ctx->flags |= AV_CODEC_FLAG_LOW_DELAY;
    g_ctx->thread_count = 2;
    g_ctx->thread_type = FF_THREAD_SLICE; /* frame threading adds a frame of latency per thread */
    int r = avcodec_open2(g_ctx, codec, NULL);
    if (r < 0) { logmsg("avcodec_open2 failed (%d)", r); avcodec_free_context(&g_ctx); return -1; }
    logmsg("decoder configured for %dx%d (avcC %zu bytes)", w, h, len);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc != 2 || strncmp(argv[1], "/dev/shm/mgu-video-", 19) != 0) {
        fprintf(stderr, "usage: airplay-video /dev/shm/mgu-video-<name>\n");
        return 2;
    }
    g_path = argv[1];
    av_log_set_level(AV_LOG_ERROR);
    g_pkt = av_packet_alloc();
    g_frame = av_frame_alloc();
    uint8_t *buf = NULL;
    size_t cap = 0;
    g_last_stats = time(NULL);

    for (;;) {
        uint8_t head[5];
        int r = read_full(head, 5);
        if (r <= 0) break;
        uint32_t len = (uint32_t)head[1] | (uint32_t)head[2] << 8 | (uint32_t)head[3] << 16 | (uint32_t)head[4] << 24;
        if (len > MAX_MSG) { logmsg("message too large (%u)", len); return 1; }
        if (cap < len + AV_INPUT_BUFFER_PADDING_SIZE) {
            cap = len + AV_INPUT_BUFFER_PADDING_SIZE;
            buf = realloc(buf, cap);
            if (!buf) return 1;
        }
        if (len && read_full(buf, len) <= 0) break;
        memset(buf + len, 0, AV_INPUT_BUFFER_PADDING_SIZE);

        if (head[0] == 1 && len > 4) {
            int w = buf[0] | buf[1] << 8, h = buf[2] | buf[3] << 8;
            configure(buf + 4, len - 4, w, h);
        } else if (head[0] == 2 && g_ctx) {
            g_pkt->data = buf;
            g_pkt->size = (int)len;
            if (avcodec_send_packet(g_ctx, g_pkt) < 0) g_errors++;
            drain_frames();
        } else if (head[0] == 3) {
            publish_black();
        }

        time_t now = time(NULL);
        if (now - g_last_stats >= 10) {
            logmsg("%.1f fps, %dx%d, %u errors", g_decoded / (double)(now - g_last_stats), g_w, g_h, g_errors);
            g_decoded = 0;
            g_last_stats = now;
        }
    }
    if (g_ctx) avcodec_free_context(&g_ctx);
    return 0;
}
