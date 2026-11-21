'use strict';
/**
 * Runs the app (src/themes.js and the real lib/cluster_render_client.js) on
 * the desktop against stand-ins for cluster-render, the car and the HMI,
 * and writes what the cluster would show as PNGs in sim-out/:
 *
 *  - cluster-render: a socket server that speaks PROTOCOL.md's framing
 *    (hello, layer, set, drop, F frames: whole and in rects), refuses what
 *    the service would (a frame of the wrong size, an unknown ref, a message
 *    over 5,529,664 bytes), and composes the visible layers as the service
 *    places them: rect, z, rotation and scale about the pivot, bilinear;
 *  - the car: typed proxies for Vehicle2, CDS and VehicleInformation that
 *    notify on change and answer reads, raw values scaled as the car sends
 *    them; it can go silent (reads fail, nothing notified);
 *  - the HMI: the app's own uiDescription, as tools/sim.js in daniel_hello.
 *
 * It is NOT the car or the real service: it checks the app's logic, its
 * protocol and where its layers land, not how the cluster draws them.
 *
 *   node tools/sim.js
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');
const { encode } = require('./pngenc.js');
const { decode } = require('../src/png.js');

const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'sim-out');
const PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\daniel_themes_sim_${process.pid}` : path.join(os.tmpdir(), `daniel_themes_sim_${process.pid}.sock`);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'themes-sim-'));
process.env.CLUSTER_RENDER_SOCKET = PIPE;
process.env.THEMES_DATA = DATA;
process.env.THEMES_ASSETS = path.join(APP, 'package', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const log = [];
const fail = (m) => problems.push(m);

/* ---- cluster-render stand-in ---- */
const MAX_MESSAGE = 5529664;
const layers = new Map();
const stats = { json: 0, frames: 0, frameBytes: 0, hellos: 0 };
const sockets = new Set();
let targetState = '';

function sendJson(sock, obj) {
    const b = Buffer.from(JSON.stringify(obj), 'utf8'), m = Buffer.alloc(5 + b.length);
    m.writeUInt32LE(b.length + 1, 0); m[4] = 0x4a; b.copy(m, 5);
    sock.write(m);
}

function updateTarget(sock) {
    const want = Array.from(layers.values()).some((l) => l.visible && l.have);
    const st = want ? 'shown' : 'released';
    if (st !== targetState) { targetState = st; sendJson(sock, { ev: 'target', target: 'panel', state: st, holder: '', reason: '' }); }
}

function handle(sock, type, body) {
    if (type === 0x4a) {
        stats.json++;
        let m;
        try { m = JSON.parse(body.toString('utf8')); } catch (e) { fail('a J message is not JSON'); return; }
        if (m.op === 'hello') {
            stats.hellos++;
            layers.clear(); targetState = '';
            if (m.proto !== 1) fail(`hello proto ${m.proto}`);
            sendJson(sock, { ev: 'hello', proto: 1, backend: 'id7', targets: 'map:1088x480,panel:1920x720,hud:800x480' });
        } else if (m.op === 'layer') {
            if (m.target !== 'panel') fail(`layer ${m.ref} on ${m.target}, not panel`);
            if (m.kind !== 'image') fail(`layer ${m.ref} is ${m.kind}`);
            if (!(m.iw > 0 && m.ih > 0 && m.iw <= 1920 && m.ih <= 720)) fail(`layer ${m.ref} image ${m.iw}x${m.ih}`);
            layers.set(m.ref, { ref: m.ref, x: m.x, y: m.y, w: m.w, h: m.h, z: m.z || 0, iw: m.iw, ih: m.ih, cls: m.class,
                visible: m.visible === undefined ? 1 : m.visible, rotate: m.rotate || 0, sx: m.sx === undefined ? 1 : m.sx, sy: m.sy === undefined ? 1 : m.sy,
                px: m.px === undefined ? m.w / 2 : m.px, py: m.py === undefined ? m.h / 2 : m.py, img: Buffer.alloc(m.iw * m.ih * 4), have: false });
            sendJson(sock, { ev: 'layer', ref: m.ref, state: 'waiting' });
        } else if (m.op === 'set') {
            const l = layers.get(m.ref);
            if (!l) { fail(`set on unknown ref ${m.ref}`); return; }
            ['visible', 'rotate', 'sx', 'sy', 'px', 'py', 'x', 'y', 'w', 'h', 'z'].forEach((k) => { if (m[k] !== undefined) l[k] = m[k]; });
        } else if (m.op === 'drop') layers.delete(m.ref);
        else fail(`unexpected op ${m.op}`);
        updateTarget(sock);
    } else if (type === 0x46) {
        stats.frames++; stats.frameBytes += body.length;
        const ref = body.readUInt32LE(0), n = body.readUInt16LE(12), l = layers.get(ref);
        if (!l) { fail(`frame for unknown ref ${ref}`); return; }
        let off = 14 + n * 8;
        if (n === 0) {
            const need = l.iw * l.ih * 4;
            if (body.length - off !== need) { fail(`whole frame for ${ref}: ${body.length - off} bytes, not ${need}`); return; }
            body.copy(l.img, 0, off, off + need);
        } else {
            for (let i = 0; i < n; i++) {
                const x = body.readUInt16LE(14 + i * 8), y = body.readUInt16LE(16 + i * 8), w = body.readUInt16LE(18 + i * 8), h = body.readUInt16LE(20 + i * 8);
                if (x + w > l.iw || y + h > l.ih) { fail(`rect ${x},${y} ${w}x${h} outside ${l.iw}x${l.ih}`); return; }
                for (let r = 0; r < h; r++) { body.copy(l.img, ((y + r) * l.iw + x) * 4, off, off + w * 4); off += w * 4; }
            }
            if (off !== body.length) fail(`frame for ${ref}: ${body.length - off} bytes left over`);
        }
        l.have = true;
        updateTarget(sock);
    } else fail(`unexpected message type ${type}`);
}

