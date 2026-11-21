'use strict';
/**
 * png.js - reads a PNG into RGBA (straight alpha), on the head unit's Node 8
 * with only zlib. Handles what tools/build_assets.js writes: 8-bit gray,
 * gray+alpha, RGB and RGBA, not interlaced, every filter type.
 *
 *   const { decode } = require('./png.js');
 *   const img = decode(fs.readFileSync(file));   // { width, height, data: Buffer w*h*4 }
 */
const zlib = require('zlib');

const SIGNATURE = '89504e470d0a1a0a';
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };   // colour type -> samples a pixel

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decode(buf) {
    if (buf.length < 8 || buf.slice(0, 8).toString('hex') !== SIGNATURE) throw new Error('not a PNG');
    let off = 8, width = 0, height = 0, depth = 0, type = -1, interlace = 0;
    const idat = [];
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off), kind = buf.toString('ascii', off + 4, off + 8);
        const body = buf.slice(off + 8, off + 8 + len);
        off += 12 + len;
        if (kind === 'IHDR') {
            width = body.readUInt32BE(0); height = body.readUInt32BE(4);
            depth = body[8]; type = body[9]; interlace = body[12];
        } else if (kind === 'IDAT') idat.push(body);
        else if (kind === 'IEND') break;
    }
    const ch = CHANNELS[type];
    if (!width || !height || depth !== 8 || !ch || interlace) {
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * ch;
    if (raw.length < (stride + 1) * height) throw new Error('PNG data is short');
    const px = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
        for (let i = 0; i < stride; i++) {
            const a = i >= ch ? px[dst + i - ch] : 0, b = y ? px[up + i] : 0, c = y && i >= ch ? px[up + i - ch] : 0;
            let v = raw[src + i];
            if (f === 1) v += a;
            else if (f === 2) v += b;
            else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) v += paeth(a, b, c);
            else if (f !== 0) throw new Error(`bad PNG filter ${f} on row ${y}`);
            px[dst + i] = v & 255;
        }
    }
    if (ch === 4) return { width, height, data: px };
    const out = Buffer.alloc(width * height * 4);
    for (let i = 0, j = 0; i < px.length; i += ch, j += 4) {
        if (ch === 3) { out[j] = px[i]; out[j + 1] = px[i + 1]; out[j + 2] = px[i + 2]; out[j + 3] = 255; }
        else { out[j] = out[j + 1] = out[j + 2] = px[i]; out[j + 3] = ch === 2 ? px[i + 1] : 255; }
    }
    return { width, height, data: out };
}

module.exports = { decode };
