'use strict';
/**
 * Runs src/airplay.js on the desktop against stand-ins for:
 *   - the oap-sdk (OnlineApp, logging, someipBuilders with a speed you set)
 *   - the HMI, built from this app's own uiDescription.json (ID7)
 *   - the daniel-airplay tool's control socket (JSON lines)
 *   - mgu-render: a socket speaking its wire format (HELLO, X_READY, READY,
 *     MODE, PLACE, VIDEO, SHOW, FRAME, TICK), recording what the app draws
 *
 * and checks the safety rules: the phone's picture is drawn only while parked,
 * streaming and on the screen page, and goes (page closed) once the car moves.
 * It is NOT BMW's SDK or the real renderer.
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

const sockPath = (name) => (process.platform === 'win32' ? `\\\\.\\pipe\\daniel-airplay-sim-${name}-${process.pid}` : path.join(os.tmpdir(), `daniel-airplay-sim-${name}-${process.pid}.sock`));
const CTL = sockPath('ctl');
const RENDER = sockPath('render');
process.env.DANIEL_AIRPLAY_CTL = CTL;
process.env.MGU_RENDERD_SOCKET = RENDER;

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
const entryStates = {};
rhmi.getByName = (n) => byName[n] || null;
rhmi.mapEntryState = (uuid, st) => { entryStates[uuid] = st; return Promise.resolve(); };
rhmi.openEntryState = () => { setVisible('ST_Airplay_Main', true); return Promise.resolve(); };
rhmi.openState = (n) => { setImmediate(() => setVisible(n, true)); return Promise.resolve(); };
rhmi.closeState = (n) => { if (visible[n]) setImmediate(() => setVisible(n, false)); return Promise.resolve(); };

/* ---- oap-sdk stand-in ---- */
let speedRaw = 0;             // 1/64 km/h; null = no answer
let initializedCalled = false;
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

/* ---- tool stand-in ---- */
let toolClient = null;
const toolCmds = [];
const toolServer = net.createServer((s) => {
    toolClient = s;
    s.setEncoding('utf8');
    let buf = '';
    s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { toolCmds.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    s.on('error', () => {});
});
const toolStatus = (st) => { if (toolClient) toolClient.write(JSON.stringify(Object.assign({ type: 'status', name: 'BMW', addresses: ['172.16.222.97'], video: '/dev/shm/mgu-video-daniel-airplay' }, st)) + '\n'); };

/* ---- mgu-render stand-in (wire format: u32 type, u32 len, payload padded to 4) ---- */
const R = { shownNow: false, frames: [], video: null, mode: null, place: null, hello: null };
const msg = (type, payload) => {
    const len = payload ? payload.length : 0;
    const b = Buffer.alloc(8 + len + ((4 - (len & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4);
    if (len) payload.copy(b, 8);
    return b;
};
const renderServer = net.createServer((s) => {
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
                ready.writeUInt32LE(1, 0); ready.writeUInt32LE(3, 4); ready.writeUInt32LE(16 | 4, 8);   // layer+embed; video, front gate
                [104, 88, 1692, 544].forEach((v, i) => ready.writeInt32LE(v, 12 + i * 4));            // embed box
                [0, 80, 1920, 640].forEach((v, i) => ready.writeInt32LE(v, 28 + i * 4));              // app area
                s.write(msg(0x4d520101, ready));
                const r = Buffer.alloc(12); r.writeUInt32LE(1920, 4); r.writeUInt32LE(720, 8);
                s.write(msg(101, r));
            } else if (type === 0x4d520001) R.mode = p.readUInt32LE(0) === 2 ? 'embed' : 'layer';
            else if (type === 2) R.place = { x: p.readInt32LE(0), y: p.readInt32LE(4), w: p.readInt32LE(8), h: p.readInt32LE(12) };
            else if (type === 3) R.shownNow = p.readUInt32LE(0) === 1;
            else if (type === 13) R.video = { id: p.readUInt32LE(0), file: p.slice(4).toString().replace(/\0+$/, '') };
            else if (type === 7) {                    // FRAME: is a VIDEO op (19) in it?
                const words = [];
                for (let i = 0; i + 4 <= p.length; i += 4) words.push(p.readUInt32LE(i));
                R.frames.push(words.length > 0 && words[0] === 19);
                const t = Buffer.alloc(8); t.writeUInt32LE(R.frames.length, 0);
                setTimeout(() => s.write(msg(102, t)), 30);   // TICK at ~30 fps
            }
        }
    });
});