const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 5) {
            const len = buf.readUInt32LE(0);
            if (len < 1 || len > MAX_MESSAGE) { fail(`message of ${len} bytes`); sock.destroy(); return; }
            if (buf.length < 4 + len) break;
            const type = buf[4], body = buf.slice(5, 4 + len);
            buf = buf.slice(4 + len);
            handle(sock, type, body);
        }
    });
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
});

/* What the panel shows: black, then every visible layer that has pixels, by z. */
function compose() {
    const W = 1920, H = 720, out = Buffer.alloc(W * H * 4);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    Array.from(layers.values()).filter((l) => l.visible && l.have).sort((a, b) => a.z - b.z || a.ref - b.ref).forEach((l) => {
        const th = l.rotate * Math.PI / 180, c = Math.cos(th), s = Math.sin(th), ox = l.x + l.px, oy = l.y + l.py;
        const kx = l.iw / l.w, ky = l.ih / l.h;
        const corners = [[0, 0], [l.w, 0], [0, l.h], [l.w, l.h]].map((p) => {
            const dx = (p[0] - l.px) * l.sx, dy = (p[1] - l.py) * l.sy;
            return [ox + dx * c - dy * s, oy + dx * s + dy * c];
        });
        const x0 = Math.max(0, Math.floor(Math.min.apply(null, corners.map((p) => p[0])))), x1 = Math.min(W, Math.ceil(Math.max.apply(null, corners.map((p) => p[0]))));
        const y0 = Math.max(0, Math.floor(Math.min.apply(null, corners.map((p) => p[1])))), y1 = Math.min(H, Math.ceil(Math.max.apply(null, corners.map((p) => p[1]))));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const dx = x + 0.5 - ox, dy = y + 0.5 - oy;
            const lx = (dx * c + dy * s) / l.sx + l.px, ly = (-dx * s + dy * c) / l.sy + l.py;
            const u = lx * kx - 0.5, v = ly * ky - 0.5;
            if (u < -0.5 || v < -0.5 || u > l.iw - 0.5 || v > l.ih - 0.5) continue;
            const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0, px = [0, 0, 0, 0];
            [[u0, v0, (1 - fu) * (1 - fv)], [u0 + 1, v0, fu * (1 - fv)], [u0, v0 + 1, (1 - fu) * fv], [u0 + 1, v0 + 1, fu * fv]].forEach((q) => {
                const qx = Math.min(l.iw - 1, Math.max(0, q[0])), qy = Math.min(l.ih - 1, Math.max(0, q[1])), o = (qy * l.iw + qx) * 4, a = l.img[o + 3] / 255 * q[2];
                px[0] += l.img[o] * a; px[1] += l.img[o + 1] * a; px[2] += l.img[o + 2] * a; px[3] += a;
            });
            if (px[3] <= 0) continue;
            const o = (y * W + x) * 4, a = px[3];
            for (let j = 0; j < 3; j++) out[o + j] = Math.round(px[j] + out[o + j] * (1 - a));
        }
    });
    return out;
}

