'use strict';
/**
 * Hello: a starter app for mgu-store. One page (ST_Hello_Main) with a status
 * line, a "Press me" button that counts presses and a Reset button.
 *
 * Runs on the head unit's Node 8: no npm packages, no syntax newer than
 * Node 8 (no ?. or ??). It may require only the oap-sdk names listed in
 * mgu-app.json "sdk", its own modules as './<file>', and Node builtins.
 *
 * The page and its components are defined in tools/gen_rhmi.js; the names
 * below must match the names there (tools/check.js checks that).
 */
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');

const logger = logging.getSDKLogger();

const MAIN = 'ST_Hello_Main';
const C = { status: 'helloStatus', count: 'helloCount', reset: 'helloReset' };
/* A hidden label only iDrive 8's description has: tells the two apart. */
const ID8_MARKER = 'helloHmiID8';
/* iDrive 8's button widget calls its text cell PrimaryText. */
const BUTTON_CELL = { ID7: 'Text', ID8: 'PrimaryText' };
/* The start reasons for which the app is opened on screen right away. */
const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
/* A press can arrive twice (the component's event and the raw userEvent). */
const PRESS_DEDUPE_MS = 400;

function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class Hello extends OnlineApp {
    constructor() {
        super();
        this._count = 0;
        this._hmi = 'ID7';
        this._main = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._stopping = null;

        this.on('initialized', () => {
            this._setup().catch((err) => logger.error(`hello init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._stop(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._open(uuid));
    }

    _setup() {
        logger.info(`hello ${this.getAppId()} starting`);
        if (!this.rhmiApplication) {
            // Started in the background (no screen for this start reason).
            return this.initialized();
        }
        const rhmi = this.rhmiApplication;
        this._main = rhmi.getByName(MAIN);
        if (!this._main) {
            return Promise.reject(new Error(`uiDescription has no ${MAIN}`));
        }
        this._hmi = rhmi.getByName(ID8_MARKER) ? 'ID8' : 'ID7';
        Object.keys(C).forEach((key) => {
            const name = C[key];
            this._components[name] = rhmi.getByName(name);
            if (!this._components[name]) {
                logger.warn(`${name} not found in uiDescription`);
            }
        });

        this._bind(C.count, () => {
            this._count += 1;
            this._render();
        });
        this._bind(C.reset, () => {
            this._count = 0;
            this._render();
        });
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._press(entry.name, entry.handler);
            }
        });
        // The HMI restarted and lost what was written: write it again.
        rhmi.on('restoreHmi', () => this._render());
        this._main.on('visible', (ev) => {
            if (isTrue(ev && ev.visible)) {
                this._render();
            }
        });

        const foreground = this._startedForeground();
        return this._registerEntryPoint()
            .then(() => {
                if (foreground) {
                    this.registerActive();
                }
                return this.initialized();
            })
            .then(() => {
                this._render();
                const last = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return last ? this._open(last) : undefined;
            });
    }

    _startedForeground() {
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.indexOf(reason) >= 0;
    }

    /* The tile: the entry point rhmiData/application.json describes. */
    _registerEntryPoint() {
        const described = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => described.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._main))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${description.name} ENABLED`));
    }

    /* The tile was pressed: show the page. */
    _open(uuid) {
        if (this._stopping || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._render();
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    _bind(name, handler) {
        const comp = this._components[name];
        if (!comp) {
            return;
        }
        try {
            this._actionById[Number(comp.getId())] = { name, handler };
        } catch (e) {
            /* no id: the component's own events only */
        }
        comp.on('action', () => this._press(name, handler));
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) {
            return;
        }
        this._lastPress[name] = now;
        logger.info(`pressed ${name}`);
        try {
            handler();
        } catch (err) {
            logger.warn(`${name} failed: ${err && err.message}`);
        }
    }

    /* ---- what the page shows ---- */

    _render() {
        const n = this._count;
        this._label(C.status, n === 0 ? 'Hello from your own app!' : `Pressed ${n} time${n === 1 ? '' : 's'}`);
        this._button(C.count, n === 0 ? 'Press me' : `Press me (${n})`);
    }

    _label(name, text) {
        this._write(name, 'Text', text);
    }

    _button(name, text) {
        this._write(name, BUTTON_CELL[this._hmi], text);
    }

    _write(name, cell, text) {
        const comp = this._components[name];
        if (!comp) {
            return;
        }
        Promise.resolve(comp.setValue(0, cell, text, 'Text'))
            .catch((err) => logger.warn(`write ${name}.${cell} failed: ${err && err.message}`));
    }

    _stop(reason) {
        if (this._stopping) {
            return this._stopping;
        }
        logger.info(`hello shutting down (${reason})`);
        this._stopping = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._stopping;
    }
}

const app = new Hello();
app.start().catch((err) => {
    // Stays resident so the app manager can stop or restart it.
    logger.error(`hello failed to start: ${err && err.message}`);
});
