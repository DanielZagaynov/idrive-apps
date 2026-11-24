'use strict';
/**
 * draw.js - draws a Lane Hop frame as mgu-render draw ops (PROTOCOL.md, "Draw
 * ops"): CLEAR and RECT only, in logical px, colours 0xRRGGBBAA. Everything is
 * blocky pixel art made of rectangles, so the renderer's GPU does the drawing
 * and a frame is a few tens of kilobytes.
 *
 * The view is a raised 3/4 view: forward is up the screen, and every object
 * (cars, trees, logs, trains, the hamster) is a block with a lit top face, a
 * darker front face and a shadow on the ground, drawn far to near so nearer
 * things stand in front.
 *
 * Logical px: one grid cell is CELL x CELL; LANES lanes fit the field's height.
 * The app places the renderer with scale = box height / FIELD_H, so the field
 * fills the page's height whatever the box is; the play area (WIDTH cells) is
 * centred, and the scenery either side of it is dimmed.
 *
 * Node 8: no ?. ?? or class fields.
 */
const G = require('./game');
const WIDTH = G.WIDTH, hash2 = G.hash2;

const CELL = 12;
const LANES = 11;
const FIELD_H = LANES * CELL;
const OP_CLEAR = 1, OP_RECT = 2;

/* ---- the op buffer ---- */

class Ops {
    constructor() {
        this._grow(16384);
        this.n = 0;
    }
    _grow(words) {
        const f = new Float32Array(words);
        if (this.f) f.set(this.f.subarray(0, this.n));
        this.f = f;
        this.u = new Uint32Array(f.buffer);
    }
    reset() { this.n = 0; return this; }
    _room(k) { if (this.n + k > this.f.length) this._grow(this.f.length * 2); }
    clear(c) {
        this._room(2);
        this.u[this.n++] = OP_CLEAR; this.u[this.n++] = c >>> 0;
    }
    rect(x, y, w, h, c) {
        if (w <= 0 || h <= 0) return;
        this._room(6);
        const n = this.n;
        this.u[n] = OP_RECT; this.f[n + 1] = x; this.f[n + 2] = y; this.f[n + 3] = w; this.f[n + 4] = h;
        this.u[n + 5] = c >>> 0;
        this.n = n + 6;
    }
    words() { return this.u.subarray(0, this.n); }
}

/* ---- colours ---- */

const K = {
    sky: 0x203040ff,
    grass: [0x9bd84fff, 0x92cf48ff], grassEdge: 0x6c9f33ff, dirt: 0x8a6a3cff, tuft: 0x7fbd3cff,
    flower: [0xfff176ff, 0xffffffff, 0xff8a80ff],
    trunk: 0x8d5a32ff, trunkDark: 0x6b4223ff,
    leaf: [0x5cbf3fff, 0x4caf50ff, 0x7cc94aff], leafDark: [0x3c8f2bff, 0x2f7d3aff, 0x5a9e33ff],
    rock: 0xb0b6bcff, rockDark: 0x80878eff,
    road: 0x52575fff, roadEdge: 0x3e4249ff, dash: 0xe8e8e8ff, curb: 0xb9bcc0ff,
    water: 0x4fb3efff, waterDeep: 0x3f9edcff, wave: 0x8fd3ffff, bank: 0x2f7fb8ff, foam: 0xe8f7ffff,
    log: 0xa86f3cff, logTop: 0xc58a4fff, logDark: 0x7a4b25ff, ring: 0xe2b97fff,
    gravel: 0x9c9284ff, gravelDark: 0x7d7468ff, sleeper: 0x6b4f37ff, steel: 0xd5dadeff, steelDark: 0x8e959cff,
    post: 0x37474fff, lampOff: 0x5b1a1aff, lampOn: 0xff3b30ff, lampGlow: 0xff3b3055,
    train: 0x2e6fb0ff, trainTop: 0x4a8ad0ff, trainNose: 0xffc83dff, trainNoseTop: 0xffd970ff, trainWin: 0xc7ecffff, trainGap: 0x1c2a38ff,
    cars: [0xe84a4aff, 0xffcf33ff, 0x9c5ce6ff, 0x2ec4d6ff, 0xff8a33ff, 0x52d273ff],
    glass: 0xbfe9ffff, glassDark: 0x7fbfe0ff, tyre: 0x22252aff, lamp: 0xfff6b0ff, tail: 0xff5252ff,
    box: [0xf4f4f4ff, 0x4a90d9ff, 0xff8a33ff],
    outline: 0x4a2c14ff, fur: 0xf0a85aff, furLit: 0xf4bd7eff, furDark: 0xc9803eff, belly: 0xfff1dcff, ear: 0xff9fb0ff,
    eye: 0x1b1b1bff, shine: 0xffffffff, nose: 0xff6f8aff,
    shadow: 0x00000038, splash: 0xe3f4ffff, dim: 0x0b1d2e70,
    text: 0xffffffff, textDim: 0xd5dde2ff, panel: 0x0d1117c8, gold: 0xffd54fff, red: 0xff6e6eff
};

