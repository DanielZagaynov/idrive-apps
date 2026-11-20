'use strict';
/**
 * cluster.js - one theme on the whole instrument cluster (iDrive 7,
 * cluster-render's `panel` target, 1920x720, drawn over BMW's gauges):
 *
 *   plate      the theme's artwork without needles or readouts (image, sent once)
 *   levels     a band along each scale, lit from zero up to the value
 *              (theme.json "level"), redrawn where it changes
 *   needles    one image each, turned and stretched about its gauge's pivot
 *              so its tip stops just short of the number for the value
 *              (theme.json "points": where each number sits on the scale)
 *   hubs       the artwork's own hub caps, cut out of the plate, over the needles' bases
 *   readouts   speed, gear and rpm text in small images, redrawn when they change
 *
 * Nothing shows until show(true); the app shows it only while the car's
 * speed is known and fresh, so a stale speed is never left on the cluster.
 *
 *   const ct = new ClusterTheme(ClusterRender, { app, assets, theme, logger });
 *   ct.load(); ct.start();
 *   ct.update({ speedKmh, rpm, gear, stage }); ct.show(true);
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { decode } = require('./png');
const glyphs = require('./glyphs');

const TARGET = 'panel';
const SEND_MS = 33;            // needles at most ~30 times a second
const TEXT_MS = 250;           // readouts at most 4 times a second
const MIN_DEG = 0.2;           // smaller needle moves are not sent
const MIN_SCALE = 0.002;
const KMH_TO_MPH = 0.621371;
const LEVEL_MS = 50;           // levels at most 20 times a second

/* Where the needle for value v points: angle (degrees clockwise from the
 * right, on screen) and length from the pivot. Between two numbers it aims
 * along the straight line joining them, which follows the scale's track. */
function aim(scale, v) {
    const p = scale.points, last = p.length - 1;
    const val = Math.max(p[0][0], Math.min(p[last][0], typeof v === 'number' && isFinite(v) ? v : 0));
    let i = 0;
    while (i < last - 1 && val > p[i + 1][0]) i++;
    const span = p[i + 1][0] - p[i][0], t = span ? (val - p[i][0]) / span : 0;
    const x = p[i][1] + (p[i + 1][1] - p[i][1]) * t, y = p[i][2] + (p[i + 1][2] - p[i][2]) * t;
    const dx = x - scale.pivot[0], dy = y - scale.pivot[1];
    return { rotate: Math.atan2(dy, dx) * 180 / Math.PI, length: Math.max(0, Math.hypot(dx, dy) - (scale.margin || 0)) };
}

