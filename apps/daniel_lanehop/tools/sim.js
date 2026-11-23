'use strict';
/**
 * Runs src/lanehop.js on the desktop against stand-ins for:
 *   - the oap-sdk (OnlineApp, logging, someipBuilders with a speed you set and
 *     a FrontCCU you can turn)
 *   - the HMI, built from this app's own uiDescription.json (ID7)
 *   - mgu-render: a socket speaking its wire format (HELLO, X_READY, READY,
 *     MODE, PLACE, SHOW, CLAIM, X_GRAB, FPS, FRAME, TICK, TOUCH, X_CCU,
 *     X_STATE), recording what the app sends
 *
 * and checks the rules: the game shows and takes the controller and touch
 * only while parked and on its page; moving closes it and gives them back;
 * input moves the robot; frames use only CLEAR and RECT; the best score is
 * saved. It is NOT BMW's SDK or the real renderer.
 *
 *   node tools/sim.js
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const APP = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'mgu-app.json'), 'utf8'));
const pkgDir = path.join(APP, manifest.tree);
const appDescription = JSON.parse(fs.readFileSync(path.join(pkgDir, 'rhmiData', 'application.json'), 'utf8'));
const ui = JSON.parse(fs.readFileSync(path.join(pkgDir, 'rhmiData', 'uiDescriptions', 'ID7', 'uiDescription.json'), 'utf8'));

const RENDER = process.platform === 'win32' ? `\\\\.\\pipe\\daniel-lanehop-sim-${process.pid}` : path.join(os.tmpdir(), `daniel-lanehop-sim-${process.pid}.sock`);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lanehop-sim-'));
process.env.MGU_RENDERD_SOCKET = RENDER;
process.env.LANEHOP_DATA = DATA;

const problems = [];
const log = [];
const logger = {
    info: (m) => log.push(`info  ${m}`), warn: (m) => log.push(`warn  ${m}`),
    error: (m) => { log.push(`error ${m}`); problems.push(m); }, debug: () => {}
};

/* ---- HMI stand-in ---- */
const byName = {};
const shown = {};
const visible = {};
Object.keys(ui.containers).forEach((cid) => {
    const c = ui.containers[cid];
    const st = new EventEmitter();
    st.getId = () => Number(cid);
    byName[c.name] = st;
    Object.keys(c.components).forEach((id) => {
        const d = c.components[id];
        const comp = new EventEmitter();
        comp.getId = () => Number(id);
        comp.setValue = (r, cell, value) => {
            if (!Object.prototype.hasOwnProperty.call(d.rows[0], cell)) return Promise.reject(new Error(`${d.name} has no cell ${cell}`));
            shown[d.name] = value;
            return Promise.resolve();
        };
        byName[d.name] = comp;
    });
});
const setVisible = (name, on) => { visible[name] = on; byName[name].emit('visible', { visible: on }); };
const rhmi = new EventEmitter();
rhmi.getByName = (n) => byName[n] || null;
rhmi.mapEntryState = () => Promise.resolve();
rhmi.openEntryState = () => { setVisible('ST_Lanehop_Main', true); return Promise.resolve(); };
rhmi.openState = (n) => { setImmediate(() => setVisible(n, true)); return Promise.resolve(); };
rhmi.closeState = (n) => { if (visible[n]) setImmediate(() => setVisible(n, false)); return Promise.resolve(); };

