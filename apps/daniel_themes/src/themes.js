'use strict';
/**
 * Themes: draws a theme over the whole instrument cluster (iDrive 7) with
 * live needles and readouts: speed, rpm and gear from the car
 * (src/car.js), drawn through cluster-render (src/cluster.js). Starts with
 * the head unit (mguAppStartType autostart); its tile opens one page to
 * turn the theme and its glow on or off, pick the theme (one button per
 * theme in assets/themes.json) and see what it is doing.
 *
 * The rule that keeps it safe: the theme is on the cluster only while the
 * car's speed is known and fresh (read within 2.5 s). Without it (no
 * signal, the car's interface gone, the renderer restarting) it is taken
 * off and BMW's own gauges show again.
 *
 * Runs on the head unit's Node 8: no syntax newer than Node 8 (no ?. ??),
 * requires only './<module>', the oap-sdk names in mgu-app.json "sdk" and
 * Node builtins. Screen names are in tools/gen_rhmi.js (tools/check.js).
 */
const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const { ClusterRender } = require('./cluster_render_client.js');
const { ClusterTheme, findAssets } = require('./cluster.js');
const { Car } = require('./car.js');

const logger = logging.getSDKLogger();

const APP_ID = 'daniel_themes';
const MAIN = 'ST_Themes_Main';
const C = { status: 'themesStatus', toggle: 'themesToggle', glow: 'themesGlow', theme: 'themesTheme' };
const BUTTON_CELL = 'Text';            // iDrive 7's LT_Button_1Row (the app is iDrive 7 only)
const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
const PRESS_DEDUPE_MS = 400;
const GATE_MS = 250;                    // how often the show rule is looked at
const RENDERER_MISSING_MS = 15000;      // no answer from cluster-render this long: say it is not installed
const CLUSTER_AFTER_MS = 4000;          // the theme starts by then even if the page setup has not finished
const HIDE_SETTLE_MS = 300;            // a page hidden this long (not shown again meanwhile) counts as gone

/* Where the app keeps its files: next to its installed package on the car;
 * THEMES_DATA / THEMES_ASSETS for tools/sim.js. */
const DATA_DIR = process.env.THEMES_DATA || path.join(__dirname, '..', '..', 'data');
const SETTINGS = path.join(DATA_DIR, 'settings.json');
const ASSET_DIRS = process.env.THEMES_ASSETS ? [process.env.THEMES_ASSETS]
    : [path.join(__dirname, '..', 'assets'), path.join(__dirname, '..', 'package', 'assets')];

function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

function readSettings() {
    try {
        const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
        return { enabled: s.enabled !== false, glow: s.glow !== false, theme: typeof s.theme === 'string' ? s.theme : 'christmas' };
    } catch (e) {
        return { enabled: true, glow: true, theme: 'christmas' };
    }
}

function writeSettings(s) {
    try {
        fs.mkdirSync(DATA_DIR);
    } catch (e) { /* there already */ }
    try {
        fs.writeFileSync(SETTINGS, JSON.stringify(s));
    } catch (e) {
        logger.warn(`settings not saved: ${e.message}`);
    }
}