/* Light / dark variants of a colour (keeps alpha). */
function shade(c, f) {
    const ch = (s) => Math.max(0, Math.min(255, Math.round(((c >>> s) & 255) * f))) << s;
    return ((ch(24) | ch(16) | ch(8)) >>> 0 | (c & 255)) >>> 0;
}

/* ---- a 3 x 5 pixel font ---- */

const FONT = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
    '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001010010010',
    '8': '111101111101111', '9': '111101111001111',
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
    E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
    I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
    M: '101111111101101', N: '111101101101101', O: '010101101101010', P: '110101110100100',
    Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
    U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
    Y: '101101010010010', Z: '111001010100111',
    '!': '010010010000010', ':': '000010000010000', '-': '000000111000000', '.': '000000000000010',
    '/': '001001010100100', '+': '000010111010000', ' ': '000000000000000'
};

function textWidth(s, sc) {
    return s.length ? (s.length * 4 - 1) * sc : 0;
}

/* Text at x, y (top left), sc px per font pixel; runs of lit pixels in a row become one rect. */
function text(ops, s, x, y, sc, c) {
    const str = String(s).toUpperCase();
    for (let i = 0; i < str.length; i++) {
        const g = FONT[str[i]] || FONT[' '];
        const gx = x + i * 4 * sc;
        for (let row = 0; row < 5; row++) {
            let run = -1;
            for (let col = 0; col <= 3; col++) {
                const on = col < 3 && g[row * 3 + col] === '1';
                if (on && run < 0) run = col;
                if (!on && run >= 0) {
                    ops.rect(gx + run * sc, y + row * sc, (col - run) * sc, sc, c);
                    run = -1;
                }
            }
        }
    }
}

function centred(ops, s, cx, y, sc, c) {
    text(ops, s, Math.round(cx - textWidth(s, sc) / 2), y, sc, c);
}

/* ---- the view ---- */

/* Where things go on screen for this frame. */
function view(g, w) {
    const ox = Math.round((w - WIDTH * CELL) / 2);
    return {
        w, ox,
        sx: (y) => ox + y * CELL,                                   // left edge of cell column y
        ly: (x) => FIELD_H - (x - g.camX + 1) * CELL,               // top edge of lane x
        yMin: Math.floor(-ox / CELL) - 1,
        yMax: Math.ceil((w - ox) / CELL) + 1
    };
}

/*
 * A block standing on the ground: footprint x..x+w wide, from screen row
 * `back` down `depth` px; it rises `h` px. Top face lit, front face dark.
 */
function block(ops, x, back, w, depth, h, top, front) {
    ops.rect(x, back - h, w, depth, top);
    ops.rect(x, back - h + depth, w, h, front);
}

/* ---- ground, lane by lane ---- */

