/*
 * fairplay_cli: tiny helper that unwraps the AirPlay mirroring AES key.
 *
 *   fairplay.exe <keymsg-hex (164 bytes)> <ekey-hex (72 bytes)>
 *
 * Prints the 16-byte AES key as 32 hex characters on stdout.
 * The actual math lives in playfair/ (reverse-engineered FairPlay, GPL-3).
 */
#include <stdio.h>
#include <string.h>
#include "playfair/playfair.h"

static int parse_hex(const char *hex, unsigned char *out, size_t len)
{
    if (strlen(hex) != len * 2) return -1;
    for (size_t i = 0; i < len; i++) {
        unsigned int b;
        if (sscanf(hex + 2 * i, "%2x", &b) != 1) return -1;
        out[i] = (unsigned char)b;
    }
    return 0;
}

int main(int argc, char **argv)
{
    unsigned char keymsg[164], ekey[72], key[16];
    if (argc != 3 || parse_hex(argv[1], keymsg, sizeof keymsg) || parse_hex(argv[2], ekey, sizeof ekey)) {
        fprintf(stderr, "usage: fairplay <keymsg-hex:164 bytes> <ekey-hex:72 bytes>\n");
        return 2;
    }
    playfair_decrypt(keymsg, ekey, key);
    for (int i = 0; i < 16; i++) printf("%02x", key[i]);
    printf("\n");
    return 0;
}
