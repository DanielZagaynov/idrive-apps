'use strict';
/**
 * game.js - Lane Hop's rules, with no car or renderer in it (tools/sim.js and
 * tools/preview.js drive it on the desktop).
 *
 * The world scrolls to the right, to suit the wide centre display: the robot
 * starts on the left and hops right, column by column. Every column is one of
 *
 *   grass  safe; trees block single cells
 *   road   cars and trucks drive up or down the column
 *   water  crates float up or down; stand on one or fall in, and leaving the
 *          screen on a crate loses too
 *   rail   a warning light flashes, then a train runs through fast
 *
 * Grid units: a cell is 1 x 1; columns are x (0 = start), rows are y (0 = top,
 * ROWS - 1 = bottom). update(dt) advances the world by dt seconds.
 *
 * Node 8: no ?. ?? or class fields.
 */

const ROWS = 11;
const START_GRASS = 4;          // safe columns at the start
const HOP_S = 0.11;             // a hop's animation time
const MAX_DT = 0.1;             // longer frames are cut (a stall must not skip a car)
const CAM_BEHIND = 4;           // columns kept on screen behind the robot

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
        this.pathRow = Math.floor(ROWS / 2);
        this.time = 0;
        this.state = 'ready';            // ready | playing | over
        this.paused = false;
        this.death = null;               // hit | water | drift | train
        const mid = Math.floor(ROWS / 2);
        this.player = { x: 0, y: mid, fromX: 0, fromY: mid, hop: 1, face: 1 };
        this.score = 0;
        this.camX = -CAM_BEHIND;
        this.newBest = false;
        this.deadAt = 0;
        for (let i = 0; i < 60; i++) this._addColumn();
    }

    /* ---- the world ---- */

    column(x) {
        if (x < 0) return { type: 'grass', trees: [], items: [], x };
        while (x >= this.cols.length) this._addColumn();
        return this.cols[x];
    }

    _difficulty(x) {
        return clamp(x / 160, 0, 1);       // 0 at the start, 1 from column 160 on
    }

    _addColumn() {
        const x = this.cols.length;
        const r = this.rand;
        const d = this._difficulty(x);
        const prevPath = this.pathRow;
        this.pathRow = clamp(prevPath + Math.floor(r() * 3) - 1, 1, ROWS - 2);
        let type;
        if (x < START_GRASS) type = 'grass';
        else {
            const prev = this.cols[x - 1].type;
            const p = r();
            const grass = 0.42 - d * 0.2;                            // fewer rests as it gets harder
            if (prev === 'water' && p < 0.3 + d * 0.25) type = 'water';      // rivers come a few columns wide
            else if (prev === 'road' && p < 0.3 + d * 0.2) type = 'road';     // and so do motorways
            else if (p < grass) type = 'grass';
            else if (p < grass + (1 - grass) * 0.45) type = 'road';
            else if (p < grass + (1 - grass) * 0.82) type = 'water';
            else type = 'rail';
        }
        const col = { type, x, dir: r() < 0.5 ? 1 : -1, items: [], trees: [], loop: ROWS + 6, speed: 0 };

        if (type === 'grass') {
            // never a tree on this column's path row or the last one's: the way on stays open
            const density = x < START_GRASS ? 0.12 : 0.18 + d * 0.14;
            for (let y = 0; y < ROWS; y++) {
                if (y === prevPath || y === this.pathRow) continue;
                if (x < START_GRASS && Math.abs(y - Math.floor(ROWS / 2)) <= 1) continue;
                if (r() < density) col.trees.push(y);
            }
            col.flowers = [Math.floor(r() * ROWS), Math.floor(r() * ROWS)];
        } else if (type === 'road') {
            col.speed = (1.6 + d * 2.6) * (0.75 + r() * 0.5);
            col.loop = ROWS + 4 + Math.floor(r() * 6);
            const truck = r() < 0.35;
            const count = Math.max(1, Math.round(col.loop / (truck ? 6.5 : 4.8) * (0.7 + d * 0.5)));
            const gap = col.loop / count;
            const off = r() * col.loop;
            for (let i = 0; i < count; i++) {
                const len = truck && r() < 0.8 ? 2 : 1;
                col.items.push({ y: off + i * gap + r() * Math.max(0, gap - len - 1.6), len, color: Math.floor(r() * 5) });
            }
        } else if (type === 'water') {
            col.speed = (1.0 + d * 1.4) * (0.75 + r() * 0.5);
            col.loop = ROWS + 5 + Math.floor(r() * 5);
            const count = Math.max(2, Math.round(col.loop / (4.2 + d * 1.8)));
            const gap = col.loop / count;
            const off = r() * col.loop;
            for (let i = 0; i < count; i++) {
                const len = 2 + (r() < 0.55 - d * 0.35 ? 1 : 0);
                col.items.push({ y: off + i * gap, len: Math.min(len, gap - 0.8) });
            }
        } else {
            // rail: a train every `period` seconds, its light flashing `warn` seconds before
            col.period = 4.5 + r() * 4 - d * 1.5;
            col.phase = r() * col.period;
            col.warn = 1.3;
            col.trainLen = ROWS + 8;
            col.speed = 30;
        }
        this.cols.push(col);
    }

    /* The top of a moving item of a road or water column at time t. */
    itemY(col, item, t) {
        return wrap(item.y + col.dir * col.speed * (t === undefined ? this.time : t), col.loop) - 2;
    }

    /* The train of a rail column: { y (top, null when none on screen), len, warning }. */
    train(col, t) {
        const now = t === undefined ? this.time : t;
        const c = wrap(now + col.phase, col.period);
        const runFor = (ROWS + col.trainLen + 4) / col.speed;
        const warning = c > col.period - col.warn || c < runFor;
        if (c >= runFor) return { y: null, len: col.trainLen, warning };
        const head = c * col.speed - col.trainLen - 2;        // the top edge moving down
        const y = col.dir > 0 ? head : ROWS - head - col.trainLen;
        return { y, len: col.trainLen, warning };
    }

    treeAt(x, y) {
        const col = this.column(x);
        return col.type === 'grass' && col.trees.indexOf(y) >= 0;
    }

    /* ---- input ---- */

    /** A move: 'up' | 'down' | 'forward' | 'back'. Returns true if the robot moved. */
    move(dir) {
        if (this.paused || this.state === 'over') return false;
        if (this.state === 'ready') this.state = 'playing';
        const p = this.player;
        if (p.hop < 1) return false;                 // still in the air
        let nx = p.x, ny = Math.round(p.y);
        if (dir === 'forward') nx += 1;
        else if (dir === 'back') nx -= 1;
        else if (dir === 'up') ny -= 1;
        else if (dir === 'down') ny += 1;
        else return false;
        if (dir === 'forward' || dir === 'back') p.face = dir === 'forward' ? 1 : -1;
        if (ny < 0 || ny >= ROWS) return false;
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

    /** Advances dt seconds. Returns the cause when the robot just lost, else undefined. */
    update(dt) {
        if (this.paused) return undefined;
        dt = clamp(dt, 0, MAX_DT);
        this.time += dt;
        const p = this.player;
        if (p.hop < 1) p.hop = Math.min(1, p.hop + dt / HOP_S);

        // the camera follows the robot forward, never back
        const target = p.x - CAM_BEHIND;
        if (target > this.camX) this.camX += (target - this.camX) * Math.min(1, dt * 4);

        if (this.state !== 'playing') return undefined;
        const col = this.column(p.x);
        if (p.hop < 1) {
            // in the air: only a car or train can still get the robot, from half way on
            if (p.hop >= 0.5 && col.type === 'road' && this._carAt(col, p.y)) return this._die('hit');
            if (p.hop >= 0.5 && col.type === 'rail' && this._trainAt(col, p.y)) return this._die('train');
            return undefined;
        }
        if (col.type === 'water') {
            if (!this._crateUnder(col, p.y)) return this._die('water');
            p.y += col.dir * col.speed * dt;
            if (p.y < -0.45 || p.y > ROWS - 0.55) return this._die('drift');
        } else if (col.type === 'road' && this._carAt(col, p.y)) {
            return this._die('hit');
        } else if (col.type === 'rail' && this._trainAt(col, p.y)) {
            return this._die('train');
        }
        return undefined;
    }

    _carAt(col, y) {
        return col.items.some((it) => {
            const top = this.itemY(col, it);
            return y + 0.8 > top + 0.1 && y + 0.2 < top + it.len - 0.1;
        });
    }

    _crateUnder(col, y) {
        const c = y + 0.5;
        for (let i = 0; i < col.items.length; i++) {
            const top = this.itemY(col, col.items[i]);
            if (c > top - 0.05 && c < top + col.items[i].len + 0.05) return col.items[i];
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

module.exports = { Game, ROWS, HOP_S, rng };