function snapshot(name) {
    fs.writeFileSync(path.join(OUT, name), encode(1920, 720, compose()));
    return path.join('sim-out', name);
}

/* ---- the car stand-in ---- */
const car = { online: true, v: {} };
/* notifyOnly: the manifest asks for the field with "s" (the car's interface
 * database has no getter for it), so every read is refused */
class Attr {
    constructor(get, notifyOnly) { this.get = get; this.subs = []; this.notifyOnly = !!notifyOnly; }
    subscribe(fn) { this.subs.push(fn); return Promise.resolve(); }
    getValue() {
        if (this.notifyOnly) return Promise.reject(new Error('no getter'));
        if (!car.online) return Promise.reject(new Error('timeout'));
        const v = this.get();
        return v === undefined ? Promise.reject(new Error('no value yet')) : Promise.resolve(v);
    }
    notify() { const v = this.get(); if (car.online && v !== undefined) this.subs.forEach((f) => f(v)); }
}
const attrs = {
    statusCarSpeed2: new Attr(() => (car.v.speedKmh === undefined ? undefined : { speedVehicleCentreOfGravity: Math.round(car.v.speedKmh / 0.015625) })),
    statusEngineSpeed2: new Attr(() => (car.v.rpm === undefined ? undefined : { actualValueRPMEngineCrankshaft: Math.round(car.v.rpm / 0.25) })),
    statusGearboxDrive: new Attr(() => (car.v.stage === undefined ? undefined : { statusActualStageDrive: car.v.stage, statusActualGearDrive: car.v.gearWire }), true),
    DataPowerTrain2: new Attr(() => undefined, true)
};
const IFACES = {
    'de.bmw.infotainment.vehicle.Vehicle2': ['statusCarSpeed2'],
    'de.bmw.infotainment.vehicle.CDS': ['statusEngineSpeed2'],
    'de.bmw.infrastructure.VehicleInformation': ['statusGearboxDrive', 'DataPowerTrain2']
};
const someipBuilders = {
    buildTypedProxy(iface, instance) {
        if (!IFACES[iface]) return Promise.reject(new Error(`no proxy for ${iface}`));
        if (instance !== '1') fail(`proxy ${iface} instance ${instance}`);
        const p = { init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(), shutdown() {} };
        IFACES[iface].forEach((n) => { p[n] = attrs[n]; });
        return Promise.resolve(p);
    }
};
function drive(v) { Object.assign(car.v, v); Object.keys(attrs).forEach((k) => attrs[k].notify()); }

