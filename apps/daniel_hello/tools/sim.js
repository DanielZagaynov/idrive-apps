'use strict';
/**
 * Runs src/hello.js on the desktop against a stand-in for the oap-sdk and
 * the HMI, for iDrive 7 and iDrive 8: starts the app, taps the tile, presses
 * "Press me" three times (once delivered twice, as the HMI can) and Reset,
 * and prints what the page shows after each step.
 *
 * The stand-in is built from this app's own uiDescription.json: a write to
 * a cell the component's widget does not have (Text on iDrive 8's button,
 * say) fails, as it would on the car. It is NOT BMW's SDK: it checks your
 * logic and your screen names, not how the real HMI behaves.
 *
 *   node tools/sim.js            both head units
 *   node tools/sim.js --hmi ID8  one
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const EventEmitter = require('events');
const Module = require('module');

const APP = path.join(__dirname, '..');
const args = process.argv.slice(2);
const hmiArg = args[args.indexOf('--hmi') + 1];

if (args.indexOf('--hmi') < 0) {
    let failed = false;
    ['ID7', 'ID8'].forEach((hmi) => {
        const r = cp.spawnSync(process.execPath, [__filename, '--hmi', hmi], { stdio: 'inherit' });
        failed = failed || r.status !== 0;
    });
    process.exitCode = failed ? 1 : 0;
    return;
}

const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'mgu-app.json'), 'utf8'));
const pkgDir = path.join(APP, manifest.tree);
const appDescription = JSON.parse(fs.readFileSync(path.join(pkgDir, 'rhmiData', 'application.json'), 'utf8'));
const ui = JSON.parse(fs.readFileSync(path.join(pkgDir, 'rhmiData', 'uiDescriptions', hmiArg, 'uiDescription.json'), 'utf8'));
const texts = JSON.parse(fs.readFileSync(path.join(pkgDir, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json'), 'utf8'));

const problems = [];
const log = [];
const logger = {
    info: (m) => log.push(`info  ${m}`), warn: (m) => { log.push(`warn  ${m}`); problems.push(m); },
    error: (m) => { log.push(`error ${m}`); problems.push(m); }, debug: () => {}
};

/* ---- the HMI stand-in ---- */
const byName = {};
const shown = {};          // component name -> { cell: text }
Object.keys(ui.containers).forEach((cid) => {
    const c = ui.containers[cid];
    const state = new EventEmitter();
    state.getId = () => Number(cid);
    state.name = c.name;
    byName[c.name] = state;
    Object.keys(c.components).forEach((id) => {
        const desc = c.components[id];
        const comp = new EventEmitter();
        const row = desc.rows[0] || {};
        comp.getId = () => Number(id);
        shown[desc.name] = {};
        Object.keys(row).forEach((cell) => {
            const v = row[cell];
            if (v.type === 'StringId') shown[desc.name][cell] = texts[v.value];
            else if (v.type === 'Text') shown[desc.name][cell] = v.value;
        });
        comp.setValue = (r, cell, value) => {
            if (r !== 0) return Promise.reject(new Error(`row ${r}: the component has one row`));
            if (!Object.prototype.hasOwnProperty.call(row, cell)) {
                return Promise.reject(new Error(`${desc.name} (${desc.type}) has no cell ${cell} on ${hmiArg}`));
            }
            shown[desc.name][cell] = value;
            return Promise.resolve();
        };
        comp.setProperty = () => Promise.resolve();
        byName[desc.name] = comp;
    });
});

const rhmi = new EventEmitter();
let openState = null;
const entryStates = {};
rhmi.getByName = (name) => byName[name] || null;
rhmi.mapEntryState = (uuid, state) => { entryStates[uuid] = state; return Promise.resolve(); };
rhmi.openEntryState = (uuid) => {
    const state = entryStates[uuid];
    if (!state) return Promise.reject(new Error(`no state mapped to entry point ${uuid}`));
    openState = state;
    state.emit('visible', { visible: true });
    return Promise.resolve();
};

/* ---- the oap-sdk stand-in ---- */
let availability = null;
let initializedCalled = false;
class OnlineApp extends EventEmitter {
    constructor() {
        super();
        this.rhmiApplication = rhmi;
        this.appDescription = appDescription;
        this.startReason = 'ENTRY_POINT';
    }
    start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
    initialized() { initializedCalled = true; return Promise.resolve(); }
    getAppId() { return manifest.id; }
    registerActive() {}
    getLastExecutedEntryPointUuid() { return null; }
    destroyBundles() { return Promise.resolve(); }
    getEntryPoints() {
        return appDescription.application.entryPoints.map((d) => ({
            getDescription: () => d,
            init: () => Promise.resolve(),
            setAvailability: (s) => { availability = s; return Promise.resolve(); }
        }));
    }
}
const stubs = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => logger }
};
const load = Module._load;
Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    if (/^oap-sdk/.test(request)) throw new Error(`sim.js has no stand-in for ${request}: add it to stubs`);
    return load.apply(this, arguments);
};
let now = 1e6;
Date.now = () => now;

/* ---- the run ---- */
const settle = () => new Promise((r) => setTimeout(r, 10));
const page = (title) => {
    const lines = [];
    Object.keys(ui.containers).forEach((cid) => {
        const c = ui.containers[cid];
        if (!openState || c.name !== openState.name) return;
        Object.keys(c.components).forEach((id) => {
            const d = c.components[id];
            if (d.properties.Visible && d.properties.Visible.value === 0) return;
            const cells = shown[d.name];
            const t = cells.Text !== undefined ? cells.Text : cells.PrimaryText;
            lines.push(`    ${d.type.padEnd(7)} ${d.name.padEnd(28)} ${JSON.stringify(t)}`);
        });
    });
    console.log(`  ${title}\n${lines.join('\n')}`);
};
const press = (name, twice) => {
    now += 1000;
    byName[name].emit('action', { row: 0 });
    if (twice) rhmi.emit('userEvent', { eventType: 'ACTION', sourceId: byName[name].getId(), parameterMap: {} });
};
const expect = (name, cell, want) => {
    const got = shown[name] && shown[name][cell];
    if (got !== want) problems.push(`${name}.${cell} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};
const btn = hmiArg === 'ID8' ? 'PrimaryText' : 'Text';

console.log(`${manifest.id} on ${hmiArg}`);
require(path.join(APP, manifest.modules[0]));
settle()
    .then(() => {
        if (!initializedCalled) problems.push('the app never called initialized()');
        if (availability !== 'ENABLED') problems.push(`the tile is ${availability}, not ENABLED`);
        const ep = appDescription.application.entryPoints[0];
        // the app opened its page itself (start reason ENTRY_POINT); a tile press does it again
        return Promise.resolve(rhmi.openEntryState(ep.uuid)).then(settle);
    })
    .then(() => {
        page('tile pressed');
        expect('helloStatus', 'Text', 'Hello from your own app!');
        press('helloCount', true);
        press('helloCount');
        press('helloCount');
        return settle();
    })
    .then(() => {
        page('"Press me" pressed 3 times (the first delivered twice)');
        expect('helloStatus', 'Text', 'Pressed 3 times');
        expect('helloCount', btn, 'Press me (3)');
        press('helloReset');
        return settle();
    })
    .then(() => {
        page('Reset pressed');
        expect('helloStatus', 'Text', 'Hello from your own app!');
        expect('helloCount', btn, 'Press me');
        if (problems.length) {
            console.log(log.map((l) => `    ${l}`).join('\n'));
            console.error(problems.map((p) => `  FAIL ${p}`).join('\n'));
            process.exitCode = 1;
        } else {
            console.log('  ok\n');
        }
    });
