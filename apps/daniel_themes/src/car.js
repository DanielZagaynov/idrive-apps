'use strict';
/**
 * car.js - speed, engine rpm and gear from the car's SOME/IP fields, scaled
 * as BMW scales them (the same fields and factors as idrive7-apps'
 * kit/runtime/car.js), with how fresh each one is.
 *
 *   const car = new Car(someipBuilders, logger);
 *   car.on('change', () => car.data());   // { speedKmh, rpm, gear, stage }
 *   car.fresh('speedKmh')                 // read within STALE_MS
 *   car.start(); ... car.stop();
 *
 * Fields notify only on change, so a car standing still sends nothing new.
 * The fields are therefore also read once a second (POLL_MS): a value is
 * fresh while a read or a notification came within STALE_MS. Where a field
 * has no getter (every read fails), its notifications alone count, and a
 * value seen once stays fresh while its interface is there.
 *
 * Interfaces and fields must be in package/manifest.json (tools/check.js
 * checks that).
 */
const EventEmitter = require('events');

const STALE_MS = 2500;
const POLL_MS = 1000;

/* raw * factor + offset; raw === invalid (or >= invalidFrom) is no value */
const SCALE = {
    speed: { factor: 0.015625, offset: 0, invalid: 65535 },
    rpm: { factor: 0.25, offset: 0, invalid: 65535 }
};
/* A hybrid's stopped engine leaves its run-down value as the signal; below this it is stopped. */
const ENGINE_STOPPED_RPM = 400;

/* statusActualGearDrive: names or wire numbers (G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2) */
const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
const gearOf = (x) => (typeof x === 'number' ? (x >= 3 && x <= 12 ? x - 2 : x === 1 ? -1 : x === 2 ? 0 : undefined) : GEARS[x]);
/* statusActualStageDrive: P = 1, R = 2, N = 3, D = 4 */
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
/* DataPowerTrain2.statusGearSelectionDrive: N = 1, R = 2, P = 3, NP = 4, _1 = 5 ... _9 = 13 */
function selectionOf(x) {
    const n = typeof x === 'number' ? x : ({ N: 1, R: 2, P: 3, NP: 4 })[x] || (/^_\d$/.test(String(x)) ? 4 + Number(String(x).slice(1)) : undefined);
    if (n === 1) return { stage: 'N', gear: 0 };
    if (n === 2) return { stage: 'R', gear: -1 };
    if (n === 3) return { stage: 'P', gear: 0 };
    if (n === 4) return { stage: undefined, gear: 0 };
    if (n >= 5 && n <= 13) return { stage: 'D', gear: n - 4 };
    return undefined;
}

function scaled(kind, raw) {
    const c = SCALE[kind];
    if (typeof raw !== 'number' || raw === c.invalid) return null;
    return raw * c.factor + c.offset;
}

const VEHICLE2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const CDS = 'de.bmw.infotainment.vehicle.CDS';
const VEHICLE_INFO = 'de.bmw.infrastructure.VehicleInformation';

/* interface -> field -> (car, value) */
const FIELDS = {
    [VEHICLE2]: {
        statusCarSpeed2: (car, v) => car._put('speedKmh', scaled('speed', v && v.speedVehicleCentreOfGravity))
    },
    [CDS]: {
        statusEngineSpeed2: (car, v) => {
            const r = scaled('rpm', v && v.actualValueRPMEngineCrankshaft);
            car._put('rpm', r !== null && r < ENGINE_STOPPED_RPM ? 0 : r);
        }
    },
    [VEHICLE_INFO]: {
        statusGearboxDrive: (car, v) => {
            const s = STAGES[v && v.statusActualStageDrive], g = gearOf(v && v.statusActualGearDrive);
            if (s !== undefined) car._put('stage', s);
            if (g !== undefined) car._put('gear', g);
        },
        DataPowerTrain2: (car, v) => {
            const sel = selectionOf(v && v.statusGearSelectionDrive);
            if (!sel) return;
            if (sel.stage !== undefined) car._put('stage', sel.stage);
            car._put('gear', sel.gear);
        }
    }
};