/* ---- oap-sdk stand-in ---- */
let speedRaw = 0;             // 1/64 km/h; null = no answer
let initializedCalled = false;
let frontCcu = null;          // FrontCCU subscriber
class OnlineApp extends EventEmitter {
    constructor() { super(); this.rhmiApplication = rhmi; this.appDescription = appDescription; this.startReason = 'ENTRY_POINT'; }
    start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
    initialized() { initializedCalled = true; return Promise.resolve(); }
    getAppId() { return manifest.id; }
    registerActive() {}
    getLastExecutedEntryPointUuid() { return null; }
    destroyBundles() { return Promise.resolve(); }
    getEntryPoints() {
        return appDescription.application.entryPoints.map((d) => ({
            getDescription: () => d, init: () => Promise.resolve(), setAvailability: () => Promise.resolve()
        }));
    }
}
const someipBuilders = {
    buildAndInitTypedProxy: (iface) => {
        if (iface !== 'de.bmw.infotainment.vehicle.Vehicle2') return Promise.reject(new Error('unexpected ' + iface));
        return Promise.resolve({ statusCarSpeed2: { getValue: () => (speedRaw === null ? Promise.reject(new Error('timeout')) : Promise.resolve({ speedVehicleCentreOfGravity: speedRaw })) } });
    },
    buildTypedProxy: (iface) => {
        if (iface !== 'de.bmw.infotainment.controlelements.FrontCCU') return Promise.reject(new Error('unexpected ' + iface));
        return Promise.resolve({
            init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
            statusRotaryEncoderState: { subscribe: (cb) => { frontCcu = cb; return Promise.resolve(); } }
        });
    }
};
const stubs = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => logger },
    'oap-sdk/src/someip/someipBuilders': someipBuilders
};
const load = Module._load;
Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    if (/^oap-sdk/.test(request)) throw new Error(`sim.js has no stand-in for ${request}`);
    return load.apply(this, arguments);
};

/* ---- mgu-render stand-in (wire format: u32 type, u32 len, payload padded to 4) ---- */
const BOX = { x: 104, y: 88, w: 1692, h: 544 };
const R = { shownNow: false, frames: 0, badOps: [], mode: null, place: null, hello: null, claims: null, grab: null, fps: null, sock: null };
const msg = (type, payload) => {
    const len = payload ? payload.length : 0;
    const b = Buffer.alloc(8 + len + ((4 - (len & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4);
    if (len) payload.copy(b, 8);
    return b;
};
function checkOps(p) {
    let i = 0;
    while (i + 4 <= p.length) {
        const op = p.readUInt32LE(i);
        if (op === 1) i += 8;
        else if (op === 2) i += 24;
        else { R.badOps.push(op); return; }
    }
}
const renderServer = net.createServer((s) => {
    R.sock = s;
    let buf = Buffer.alloc(0);
    s.on('error', () => {});
    s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
            const type = buf.readUInt32LE(0), len = buf.readUInt32LE(4);
            if (buf.length < 8 + len) break;
            const p = buf.slice(8, 8 + len);
            buf = buf.slice(8 + len);
            if (type === 1) {                         // HELLO -> X_READY, READY
                R.hello = p.toString().split('\0')[0];
                const ready = Buffer.alloc(52);
                ready.writeUInt32LE(1, 0); ready.writeUInt32LE(3, 4); ready.writeUInt32LE(1 | 2 | 4, 8);   // layer+embed; touch, controller, front gate
                [BOX.x, BOX.y, BOX.w, BOX.h].forEach((v, i) => ready.writeInt32LE(v, 12 + i * 4));
                [0, 80, 1920, 640].forEach((v, i) => ready.writeInt32LE(v, 28 + i * 4));
                s.write(msg(0x4d520101, ready));
                const r = Buffer.alloc(12); r.writeUInt32LE(1920, 4); r.writeUInt32LE(720, 8);
                s.write(msg(101, r));
            } else if (type === 0x4d520001) R.mode = p.readUInt32LE(0) === 2 ? 'embed' : 'layer';
            else if (type === 2) R.place = { x: p.readInt32LE(0), y: p.readInt32LE(4), w: p.readInt32LE(8), h: p.readInt32LE(12), scale: p.readFloatLE(16) };
            else if (type === 3) R.shownNow = p.readUInt32LE(0) === 1;
            else if (type === 9) {
                const n = p.readUInt32LE(0);
                R.claims = [];
                for (let i = 0; i < n; i++) R.claims.push({ x: p.readFloatLE(4 + i * 16), y: p.readFloatLE(8 + i * 16), w: p.readFloatLE(12 + i * 16), h: p.readFloatLE(16 + i * 16) });
            } else if (type === 0x4d520002) R.grab = p.readUInt32LE(0) === 1;
            else if (type === 12) R.fps = p.readUInt32LE(0);
            else if (type === 7) {                    // FRAME
                R.frames++;
                checkOps(p);
                const t = Buffer.alloc(8); t.writeUInt32LE(R.frames, 0);
                setTimeout(() => s.write(msg(102, t)), 33);   // TICK at ~30 fps
            }
        }
    });
});
const touch = (phase, x, y) => {
    const b = Buffer.alloc(12);
    b.writeUInt32LE({ down: 1, move: 2, up: 3 }[phase], 0); b.writeFloatLE(x, 4); b.writeFloatLE(y, 8);
    R.sock.write(msg(105, b));
};
let ccuSeq = 0, ccuKnob = 1000;
const ccu = (o) => {
    const b = Buffer.alloc(8);
    b[0] = o.seq === undefined ? ccuSeq : o.seq; b.writeUInt16BE(o.knob === undefined ? ccuKnob : o.knob, 1);
    b[3] = o.press || 0; b[4] = o.tilt || 0;
    R.sock.write(msg(0x4d520103, b));
};
const stateMsg = (onScreen, front) => {
    const b = Buffer.alloc(12); b.writeUInt32LE(2, 0); b.writeUInt32LE(onScreen ? 1 : 0, 4); b.writeUInt32LE(front ? 1 : 0, 8);
    R.sock.write(msg(0x4d520102, b));
};

