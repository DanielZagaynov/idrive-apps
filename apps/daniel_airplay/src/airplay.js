'use strict';
/**
 * AirPlay Mirror: shows the iPhone's screen (iOS Screen Mirroring to the car)
 * on the centre display, while the car is parked.
 *
 * The daniel-airplay tool (a system service) receives the phone's stream on the
 * car's Wi-Fi hotspot and decodes it into /dev/shm/mgu-video-daniel-airplay;
 * this app shows that through mgu-render on its own page, and reports the
 * receiver's state on its main page.
 *
 * Pages (tools/gen_rhmi.js):
 *   ST_Airplay_Main   status, "Show phone screen", "Stop mirroring"
 *   ST_Airplay_Embed  the picture inside the page (mgu-render embed placement)
 *   ST_Airplay_Layer  the host page when mgu-render can only draw on its layer
 *
 * Safety: the picture is drawn only while Vehicle2's speed says the car stands
 * still (speed.js: < 3 km/h, read in the last 3 s). Once it moves, the picture
 * goes and the app returns to its main page.
 *
 * Node 8; requires only the sdk names in mgu-app.json, its modules and builtins.
 */
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const ToolLink = require('./tool_link').ToolLink;
const Speed = require('./speed').Speed;
const render = require('./mgu_render_client');

const logger = logging.getSDKLogger();

const S = { main: 'ST_Airplay_Main', embed: 'ST_Airplay_Embed', layer: 'ST_Airplay_Layer' };
const C = { status: 'airplayStatus', show: 'airplayShow', stop: 'airplayStop' };
const VIDEO_ID = 1;
const DEFAULT_VIDEO = '/dev/shm/mgu-video-daniel-airplay';
const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
const PRESS_DEDUPE_MS = 400;
const GATE_MS = 500;

function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

/** What the main page says, from the tool's status and the gate. */
function statusText(st, parked, renderer) {
    const name = st.name || 'BMW';
    switch (st.state) {
        case 'missing':
            return 'The AirPlay receiver is not running.\nInstall "AirPlay receiver" in the Store, then restart the head unit.';
        case 'starting':
            return 'Starting the receiver…';
        case 'error':
            return 'Receiver problem: ' + (st.error || 'unknown') + '\nSee: journalctl -u daniel-airplay';
        case 'connecting':
            return (st.device || 'iPhone') + ' is connecting…';
        case 'streaming':
            if (!parked) return 'Paused while driving.\n' + (st.device || 'iPhone') + ' stays connected; the screen shows again when you stop.';
            if (!renderer) return 'Mirroring ' + (st.device || 'iPhone') + ', but mgu-render (the renderer) is not available.';
            return 'Mirroring ' + (st.device || 'iPhone') + ' (' + st.width + '×' + st.height + ').\nPress "Show phone screen".';
        default: { // ready
            const where = st.addresses && st.addresses.length ? '' : '\n(The car\'s Wi-Fi hotspot is not up yet.)';
            return 'Ready. On your iPhone (on the car\'s Wi-Fi): Control Centre → Screen Mirroring → "' + name + '".' + where;
        }
    }
}

