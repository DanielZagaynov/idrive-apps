'use strict';
/**
 * Tests src/game.js on the desktop:
 *   - every world is passable: trees never wall off the way forward (300
 *     lanes, 300 seeds);
 *   - the start is safe: standing still on the first lanes never loses;
 *   - the layout: hazards come in groups with grass between most of them, and
 *     neighbouring rivers run opposite ways;
 *   - the rules: trees block, the play area's edges block, water without a log
 *     loses, a car loses, a log carries the hamster;
 *   - fairness: a careful player that looks a moment ahead gets well past the
 *     start in most worlds.
 *
 *   node tools/test_game.js
 */
const G = require('../src/game');
const Game = G.Game, ROWS = G.WIDTH;

const problems = [];
const expect = (what, ok, detail) => { if (!ok) problems.push(`${what}${detail ? ': ' + detail : ''}`); else console.log(`  ok   ${what}`); };

/* ---- passable ---- */
let walled = null;
for (let seed = 1; seed <= 300 && !walled; seed++) {
    const g = new Game(seed);
    let reach = new Set([Math.floor(ROWS / 2)]);
    for (let x = 1; x < 300; x++) {
        const next = new Set();
        reach.forEach((y) => { if (!g.treeAt(x, y)) next.add(y); });
        // spread up and down inside the column through free cells
        const stack = Array.from(next);
        while (stack.length) {
            const y = stack.pop();
            [y - 1, y + 1].forEach((ny) => {
                if (ny >= 0 && ny < ROWS && !next.has(ny) && !g.treeAt(x, ny)) { next.add(ny); stack.push(ny); }
            });
        }
        if (!next.size) { walled = `seed ${seed}, column ${x}`; break; }
        reach = next;
    }
}
expect('300 worlds x 300 lanes: trees never wall off the way forward', !walled, walled);

/* ---- a safe start ---- */
let unsafe = null;
for (let seed = 1; seed <= 100 && !unsafe; seed++) {
    const g = new Game(seed);
    g.move('left'); g.move('right');              // starts the game without leaving lane 0
    for (let i = 0; i < 30 * 20; i++) { if (g.update(1 / 30)) { unsafe = `seed ${seed}: ${g.death}`; break; } }
    for (let x = 1; x < 4 && !unsafe; x++) if (g.column(x).type !== 'grass') unsafe = `seed ${seed}: lane ${x} is ${g.column(x).type}`;
}
expect('the first 4 lanes are grass and standing there is safe', !unsafe, unsafe);

/* ---- layout ---- */
{
    let grass = 0, longest = 0, run = 0, sameRiver = null;
    for (let seed = 1; seed <= 50; seed++) {
        const g = new Game(seed);
        run = 0;
        for (let x = 0; x < 300; x++) {
            const c = g.column(x);
            if (c.type === 'grass') { grass++; run = 0; } else { run++; longest = Math.max(longest, run); }
            const prev = g.column(x - 1);
            if (c.type === 'water' && prev.type === 'water' && c.dir === prev.dir && !sameRiver) sameRiver = `seed ${seed}, lane ${x}`;
        }
    }
    const share = grass / (50 * 300);
    expect('about a third of the lanes are grass to rest on', share > 0.28 && share < 0.5, `${Math.round(share * 100)}%`);
    expect('hazards never run more than 9 lanes without a rest', longest <= 9, `longest ${longest}`);
    expect('neighbouring river lanes flow opposite ways', !sameRiver, sameRiver);
}