/* ---- run ---- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const expect = (what, ok, detail) => { if (!ok) problems.push(`${what}${detail ? ': ' + detail : ''}`); else console.log(`  ok   ${what}`); };
const press = (name) => byName[name].emit('action', { row: 0 });
let app = null;
const game = () => app.game;
const pos = () => `x=${game().player.x} y=${game().player.y} state=${game().state} paused=${game().paused}`;

console.log(`${manifest.id} on ID7 (simulated)`);
let at;
new Promise((r) => renderServer.listen(RENDER, r))
    .then(() => { app = require(path.join(APP, manifest.modules[0])).app; return wait(1200); })
    .then(() => {
        expect('app called initialized()', initializedCalled);
        expect('connected to mgu-render as daniel_lanehop, embed mode', R.hello === 'daniel_lanehop' && R.mode === 'embed', JSON.stringify(R.mode));
        expect('placed over the box, scaled so the field fills its height', R.place && R.place.w === BOX.w && Math.abs(R.place.scale - BOX.h / 132) < 1e-3, JSON.stringify(R.place));
        expect('frame cap 30 fps', R.fps === 30);
        expect('main page says Press "Play"', /Press "Play"/.test(shown.lanehopStatus || ''), shown.lanehopStatus);
        expect('nothing shown, no controller or touch held before Play', !R.shownNow && !R.grab && !(R.claims && R.claims.length));
        press('lanehopPlay');
        return wait(600);
    })
    .then(() => {
        expect('"Play" opened the embed page', visible.ST_Lanehop_Embed === true);
        expect('game shown (SHOW 1), controller grabbed, touch claimed over the field', R.shownNow && R.grab === true && R.claims && R.claims.length === 1 && Math.abs(R.claims[0].h - 132) < 1e-3, JSON.stringify(R.claims));
        expect('frames keep coming (the TICK loop runs)', R.frames > 8, `${R.frames} frames`);
        expect('frames use only CLEAR and RECT', R.badOps.length === 0, JSON.stringify(R.badOps));
        expect('game waits on its title screen', game().state === 'ready');
        ccuSeq++;
        ccu({ press: 1 });                        // press: start and hop
        return wait(300);
    })
    .then(() => {
        ccu({ press: 0 });
        expect('controller press started the game and hopped forward', game().state === 'playing' && game().player.x === 1, pos());
        at = game().player.y;
        ccu({ tilt: 7 });                         // tilt south
        return wait(250);
    })
    .then(() => {
        ccu({ tilt: 0 });
        expect('tilt south hopped down', game().player.y === at + 1, pos());
        ccuKnob -= 1; ccu({});                    // knob one detent anticlockwise
        return wait(250);
    })
    .then(() => {
        expect('knob anticlockwise hopped up', game().player.y === at, pos());
        frontCcu({ frontRotaryEncoderOperation: 5, frontRotaryEncoderPushButton: 'KEINE_BETAETIGUNG', frontRotaryEncoderDeflection: 'MITTELSTELLUNG' });
        frontCcu({ frontRotaryEncoderOperation: 6, frontRotaryEncoderPushButton: 'KEINE_BETAETIGUNG', frontRotaryEncoderDeflection: 'MITTELSTELLUNG' });
        press('lanehopEmbedFocus');
        return wait(250);
    })
    .then(() => {
        expect('while grabbed, FrontCCU and the page button are ignored (no double moves)', game().player.y === at && game().player.x === 1, pos());
        touch('down', 200, 60); touch('up', 201, 61);   // tap
        return wait(250);
    })
    .then(() => {
        expect('a tap hopped forward', game().player.x === 2, pos());
        at = game().player.y;
        touch('down', 200, 80); touch('move', 200, 50); touch('up', 200, 40);   // swipe up
        return wait(250);
    })
    .then(() => {
        expect('a swipe up hopped up', game().player.y === at - 1 || (at === 0 && game().player.y === 0), pos());
        stateMsg(false, false);                   // a popup over the page
        return wait(300);
    })
    .then(() => {
        expect('covered by the HMI: game paused', game().paused === true);
        stateMsg(true, true);
        return wait(300);
    })
    .then(() => {
        expect('uncovered: game runs again', game().paused === false);
        speedRaw = 40 * 64;                       // driving at 40 km/h
        return wait(1500);
    })
    .then(() => {
        expect('moving: game page closed', visible.ST_Lanehop_Embed === false);
        expect('moving: hidden (SHOW 0), controller and touch given back', !R.shownNow && R.grab === false && R.claims && R.claims.length === 0, JSON.stringify({ grab: R.grab, claims: R.claims }));
        expect('moving: game paused', game().paused === true);
        expect('moving: main page says available when parked', /available when parked/.test(shown.lanehopStatus || ''), shown.lanehopStatus);
        at = R.frames;
        press('lanehopPlay');                     // Play while moving does nothing
        return wait(600);
    })
    .then(() => {
        expect('Play while moving does not open the game', visible.ST_Lanehop_Embed === false && !R.shownNow);
        expect('no frames while hidden', R.frames === at, `${R.frames - at} frames`);
        speedRaw = null;                          // the speed signal goes quiet
        return wait(4000);
    })
    .then(() => {
        expect('no fresh speed reading counts as not parked', /available when parked/.test(shown.lanehopStatus || ''), shown.lanehopStatus);
        speedRaw = 0;
        return wait(1500);
    })
    .then(() => {
        at = game().player.x;
        press('lanehopPlay');
        return wait(600);
    })
    .then(() => {
        expect('parked again: Play brings the same game back', R.shownNow && R.grab && game().paused === false && game().player.x === at, pos());
        // walk into trouble until the robot loses
        let n = 0, lastX = -1;
        const step = () => {
            if (game().state === 'over' || n++ > 400) return Promise.resolve();
            if (game().player.x === lastX) {
                ccu({ tilt: n % 4 < 2 ? 1 : 7 }); ccu({ tilt: 0 });   // blocked by a tree: sidestep up or down
            }
            lastX = game().player.x;
            ccuSeq++; ccu({ press: 1 }); ccu({ press: 0 });
            return wait(140).then(step);
        };
        return step();
    })
    .then(() => wait(300))
    .then(() => {
        expect('the robot can lose', game().state === 'over', pos());
        const saved = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'best.json'), 'utf8')).best; } catch (e) { return null; } })();
        expect('best score saved to best.json', saved === game().best && saved > 0, `saved ${saved}, best ${game().best}`);
        return wait(700);
    })
    .then(() => {
        ccuSeq++; ccu({ press: 1 }); ccu({ press: 0 });
        return wait(300);
    })
    .then(() => {
        expect('press after a game over starts a new game', game().state === 'playing' && game().player.x <= 1, pos());
        setVisible('ST_Lanehop_Embed', false);    // BACK
        return wait(400);
    })
    .then(() => {
        expect('BACK: hidden, controller and touch given back', !R.shownNow && R.grab === false && R.claims.length === 0);
        expect('main page shows the best score', new RegExp(`Best: ${game().best}`).test(shown.lanehopStatus || ''), shown.lanehopStatus);
        expect('frames used only CLEAR and RECT throughout', R.badOps.length === 0, JSON.stringify(R.badOps));
        if (problems.length) {
            console.log(log.map((l) => `    ${l}`).join('\n'));
            console.error(problems.map((p) => `  FAIL ${p}`).join('\n'));
            process.exit(1);
        }
        console.log(`  all ok (${R.frames} frames drawn)`);
        process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
