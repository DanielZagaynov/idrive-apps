'use strict';
/**
 * Writes the tile icon, package/rhmiData/variantGroups/Common/images/lanehop_icon.png:
 * 140 x 140 RGBA (the size of the car's app list): a near-white robot (Lane
 * Hop's player) between two dashed lane lines, on a transparent background,
 * like the other apps' tiles. No dependencies. Replace the PNG with your own
 * any time (at most 128 KiB).
 *
 *   node tools/make_icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 140;
const SS = 4;                      // supersampling per axis
const OUT = path.join(__dirname, '..', 'package', 'rhmiData', 'variantGroups', 'Common', 'images', 'lanehop_icon.png');

function inRoundRect(x, y, x0, y0, x1, y1, r) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + r, Math.min(x1 - r, x));
    const cy = Math.max(y0 + r, Math.min(y1 - r, y));
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}

function inside(x, y) {
    // dashed lane lines left and right
    if ((Math.abs(x - 20) <= 3 || Math.abs(x - 120) <= 3) && (Math.floor((y - 10) / 24) % 2 === 0) && y > 10 && y < 130) return true;
    // antenna: a stalk and a ball
    if (Math.abs(x - 70) <= 2.5 && y >= 26 && y <= 40) return true;
    if ((x - 70) * (x - 70) + (y - 22) * (y - 22) <= 36) return true;
    // body with the visor cut out, and an eye left in it
    const body = inRoundRect(x, y, 40, 38, 100, 98, 12);
    const visor = inRoundRect(x, y, 49, 50, 91, 72, 5);
    const eye = inRoundRect(x, y, 76, 56, 86, 66, 2);
    if (body && (!visor || eye)) return true;
    // feet
    if (inRoundRect(x, y, 46, 102, 62, 116, 3) || inRoundRect(x, y, 78, 102, 94, 116, 3)) return true;
    return false;
}

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;      // filter: none
    for (let x = 0; x < N; x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
                if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hit++;
            }
        }
        const o = y * (N * 4 + 1) + 1 + x * 4;
        raw[o] = 235; raw[o + 1] = 238; raw[o + 2] = 242;
        raw[o + 3] = Math.round(255 * hit / (SS * SS));
    }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${png.length} bytes)`);