class Themes extends OnlineApp {
    constructor() {
        super();
        this._main = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._stopping = null;
        this._settings = readSettings();
        this._theme = null;
        this._car = null;
        this._error = '';
        this._renderer = 'connecting';
        this._target = '';
        this._started = Date.now();
        this._statusText = '';
        this._themes = [];
        this._visible = false;
        this._hideTimer = null;

        /* MainApp stops an app that does not report itself active once its
         * status channel is up (idrive7-apps kit/runtime/mgu.js). */
        this.on('appStatusProxyReady', () => this._reportActive());
        this.on('changeVisibility', (data) => { if (data && data.visible === false) this._setVisible(false); });
        /* The page first: decoding the theme's pictures takes seconds of the
         * car's CPU (cpuLimit), and the HMI waits on an opened app meanwhile.
         * The theme starts once the page is set up, or after CLUSTER_AFTER_MS. */
        this.on('initialized', () => {
            this._loadThemeList();
            let started = false;
            const startCluster = () => { if (!started && !this._stopping) { started = true; this._startCluster(); } };
            this._setupHmi()
                .catch((err) => logger.error(`themes HMI setup failed: ${err && err.message}`))
                .then(() => setTimeout(startCluster, 0));
            setTimeout(startCluster, CLUSTER_AFTER_MS);
        });
        this.on('shutdown', (reason) => this._stop(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._open(uuid));
    }

    /* ---- the cluster ---- */

    /* The theme list (small): the page's buttons need it before the theme starts. */
    _loadThemeList() {
        try {
            this._assets = findAssets(ASSET_DIRS);
            this._themes = JSON.parse(fs.readFileSync(path.join(this._assets, 'themes.json'), 'utf8')).themes || [];
        } catch (e) {
            this._error = e.message;
            logger.error(`no themes: ${e.message}`);
        }
        if (this._themes.length && !this._themes.some((t) => t.id === this._settings.theme)) this._settings.theme = this._themes[0].id;
    }

    _startCluster() {
        logger.info(`${APP_ID} starting, theme ${this._settings.theme} ${this._settings.enabled ? 'on' : 'off'}`);
        this._startTheme();
        this._car = new Car(someipBuilders, logger);
        this._car.start();
        this._gate = setInterval(() => this._applyGate(), GATE_MS);
    }

    /* Puts the picked theme's layers on cluster-render (hidden until the show rule says so). */
    _startTheme() {
        if (!this._assets) return;
        this._error = '';
        try {
            const theme = new ClusterTheme(ClusterRender, {
                app: APP_ID, assets: this._assets, theme: this._settings.theme, logger, socket: process.env.CLUSTER_RENDER_SOCKET
            });
            theme.load();
            theme.levelsOn(this._settings.glow);
            theme.on('renderer', (s) => { if (theme === this._theme) { this._renderer = s; this._render(); } });
            theme.on('target', (state) => { if (theme === this._theme) { this._target = state; this._render(); } });
            this._theme = theme;
            theme.start();
        } catch (e) {
            this._error = e.message;
            this._theme = null;
            logger.error(`theme ${this._settings.theme} not started: ${e.message}`);
        }
    }

    /* Another theme: the old one's layers go, the new one's come (shown by the next gate). */
    _pickTheme(id) {
        if (id === this._settings.theme && this._theme) return;
        this._settings.theme = id;
        writeSettings(this._settings);
        logger.info(`theme ${id} picked`);
        if (this._theme) this._theme.stop();
        this._theme = null;
        this._renderer = 'connecting';
        this._target = '';
        this._startTheme();
        this._applyGate();
        this._render(true);
    }

    /* The one place that decides whether the theme is on the cluster. */
    _shouldShow() {
        return !!(this._theme && this._settings.enabled && this._car && this._car.fresh('speedKmh'));
    }

    _applyGate() {
        if (!this._theme) return;
        const car = this._car, d = car.data();
        // a value not fresh is not drawn as if it were: no rpm needle, no text
        this._theme.update({
            speedKmh: d.speedKmh,
            rpm: car.fresh('rpm') ? d.rpm : undefined,
            gear: car.fresh('gear') ? d.gear : undefined,
            stage: car.fresh('stage') ? d.stage : undefined
        });
        this._theme.show(this._shouldShow());
        this._render();
    }

    _status() {
        if (this._error) return `Theme could not load: ${this._error}`;
        if (!this._settings.enabled) return 'Off: BMW gauges on the cluster';
        if (this._renderer !== 'ready') {
            return Date.now() - this._started > RENDERER_MISSING_MS && this._renderer === 'connecting'
                ? 'Waiting for Cluster renderer (install it from the Store: robertnisipeanu/idrive-apps)'
                : 'Connecting to the cluster renderer';
        }
        if (!this._car.fresh('speedKmh')) return 'Hidden: no speed from the car yet';
        if (this._target === 'shown') return 'On the cluster';
        if (this._target === 'parked' || this._target === 'locked') return `Waiting: the cluster is busy (${this._target})`;
        return 'Starting on the cluster';
    }

    /* ---- the page ---- */

    _setupHmi() {
        if (!this.rhmiApplication) {
            return this.initialized();     // started in the background: no page this time
        }
        const rhmi = this.rhmiApplication;
        this._main = rhmi.getByName(MAIN);
        if (!this._main) return Promise.reject(new Error(`uiDescription has no ${MAIN}`));
        Object.keys(C).forEach((key) => {
            const name = C[key];
            this._components[name] = rhmi.getByName(name);
            if (!this._components[name]) logger.warn(`${name} not found in uiDescription`);
        });
        this._bind(C.toggle, () => {
            this._settings.enabled = !this._settings.enabled;
            writeSettings(this._settings);
            logger.info(`theme turned ${this._settings.enabled ? 'on' : 'off'}`);
            this._applyGate();
            this._render(true);
        });
        this._bind(C.glow, () => {
            this._settings.glow = !this._settings.glow;
            writeSettings(this._settings);
            logger.info(`glow turned ${this._settings.glow ? 'on' : 'off'}`);
            if (this._theme) this._theme.levelsOn(this._settings.glow);
            this._render(true);
        });
        this._themes.forEach((t) => {
            const name = `themesPick_${t.id}`;
            this._components[name] = rhmi.getByName(name);
            if (!this._components[name]) logger.warn(`${name} not found in uiDescription`);
            this._bind(name, () => this._pickTheme(t.id));
        });
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) this._press(entry.name, entry.handler);
        });
        rhmi.on('restoreHmi', () => this._render(true));
        rhmi.on('applicationStackChanged', (stack) => {
            if (!stack || typeof stack !== 'object' || !Object.keys(stack).length) return;
            this._setVisible(Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP'));
        });
        this._main.on('visible', (ev) => {
            clearTimeout(this._hideTimer);
            if (isTrue(ev && ev.visible)) this._setVisible(true);
            else this._hideTimer = setTimeout(() => this._setVisible(false), HIDE_SETTLE_MS);
        });

        const foreground = this._startedForeground();
        return this._registerEntryPoint()
            .then(() => {
                if (foreground) this.registerActive();
                return this.initialized();
            })
            .then(() => {
                if (this._visible) this._reportVisible();
                this._render(true);
                const last = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return last ? this._open(last) : undefined;
            });
    }

    _startedForeground() {
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.indexOf(reason) >= 0;
    }

    _registerEntryPoint() {
        const described = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find((ep) => described.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) return Promise.reject(new Error('no entry point handed over by the manager'));
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._main))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${description.name} ENABLED`));
    }

    _reportActive() {
        Promise.resolve()
            .then(() => this.registerActive())
            .then(() => logger.info('registered active'))
            .catch((err) => logger.warn(`registerActive failed: ${err && err.message}`));
    }

    /* The page shown or gone, reported to MainApp as the Store app does: the
     * HMI's "Loading app" waits for an opened app to report itself visible. */
    _setVisible(visible) {
        if (this._stopping || this._visible === visible) return;
        this._visible = visible;
        clearTimeout(this._hideTimer);
        logger.info(`page ${visible ? 'visible' : 'hidden'}`);
        if (visible) this._render(true);
        this._reportVisible();
    }

    _reportVisible() {
        if (!this._initialized || !this._appStatusService) return;   // reported once initialized
        let reports;
        try {
            reports = this._visible ? [this.registerActive(), this.registerHmiVisible()] : [this.unregisterHmiVisible()];
        } catch (err) {
            reports = [Promise.reject(err)];
        }
        reports.forEach((r) => Promise.resolve(r).catch((err) => logger.warn(`app status report failed: ${err && err.message}`)));
    }

    _open(uuid) {
        if (this._stopping || !this.rhmiApplication || !uuid) return Promise.resolve();
        this._setVisible(true);
        this._render(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    _bind(name, handler) {
        const comp = this._components[name];
        if (!comp) return;
        try {
            this._actionById[Number(comp.getId())] = { name, handler };
        } catch (e) { /* no id: the component's own events only */ }
        comp.on('action', () => this._press(name, handler));
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) return;
        this._lastPress[name] = now;
        logger.info(`pressed ${name}`);
        try {
            handler();
        } catch (err) {
            logger.warn(`${name} failed: ${err && err.message}`);
        }
    }

    /* Writes the page; only what changed unless forced (the HMI restarted, the page opened). */
    _render(force) {
        if (!this._main) return;
        const status = this._status();
        if (!force && status === this._statusText) return;
        this._statusText = status;
        this._write(C.status, 'Text', status);
        this._write(C.toggle, BUTTON_CELL, this._settings.enabled ? 'Turn theme off' : 'Turn theme on');
        this._write(C.glow, BUTTON_CELL, this._settings.glow ? 'Turn glow off' : 'Turn glow on');
        const picked = this._themes.find((t) => t.id === this._settings.theme);
        this._write(C.theme, 'Text', `Theme: ${picked ? picked.name : this._settings.theme}`);
        this._themes.forEach((t) => this._write(`themesPick_${t.id}`, BUTTON_CELL, `${t.name}${t.id === this._settings.theme ? ' (selected)' : ''}`));
    }

    _write(name, cell, text) {
        const comp = this._components[name];
        if (!comp) return;
        Promise.resolve(comp.setValue(0, cell, text, 'Text'))
            .catch((err) => logger.warn(`write ${name}.${cell} failed: ${err && err.message}`));
    }

    _stop(reason) {
        if (this._stopping) return this._stopping;
        logger.info(`${APP_ID} shutting down (${reason})`);
        if (this._gate) clearInterval(this._gate);
        if (this._theme) this._theme.stop();
        if (this._car) this._car.stop();
        this._stopping = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._stopping;
    }
}

const app = new Themes();
app.start().then(() => app._reportActive()).catch((err) => {
    // stays resident so the app manager can stop or restart it
    logger.error(`${APP_ID} failed to start: ${err && err.message}`);
});
