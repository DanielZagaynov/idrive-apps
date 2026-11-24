'use strict';
/**
 * game.js - Lane Hop's rules, with no car or renderer in it (tools/sim.js and
 * tools/preview.js drive it on the desktop).
 *
 * The hamster starts at the bottom and hops forward (up the screen), lane by
 * lane. Lanes come in groups, with a strip of grass to rest on between most of
 * them:
 *
 *   grass  safe; trees and rocks block single cells
 *   road   1-4 lanes of cars and trucks driving left or right
 *   water  1-3 lanes of logs floating left or right (neighbours alternate);
 *          stand on a log or fall in, and riding one out of the play area
 *          loses too
 *   rail   a warning light flashes, then a train runs through fast
 *
 * Grid units: a cell is 1 x 1. Lanes are x (0 = start, forward = +1); across a
 * lane is y (0 = the play area's left cell, WIDTH - 1 its right one). Cars,
 * logs and trains also run MARGIN cells beyond each side, where they are drawn
 * but cannot be reached. update(dt) advances the world by dt seconds.
 *
 * Node 8: no ?. ?? or class fields.
 */

const WIDTH = 17;               // cells across the play area
const MARGIN = 12;              // cells simulated (and drawn) beyond each side
const START_GRASS = 4;          // safe lanes at the start
const HOP_S = 0.12;             // a hop's animation time
const MAX_DT = 0.1;             // longer frames are cut (a stall must not skip a car)
const CAM_BEHIND = 3;           // lanes kept on screen behind the hamster

/* A small seeded random number generator (mulberry32). */
function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/* Wrap v into [0, len). */
const wrap = (v, len) => ((v % len) + len) % len;
/* A stable small hash of two integers (scenery that must not change between frames). */
const hash2 = (a, b) => {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0);
};

class Game {
    constructor(seed) {
        this.seed = (seed === undefined ? Date.now() : seed) >>> 0;
        this.best = 0;
        this.reset();
    }

    reset() {
        this.rand = rng(this.seed);
        this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;   // the next game is a different world
        this.cols = [];
        this.queue = [];
        this.lastGroup = 'grass';
        this.hazardRun = 0;
        this.behind = {};
        this.pathRow = Math.floor(WIDTH / 2);
        this.time = 0;
        this.state = 'ready';            // ready | playing | over
        this.paused = false;
        this.death = null;               // hit | water | drift | train
        const mid = Math.floor(WIDTH / 2);
        this.player = { x: 0, y: mid, fromX: 0, fromY: mid, hop: 1, face: 'back' };    // it starts looking at you
        this.score = 0;
        this.camX = -CAM_BEHIND;
        this.newBest = false;
        this.deadAt = 0;
        for (let i = 0; i < 40; i++) this._addColumn();
    }

    /* ---- the world ---- */

    /** Lane x. Just behind the start is open grass, then a hedge of trees. */
    column(x) {
        if (x < 0) {
            if (!this.behind[x]) {
                const trees = [], kinds = [], decor = [];
                if (x < -1) for (let y = 0; y < WIDTH; y++) { trees.push(y); kinds.push(0); }
                for (let y = -MARGIN; y < WIDTH + MARGIN; y++) if (y < 0 || y >= WIDTH) decor.push(y);
                this.behind[x] = { type: 'grass', trees, kinds, decor, items: [], x, dir: 1, speed: 0, loop: 1 };
            }
            return this.behind[x];
        }
        while (x >= this.cols.length) this._addColumn();
        return this.cols[x];
    }

    _difficulty(x) {
        return clamp(x / 150, 0, 1);       // 0 at the start, 1 from lane 150 on
    }

    /* The next group of lanes: a rest of grass after most hazards, else 1-4 lanes of one hazard. */
    _plan(x) {
        const r = this.rand;
        const d = this._difficulty(x);
        if (this.lastGroup !== 'grass' && (r() > d * 0.3 || this.hazardRun >= 5)) {
            const n = 1 + (r() < 0.45 - d * 0.25 ? 1 : 0) + (r() < 0.12 ? 1 : 0);
            for (let i = 0; i < n; i++) this.queue.push('grass');
            this.lastGroup = 'grass';
            return;
        }
        const p = r();
        let type, n;
        if (p < 0.48) { type = 'road'; n = 1 + Math.floor(r() * (2 + d * 2.2)); }
        else if (p < 0.8) { type = 'water'; n = 1 + Math.floor(r() * (1.8 + d * 1.4)); }
        else { type = 'rail'; n = 1 + (r() < 0.2 + d * 0.3 ? 1 : 0); }
        for (let i = 0; i < n; i++) this.queue.push(type);
        this.lastGroup = type;
    }

