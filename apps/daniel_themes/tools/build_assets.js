'use strict';
/**
 * Makes what the car loads, from each theme in themes/*.json, into
 * package/assets/ (committed: the car does not run this):
 *
 *   <theme>/plate.png       the artwork without needles or readouts, 1920x720
 *                           (theme "plate"; until that file exists, the render
 *                           itself, marked plateIsRender: tools/check.js fails then)
 *   <theme>/needle.png      the needle, pointing right from its pivot
 *   <theme>/hub_speed.png, hub_rpm.png   the artwork's hub caps, cut from the plate
 *   <theme>/glyphs.json     each readout's characters at its exact size, with a shadow
 *   <theme>/theme.json      what src/cluster.js needs of the theme
 *   themes.json, fonts/OFL-Barlow.txt
 *   rhmiData/.../images/themes_icon.png   the tile: a corner of the first theme's render
 *
 *   node tools/build_assets.js [--fonts <idrive7-apps>/kit/runtime/fonts] [--ffmpeg <path>]
 *
 * Needs ffmpeg (images in) and idrive7-apps' baked Barlow atlas
 * (kit/runtime/fonts/gear_barlow.json, OFL), by default from a checkout
 * next to this repository.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const zlib = require('zlib');
const { decode } = require('../src/png.js');
const { encode } = require('./pngenc.js');

const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'package', 'assets');
const ICON = path.join(APP, 'package', 'rhmiData', 'variantGroups', 'Common', 'images', 'themes_icon.png');
const argv = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };

const FONTS = path.resolve(arg('--fonts') || process.env.THEMES_FONTS ||
    path.join(APP, '..', '..', '..', 'ref-idrive7-apps', 'kit', 'runtime', 'fonts'));
const ATLAS_SIZE = 200;              // gear_barlow's 200 px size: capitals and digits 140 px tall
const ATLAS_CAP = 140;
const CHARS = { speed: '0123456789', gear: 'PRND0123456789', rpm: '0123456789,' };

function ffmpegPath() {
    const given = arg('--ffmpeg') || process.env.FFMPEG;
    if (given) return given;
    const r = cp.spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    if (r.status === 0) return 'ffmpeg';
    const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    try {
        for (const d of fs.readdirSync(winget).filter((n) => /FFmpeg/i.test(n))) {
            const base = path.join(winget, d);
            for (const sub of fs.readdirSync(base)) {
                const exe = path.join(base, sub, 'bin', 'ffmpeg.exe');
                if (fs.existsSync(exe)) return exe;
            }
        }
    } catch (e) { /* none there */ }
    throw new Error('ffmpeg not found: install it or pass --ffmpeg <path>');
}