/* ---- the HMI and oap-sdk stand-ins ---- */
const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'mgu-app.json'), 'utf8'));
const pkgDir = path.join(APP, manifest.tree);
const appDescription = JSON.parse(fs.readFileSync(path.join(pkgDir, 'rhmiData', 'application.json'), 'utf8'));
const ui = JSON.parse(fs.readFileSync(path.join(pkgDir, 'rhmiData', 'uiDescriptions', 'ID7', 'uiDescription.json'), 'utf8'));
const texts = JSON.parse(fs.readFileSync(path.join(pkgDir, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json'), 'utf8'));
const logger = {
    info: (m) => log.push(`info  ${m}`), warn: (m) => log.push(`warn  ${m}`),
    error: (m) => { log.push(`error ${m}`); fail(m); }, debug: () => {}
};
const byName = {}, shown = {};
Object.keys(ui.containers).forEach((cid) => {
    const c = ui.containers[cid], state = new EventEmitter();
    state.getId = () => Number(cid); state.name = c.name; byName[c.name] = state;
    Object.keys(c.components).forEach((id) => {
        const desc = c.components[id], comp = new EventEmitter(), row = desc.rows[0] || {};
        comp.getId = () => Number(id);
        shown[desc.name] = {};
        Object.keys(row).forEach((cell) => { const v = row[cell]; shown[desc.name][cell] = v.type === 'StringId' ? texts[v.value] : v.value; });
        comp.setValue = (r, cell, value) => {
            if (!Object.prototype.hasOwnProperty.call(row, cell)) return Promise.reject(new Error(`${desc.name} has no cell ${cell}`));
            shown[desc.name][cell] = value;
            return Promise.resolve();
        };
        byName[desc.name] = comp;
    });
});
const rhmi = new EventEmitter();
const entryStates = {};
rhmi.getByName = (n) => byName[n] || null;
rhmi.mapEntryState = (uuid, st) => { entryStates[uuid] = st; return Promise.resolve(); };
rhmi.openEntryState = (uuid) => { const st = entryStates[uuid]; if (st) st.emit('visible', { visible: true }); return Promise.resolve(); };
let availability = null;
class OnlineApp extends EventEmitter {
    constructor() { super(); this.rhmiApplication = rhmi; this.appDescription = appDescription; this.startReason = 'AUTOSTART'; }
    start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
    initialized() { return Promise.resolve(); }
    getAppId() { return manifest.id; }
    registerActive() {}
    getLastExecutedEntryPointUuid() { return null; }
    destroyBundles() { return Promise.resolve(); }
    getEntryPoints() {
        return appDescription.application.entryPoints.map((d) => ({
            getDescription: () => d, init: () => Promise.resolve(), setAvailability: (s) => { availability = s; return Promise.resolve(); }
        }));
    }
}
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
/* modules require each other as './<file>' (one folder once linked): find them in src/ or lib/ */
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent) {
    if (/^\.\/[\w-]+(\.js)?$/.test(request)) {
        const base = request.replace(/^\.\//, '').replace(/\.js$/, '') + '.js';
        for (const dir of ['src', 'lib']) { const f = path.join(APP, dir, base); if (fs.existsSync(f)) return f; }
    }
    return resolve.apply(this, arguments);
};

/* ---- the run ---- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = () => Array.from(layers.values()).filter((l) => l.visible).length;
const status = () => shown.themesStatus && shown.themesStatus.Text;
const MPH = 1 / 0.621371;
const { aim, levelBand } = require('../src/cluster.js');
const themeOf = (id) => JSON.parse(fs.readFileSync(path.join(APP, 'package', 'assets', id, 'theme.json'), 'utf8'));
let theme = themeOf('christmas');
/* The level band lit exactly up to value: every band pixel at or below it, none above. */
let bands = {};
function levelAt(g, value) {
    const b = bands[g] || (bands[g] = levelBand(theme[g], theme.level));
    const l = Array.from(layers.values()).find((q) => q.x === b.x && q.y === b.y && q.iw === b.w && q.ih === b.h);
    if (!l) { fail(`no level layer for ${g}`); return; }
    let wrong = 0, lit = 0;
    for (let k = 0; k < b.idx.length; k++) {
        const a = l.img[b.idx[k] * 4 + 3], want = b.val[k] <= value ? b.rgba[b.idx[k] * 4 + 3] : 0;
        if (Math.abs(b.val[k] - value) < 0.01) continue;   // exactly at the value: either is right
        if (a !== want) wrong++;
        if (a) lit++;
    }
    if (wrong) fail(`${g} level at ${value}: ${wrong} of ${b.idx.length} pixels wrong`);
    if (value > 0 && !lit) fail(`${g} level at ${value}: nothing lit`);
    return lit;
}

function needleAt(g, value) {
    const want = aim(theme[g], value), refs = Array.from(layers.values()).filter((l) => l.iw === theme.needle.length + 16);
    const l = refs[g === 'speed' ? 0 : 1];
    if (!l) { fail(`no ${g} needle layer`); return; }
    if (Math.abs(l.rotate - want.rotate) > 0.3) fail(`${g} needle at ${l.rotate.toFixed(1)} deg for ${value}, expected ${want.rotate.toFixed(1)}`);
    if (Math.abs(l.sx * theme.needle.length - want.length) > 2) fail(`${g} needle ${Math.round(l.sx * theme.needle.length)} px long for ${value}, expected ${Math.round(want.length)}`);
}
function textInk(box) {   // the readout layer at this box has some opaque pixels
    const l = Array.from(layers.values()).find((x) => x.x === box[0] && x.y === box[1]);
    if (!l) return -1;
    let n = 0;
    for (let i = 3; i < l.img.length; i += 4) if (l.img[i] > 128) n++;
    return n;
}
function step(title) { console.log(`  ${title}: status "${status()}", ${visible()}/${layers.size} layers visible, target ${targetState || '-'}`); }

server.listen(PIPE, () => {
    console.log(`daniel_themes on a stand-in cluster-render (${PIPE})`);
    require(path.join(APP, manifest.modules[0]));
    run().catch((e) => fail(`sim: ${e.stack || e}`)).then(finish);
});

async function run() {
    await wait(1500);
    step('started, no car data');
    if (!stats.hellos) fail('the app never said hello to cluster-render');
    if (layers.size !== 10) fail(`${layers.size} layers, expected 10 (plate, 2 levels, 2 needles, 2 hubs, 3 readouts)`);
    if (visible()) fail('layers visible before the car sent a speed');
    if (availability !== 'ENABLED') fail(`tile ${availability}`);

    drive({ speedKmh: 0, rpm: 780, stage: 'P', gearWire: 2 });
    await wait(800);
    step('parked, engine idling');
    if (visible() !== layers.size) fail('not all layers visible with a fresh speed');
    if (targetState !== 'shown') fail(`target ${targetState} after showing`);
    needleAt('speed', 0); needleAt('rpm', 780); levelAt('speed', 0); levelAt('rpm', 780);
    console.log(`    ${snapshot('1-parked.png')}`);

    drive({ speedKmh: 60 * MPH, rpm: 1800, stage: 'D', gearWire: 5 });
    await wait(800);
    step('60 mph, 1,800 rpm, D (the render\'s own values)');
    needleAt('speed', 60); needleAt('rpm', 1800); levelAt('speed', 60); levelAt('rpm', 1800);
    if (textInk(theme.readouts.speed.box) <= 0) fail('the speed readout has no text');
    if (textInk(theme.readouts.gear.box) <= 0) fail('the gear readout has no text');
    console.log(`    ${snapshot('2-60mph.png')}`);

    drive({ speedKmh: 180 * MPH, rpm: 7000, stage: 'D', gearWire: 10 });
    await wait(800);
    step('180 mph, 7,000 rpm');
    needleAt('speed', 180); needleAt('rpm', 7000); levelAt('speed', 180); levelAt('rpm', 7000);
    console.log(`    ${snapshot('3-180mph.png')}`);

    drive({ speedKmh: 35 * MPH, rpm: 2600, stage: 'R', gearWire: 1 });
    await wait(800);
    step('35 mph in R');
    needleAt('speed', 35); needleAt('rpm', 2600); levelAt('speed', 35); levelAt('rpm', 2600);
    console.log(`    ${snapshot('4-35mph-R.png')}`);

    car.online = false;
    await wait(3300);
    step('car silent for 3.3 s');
    if (visible()) fail('the theme stayed on the cluster with a stale speed');
    if (!/no speed/.test(status())) fail(`status "${status()}" while the speed is stale`);

    car.online = true;
    drive({ speedKmh: 50 * MPH, rpm: 2000, stage: 'D', gearWire: 4 });
    await wait(1300);
    step('car back');
    if (visible() !== layers.size) fail('the theme did not come back with the speed');

    byName.themesToggle.emit('action', { row: 0 });
    await wait(500);
    step('turned off on the page');
    if (visible()) fail('layers visible after Turn theme off');
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')); } catch (e) { /* checked below */ }
    if (!saved || saved.enabled !== false) fail(`settings.json after turning off: ${JSON.stringify(saved)}`);
    if (shown.themesToggle.Text !== 'Turn theme on') fail(`button reads "${shown.themesToggle.Text}"`);
    await wait(450);
    byName.themesToggle.emit('action', { row: 0 });
    await wait(500);
    step('turned on again');
    if (visible() !== layers.size) fail('layers not visible after Turn theme on');

    await wait(450);
    byName.themesGlow.emit('action', { row: 0 });
    await wait(500);
    step('glow turned off on the page');
    if (visible() !== layers.size - 2) fail(`${visible()} of ${layers.size} layers visible with the glow off, expected all but the 2 levels`);
    saved = null;
    try { saved = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')); } catch (e) { /* checked below */ }
    if (!saved || saved.glow !== false || saved.enabled !== true) fail(`settings.json after glow off: ${JSON.stringify(saved)}`);
    if (shown.themesGlow.Text !== 'Turn glow on') fail(`glow button reads "${shown.themesGlow.Text}"`);
    console.log(`    ${snapshot('6-glow-off.png')}`);
    await wait(450);
    byName.themesGlow.emit('action', { row: 0 });
    await wait(500);
    step('glow turned on again');
    if (visible() !== layers.size) fail('levels not visible after Turn glow on');

    /* every theme from the page: its own plate, needles, levels and readouts */
    const list = JSON.parse(fs.readFileSync(path.join(APP, 'package', 'assets', 'themes.json'), 'utf8')).themes;
    for (const t of list.filter((x) => x.id !== 'christmas').concat([{ id: 'christmas' }])) {
        await wait(450);
        if (!byName[`themesPick_${t.id}`]) { fail(`no button for theme ${t.id}`); continue; }
        byName[`themesPick_${t.id}`].emit('action', { row: 0 });
        theme = themeOf(t.id); bands = {};
        drive({ speedKmh: 90 * MPH, rpm: 5500, stage: 'D', gearWire: 6 });
        await wait(1500);
        step(`picked ${theme.name} at 90 mph, 5,500 rpm`);
        const want = 1 + 2 + 2 + 2 + Object.keys(theme.readouts).length;
        if (layers.size !== want) fail(`${theme.id}: ${layers.size} layers, expected ${want}`);
        if (visible() !== layers.size || targetState !== 'shown') fail(`${theme.id}: not shown after picking it`);
        needleAt('speed', 90); needleAt('rpm', 5500); levelAt('speed', 90); levelAt('rpm', 5500);
        if (textInk(theme.readouts.speed.box) <= 0) fail(`${theme.id}: the speed readout has no text`);
        let picked = null;
        try { picked = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')); } catch (e) { /* checked below */ }
        if (!picked || picked.theme !== theme.id) fail(`settings.json after picking ${theme.id}: ${JSON.stringify(picked)}`);
        const btn = shown[`themesPick_${theme.id}`];
        if (!btn || !/\(selected\)$/.test(btn.Text)) fail(`${theme.id} button reads "${btn && btn.Text}"`);
        if (theme.id !== 'christmas') console.log(`    ${snapshot(`7-${theme.id}.png`)}`);
    }
    drive({ speedKmh: 50 * MPH, rpm: 2000, stage: 'D', gearWire: 4 });
    await wait(600);

    const hellos = stats.hellos;
    sockets.forEach((s) => s.destroy());
    await wait(2500);
    step('cluster-render restarted');
    if (stats.hellos <= hellos) fail('the client did not reconnect');
    if (layers.size !== 10 || !Array.from(layers.values()).every((l) => l.have)) fail('layers or their pixels not made again after the restart');
    if (visible() !== layers.size || targetState !== 'shown') fail('not shown again after the restart');
    needleAt('speed', 50);
    console.log(`    ${snapshot('5-after-restart-50mph.png')}`);
}

function finish() {
    console.log(`  protocol: ${stats.hellos} hello(s), ${stats.json} JSON messages, ${stats.frames} frames, ${(stats.frameBytes / 1048576).toFixed(1)} MiB of pixels`);
    // the render beside the app's 60 mph frame, to compare by eye
    try {
        const render = decode(fs.readFileSync(path.join(APP, 'package', 'assets', 'christmas', 'plate.png')));
        const sim = decode(fs.readFileSync(path.join(OUT, '2-60mph.png')));
        const both = Buffer.concat([render.data, sim.data]);
        fs.writeFileSync(path.join(OUT, 'compare-plate-vs-60mph.png'), encode(1920, 1440, both));
    } catch (e) { /* the steps above say why */ }
    if (problems.length) {
        console.log(log.map((l) => `    ${l}`).join('\n'));
        console.error(problems.map((p) => `  FAIL ${p}`).join('\n'));
        process.exitCode = 1;
    } else console.log('  ok');
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* temp */ }
    setTimeout(() => process.exit(), 50);
}