    _addColumn() {
        const x = this.cols.length;
        const r = this.rand;
        const d = this._difficulty(x);
        const prevPath = this.pathRow;
        this.pathRow = clamp(prevPath + Math.floor(r() * 3) - 1, 1, WIDTH - 2);
        let type;
        if (x < START_GRASS) type = 'grass';
        else {
            if (!this.queue.length) this._plan(x);
            type = this.queue.shift();
        }
        this.hazardRun = type === 'grass' ? 0 : this.hazardRun + 1;
        const prev = x > 0 ? this.cols[x - 1] : null;
        const col = { type, x, dir: r() < 0.5 ? 1 : -1, items: [], trees: [], kinds: [], decor: [], loop: WIDTH + 2 * MARGIN, speed: 0 };

        if (type === 'grass') {
            // never a tree on this lane's path cell or the last one's: the way on stays open
            const density = x < START_GRASS ? 0.1 : 0.16 + d * 0.12;
            for (let y = 0; y < WIDTH; y++) {
                if (y === prevPath || y === this.pathRow) continue;
                if (x < START_GRASS && Math.abs(y - Math.floor(WIDTH / 2)) <= 2) continue;
                if (r() < density) {
                    col.trees.push(y);
                    const k = r();
                    col.kinds.push(k < 0.55 ? 0 : k < 0.85 ? 1 : 2);      // short tree, tall tree, rock
                }
            }
            // scenery beyond the play area (drawn, never reached)
            for (let y = -MARGIN; y < WIDTH + MARGIN; y++) {
                if (y >= 0 && y < WIDTH) continue;
                const edge = y === -1 || y === WIDTH;
                if (r() < (edge ? 0.7 : 0.4)) col.decor.push(y);
            }
        } else if (type === 'road') {
            col.speed = (1.5 + d * 2.5) * (0.75 + r() * 0.5);
            col.loop = WIDTH + 2 * MARGIN + Math.floor(r() * 8);
            const truck = r() < 0.3;
            const count = Math.max(2, Math.round(col.loop / (truck ? 8.5 : 6) * (0.7 + d * 0.5)));
            const gap = col.loop / count;
            const off = r() * col.loop;
            for (let i = 0; i < count; i++) {
                const len = truck && r() < 0.8 ? 2.6 : 1.5;
                col.items.push({ y: off + i * gap + r() * Math.max(0, gap - len - 2), len, color: Math.floor(r() * 6) });
            }
        } else if (type === 'water') {
            if (prev && prev.type === 'water') col.dir = -prev.dir;    // neighbouring currents run opposite ways
            col.speed = (1.0 + d * 1.3) * (0.75 + r() * 0.5);
            col.loop = WIDTH + 2 * MARGIN + Math.floor(r() * 8);
            const count = Math.max(3, Math.round(col.loop / (5 + d * 2)));
            const gap = col.loop / count;
            const off = r() * col.loop;
            for (let i = 0; i < count; i++) {
                const len = 2 + Math.floor(r() * (3 - d * 1.5));
                col.items.push({ y: off + i * gap, len: Math.min(len, gap - 1) });
            }
        } else {
            // rail: a train every `period` seconds, its light flashing `warn` seconds before
            col.period = 5.5 + r() * 4 - d * 1.5;
            col.phase = r() * col.period;
            col.warn = 1.4;
            col.trainLen = 12 + Math.floor(r() * 8);
            col.speed = 32;
        }
        this.cols.push(col);
    }

    /* The left edge of a moving item of a road or water lane at time t. */
    itemY(col, item, t) {
        return wrap(item.y + col.dir * col.speed * (t === undefined ? this.time : t), col.loop) - MARGIN;
    }