function hex(c) {
    const n = parseInt(String(c).replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* The band that fills along a scale: every pixel of it with the value at
 * which it lights. A pixel's value is where the ray from the pivot through
 * it crosses the scale's track (the straight lines joining the numbers,
 * the line the needle follows), so the band ends exactly under the needle.
 * Returns { x, y, w, h, rgba, idx (pixel offsets in the box, by value), val, top }. */
function levelBand(scale, lv) {
    const p = scale.points, pv = scale.pivot, top = p[p.length - 1][0];
    const ang = [];
    p.forEach((q, i) => {
        let a = Math.atan2(q[2] - pv[1], q[1] - pv[0]);
        if (i) { while (a - ang[i - 1] > Math.PI) a -= 2 * Math.PI; while (a - ang[i - 1] < -Math.PI) a += 2 * Math.PI; }
        ang.push(a);
    });
    const dir = ang[ang.length - 1] > ang[0] ? 1 : -1;
    const lo = Math.min(ang[0], ang[ang.length - 1]), hi = Math.max(ang[0], ang[ang.length - 1]);
    const near = lv.inner - lv.glow, far = lv.inner + lv.width + lv.glow;
    let x0 = pv[0], y0 = pv[1], x1 = pv[0], y1 = pv[1];
    p.forEach((q) => { x0 = Math.min(x0, q[1]); y0 = Math.min(y0, q[2]); x1 = Math.max(x1, q[1]); y1 = Math.max(y1, q[2]); });
    const pad = Math.max(0, -near) + 2;           // a band outside the numbers reaches past them
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(1920, Math.ceil(x1 + pad)); y1 = Math.min(720, Math.ceil(y1 + pad));
    const w = x1 - x0, h = y1 - y0, c0 = hex(lv.from), c1 = hex(lv.to), alpha = lv.alpha == null ? 1 : lv.alpha;
    const cr = lv.red && typeof scale.redFrom === 'number' ? hex(lv.red) : null;
    const rgba = Buffer.alloc(w * h * 4), offs = [], vals = [];
    const edge = (d, a, b) => Math.max(0, Math.min(1, (d - a) / (b - a)));
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = x0 + x + 0.5 - pv[0], dy = y0 + y + 0.5 - pv[1];
            let a = Math.atan2(dy, dx);
            while (a < lo) a += 2 * Math.PI;
            while (a > hi) a -= 2 * Math.PI;
            if (a < lo) continue;
            let i = 0;
            while (i < ang.length - 2 && (a - ang[i + 1]) * dir > 0) i++;
            /* where the ray crosses the line from number i to number i+1 */
            const ax = p[i][1] - pv[0], ay = p[i][2] - pv[1], bx = p[i + 1][1] - pv[0], by = p[i + 1][2] - pv[1];
            const ux = Math.cos(a), uy = Math.sin(a), ex = bx - ax, ey = by - ay, den = ux * ey - uy * ex;
            if (Math.abs(den) < 1e-9) continue;
            const R = (ax * ey - ay * ex) / den, t = Math.max(0, Math.min(1, (ax * uy - ay * ux) / den));
            if (R <= 0) continue;
            const d = R - Math.hypot(dx, dy);            // px inside the numbers' line
            if (d < near || d > far) continue;
            const core = Math.min(edge(d, lv.inner - 1, lv.inner + 1), 1 - edge(d, lv.inner + lv.width - 1, lv.inner + lv.width + 1));
            const out = d < lv.inner ? (lv.inner - d) / lv.glow : Math.max(0, d - lv.inner - lv.width) / lv.glow;
            const glow = 0.35 * Math.pow(Math.max(0, 1 - out), 2);
            const al = alpha * Math.max(core, glow);
            if (al <= 0.004) continue;
            const v = p[i][0] + (p[i + 1][0] - p[i][0]) * t, f = Math.max(0, Math.min(1, v / top)), o = (y * w + x) * 4;
            const red = cr && v >= scale.redFrom;      // the scale's red zone keeps its colour when lit
            rgba[o] = red ? cr[0] : Math.round(c0[0] + (c1[0] - c0[0]) * f);
            rgba[o + 1] = red ? cr[1] : Math.round(c0[1] + (c1[1] - c0[1]) * f);
            rgba[o + 2] = red ? cr[2] : Math.round(c0[2] + (c1[2] - c0[2]) * f);
            rgba[o + 3] = Math.round(al * 255);
            offs.push(y * w + x); vals.push(v);
        }
    }
    const order = offs.map((_, k) => k).sort((m, n) => vals[m] - vals[n]);
    return { x: x0, y: y0, w, h, rgba, idx: Int32Array.from(order.map((k) => offs[k])), val: Float32Array.from(order.map((k) => vals[k])), top };
}

/* How many of the band's pixels (sorted by value) light at value v. */
function litCount(band, v) {
    let a = 0, b = band.val.length;
    while (a < b) { const m = (a + b) >> 1; if (band.val[m] <= v) a = m + 1; else b = m; }
    return a;
}

