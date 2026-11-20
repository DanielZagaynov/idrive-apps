'use strict';
/**
 * speed.js - "parked" for the AirPlay Mirror app: the phone's screen shows only
 * while the car stands still.
 *
 * Vehicle2.statusCarSpeed2 (speedVehicleCentreOfGravity, 1/64 km/h, 65535 =
 * invalid) read every second through the oap-sdk, as the Drive Recorder app
 * does. Parked = a reading from the last 3 s below 3 km/h. No reading, a stale
 * one or an invalid one counts as NOT parked: the safe side.
 */
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');

const PARKED_KMH = 3;
const FRESH_MS = 3000;
const POLL_MS = 1000;
const RETRY_MS = 15000;

class Speed {
    constructor(log, now) {
        this.log = log;
        this.now = now || Date.now;
        this.proxy = null;
        this.reading = null;      // { kmh, at }
        this.timers = [];
    }

    start() {
        const connect = () => {
            someipBuilders.buildAndInitTypedProxy('de.bmw.infotainment.vehicle.Vehicle2', '1', 10000)
                .then((p) => { this.proxy = p; this.log.info('speed: connected'); })
                .catch((e) => {
                    this.log.warn('speed: ' + ((e && e.message) || e) + ', retrying');
                    this.timers.push(setTimeout(connect, RETRY_MS));
                });
        };
        connect();
        this.timers.push(setInterval(() => this.poll(), POLL_MS));
    }

    poll() {
        if (!this.proxy) return Promise.resolve();
        return Promise.resolve()
            .then(() => this.proxy.statusCarSpeed2.getValue())
            .then((x) => {
                const raw = x && x.speedVehicleCentreOfGravity;
                if (typeof raw === 'number' && raw !== 65535) this.reading = { kmh: raw / 64, at: this.now() };
            }, () => null);
    }

    parked() {
        const r = this.reading;
        return !!(r && this.now() - r.at < FRESH_MS && r.kmh < PARKED_KMH);
    }

    kmh() { return this.reading ? this.reading.kmh : null; }

    stop() { this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); this.timers = []; }
}

module.exports = { Speed, PARKED_KMH, FRESH_MS };
