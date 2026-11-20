'use strict';
/**
 * pngenc.js - writes RGBA (straight alpha) as a PNG, for the desktop tools.
 * Each row takes the filter (none, sub, up, average, paeth) that packs best.
 *
 *   const { encode } = require('./pngenc.js');
 *   fs.writeFileSync(file, encode(width, height, rgbaBuffer));
 */
const zlib = require('zlib');

const CRC = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
});
function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    len.writeUInt32BE(data.length, 0);
    crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
}
function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function encode(w, h, rgba) {
    const stride = w * 4, raw = Buffer.alloc((stride + 1) * h), row = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        let best = null, bestSum = Infinity, bestF = 0;
        for (let f = 0; f < 5; f++) {
            let sum = 0;
            for (let i = 0; i < stride; i++) {
                const x = rgba[y * stride + i], a = i >= 4 ? rgba[y * stride + i - 4] : 0;
                const b = y ? rgba[(y - 1) * stride + i] : 0, c = y && i >= 4 ? rgba[(y - 1) * stride + i - 4] : 0;
                const p = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
                row[i] = (x - p) & 255;
                sum += row[i] < 128 ? row[i] : 256 - row[i];
            }
            if (sum < bestSum) { bestSum = sum; bestF = f; best = Buffer.from(row); }
        }
        raw[y * (stride + 1)] = bestF;
        best.copy(raw, y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { encode };