function withCommas(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* The texts the readouts show for one sample. */
function texts(theme, d) {
    const out = { speed: '', gear: '', rpm: '' };
    if (typeof d.speedKmh === 'number') {
        const v = theme.speed.unit === 'mph' ? d.speedKmh * KMH_TO_MPH : d.speedKmh;
        out.speed = String(Math.max(0, Math.round(v)));
    }
    if (d.stage === 'P' || d.stage === 'R' || d.stage === 'N' || d.stage === 'D') out.gear = d.stage;
    else if (d.gear === -1) out.gear = 'R';
    else if (typeof d.gear === 'number' && d.gear > 0 && d.gear < 10) out.gear = String(d.gear);
    if (typeof d.rpm === 'number') out.rpm = withCommas(Math.round(d.rpm / 100) * 100);
    return out;
}

function findAssets(dirs) {
    for (let i = 0; i < dirs.length; i++) if (fs.existsSync(path.join(dirs[i], 'themes.json'))) return dirs[i];
    throw new Error(`no assets/themes.json in ${dirs.join(', ')}`);
}

class ClusterTheme extends EventEmitter {
    /* opts: app (id for the logs), assets (folder with themes.json), theme (id),
     * logger, socket (cluster-render's socket, default the client's). */
    constructor(ClusterRender, opts) {
        super();
        this.CR = ClusterRender;
        this.o = opts;
        this.log = opts.logger;
        this.cr = null;
        this.refs = {};
        this.readouts = {};
        this.levels = {};
        this.lastLevel = 0;
        this.levelsShown = true;
        this.shown = false;
        this.data = {};
        this.sent = {};
        this.lastText = 0;
        this.timer = null;
        this.layerState = {};
        this.targetState = '';
    }

    /* Reads the theme's files. Throws when one is missing or broken. */
    load() {
        const dir = path.join(this.o.assets, this.o.theme);
        const read = (f) => fs.readFileSync(path.join(dir, f));
        this.theme = JSON.parse(read('theme.json').toString('utf8'));
        this.plate = decode(read('plate.png'));
        if (this.plate.width !== 1920 || this.plate.height !== 720) throw new Error(`plate is ${this.plate.width}x${this.plate.height}, not 1920x720`);
        this.needle = decode(read('needle.png'));
        this.hubs = { speed: decode(read('hub_speed.png')), rpm: decode(read('hub_rpm.png')) };
        const fonts = JSON.parse(read('glyphs.json').toString('utf8'));
        if (this.theme.level) {
            ['speed', 'rpm'].forEach((g) => {
                const b = levelBand(this.theme[g], this.theme.level);
                this.levels[g] = { band: b, img: Buffer.alloc(b.w * b.h * 4), lit: 0 };
            });
        }
        Object.keys(this.theme.readouts).forEach((k) => {
            const r = this.theme.readouts[k];
            this.readouts[k] = { def: r, font: glyphs.unpack(fonts[k]), w: r.box[2], h: r.box[3],
                img: Buffer.alloc(r.box[2] * r.box[3] * 4), text: null, span: null };
        });
        this.log.info(`theme ${this.theme.id}: ${this.theme.name} loaded${this.theme.plateIsRender ? ' (plate is the render: needles drawn twice)' : ''}`);
        return this.theme;
    }

    start() {
        const cr = this.cr = new this.CR(this.o.app, this.o.socket);
        const t = this.theme, base = { target: TARGET, klass: 'content', visible: false };
        this.refs.plate = cr.image(Object.assign({}, base, { z: 0, x: 0, y: 0, w: 1920, h: 720 }));
        cr.pixels(this.refs.plate, null, this.plate.data);
        Object.keys(this.levels).forEach((g) => {
            const l = this.levels[g], b = l.band;
            this.refs[`level_${g}`] = cr.image(Object.assign({}, base, { z: 1, x: b.x, y: b.y, w: b.w, h: b.h }));
            cr.pixels(this.refs[`level_${g}`], null, l.img);
        });
        ['speed', 'rpm'].forEach((g) => {
            const pv = t[g].pivot, n = t.needle, hr = t.hubRadius;
            const ref = this.refs[`needle_${g}`] = cr.image(Object.assign({}, base, {
                z: 2, x: pv[0] - n.pivotX, y: pv[1] - n.pivotY, w: this.needle.width, h: this.needle.height,
                px: n.pivotX, py: n.pivotY, rotate: 0, sx: 1, sampling: 'bilinear' }));
            cr.pixels(ref, null, this.needle.data);
            const hub = this.refs[`hub_${g}`] = cr.image(Object.assign({}, base, {
                z: 3, x: pv[0] - hr, y: pv[1] - hr, w: this.hubs[g].width, h: this.hubs[g].height }));
            cr.pixels(hub, null, this.hubs[g].data);
        });
        Object.keys(this.readouts).forEach((k) => {
            const r = this.readouts[k], b = r.def.box;
            this.refs[`text_${k}`] = cr.image(Object.assign({}, base, { z: 2, x: b[0], y: b[1], w: b[2], h: b[3] }));
            cr.pixels(this.refs[`text_${k}`], null, r.img);
        });
        Object.keys(this.refs).forEach((k) => { if (!this.refs[k]) throw new Error(`cluster-render client refused layer ${k}`); });
        const names = {};
        Object.keys(this.refs).forEach((k) => { names[this.refs[k]] = k; });
        cr.on('ready', () => { this.log.info(`cluster-render ready (${cr.backend}: ${cr.targets})`); this.emit('renderer', 'ready'); });
        cr.on('disconnected', () => { this.log.warn('cluster-render went away'); this.emit('renderer', 'gone'); });
        cr.on('layer', (ref, state, reason) => {
            if (this.layerState[ref] !== state) this.log.info(`layer ${names[ref] || ref}: ${state}${reason ? ` (${reason})` : ''}`);
            this.layerState[ref] = state;
            if (ref === this.refs.plate) this.emit('plate', state, reason);
        });
        cr.on('target', (name, state, holder, reason) => {
            if (name !== TARGET) return;
            this.targetState = state;
            this.log.info(`target ${name}: ${state}${holder ? ` held by ${holder}` : ''}${reason ? ` (${reason})` : ''}`);
            this.emit('target', state, holder, reason);
        });
        cr.on('refused', (op, ref, reason) => this.log.warn(`cluster-render refused ${op} ${names[ref] || ref}: ${reason}`));
        cr.connect();
        this.timer = setInterval(() => this._tick(), SEND_MS);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.cr) this.cr.close();
        this.cr = null;
    }

    update(d) { this.data = d || {}; }

    /* The level bands (the glow) on or off; the rest of the theme stays. */
    levelsOn(on) {
        this.levelsShown = !!on;
        if (!this.cr || !this.shown) return;
        Object.keys(this.levels).forEach((g) => this.cr.set(this.refs[`level_${g}`], { visible: this.levelsShown }));
    }

    show(on) {
        if (!this.cr || on === this.shown) return;
        this.shown = on;
        this.log.info(on ? 'theme on the cluster' : 'theme off the cluster');
        if (on) { this.sent = {}; this.lastText = 0; this.lastLevel = 0; this._tick(); }
        Object.keys(this.refs).forEach((k) => this.cr.set(this.refs[k], { visible: on && (this.levelsShown || k.indexOf('level_') !== 0) }));
    }

    _tick() {
        if (!this.cr || !this.shown) return;
        const t = this.theme, d = this.data;
        const spd = typeof d.speedKmh === 'number' ? (t.speed.unit === 'mph' ? d.speedKmh * KMH_TO_MPH : d.speedKmh) : 0;
        this._needle('speed', aim(t.speed, spd));
        this._needle('rpm', aim(t.rpm, typeof d.rpm === 'number' ? d.rpm : 0));
        const now = Date.now();
        if (now - this.lastLevel >= LEVEL_MS) {
            this.lastLevel = now;
            if (this.levels.speed) this._level('speed', spd);
            if (this.levels.rpm) this._level('rpm', typeof d.rpm === 'number' ? d.rpm : 0);
        }
        if (now - this.lastText >= TEXT_MS) {
            this.lastText = now;
            const tx = texts(t, d);
            Object.keys(this.readouts).forEach((k) => this._text(k, tx[k]));
        }
    }

    _needle(g, a) {
        const sx = a.length / this.theme.needle.length, last = this.sent[g];
        if (last && Math.abs(last.rotate - a.rotate) < MIN_DEG && Math.abs(last.sx - sx) < MIN_SCALE) return;
        this.sent[g] = { rotate: a.rotate, sx };
        this.cr.set(this.refs[`needle_${g}`], { rotate: Math.round(a.rotate * 100) / 100, sx: Math.round(sx * 1000) / 1000 });
    }

    /* Lights the band up to v; sends only the box around the pixels that changed. */
    _level(g, v) {
        const l = this.levels[g], b = l.band, n = litCount(b, Math.max(0, v));
        if (n === l.lit) return;
        const from = Math.min(n, l.lit), to = Math.max(n, l.lit), on = n > l.lit;
        let x0 = b.w, y0 = b.h, x1 = 0, y1 = 0;
        for (let k = from; k < to; k++) {
            const i = b.idx[k], x = i % b.w, y = (i / b.w) | 0, o = i * 4;
            if (on) b.rgba.copy(l.img, o, o, o + 4); else l.img.fill(0, o, o + 4);
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
        l.lit = n;
        const rw = x1 - x0 + 1, rows = [];
        for (let y = y0; y <= y1; y++) rows.push(l.img.slice((y * b.w + x0) * 4, (y * b.w + x0 + rw) * 4));
        this.cr.pixels(this.refs[`level_${g}`], [{ x: x0, y: y0, w: rw, h: y1 - y0 + 1 }], Buffer.concat(rows));
    }

    /* Redraws a readout; sends only the columns the old and new text cover. */
    _text(k, text) {
        const r = this.readouts[k];
        if (r.text === text) return;
        r.text = text;
        const def = r.def, f = r.font, pad = (f.pad || 0) + Math.abs((f.shadow && f.shadow.dx) || 0) + 2;
        const x = def.x - def.box[0], y = def.y - def.box[1], w = glyphs.width(f, text);
        const left = def.align === 'center' ? x - w / 2 : def.align === 'right' ? x - w : x;
        const span = text ? [Math.max(0, Math.floor(left - pad)), Math.min(r.w, Math.ceil(left + w + pad))] : null;
        r.img.fill(0);
        if (text) glyphs.draw(r.img, r.w, r.h, f, text, x, y, { align: def.align, color: def.color });
        const both = [span, r.span].filter(Boolean);
        r.span = span;
        if (!both.length) return;
        const x0 = Math.min.apply(null, both.map((s) => s[0])), x1 = Math.max.apply(null, both.map((s) => s[1]));
        if (x1 <= x0) return;
        const rows = [];
        for (let yy = 0; yy < r.h; yy++) rows.push(r.img.slice((yy * r.w + x0) * 4, (yy * r.w + x1) * 4));
        this.cr.pixels(this.refs[`text_${k}`], [{ x: x0, y: 0, w: x1 - x0, h: r.h }], Buffer.concat(rows));
    }
}

module.exports = { ClusterTheme, aim, texts, levelBand, litCount, findAssets, TARGET };