    /* The train of a rail lane: { y (left edge, null when none is running), len, warning }. */
    train(col, t) {
        const now = t === undefined ? this.time : t;
        const c = wrap(now + col.phase, col.period);
        const runFor = (WIDTH + 2 * MARGIN + col.trainLen) / col.speed;
        const warning = c > col.period - col.warn || c < runFor;
        if (c >= runFor) return { y: null, len: col.trainLen, warning };
        const head = c * col.speed - col.trainLen - MARGIN;     // the left edge moving right
        const y = col.dir > 0 ? head : WIDTH - head - col.trainLen;
        return { y, len: col.trainLen, warning };
    }

    treeAt(x, y) {
        const col = this.column(x);
        return col.type === 'grass' && col.trees.indexOf(y) >= 0;
    }

    /* ---- input ---- */

    /** A move: 'forward' | 'back' | 'left' | 'right'. Returns true if the hamster moved. */
    move(dir) {
        if (this.paused || this.state === 'over') return false;
        if (this.state === 'ready') this.state = 'playing';
        const p = this.player;
        if (p.hop < 1) return false;                 // still in the air
        let nx = p.x, ny = Math.round(p.y);
        if (dir === 'forward') nx += 1;
        else if (dir === 'back') nx -= 1;
        else if (dir === 'left') ny -= 1;
        else if (dir === 'right') ny += 1;
        else return false;
        p.face = dir;
        if (ny < 0 || ny >= WIDTH) return false;
        if (nx < 0 || nx < Math.ceil(this.camX) + 1) return false;
        if (this.treeAt(nx, ny)) return false;
        p.fromX = p.x; p.fromY = p.y;
        p.x = nx; p.y = ny;
        p.hop = 0;
        if (nx > this.score) this.score = nx;
        return true;
    }

    /** Press: starts, hops forward, or after a game over starts a new game. */
    press() {
        if (this.paused) return false;
        if (this.state === 'over') {
            if (this.time - this.deadAt < 0.6) return false;    // a press meant for the last hop
            const best = this.best;
            this.reset();
            this.best = best;
            this.state = 'playing';
            return true;
        }
        return this.move('forward');
    }

    pause(on) { this.paused = !!on; }

    /* ---- time ---- */

    /** Advances dt seconds. Returns the cause when the hamster just lost, else undefined. */
    update(dt) {
        if (this.paused) return undefined;
        dt = clamp(dt, 0, MAX_DT);
        this.time += dt;
        const p = this.player;
        if (p.hop < 1) p.hop = Math.min(1, p.hop + dt / HOP_S);

        // the camera follows the hamster forward, never back
        const target = p.x - CAM_BEHIND;
        if (target > this.camX) this.camX += (target - this.camX) * Math.min(1, dt * 5);

        if (this.state !== 'playing') return undefined;
        const col = this.column(p.x);
        if (p.hop < 1) {
            // in the air: only a car or train can still get the hamster, from half way on
            if (p.hop >= 0.5 && col.type === 'road' && this._carAt(col, p.y)) return this._die('hit');
            if (p.hop >= 0.5 && col.type === 'rail' && this._trainAt(col, p.y)) return this._die('train');
            return undefined;
        }
        if (col.type === 'water') {
            if (!this._logUnder(col, p.y)) return this._die('water');
            p.y += col.dir * col.speed * dt;
            if (p.y < -0.45 || p.y > WIDTH - 0.55) return this._die('drift');
        } else if (col.type === 'road' && this._carAt(col, p.y)) {
            return this._die('hit');
        } else if (col.type === 'rail' && this._trainAt(col, p.y)) {
            return this._die('train');
        }
        return undefined;
    }

    _carAt(col, y) {
        return col.items.some((it) => {
            const left = this.itemY(col, it);
            return y + 0.8 > left + 0.1 && y + 0.2 < left + it.len - 0.1;
        });
    }

    _logUnder(col, y) {
        const c = y + 0.5;
        for (let i = 0; i < col.items.length; i++) {
            const left = this.itemY(col, col.items[i]);
            if (c > left - 0.05 && c < left + col.items[i].len + 0.05) return col.items[i];
        }
        return null;
    }

    _trainAt(col, y) {
        const t = this.train(col);
        return t.y !== null && y + 0.8 > t.y && y + 0.2 < t.y + t.len;
    }

    _die(why) {
        this.state = 'over';
        this.death = why;
        this.deadAt = this.time;
        if (this.score > this.best) { this.best = this.score; this.newBest = true; }
        return why;
    }
}

module.exports = { Game, WIDTH, MARGIN, HOP_S, rng, hash2 };
