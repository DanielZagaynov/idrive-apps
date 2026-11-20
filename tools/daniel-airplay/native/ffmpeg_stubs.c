/*
 * ffmpeg 7.1.1 built with only the H.264 decoder compiles h2645_sei.c (shared
 * H.264/HEVC SEI code) but not aom_film_grain.c, which it references when it
 * resets AV1 film-grain (AFGS1) SEI state. iPhone streams never carry that SEI,
 * so a no-op is correct here.
 */
void ff_aom_uninit_film_grain_params(void *s);
void ff_aom_uninit_film_grain_params(void *s) { (void)s; }