class AirplayMirror extends OnlineApp {
    constructor() {
        super();
        this._main = null;
        this._states = {};
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._stopping = null;
        this._screenVisible = { embed: false, layer: false };
        this._wantScreen = false;      // the user asked for the screen page
        this._shown = false;           // the picture is drawn now
        this._box = null;
        this._rendererReady = false;
        this._lastText = null;

        this.link = new ToolLink(logger);
        this.speed = new Speed(logger);
        this.gpu = null;

        this.on('initialized', () => {
            this._setup().catch((err) => logger.error(`airplay init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._stop(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._open(uuid));
    }

    _setup() {
        logger.info(`airplay ${this.getAppId()} starting`);
        this.link.on('status', () => this._update());
        this.link.connect();
        this.speed.start();
        this._startRenderer();
        this._gate = setInterval(() => this._update(), GATE_MS);

        if (!this.rhmiApplication) return this.initialized();
        const rhmi = this.rhmiApplication;
        this._main = rhmi.getByName(S.main);
        if (!this._main) return Promise.reject(new Error(`uiDescription has no ${S.main}`));
        Object.keys(S).forEach((k) => { this._states[k] = rhmi.getByName(S[k]); });
        Object.keys(C).forEach((k) => {
            this._components[C[k]] = rhmi.getByName(C[k]);
            if (!this._components[C[k]]) logger.warn(`${C[k]} not found in uiDescription`);
        });

        this._bind(C.show, () => this._showScreen());
        this._bind(C.stop, () => { this.link.send({ cmd: 'stop' }); });
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) this._press(entry.name, entry.handler);
        });
        rhmi.on('restoreHmi', () => { this._lastText = null; this._render(); });
        this._main.on('visible', (ev) => { if (isTrue(ev && ev.visible)) { this._lastText = null; this._render(); } });
        ['embed', 'layer'].forEach((k) => {
            const st = this._states[k];
            if (!st) return;
            st.on('visible', (ev) => {
                this._screenVisible[k] = isTrue(ev && ev.visible);
                if (!this._screenVisible.embed && !this._screenVisible.layer) this._wantScreen = false;
                this._update();
            });
        });

        const foreground = this._startedForeground();
        return this._registerEntryPoint()
            .then(() => { if (foreground) this.registerActive(); return this.initialized(); })
            .then(() => {
                this._render();
                const last = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return last ? this._open(last) : undefined;
            });
    }

    /* ---- mgu-render ---- */

    _startRenderer() {
        const gpu = new render.RenderClient('daniel_airplay', logger, { mode: 'embed' });
        this.gpu = gpu;
        gpu.on('ready', (screen, info) => {
            if (!info || !info.video) {
                logger.warn('mgu-render: this renderer cannot show video (install or update mgu-render)');
                this._rendererReady = false;
                this._update();
                return;
            }
            if (info.modes.indexOf('embed') < 0) gpu.mode('layer');
            const box = gpu.mode() === 'embed' ? info.embedBox : info.appArea;
            this._box = box;
            gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, ox: 0, oy: 0 });
            gpu.fps(30);
            gpu.video(VIDEO_ID, this.link.status.video || DEFAULT_VIDEO);
            this._rendererReady = true;
            logger.info(`mgu-render: ${gpu.mode()} ${box.w}x${box.h} at ${box.x},${box.y}`);
            this._update();
            this._frame();
        });
        gpu.on('tick', () => this._frame());
        gpu.on('closed', () => { this._shown = false; });
        gpu.connect();
    }

    /** One frame: the newest video picture fitted into the box, or nothing. */
    _frame() {
        if (!this.gpu || !this._rendererReady || !this._box) return;
        const ops = this._shown ? render.videoOp(VIDEO_ID, 0, 0, this._box.w, this._box.h, 0) : new Uint32Array(0);
        this.gpu.frameWords(ops);
    }

    /* ---- the gate: what is shown, re-evaluated on every change and twice a second ---- */

    _update() {
        const st = this.link.status;
        const parked = this.speed.parked();
        const onScreenPage = this._screenVisible.embed || this._screenVisible.layer;
        const show = !!(onScreenPage && parked && st.state === 'streaming' && this._rendererReady);

        if (onScreenPage && !parked) {
            // Moving: leave the picture's page at once.
            logger.info(`car moving (${this.speed.kmh()} km/h): picture hidden`);
            this._closeScreen();
        }
        if (show !== this._shown) {
            this._shown = show;
            if (this.gpu) this.gpu.show(show);
            this._frame();
        }
        this._render();
    }

    _showScreen() {
        if (!this.speed.parked()) {
            this._render();
            return;
        }
        this._wantScreen = true;
        const page = this.gpu && this.gpu.mode() === 'layer' ? S.layer : S.embed;
        Promise.resolve(this.rhmiApplication.openState(page))
            .catch((err) => logger.warn(`openState ${page} failed: ${err && err.message}`));
    }

    _closeScreen() {
        this._wantScreen = false;
        this._screenVisible.embed = false;
        this._screenVisible.layer = false;
        [S.embed, S.layer].forEach((name) => {
            Promise.resolve(this.rhmiApplication && this.rhmiApplication.closeState(name)).catch(() => {});
        });
    }

    /* ---- the main page ---- */

    _render() {
        const text = statusText(this.link.status, this.speed.parked(), this._rendererReady);
        if (text === this._lastText) return;
        this._lastText = text;
        this._write(C.status, text);
    }

    _write(name, text) {
        const comp = this._components[name];
        if (!comp) return;
        Promise.resolve(comp.setValue(0, 'Text', text, 'Text'))
            .catch((err) => logger.warn(`write ${name} failed: ${err && err.message}`));
    }

    /* ---- plumbing, as in the Hello app ---- */

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

    _open(uuid) {
        if (this._stopping || !this.rhmiApplication || !uuid) return Promise.resolve();
        this._lastText = null;
        this._render();
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    _bind(name, handler) {
        const comp = this._components[name];
        if (!comp) return;
        try { this._actionById[Number(comp.getId())] = { name, handler }; } catch (e) { /* no id */ }
        comp.on('action', () => this._press(name, handler));
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) return;
        this._lastPress[name] = now;
        logger.info(`pressed ${name}`);
        try { handler(); } catch (err) { logger.warn(`${name} failed: ${err && err.message}`); }
    }

    _stop(reason) {
        if (this._stopping) return this._stopping;
        logger.info(`airplay shutting down (${reason})`);
        clearInterval(this._gate);
        this.speed.stop();
        this.link.close();
        if (this.gpu) { this.gpu.show(false); this.gpu.close(); }
        this._stopping = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._stopping;
    }
}

const app = new AirplayMirror();
app.start().catch((err) => {
    logger.error(`airplay failed to start: ${err && err.message}`);
});

module.exports = { statusText };