function ffmpeg(args) {
    const r = cp.spawnSync(ffmpegPath(), ['-v', 'error', '-y'].concat(args), { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${r.stderr}`);
}

function rgbOf(hex) { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }

/* ---- the needle: a tapered red bar from its pivot to the right, lit from above ---- */
function needle(def) {
    const pad = 12, L = def.length, W = L + pad + 4, H = 24, cy = H / 2, SS = 4;
    const base = rgbOf(def.color), hi = base.map((c) => Math.min(255, Math.round(c + (255 - c) * 0.35))), lo = base.map((c) => Math.round(c * 0.62));
    const img = Buffer.alloc(W * H * 4);
    const half = (x) => { const t = Math.max(0, Math.min(1, (x - pad) / L)); return (def.base / 2) * (1 - t) + (def.tip / 2) * t; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let cover = 0, edge = 0, shade = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
            const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
            let h, inside;
            if (px < pad) { h = def.base / 2; inside = Math.hypot(px - pad, py - cy) <= h; }       // round base under the hub
            else if (px <= pad + L) { h = half(px); inside = Math.abs(py - cy) <= h; }
            else { h = def.tip / 2; inside = Math.hypot(px - pad - L, py - cy) <= h; }             // round tip
            if (!inside) continue;
            cover++;
            const v = (py - cy) / Math.max(h, 0.5);                                                // -1 top .. 1 bottom
            shade += v;
            if (Math.abs(v) > 0.72) edge++;
        }
        if (!cover) continue;
        const v = shade / cover, e = edge / cover, o = (y * W + x) * 4;
        for (let j = 0; j < 3; j++) {
            const lit = v < 0 ? base[j] + (hi[j] - base[j]) * Math.min(1, -v * 1.4) : base[j] + (lo[j] - base[j]) * Math.min(1, v);
            img[o + j] = Math.round(lit * (1 - e * 0.45));
        }
        img[o + 3] = Math.round(255 * cover / (SS * SS));
    }
    return { width: W, height: H, data: img, pivotX: pad, pivotY: cy };
}

/* ---- a hub cap: a disc of the plate around the pivot, soft-edged ---- */
function hub(plate, cx, cy, r) {
    const S = 2 * r, img = Buffer.alloc(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const d = Math.hypot(x + 0.5 - r, y + 0.5 - r), a = Math.max(0, Math.min(1, r - d));
        if (a <= 0) continue;
        const sx = Math.round(cx - r + x), sy = Math.round(cy - r + y), si = (sy * plate.width + sx) * 4, o = (y * S + x) * 4;
        plate.data.copy(img, o, si, si + 3);
        img[o + 3] = Math.round(255 * a);
    }
    return { width: S, height: S, data: img };
}

/* ---- glyphs: the atlas's, box-filtered down to the readout's size ---- */
function loadAtlas() {
    const file = path.join(FONTS, 'gear_barlow.json');
    if (!fs.existsSync(file)) throw new Error(`no ${file}: pass --fonts <idrive7-apps>/kit/runtime/fonts`);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const s = j.sizes.find((x) => x.size === ATLAS_SIZE);
    return { s, alpha: zlib.inflateSync(Buffer.from(s.alpha, 'base64')) };
}

/* Box-filters an alpha map by kx across and ky down. */
function resample(src, sw, sh, kx, ky) {
    const w = Math.max(1, Math.ceil(sw * kx)), h = Math.max(1, Math.ceil(sh * ky)), out = Buffer.alloc(w * h);
    const n = Math.max(2, Math.ceil(1 / Math.min(kx, ky)) + 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const sx = Math.floor((x + (i + 0.5) / n) / kx), sy = Math.floor((y + (j + 0.5) / n) / ky);
            if (sx < sw && sy < sh) sum += src[sy * sw + sx];
        }
        out[y * w + x] = Math.round(sum / (n * n));
    }
    return { w, h, a: out };
}

/* Thickens strokes by r px (a round max filter), the map growing by r on each side. */
function embolden(a, w, h, r) {
    if (!(r > 0)) return { w, h, a, grow: 0 };
    const R = Math.ceil(r), W = w + 2 * R, H = h + 2 * R, out = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let m = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            const d = Math.hypot(dx, dy);
            if (d > r + 0.5) continue;
            const sx = x - R + dx, sy = y - R + dy;
            if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
            const v = a[sy * w + sx] * Math.min(1, r + 0.5 - d);   // soft edge on the last half pixel
            if (v > m) m = v;
        }
        out[y * W + x] = Math.round(m);
    }
    return { w: W, h: H, a: out, grow: R };
}

function blur(a, w, h, R) {
    const W = w + 2 * R, H = h + 2 * R;
    let m = new Float32Array(W * H);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[(y + R) * W + x + R] = a[y * w + x];
    for (let pass = 0; pass < 2; pass++) {
        const t = new Float32Array(W * H), u = new Float32Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            let s = 0;
            for (let d = -R; d <= R; d++) { const xx = x + d; if (xx >= 0 && xx < W) s += m[y * W + xx]; }
            t[y * W + x] = s / (2 * R + 1);
        }
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            let s = 0;
            for (let d = -R; d <= R; d++) { const yy = y + d; if (yy >= 0 && yy < H) s += t[yy * W + x]; }
            u[y * W + x] = s / (2 * R + 1);
        }
        m = u;
    }
    const out = Buffer.alloc(W * H);
    for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.round(m[i]));
    return { w: W, h: H, a: out };
}

/* The comma Barlow's baked atlas lacks: a round dot with a tail, at the readout's size. */
function comma(cap) {
    const r = Math.max(1.5, cap * 0.1), tail = cap * 0.2, w = Math.ceil(2 * r + 2), h = Math.ceil(2 * r + tail), SS = 4, a = Buffer.alloc(w * h);
    const cx = r + 1, cy = r;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let c = 0;
        for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
            const px = x + (i + 0.5) / SS, py = y + (j + 0.5) / SS;
            const inDot = Math.hypot(px - cx, py - cy) <= r;
            const t = (py - cy) / (tail + r);                      // the tail: leaning left, thinning
            const inTail = py > cy && t <= 1 && Math.abs(px - (cx + r * 0.3 - t * r * 1.1)) <= r * 0.55 * (1 - t * 0.7);
            if (inDot || inTail) c++;
        }
        a[y * w + x] = Math.round(255 * c / (SS * SS));
    }
    return { w, h, ox: 0, oy: -Math.round(2 * r), adv: Math.round(2 * r + cap * 0.12), a };
}

/* A readout's glyphs: def.capHeight tall, def.stretch (1) times as wide, strokes def.bold px heavier. */
function font(atlas, def, chars) {
    const cap = def.capHeight, stretch = def.stretch || 1, bold = def.bold || 0;
    // bold grows the ink `bold` px on every side: scale to cap - 2 * bold so the capitals end cap tall
    const k = (cap - 2 * bold) / ATLAS_CAP, kx = k * stretch, R = Math.max(2, Math.round(cap * 0.06)), glyphs = {};
    for (const ch of chars) {
        let g;
        if (ch === ',') g = comma(cap);
        else {
            const src = atlas.s.glyphs[ch.charCodeAt(0)];
            if (!src) throw new Error(`gear_barlow has no '${ch}'`);
            const bm = Buffer.alloc(src[2] * src[3]);
            for (let y = 0; y < src[3]; y++) atlas.alpha.copy(bm, y * src[2], (src[1] + y) * atlas.s.atlasW + src[0], (src[1] + y) * atlas.s.atlasW + src[0] + src[2]);
            const r = resample(bm, src[2], src[3], kx, k);
            // the emboldened map is padded by e.grow; its ink sits `bold` right of the pen and on the baseline
            const e = embolden(r.a, r.w, r.h, bold), b = Math.round(bold);
            g = { w: e.w, h: e.h, ox: Math.round(src[4] * kx) - e.grow + b, oy: Math.round(src[5] * k) - e.grow - b,
                adv: Math.round(src[6] * kx + 2 * bold), a: e.a };
        }
        const s = blur(g.a, g.w, g.h, R);
        glyphs[ch] = { w: g.w, h: g.h, ox: g.ox, oy: g.oy, adv: g.adv, a: g.a.toString('base64'),
            s: { w: s.w, h: s.h, ox: g.ox - R, oy: g.oy - R, a: s.a.toString('base64') } };
    }
    return { capHeight: cap, pad: R, shadow: { dx: Math.round(cap * 0.03), dy: Math.max(1, Math.round(cap * 0.05)), alpha: 0.6 }, glyphs };
}

function writePng(file, img) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encode(img.width, img.height, img.data));
}

function buildTheme(src, atlas) {
    const t = JSON.parse(fs.readFileSync(src, 'utf8'));
    const dir = path.join(OUT, t.id);
    fs.mkdirSync(dir, { recursive: true });
    const plateSrc = t.plate && fs.existsSync(path.join(APP, t.plate)) ? t.plate : t.render;
    const plateIsRender = plateSrc === t.render;
    ffmpeg(['-i', path.join(APP, plateSrc), '-vf', 'scale=1920:720:flags=lanczos', '-pix_fmt', 'rgb24', '-frames:v', '1', path.join(dir, 'plate.png')]);
    const plate = decode(fs.readFileSync(path.join(dir, 'plate.png')));
    const n = needle(t.needle);
    writePng(path.join(dir, 'needle.png'), n);
    writePng(path.join(dir, 'hub_speed.png'), hub(plate, t.speed.pivot[0], t.speed.pivot[1], t.hubRadius));
    writePng(path.join(dir, 'hub_rpm.png'), hub(plate, t.rpm.pivot[0], t.rpm.pivot[1], t.hubRadius));
    const fonts = {};
    Object.keys(t.readouts).forEach((k) => { fonts[k] = font(atlas, t.readouts[k], CHARS[k]); });
    fs.writeFileSync(path.join(dir, 'glyphs.json'), JSON.stringify(fonts));
    const runtime = {
        id: t.id, name: t.name, plateIsRender,
        speed: t.speed, rpm: t.rpm, hubRadius: t.hubRadius, readouts: t.readouts,
        needle: Object.assign({}, t.needle, { pivotX: n.pivotX, pivotY: n.pivotY })
    };
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(runtime, null, 2) + '\n');
    return { t, plateSrc, plateIsRender };
}

function main() {
    const atlas = loadAtlas();
    const srcs = fs.readdirSync(path.join(APP, 'themes')).filter((f) => f.endsWith('.json')).sort();
    const built = srcs.map((f) => buildTheme(path.join(APP, 'themes', f), atlas));
    fs.writeFileSync(path.join(OUT, 'themes.json'), JSON.stringify({ themes: built.map((b) => ({ id: b.t.id, name: b.t.name })) }, null, 2) + '\n');
    fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
    fs.copyFileSync(path.join(FONTS, 'OFL-Barlow.txt'), path.join(OUT, 'fonts', 'OFL-Barlow.txt'));
    fs.mkdirSync(path.dirname(ICON), { recursive: true });
    ffmpeg(['-i', path.join(APP, built[0].t.render), '-vf', 'scale=1920:720:flags=lanczos,crop=420:420:40:110,scale=140:140:flags=lanczos', '-pix_fmt', 'rgb24', '-frames:v', '1', ICON]);
    built.forEach((b) => console.log(`${b.t.id}: plate from ${b.plateSrc}${b.plateIsRender ? '  (NOT a clean plate: the render, with its painted needles and numbers)' : ''}`));
    console.log(`wrote ${path.relative(APP, OUT)} and the tile icon`);
}

try {
    main();
} catch (e) {
    console.error(`build_assets: ${e.message}`);
    process.exitCode = 1;
}