function ground(ops, g, v, col) {
    const y0 = v.ly(col.x);
    const nearer = g.column(col.x - 1).type, farther = g.column(col.x + 1).type;
    if (col.type === 'grass') {
        ops.rect(0, y0, v.w, CELL, K.grass[col.x & 1]);
        for (let y = v.yMin; y <= v.yMax; y++) {
            const h = hash2(col.x, y);
            if (h % 5 === 0) ops.rect(v.sx(y) + (h >>> 4) % 8 + 1, y0 + (h >>> 8) % 7 + 2, 2, 1, K.tuft);
            else if (h % 23 === 1) ops.rect(v.sx(y) + (h >>> 4) % 8 + 2, y0 + (h >>> 8) % 6 + 3, 1.5, 1.5, K.flower[(h >>> 12) % 3]);
        }
        // the raised grass shows its edge where the lane in front is lower
        if (nearer !== 'grass') { ops.rect(0, y0 + CELL - 2, v.w, 1, K.grassEdge); ops.rect(0, y0 + CELL - 1, v.w, 1, K.dirt); }
    } else if (col.type === 'road') {
        ops.rect(0, y0, v.w, CELL, K.road);
        if (farther === 'road') {
            for (let x = v.sx(v.yMin) + ((col.x * 5) % 8); x < v.w; x += 8) ops.rect(x, y0 - 0.5, 4, 1, K.dash);
        } else {
            ops.rect(0, y0, v.w, 1, K.curb);
        }
        if (nearer !== 'road') { ops.rect(0, y0 + CELL - 1, v.w, 1, K.curb); }
    } else if (col.type === 'water') {
        ops.rect(0, y0, v.w, CELL, (col.x & 1) ? K.water : K.waterDeep);
        if (farther !== 'water') ops.rect(0, y0, v.w, 2, K.bank);           // the bank's shadow on the water
        const drift = ((g.time * col.speed * col.dir * CELL) % 16 + 16) % 16;
        for (let x = -16 + drift + (col.x % 4) * 4; x < v.w; x += 16) ops.rect(x, y0 + 5 + (col.x % 3), 4, 1, K.wave);
    } else {
        ops.rect(0, y0, v.w, CELL, K.gravel);
        ops.rect(0, y0 + CELL - 1, v.w, 1, K.gravelDark);
        for (let x = v.sx(v.yMin); x < v.w; x += 4) ops.rect(x, y0 + 2, 2, 8, K.sleeper);
        ops.rect(0, y0 + 3, v.w, 1, K.steel); ops.rect(0, y0 + 4, v.w, 0.5, K.steelDark);
        ops.rect(0, y0 + 8, v.w, 1, K.steel); ops.rect(0, y0 + 9, v.w, 0.5, K.steelDark);
    }
}

/* ---- things that stand up ---- */

function tree(ops, x, y0, kind, tint) {
    if (kind === 2) {                                   // a rock
        ops.rect(x + 3, y0 + 7, 8, 4, K.shadow);
        block(ops, x + 2, y0 + 4, 8, 5, 4, K.rock, K.rockDark);
        ops.rect(x + 3, y0, 3, 1, 0xffffff50);
        return;
    }
    const leaf = K.leaf[tint % 3], dark = K.leafDark[tint % 3];
    ops.rect(x + 2.5, y0 + 6, 10, 5, K.shadow);
    ops.rect(x + 5, y0 + 7, 2.5, 4, K.trunkDark);
    ops.rect(x + 5, y0 + 6.5, 2.5, 0.5, K.trunk);
    if (kind === 1) {                                   // tall: two tiers
        block(ops, x + 1, y0 + 2, 10, 7, 5, leaf, dark);
        block(ops, x + 2.5, y0 + 2 - 5, 7, 6, 5, shade(leaf, 1.08), dark);
        ops.rect(x + 3.5, y0 - 8, 2, 1, 0xffffff40);
    } else {
        block(ops, x + 1, y0 + 2, 10, 7, 6, leaf, dark);
        ops.rect(x + 2.5, y0 - 3, 2, 1, 0xffffff40);
    }
}

function vehicle(ops, x, y0, it, dir) {
    const w = it.len * CELL - 2;
    const body = K.cars[it.color % K.cars.length];
    const lit = shade(body, 1.15), dark = shade(body, 0.75);
    const back = y0 + 3;
    ops.rect(x + 1.5, back + 2, w, 7, K.shadow);
    if (it.len > 2) {
        // a truck: the cab at the front, a tall box behind
        const cabW = 9;
        const cabX = dir > 0 ? x + w - cabW : x;
        const boxX = dir > 0 ? x : x + cabW + 1;
        const boxC = K.box[it.color % K.box.length];
        block(ops, boxX, back - 1, w - cabW - 1, 8, 8, shade(boxC, 1.05), shade(boxC, 0.82));
        ops.rect(boxX + 1, back + 1, w - cabW - 3, 1, 0xffffff30);
        block(ops, cabX, back, cabW, 7, 4, lit, dark);
        block(ops, dir > 0 ? cabX + 1 : cabX + 2, back + 1, 6, 5, 7, lit, dark);
        ops.rect(dir > 0 ? cabX + 5 : cabX + 2, back - 5, 2, 3, K.glass);         // windscreen
        ops.rect(dir > 0 ? cabX + 2 : cabX + 4, back - 1, 3, 2.5, K.glass);       // side window
        ops.rect(boxX + 2, back + 5, 3, 2, K.tyre); ops.rect(boxX + w - cabW - 6, back + 5, 3, 2, K.tyre);
        ops.rect(cabX + 3, back + 5, 3, 2, K.tyre);
    } else {
        block(ops, x, back, w, 7, 4, lit, dark);
        const cabW = w * 0.55, cabX = x + (w - cabW) / 2 + (dir > 0 ? -1 : 1);
        block(ops, cabX, back + 1, cabW, 5, 3.5, shade(body, 1.25), K.glassDark);
        ops.rect(cabX + 1, back + 2.5, cabW - 2, 1.5, K.glass);
        ops.rect(x + 2, back + 5.5, 3, 2, K.tyre); ops.rect(x + w - 5, back + 5.5, 3, 2, K.tyre);
    }
    ops.rect(dir > 0 ? x + w - 1 : x, back + 3.5, 1, 1.5, K.lamp);
    ops.rect(dir > 0 ? x : x + w - 1, back + 3.5, 1, 1.5, K.tail);
}

