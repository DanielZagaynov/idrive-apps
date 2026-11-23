'use strict';
/**
 * Draws Lane Hop frames on the desktop, the way mgu-render would, into PNGs:
 * it runs src/game.js, builds each frame with src/draw.js and paints its
 * CLEAR / RECT ops (alpha blended) at the car's embed box size.
 *
 *   node tools/preview.js            sim-out/lanehop-{ready,play,over}.png
 *   node tools/preview.js --readme   also preview.png (the README picture)
 *
 * The box defaults to 1692 x 544 (an iDrive 7 embed box as tools/sim.js
 * reports it); set BOX=WxH to try another.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Game = require('../src/game').Game;
const draw = require('../src/draw');

const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'sim-out');
const box = (process.env.BOX || '1692x544').split('x').map(Number);

/* ---- a tiny rasteriser for the two ops draw.js uses ---- */
function paint(words, scale, W, H) {
    const img = Buffer.alloc(W * H * 4);
    const f = new Float32Array(words.buffer, words.byteOffset, words.length);
    let i = 0;
    const fill = (x0, y0, x1, y1, c) => {
        const r = c >>> 24, g = (c >>> 16) & 255, b = (c >>> 8) & 255, a = (c & 255) / 255;
        x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
        x1 = Math.min(W, Math.round(x1)); y1 = Math.min(H, Math.round(y1));
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const o = (y * W + x) * 4;
                img[o] = img[o] * (1 - a) + r * a;
                img[o + 1] = img[o + 1] * (1 - a) + g * a;
                img[o + 2] = img[o + 2] * (1 - a) + b * a;
                img[o + 3] = 255;
            }
        }
    };
    while (i < words.length) {
        const op = words[i];
        if (op === draw.OP_CLEAR) { fill(0, 0, W, H, words[i + 1]); i += 2; }
        else if (op === draw.OP_RECT) {
            const x = f[i + 1] * scale, y = f[i + 2] * scale, w = f[i + 3] * scale, h = f[i + 4] * scale;
            fill(x, y, x + w, y + h, words[i + 5]);
            i += 6;
        } else throw new Error(`preview: op ${op} at word ${i} is not one draw.js should send`);
    }
    return img;
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
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function png(img, W, H) {
    const raw = Buffer.alloc(H * (W * 4 + 1));
    for (let y = 0; y < H; y++) img.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* A player that looks ahead: hops forward when the next column is safe for a moment, else waits or sidesteps. */
function autoplay(g, steps) {
    const safe = (x, y, ahead) => {
        const col = g.column(x);
        if (col.type === 'grass') return !g.treeAt(x, y);
        for (let t = 0; t <= ahead; t += 0.05) {
            const at = g.time + t;
            if (col.type === 'road' && col.items.some((it) => { const top = g.itemY(col, it, at); return y + 0.9 > top && y + 0.1 < top + it.len; })) return false;
            if (col.type === 'water' && !col.items.some((it) => { const top = g.itemY(col, it, at); return y + 0.5 > top + 0.2 && y + 0.5 < top + it.len - 0.2; })) return false;
            if (col.type === 'rail') { const tr = g.train(col, at); if (tr.warning) return false; }
        }
        return true;
    };
    for (let i = 0; i < steps && g.state !== 'over'; i++) {
        g.update(1 / 30);
        const p = g.player;
        if (p.hop < 1) continue;
        const y = Math.round(p.y);
        if (safe(p.x + 1, y, 0.35)) g.move('forward');
        else if (y > 0 && safe(p.x, y - 1, 0.3) && safe(p.x + 1, y - 1, 0.35)) g.move('up');
        else if (y < 10 && safe(p.x, y + 1, 0.3) && safe(p.x + 1, y + 1, 0.35)) g.move('down');
    }
}

function shot(g, name) {
    const W = box[0], H = box[1];
    const scale = H / draw.FIELD_H;
    const ops = draw.frame(new draw.Ops(), g, W / scale);
    const words = ops.words();
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, png(paint(words, scale, W, H), W, H));
    console.log(`wrote ${path.relative(process.cwd(), file)} (${words.length} words, ${words.length * 4} bytes a frame)`);
    return file;
}

fs.mkdirSync(OUT, { recursive: true });
shot(Object.assign(new Game(20261123), { best: 37 }), 'lanehop-ready');
// the playing shot: the first world in which the autoplayer is still going after 10 s
let g = null;
for (let seed = 20261123; seed < 20261123 + 200; seed++) {
    g = new Game(seed);
    g.best = 37;
    g.press();
    autoplay(g, 30 * 10);
    if (g.state === 'playing' && g.score >= 8 && g.player.hop >= 1) break;
}
const play = shot(g, 'lanehop-play');
let n = 0;
while (g.state !== 'over' && n++ < 2000) { g.move(['forward', 'up', 'down'][n % 3]); g.update(1 / 30); }
for (let i = 0; i < 30; i++) g.update(1 / 30);
shot(g, 'lanehop-over');
if (process.argv.indexOf('--readme') >= 0) {
    fs.copyFileSync(play, path.join(APP, 'preview.png'));
    console.log('wrote preview.png');
}