/* ---- run ---- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const expect = (what, ok, detail) => { if (!ok) problems.push(`${what}${detail ? ': ' + detail : ''}`); else console.log(`  ok   ${what}`); };
const recentVideo = () => { const f = R.frames.slice(-5); return f.length > 0 && f.every(Boolean); };
const recentBlank = () => { const f = R.frames.slice(-5); return f.length > 0 && f.every((x) => !x); };
const press = (name) => byName[name].emit('action', { row: 0 });

console.log(`${manifest.id} on ID7 (simulated)`);
Promise.all([new Promise((r) => toolServer.listen(CTL, r)), new Promise((r) => renderServer.listen(RENDER, r))])
    .then(() => { require(path.join(APP, manifest.modules[0])); return wait(1500); })
    .then(() => {
        expect('app called initialized()', initializedCalled);
        expect('connected to mgu-render as daniel_airplay, embed mode, box placed', R.hello === 'daniel_airplay' && R.mode === 'embed' && R.place && R.place.w === 1692, JSON.stringify(R));
        expect('named the tool\'s frame file as video 1', R.video && R.video.file === '/dev/shm/mgu-video-daniel-airplay', JSON.stringify(R.video));
        toolStatus({ state: 'ready' });
        return wait(800);
    })
    .then(() => {
        expect('main page shows Ready with the receiver name', /Ready\..*"BMW"/.test(shown.airplayStatus || ''), shown.airplayStatus);
        expect('no picture before streaming', !R.shownNow);
        toolStatus({ state: 'streaming', device: 'Test iPhone', width: 590, height: 1278 });
        speedRaw = 0;
        return wait(1500);
    })
    .then(() => {
        expect('streaming + parked: main page says Mirroring', /Mirroring Test iPhone/.test(shown.airplayStatus || ''), shown.airplayStatus);
        expect('still no picture until the screen page opens', !R.shownNow);
        press('airplayShow');
        return wait(800);
    })
    .then(() => {
        expect('"Show phone screen" opened the embed page', visible.ST_Airplay_Embed === true);
        expect('picture shown (SHOW 1)', R.shownNow);
        expect('frames carry the VIDEO op', recentVideo(), JSON.stringify(R.frames.slice(-5)));
        speedRaw = 40 * 64;                       // driving at 40 km/h
        return wait(1800);
    })
    .then(() => {
        expect('moving: picture hidden (SHOW 0)', !R.shownNow);
        expect('moving: frames without the VIDEO op', recentBlank(), JSON.stringify(R.frames.slice(-5)));
        expect('moving: the screen page was closed', visible.ST_Airplay_Embed === false);
        expect('moving: main page says Paused while driving', /Paused while driving/.test(shown.airplayStatus || ''), shown.airplayStatus);
        press('airplayShow');                     // pressing Show while moving does nothing
        return wait(800);
    })
    .then(() => {
        expect('Show while moving does not open the page', visible.ST_Airplay_Embed === false && !R.shownNow);
        speedRaw = null;                          // the speed signal goes quiet
        return wait(4000);
    })
    .then(() => {
        expect('no fresh speed reading counts as not parked', !R.shownNow && /Paused while driving/.test(shown.airplayStatus || ''), shown.airplayStatus);
        speedRaw = 0;
        return wait(1500);
    })
    .then(() => {
        press('airplayShow');
        return wait(800);
    })
    .then(() => {
        expect('parked again: Show brings the picture back', R.shownNow && recentVideo());
        setVisible('ST_Airplay_Embed', false);    // BACK
        return wait(600);
    })
    .then(() => {
        expect('BACK: picture hidden', !R.shownNow);
        press('airplayStop');
        return wait(300);
    })
    .then(() => {
        expect('"Stop mirroring" sends stop to the tool', toolCmds.some((c) => c.cmd === 'stop'), JSON.stringify(toolCmds));
        toolClient.destroy();
        return wait(800);
    })
    .then(() => {
        expect('tool gone: main page says the receiver is not running', /not running/.test(shown.airplayStatus || ''), shown.airplayStatus);
        if (problems.length) {
            console.log(log.map((l) => `    ${l}`).join('\n'));
            console.error(problems.map((p) => `  FAIL ${p}`).join('\n'));
            process.exit(1);
        }
        console.log('  all ok');
        process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