function logPiece(ops, x, y0, w) {
    const back = y0 + 3;
    ops.rect(x + 1, back + 6, w, 1.5, 0xffffff40);      // a wake
    block(ops, x, back, w, 6, 3, K.logTop, K.log);
    for (let k = x + 4; k < x + w - 3; k += 7) ops.rect(k, back - 2, 3, 0.75, K.logDark);
    ops.rect(x, back + 3, 1.5, 3, K.ring); ops.rect(x + w - 1.5, back + 3, 1.5, 3, K.ring);
    ops.rect(x - 1, back + 5, 1, 1, K.foam); ops.rect(x + w, back + 5, 1, 1, K.foam);
}

function signal(ops, g, x, y0, col) {
    const t = g.train(col);
    const on = t.warning && Math.floor(g.time * 6) % 2 === 0;
    ops.rect(x + 6, y0 + 9, 4, 2, K.shadow);
    ops.rect(x + 5, y0 - 4, 1.5, 13, K.post);
    block(ops, x + 3, y0 - 6, 6, 2, 4, K.post, 0x263238ff);
    ops.rect(x + 3.5, y0 - 5.5, 2, 2, on ? K.lampOn : K.lampOff);
    ops.rect(x + 6.5, y0 - 5.5, 2, 2, !on && t.warning ? K.lampOn : K.lampOff);
    if (on) ops.rect(x + 1.5, y0 - 7, 5, 5, K.lampGlow);
}

function trainCars(ops, v, col, t, y0) {
    const x = v.sx(t.y), w = t.len * CELL;
    const back = y0 + 2;
    ops.rect(x + 2, back + 3, w, 8, K.shadow);
    block(ops, x, back, w, 7, 9, K.trainTop, K.train);
    const noseW = 14;
    const nx = col.dir > 0 ? x + w - noseW : x;
    block(ops, nx, back, noseW, 7, 9, K.trainNoseTop, K.trainNose);
    for (let k = 1; k * 4 * CELL < w - 2; k++) {
        const gx = col.dir > 0 ? x + w - k * 4 * CELL : x + k * 4 * CELL;
        ops.rect(gx - 0.5, back - 2, 1, 9, K.trainGap);
    }
    for (let wx = x + 5; wx < x + w - 6; wx += 7) {
        if (wx > nx - 4 && wx < nx + noseW) continue;
        ops.rect(wx, back, 4, 3, K.trainWin);
    }
    ops.rect(col.dir > 0 ? x + w - 3 : x + 1, back + 1, 2, 3, K.trainWin);
}

/* ---- the hamster ---- */

