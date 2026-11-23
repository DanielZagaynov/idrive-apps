'use strict';
/**
 * draw.js - draws a Lane Hop frame as mgu-render draw ops (PROTOCOL.md, "Draw
 * ops"): CLEAR and RECT only, in logical px, colours 0xRRGGBBAA. Everything is
 * blocky pixel art made of rectangles, so the renderer's GPU does the drawing
 * and a frame is a few kilobytes.
 *
 * Logical px: one grid cell is CELL x CELL; the playfield is ROWS cells high.
 * The app places the renderer with scale = box height / (ROWS * CELL), so the
 * field fills the page's height whatever the box is.
 *
 * Node 8: no ?. ?? or class fields.
 */
const ROWS = require('./game').ROWS;

const CELL = 12;
const FIELD_H = ROWS * CELL;
const OP_CLEAR = 1, OP_RECT = 2;

/* ---- the op buffer ---- */

class Ops {
    constructor() {
        this._grow(8192);
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
    sky: 0x1b2430ff,
    grass: [0x6cc24aff, 0x64b944ff], flower: [0xfff176ff, 0xf8bbd0ff],
    trunk: 0x7a4b2aff, leaf: 0x2e7d32ff, leafLit: 0x43a047ff,
    road: [0x4a4e55ff, 0x45494fff], dash: 0xd9d9d9ff, curb: 0x9e9e9eff,
    water: [0x3b8fd9ff, 0x3786cfff], ripple: 0x6fb5f0ff,
    crate: 0xb5803fff, crateEdge: 0x7d5524ff,
    gravel: 0x8d8577ff, sleeper: 0x5d4632ff, steel: 0xc3c7ccff,
    lampOff: 0x5b1a1aff, lampOn: 0xff3b30ff, post: 0x37474fff,
    train: 0x2f5d8aff, trainStripe: 0xf5f5f5ff, trainWin: 0xbfe6ffff, trainNose: 0xffc107ff,
    cars: [0xe53935ff, 0xfdd835ff, 0x8e24aaff, 0x00acc1ff, 0xf4511eff],
    glass: 0xcfeeffff, tyre: 0x212121ff, lamp: 0xfff59dff,
    robot: 0xff8f1fff, robotDark: 0xd9700cff, visor: 0x263238ff, eye: 0x7ef9ffff, tip: 0xff5252ff,
    shadow: 0x00000040, splash: 0xe3f2fdff,
    text: 0xffffffff, textDim: 0xcfd8dcff, panel: 0x0d1117c8, gold: 0xffd54fff, red: 0xff6e6eff
};

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

/* ---- the pieces ---- */

function grassColumn(ops, g, col, sx) {
    ops.rect(sx, 0, CELL, FIELD_H, K.grass[col.x & 1]);
    (col.flowers || []).forEach((fy, i) => {
        if (col.trees.indexOf(fy) < 0) ops.rect(sx + 3 + i * 5, fy * CELL + 4 + i * 3, 2, 2, K.flower[i]);
    });
    col.trees.forEach((ty) => {
        const y = ty * CELL;
        ops.rect(sx + 5, y + 8, 2, 3, K.trunk);
        ops.rect(sx + 2, y + 2, 8, 7, K.leaf);
        ops.rect(sx + 3, y + 1, 6, 1, K.leaf);
        ops.rect(sx + 3, y + 3, 3, 3, K.leafLit);
    });
}

function roadColumn(ops, g, col, sx) {
    ops.rect(sx, 0, CELL, FIELD_H, K.road[col.x & 1]);
    const prev = g.column(col.x - 1), next = g.column(col.x + 1);
    // dashed lane line where two roads meet, a curb where the road ends
    if (prev.type === 'road') for (let y = 1; y < FIELD_H; y += 8) ops.rect(sx, y, 1, 4, K.dash);
    else ops.rect(sx, 0, 1, FIELD_H, K.curb);
    if (next.type !== 'road') ops.rect(sx + CELL - 1, 0, 1, FIELD_H, K.curb);
    col.items.forEach((it) => {
        const y = g.itemY(col, it) * CELL;
        if (y > FIELD_H || y + it.len * CELL < 0) return;
        vehicle(ops, sx, y, it, col.dir);
    });
}

function vehicle(ops, sx, y, it, dir) {
    const h = it.len * CELL - 2;
    const top = y + 1;
    const body = K.cars[it.color % K.cars.length];
    ops.rect(sx + 1, top + 2, 1, 3, K.tyre); ops.rect(sx + 10, top + 2, 1, 3, K.tyre);
    ops.rect(sx + 1, top + h - 5, 1, 3, K.tyre); ops.rect(sx + 10, top + h - 5, 1, 3, K.tyre);
    ops.rect(sx + 2, top, 8, h, body);
    if (it.len > 1) {
        // a truck: a cab and a box
        const cabTop = dir > 0 ? top + h - 8 : top;
        ops.rect(sx + 2, dir > 0 ? cabTop - 1 : cabTop + 8, 8, 1, K.tyre);
        ops.rect(sx + 3, dir > 0 ? cabTop + 4 : cabTop + 1, 6, 3, K.glass);
        ops.rect(sx + 3, dir > 0 ? top + 1 : top + 10, 6, h - 11, 0xffffff30);
    } else {
        ops.rect(sx + 3, dir > 0 ? top + 6 : top + 1, 6, 3, K.glass);
        ops.rect(sx + 3, dir > 0 ? top + 2 : top + 6, 6, 1, 0x00000040);
    }
    ops.rect(sx + 3, dir > 0 ? top + h - 1 : top, 2, 1, K.lamp);
    ops.rect(sx + 7, dir > 0 ? top + h - 1 : top, 2, 1, K.lamp);
}

function waterColumn(ops, g, col, sx) {
    ops.rect(sx, 0, CELL, FIELD_H, K.water[col.x & 1]);
    const drift = (g.time * col.speed * col.dir * CELL) % 24;
    for (let y = -24; y < FIELD_H + 24; y += 24) {
        const ry = y + drift + (col.x % 3) * 7;
        if (ry > -2 && ry < FIELD_H) ops.rect(sx + 2 + (col.x % 2) * 4, ry, 4, 1, K.ripple);
    }
    col.items.forEach((it) => {
        const y = g.itemY(col, it) * CELL;
        if (y > FIELD_H || y + it.len * CELL < 0) return;
        const h = it.len * CELL;
        ops.rect(sx + 1, y + 1, 10, h - 2, K.crate);
        ops.rect(sx + 1, y + 1, 10, 1, K.crateEdge); ops.rect(sx + 1, y + h - 2, 10, 1, K.crateEdge);
        ops.rect(sx + 1, y + 1, 1, h - 2, K.crateEdge); ops.rect(sx + 10, y + 1, 1, h - 2, K.crateEdge);
        for (let k = 1; k < it.len; k++) ops.rect(sx + 1, y + k * CELL, 10, 1, K.crateEdge);
        ops.rect(sx + 1, y + h - 1, 10, 1, 0xffffff50);          // a little foam
    });
}

function railColumn(ops, g, col, sx) {
    ops.rect(sx, 0, CELL, FIELD_H, K.gravel);
    for (let y = 2; y < FIELD_H; y += 6) ops.rect(sx + 1, y, 10, 2, K.sleeper);
    ops.rect(sx + 3, 0, 1, FIELD_H, K.steel);
    ops.rect(sx + 8, 0, 1, FIELD_H, K.steel);
    const t = g.train(col);
    const flash = t.warning && Math.floor(g.time * 6) % 2 === 0;
    const ly = col.dir > 0 ? 1 : FIELD_H - 8;              // the light stands where the train comes from
    ops.rect(sx + 10, ly + 3, 2, 5, K.post);
    ops.rect(sx + 9, ly, 3, 3, flash ? K.lampOn : K.lampOff);
    if (t.y !== null) {
        const y = t.y * CELL, h = t.len * CELL;
        ops.rect(sx + 1, y, 10, h, K.train);
        ops.rect(sx + 5, y, 2, h, K.trainStripe);
        for (let wy = y + 6; wy < y + h - 6; wy += 9) {
            ops.rect(sx + 2, wy, 2, 4, K.trainWin); ops.rect(sx + 8, wy, 2, 4, K.trainWin);
        }
        const nose = col.dir > 0 ? y + h - 3 : y;
        ops.rect(sx + 1, nose, 10, 3, K.trainNose);
    }
}

function robot(ops, g, x, y) {
    const p = g.player;
    const lift = p.hop < 1 ? Math.sin(Math.PI * p.hop) * 4 : 0;
    const over = g.state === 'over';
    ops.rect(x + 2, y + 10, 8, 2, K.shadow);
    if (over && (g.death === 'hit' || g.death === 'train')) {
        // flattened
        ops.rect(x, y + 7, 12, 3, K.robot);
        ops.rect(x + 2, y + 8, 8, 1, K.visor);
        ops.rect(x + 1, y + 5, 2, 2, K.tip);
        return;
    }
    if (over && (g.death === 'water' || g.death === 'drift')) {
        const k = Math.min(1, (g.time - g.deadAt) * 2);
        const r = 2 + k * 5;
        ops.rect(x + 6 - r, y + 6, r * 2, 1, K.splash);
        ops.rect(x + 6 - r * 0.6, y + 3, r * 1.2, 1, K.splash);
        ops.rect(x + 5, y + 4 - k * 3, 2, 2, K.splash);
        return;
    }
    const top = y - lift;
    const face = p.face;
    ops.rect(x + 5, top - 1, 1, 3, K.visor);                           // antenna
    ops.rect(x + 4, top - 3, 3, 2, K.tip);
    ops.rect(x + 2, top + 2, 8, 7, K.robot);                           // body
    ops.rect(x + 2, top + 8, 8, 1, K.robotDark);
    ops.rect(x + 3, top + 3, 6, 3, K.visor);                           // visor
    ops.rect(face > 0 ? x + 6 : x + 4, top + 4, 2, 1, K.eye);          // eye, looking the way it faces
    ops.rect(face > 0 ? x + 1 : x + 10, top + 5, 1, 2, K.robotDark);   // arm behind
    ops.rect(x + 3, top + 9, 2, 2, K.visor); ops.rect(x + 7, top + 9, 2, 2, K.visor);   // feet
}

/* ---- overlays ---- */

const DEATHS = { hit: 'BEEP! HIT BY A CAR', train: 'FLATTENED BY A TRAIN', water: 'SPLASH! ROBOTS SINK', drift: 'SWEPT OFF THE SCREEN' };

function panel(ops, w, y, h) {
    const pw = Math.min(w - 16, 260);
    ops.rect(Math.round((w - pw) / 2), y, pw, h, K.panel);
}

function hud(ops, g, w) {
    const score = String(g.score);
    ops.rect(2, 2, textWidth(score, 3) + 8, 21, K.panel);
    text(ops, score, 6, 5, 3, K.text);
    const best = 'BEST ' + g.best;
    const bw = textWidth(best, 2);
    ops.rect(w - bw - 10, 2, bw + 8, 16, K.panel);
    text(ops, best, w - bw - 6, 5, 2, K.textDim);
}

function overlay(ops, g, w, msg) {
    const cx = w / 2;
    if (msg) {
        panel(ops, w, 40, 52);
        centred(ops, msg.title, cx, 50, 3, K.gold);
        centred(ops, msg.line || '', cx, 74, 2, K.text);
        return;
    }
    if (g.state === 'ready') {
        panel(ops, w, 30, 72);
        centred(ops, 'LANE HOP', cx, 38, 5, K.gold);
        centred(ops, 'PRESS OR TAP TO HOP', cx, 70, 2, K.text);
        centred(ops, 'KNOB OR SWIPE: UP / DOWN', cx, 84, 1, K.textDim);
        centred(ops, 'TILT: ANY WAY', cx, 92, 1, K.textDim);
    } else if (g.state === 'over' && g.time - g.deadAt > 0.4) {
        panel(ops, w, 26, 80);
        centred(ops, 'GAME OVER', cx, 34, 4, K.red);
        centred(ops, DEATHS[g.death] || '', cx, 58, 1, K.textDim);
        centred(ops, 'SCORE ' + g.score + (g.newBest ? '  NEW BEST!' : ''), cx, 68, 2, g.newBest ? K.gold : K.text);
        centred(ops, 'PRESS TO PLAY AGAIN', cx, 86, 2, K.text);
    }
}

/**
 * One frame into ops (reset first). w = the box's width in logical px (field
 * height is FIELD_H). msg: { title, line } shows a panel over a paused game.
 */
function frame(ops, g, w, msg) {
    ops.reset();
    ops.clear(K.sky);
    const p = g.player;
    const first = Math.floor(g.camX) - 1;
    const last = Math.ceil(g.camX + w / CELL) + 1;
    for (let cx = first; cx <= last; cx++) {
        const col = g.column(cx);
        const sx = Math.round((cx - g.camX) * CELL);
        if (col.type === 'road') roadColumn(ops, g, col, sx);
        else if (col.type === 'water') waterColumn(ops, g, col, sx);
        else if (col.type === 'rail') railColumn(ops, g, col, sx);
        else grassColumn(ops, g, col, sx);
    }
    const k = p.hop < 1 ? p.hop : 1;
    const px = (p.fromX + (p.x - p.fromX) * k - g.camX) * CELL;
    const py = (p.fromY + (p.y - p.fromY) * k) * CELL;
    robot(ops, g, Math.round(px), Math.round(py));
    hud(ops, g, w);
    overlay(ops, g, w, msg);
    return ops;
}

module.exports = { Ops, frame, text, textWidth, CELL, FIELD_H, OP_CLEAR, OP_RECT, FONT };