/* ---- rules ---- */
{
    const g = new Game(7);
    g.move('forward'); for (let i = 0; i < 6; i++) g.update(1 / 30);
    const x = g.player.x;
    expect('a forward move hops one lane and scores it', x === 1 && g.score === 1, `x ${x}, score ${g.score}`);
    expect('the hamster cannot go back past the start', g.move('back') === true && (function () { for (let i = 0; i < 6; i++) g.update(1 / 30); return g.move('back') === false; })());
    g.player.y = 0; g.player.hop = 1;
    expect('the left edge blocks', g.move('left') === false);
    g.player.y = ROWS - 1; g.player.hop = 1;
    expect('the right edge blocks', g.move('right') === false);
    // a tree blocks
    const gt = new Game(11);
    let found = null;
    for (let cx = 1; cx < 60 && !found; cx++) {
        const c = gt.column(cx);
        if (c.type === 'grass' && c.trees.length && gt.column(cx - 1).type === 'grass') {
            const ty = c.trees[0];
            if (!gt.treeAt(cx - 1, ty)) found = { cx, ty };
        }
    }
    if (found) {
        gt.state = 'playing'; gt.player.x = found.cx - 1; gt.player.y = found.ty; gt.player.hop = 1; gt.camX = found.cx - 6;
        expect('a tree blocks the hop into it', gt.move('forward') === false);
    }
    // water without a log loses, a log carries
    const gw = new Game(3);
    let wx = -1;
    for (let cx = 4; cx < 200 && wx < 0; cx++) if (gw.column(cx).type === 'water') wx = cx;
    const col = gw.column(wx);
    gw.state = 'playing'; gw.player.x = wx; gw.player.hop = 1; gw.camX = wx - 6;
    let gapY = -1, logY = -1;
    for (let y = 0; y < ROWS; y++) {
        const c = y + 0.5;
        const on = col.items.some((it) => { const t = gw.itemY(col, it); return c > t - 0.05 && c < t + it.len + 0.05; });
        const deep = col.items.every((it) => { const t = gw.itemY(col, it); return c < t - 0.6 || c > t + it.len + 0.6; });
        if (deep && gapY < 0) gapY = y;
        if (on && logY < 0) {
            const it = col.items.find((i) => { const t = gw.itemY(col, i); return c > t + 0.3 && c < t + i.len - 0.3; });
            if (it) logY = y;
        }
    }
    if (gapY >= 0) {
        const t = new Game(3); t.state = 'playing'; t.player.x = wx; t.player.y = gapY; t.player.hop = 1; t.camX = wx - 6; t.column(wx);
        expect('standing in water without a log loses', t.update(1 / 30) === 'water', `row ${gapY}`);
    }
    if (logY >= 0) {
        gw.player.y = logY;
        const before = gw.player.y;
        const lost = gw.update(1 / 30);
        expect('a log carries the hamster with the current', !lost && Math.abs(gw.player.y - before - col.dir * col.speed / 30) < 1e-6, `lost ${lost}`);
    }
    // a car loses
    const gc = new Game(5);
    let rx = -1;
    for (let cx = 4; cx < 200 && rx < 0; cx++) if (gc.column(cx).type === 'road') rx = cx;
    const rc = gc.column(rx);
    const car = rc.items.find((it) => { const l = gc.itemY(rc, it); return l > 0 && l < ROWS - 3; }) || rc.items[0];
    gc.state = 'playing'; gc.player.x = rx; gc.player.hop = 1; gc.camX = rx - 6;
    gc.player.y = Math.max(0, Math.min(ROWS - 1, Math.round(gc.itemY(rc, car) + car.len / 2 - 0.5)));
    const top = gc.itemY(rc, car);
    if (top > -0.5 && top < ROWS - 0.5) expect('a car on the hamster\'s cell loses', gc.update(1 / 60) === 'hit');
}

/* ---- fair: a careful player gets somewhere ---- */
function careful(seed) {
    const g = new Game(seed);
    const safe = (x, y, ahead) => {
        const col = g.column(x);
        if (col.type === 'grass') return !g.treeAt(x, y);
        for (let t = 0; t <= ahead; t += 0.05) {
            const at = g.time + t;
            if (col.type === 'road' && col.items.some((it) => { const tp = g.itemY(col, it, at); return y + 0.95 > tp && y + 0.05 < tp + it.len; })) return false;
            if (col.type === 'water' && !col.items.some((it) => { const tp = g.itemY(col, it, at); return y + 0.5 > tp + 0.25 && y + 0.5 < tp + it.len - 0.25; })) return false;
            if (col.type === 'rail' && g.train(col, at).warning) return false;
        }
        return true;
    };
    g.press();
    for (let i = 0; i < 30 * 120 && g.state !== 'over'; i++) {
        g.update(1 / 30);
        const p = g.player;
        if (p.hop < 1) continue;
        const y = Math.round(p.y);
        const here = g.column(p.x);
        const danger = !safe(p.x, y, 0.3) || (here.type === 'water' && (p.y < 1.2 || p.y > ROWS - 2.2));
        if (safe(p.x + 1, y, 0.35)) g.move('forward');
        else if (danger || here.type === 'grass') {
            const toCentre = y < ROWS / 2 ? 1 : -1;       // when both ways look fine, drift back to the middle
            const a = y + toCentre, b = y - toCentre;
            const ok = (ny) => ny >= 0 && ny < ROWS && safe(p.x, ny, 0.3) && (safe(p.x + 1, ny, 0.35) || danger);
            if (ok(a)) g.move(a < y ? 'left' : 'right');
            else if (ok(b)) g.move(b < y ? 'left' : 'right');
            else if (danger && safe(p.x - 1, y, 0.3)) g.move('back');
        }
    }
    return g.score;
}
const scores = [];
for (let seed = 1; seed <= 40; seed++) scores.push(careful(seed));
scores.sort((a, b) => a - b);
const median = scores[Math.floor(scores.length / 2)];
console.log(`       careful player over 40 worlds: median ${median}, best ${scores[scores.length - 1]}, worst ${scores[0]}`);
expect('a careful player gets past lane 15 in most worlds', median >= 15, `median ${median}`);

if (problems.length) {
    console.error(problems.map((p) => `  FAIL ${p}`).join('\n'));
    process.exit(1);
}
console.log('  all ok');