function hamster(ops, g, cx, gy) {
    const p = g.player;
    const over = g.state === 'over';
    if (over && (g.death === 'water' || g.death === 'drift')) {
        const k = Math.min(1, (g.time - g.deadAt) * 2);
        const r = 2 + k * 6;
        ops.rect(cx - r, gy - 1, r * 2, 1, K.splash);
        ops.rect(cx - r * 0.6, gy - 3, r * 1.2, 1, K.splash);
        ops.rect(cx - 1, gy - 4 - k * 4, 2, 2, K.splash);
        ops.rect(cx - 4 - k * 2, gy - 3 - k * 2, 1.5, 1.5, K.splash);
        ops.rect(cx + 3 + k * 2, gy - 3 - k * 2, 1.5, 1.5, K.splash);
        return;
    }
    if (over) {
        // flattened
        ops.rect(cx - 7, gy - 2, 14, 2.5, K.fur);
        ops.rect(cx - 5, gy - 2.5, 10, 0.5, K.furLit);
        ops.rect(cx - 3, gy - 1.5, 1, 1, K.eye); ops.rect(cx + 2, gy - 1.5, 1, 1, K.eye);
        ops.rect(cx - 8, gy - 1.5, 1.5, 1, K.ear); ops.rect(cx + 6.5, gy - 1.5, 1.5, 1, K.ear);
        return;
    }
    const air = p.hop < 1 ? Math.sin(Math.PI * p.hop) : 0;
    const lift = air * 6;
    const stretch = 1 + air * 0.22;                     // taller and thinner in the air
    const bw = 10.5 / Math.sqrt(stretch), bh = 7 * stretch, topD = 3.5;
    ops.rect(cx - 5 + air * 2, gy - 1.5, 10 - air * 4, 3, K.shadow);
    const left = cx - bw / 2, bottom = gy - lift;
    const top = bottom - bh;
    // an outline so it stands out on the grass
    ops.rect(left + 0.5, top - topD - 0.6, bw - 1, bh + topD + 1.2, K.outline);
    ops.rect(left - 0.6, top - topD + 0.5, bw + 1.2, bh + topD - 1, K.outline);
    // ears behind the head
    ops.rect(left + 0.5, top - topD - 2.5, 3, 3, K.outline); ops.rect(left + bw - 3.5, top - topD - 2.5, 3, 3, K.outline);
    ops.rect(left + 1, top - topD - 2, 2, 2.5, K.furDark); ops.rect(left + bw - 3, top - topD - 2, 2, 2.5, K.furDark);
    ops.rect(left + 1.5, top - topD - 1.5, 1, 1.5, K.ear); ops.rect(left + bw - 2.5, top - topD - 1.5, 1, 1.5, K.ear);
    // the body: a rounded block (lit top, front below), plump at the bottom
    ops.rect(left + 1, top - topD, bw - 2, topD, K.furLit);
    ops.rect(left, top - topD + 1, bw, topD - 1, K.furLit);
    ops.rect(left, top, bw, bh - 1, K.fur);
    ops.rect(left + 1, bottom - 1, bw - 2, 1, K.fur);
    ops.rect(left, top, bw, 0.6, K.furDark);                                              // where top meets front
    // the face, by which way it is going (forward = away from us)
    const face = p.face;
    if (face === 'forward') {
        ops.rect(cx - 1, bottom - 3.5, 2, 2, K.belly);                                     // a little tail
        ops.rect(cx - 2.5, top - topD + 0.8, 5, 0.8, K.furDark);
    } else if (face === 'back') {
        ops.rect(cx - 2.5, top + 2, 5, bh - 3, K.belly);
        ops.rect(cx - 3, top + 1, 1.2, 1.5, K.eye); ops.rect(cx + 1.8, top + 1, 1.2, 1.5, K.eye);
        ops.rect(cx - 2.8, top + 1, 0.5, 0.5, K.shine); ops.rect(cx + 2, top + 1, 0.5, 0.5, K.shine);
        ops.rect(cx - 0.6, top + 2.5, 1.2, 0.8, K.nose);
        ops.rect(cx - 4.2, top + 2.6, 1.2, 0.8, K.ear); ops.rect(cx + 3, top + 2.6, 1.2, 0.8, K.ear);
    } else if (face === 'left' || face === 'right') {
        const s = face === 'right' ? 1 : -1;
        ops.rect(s > 0 ? cx - 1 : cx - 3, top + 2.5, 4, bh - 3.5, K.belly);
        ops.rect(cx + s * 2.2 - 0.6, top + 1, 1.2, 1.5, K.eye);
        ops.rect(cx + s * (bw / 2) - (s > 0 ? 0.6 : 0.4), top + 2.2, 1, 0.9, K.nose);
        ops.rect(cx - s * (bw / 2) - (s > 0 ? 1 : 0), top + bh - 3, 1, 1, K.furDark);     // tail
    }
    // feet
    const feet = p.hop < 1 ? 0.5 : 0;
    ops.rect(left + 1, bottom - 0.5 + feet, 2, 1, K.ear); ops.rect(left + bw - 3, bottom - 0.5 + feet, 2, 1, K.ear);
}

/* ---- overlays ---- */

const DEATHS = { hit: 'SQUASHED BY A CAR', train: 'FLATTENED BY A TRAIN', water: 'SPLASH! HAMSTERS CANT SWIM', drift: 'SWEPT AWAY BY THE RIVER' };

function panel(ops, w, y, h) {
    const pw = Math.min(w - 16, 230);
    ops.rect(Math.round((w - pw) / 2), y, pw, h, K.panel);
}