class Car extends EventEmitter {
    constructor(someipBuilders, logger, opts) {
        super();
        this.sb = someipBuilders;
        this.log = logger;
        this.opts = opts || {};
        this.values = {};
        this.at = {};                 // key -> last time it came (ms)
        this.readable = {};           // key -> a getter has answered at least once
        this.proxies = [];
        this.timer = null;
        this.stopped = false;
        this.loggedRaw = {};
    }

    start() {
        Object.keys(FIELDS).forEach((iface) => this._watch(iface));
        this.timer = setInterval(() => this._poll(), this.opts.pollMs || POLL_MS);
    }

    stop() {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.proxies.forEach((p) => { try { if (p.proxy.shutdown) p.proxy.shutdown(); } catch (e) { /* going anyway */ } });
        this.proxies = [];
    }

    data() {
        return { speedKmh: this.values.speedKmh, rpm: this.values.rpm, gear: this.values.gear, stage: this.values.stage };
    }

    /* Came within STALE_MS; or, for a field no read ever answered, came at all. */
    fresh(key, now) {
        const t = this.at[key];
        if (t === undefined) return false;
        if (!this.readable[key]) return true;
        return (now === undefined ? Date.now() : now) - t <= STALE_MS;
    }

    _watch(iface) {
        const fields = FIELDS[iface];
        let proxy;
        Promise.resolve()
            .then(() => this.sb.buildTypedProxy(iface, '1'))
            .then((p) => { proxy = p; return p.init(); })
            .then(() => proxy.waitUntilAvailable())
            .then(() => {
                if (this.stopped) return undefined;
                this.proxies.push({ iface, proxy });
                this.log.info(`car: ${iface.split('.').pop()} available`);
                return Promise.all(Object.keys(fields).map((f) => {
                    const attr = proxy[f];
                    if (!attr || typeof attr.subscribe !== 'function') {
                        this.log.warn(`car: ${iface.split('.').pop()}.${f} missing from the typed proxy (manifest.json?)`);
                        return undefined;
                    }
                    return Promise.resolve(attr.subscribe((v) => this._value(iface, f, v, false)))
                        .then(() => this._read(iface, proxy, f))
                        .catch((e) => this.log.warn(`car: subscribe ${f}: ${e && e.message}`));
                }));
            })
            .catch((e) => this.log.warn(`car: ${iface} unavailable: ${e && e.message}`));
    }

    _read(iface, proxy, f) {
        const attr = proxy[f];
        if (!attr || typeof attr.getValue !== 'function') return Promise.resolve();
        return Promise.resolve(attr.getValue())
            .then((v) => this._value(iface, f, v, true))
            .catch(() => { /* no getter, or the car is gone: freshness tells */ });
    }

    _poll() {
        this.proxies.forEach((p) => Object.keys(FIELDS[p.iface]).forEach((f) => this._read(p.iface, p.proxy, f)));
    }

    _value(iface, field, v, fromRead) {
        if (!this.loggedRaw[field]) {   // what a car sends, once each, for the log
            this.loggedRaw[field] = true;
            let s;
            try { s = JSON.stringify(v); } catch (e) { s = String(v); }
            this.log.info(`car: first ${field}: ${s && s.length > 200 ? s.slice(0, 200) + '...' : s}`);
        }
        this._fromRead = fromRead;
        try { FIELDS[iface][field](this, v); } catch (e) { this.log.warn(`car: ${field}: ${e && e.message}`); }
        this._fromRead = false;
    }

    _put(key, value) {
        if (value === null || value === undefined || (typeof value === 'number' && !isFinite(value))) return;
        const changed = this.values[key] !== value;
        this.values[key] = value;
        this.at[key] = Date.now();
        if (this._fromRead) this.readable[key] = true;
        if (changed) this.emit('change', key, value);
    }
}

Car.STALE_MS = STALE_MS;
Car.FIELDS = FIELDS;
Car.selectionOf = selectionOf;
Car.gearOf = gearOf;
module.exports = { Car };
