'use strict';
/**
 * Writes the tile icon, package/rhmiData/variantGroups/Common/images/hello_icon.png:
 * 140 x 140 RGBA (the size of the car's app list), a near-white waving hand
 * shape made of a palm and fingers on a transparent background. No dependencies.
 * Replace the PNG with your own any time (at most 128 KiB).
 *
 *   node tools/make_icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 140;
const SS = 4;                      // supersampling per axis
const OUT = path.join(__dirname, '..', 'package', 'rhmiData', 'variantGroups', 'Common', 'images', 'hello_icon.png');

/* Rounded rectangle (capsule) test in icon pixels. */
function inCapsule(x, y, cx, top, bottom, r) {
    const yy = Math.max(top + r, Math.min(bottom - r, y));
    return (x - cx) * (x - cx) + (y - yy) * (y - yy) <= r * r;
}

function inside(x, y) {
    // palm
    if (inCapsule(x, y, 70, 62, 116, 28)) return true;
    // four fingers
    if (inCapsule(x, y, 49, 30, 80, 8)) return true;
    if (inCapsule(x, y, 64, 22, 80, 8)) return true;
    if (inCapsule(x, y, 79, 24, 80, 8)) return true;
    if (inCapsule(x, y, 93, 34, 82, 8)) return true;
    // thumb, leaning out to the left
    const tx = x - 34, ty = y - 84;
    const rx = tx * Math.cos(0.6) + ty * Math.sin(0.6);
    const ry = -tx * Math.sin(0.6) + ty * Math.cos(0.6);
    return inCapsule(rx, ry, 0, -24, 10, 8);
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