function hud(ops, g, w) {
    const score = String(g.score);
    ops.rect(2, 2, textWidth(score, 3) + 8, 21, K.panel);
    text(ops, score, 6, 5, 3, K.text);
    const best = 'TOP ' + g.best;
    const bw = textWidth(best, 2);
    ops.rect(w - bw - 10, 2, bw + 8, 16, K.panel);
    text(ops, best, w - bw - 6, 5, 2, K.textDim);
}

function overlay(ops, g, w, msg) {
    const cx = w / 2;
    if (msg) {
        panel(ops, w, 36, 52);
        centred(ops, msg.title, cx, 46, 3, K.gold);
        centred(ops, msg.line || '', cx, 70, 2, K.text);
        return;
    }
    if (g.state === 'ready') {
        panel(ops, w, 14, 64);
        centred(ops, 'LANE HOP', cx, 21, 5, K.gold);
        centred(ops, 'PRESS OR TAP TO HOP', cx, 50, 2, K.text);
        centred(ops, 'TILT OR SWIPE: ANY WAY   KNOB: LEFT / RIGHT', cx, 64, 1, K.textDim);
    } else if (g.state === 'over' && g.time - g.deadAt > 0.4) {
        panel(ops, w, 14, 80);
        centred(ops, 'GAME OVER', cx, 22, 4, K.red);
        centred(ops, DEATHS[g.death] || '', cx, 46, 1, K.textDim);
        centred(ops, 'SCORE ' + g.score + (g.newBest ? '  NEW TOP!' : ''), cx, 56, 2, g.newBest ? K.gold : K.text);
        centred(ops, 'PRESS TO PLAY AGAIN', cx, 74, 2, K.text);
    }
}

/**
 * One frame into ops (reset first). w = the box's width in logical px (field
 * height is FIELD_H). msg: { title, line } shows a panel over a paused game.
 */
function frame(ops, g, w, msg) {
    ops.reset();
    ops.clear(K.sky);
    const v = view(g, w);
    const p = g.player;
    const near = Math.floor(g.camX) - 1;
    const far = Math.ceil(g.camX + LANES) + 1;
    // the ground, then what stands on it, far to near
    for (let x = far; x >= near; x--) ground(ops, g, v, g.column(x));
    const k = p.hop < 1 ? p.hop : 1;
    const px = p.fromX + (p.x - p.fromX) * k;
    const py = p.fromY + (p.y - p.fromY) * k;
    const pLane = Math.round(px);
    for (let x = far; x >= near; x--) {
        const col = g.column(x);
        const y0 = v.ly(x);
        if (col.type === 'grass') {
            col.decor.forEach((y) => { if (y >= v.yMin && y <= v.yMax) tree(ops, v.sx(y), y0, hash2(x, y) % 4 === 0 ? 1 : 0, hash2(y, x) % 3); });
            col.trees.forEach((y, i) => tree(ops, v.sx(y), y0, col.kinds[i], hash2(x, y) % 3));
        } else if (col.type === 'road') {
            col.items.forEach((it) => {
                const sx = v.sx(g.itemY(col, it));
                if (sx < w && sx + it.len * CELL > 0) vehicle(ops, sx + 1, y0, it, col.dir);
            });
        } else if (col.type === 'water') {
            col.items.forEach((it) => {
                const sx = v.sx(g.itemY(col, it));
                if (sx < w && sx + it.len * CELL > 0) logPiece(ops, sx + 0.5, y0, it.len * CELL - 1);
            });
        } else {
            signal(ops, g, v.sx(-1), y0, col);
            signal(ops, g, v.sx(WIDTH), y0, col);
            const t = g.train(col);
            if (t.y !== null) trainCars(ops, v, col, t, y0);
        }
        if (x === pLane) {
            const ly = FIELD_H - (px - g.camX + 1) * CELL;
            hamster(ops, g, v.sx(py) + CELL / 2, ly + 9);
        }
    }
    // the scenery beyond the play area is dimmed
    ops.rect(0, 0, v.ox, FIELD_H, K.dim);
    ops.rect(v.ox + WIDTH * CELL, 0, w - v.ox - WIDTH * CELL, FIELD_H, K.dim);
    hud(ops, g, w);
    overlay(ops, g, w, msg);
    return ops;
}

module.exports = { Ops, frame, text, textWidth, CELL, LANES, FIELD_H, OP_CLEAR, OP_RECT, FONT };
