'use strict';
/**
 * Lane Hop: a lane-crossing arcade game for the centre display, playable only
 * while the car is parked.
 *
 * Pages (tools/gen_rhmi.js):
 *   ST_Lanehop_Main   status (best score, why it can't start), "Play"
 *   ST_Lanehop_Embed  the game inside the page (mgu-render embed placement)
 *   ST_Lanehop_Layer  the host page when mgu-render can only draw on its layer
 *
 * The game (src/game.js) is drawn by src/draw.js as mgu-render draw ops, at the
 * renderer's frame rate while the game page is on screen.
 *
 * Input:
 *   - iDrive controller, held from the HMI while playing where mgu-render has the
 *     controller gate (info.controller): tilt any way hops that way (up the
 *     screen is forward), the knob hops left and right, press hops forward
 *     (and starts / restarts).
 *   - Without the gate: FrontCCU over SOME/IP gives the knob and the east and
 *     south tilts (the HMI keeps north and west = BACK); the press arrives as
 *     the page's own button being pressed, so press is how to hop forward.
 *   - Touch on the game: a tap hops forward, a swipe hops that way.
 *
 * Safety: the game page opens and stays open only while Vehicle2's speed says
 * the car stands still (speed.js: < 3 km/h, read in the last 3 s). Once it
 * moves, the game pauses, the controller goes back to the HMI and the app
 * returns to its main page.
 *
 * Node 8; requires only the sdk names in mgu-app.json, its modules and builtins.
 */
const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const Speed = require('./speed').Speed;
const render = require('./mgu_render_client');
const Game = require('./game').Game;
const draw = require('./draw');

const logger = logging.getSDKLogger();

const S = { main: 'ST_Lanehop_Main', embed: 'ST_Lanehop_Embed', layer: 'ST_Lanehop_Layer' };
const C = { status: 'lanehopStatus', play: 'lanehopPlay', embedFocus: 'lanehopEmbedFocus', layerFocus: 'lanehopLayerFocus' };
const IF_FRONTCCU = 'de.bmw.infotainment.controlelements.FrontCCU';
const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
const PRESS_DEDUPE_MS = 150;            // one press can arrive twice (the component's event and the raw userEvent)
const GATE_MS = 250;                    // how often the parked rule is looked at
const FPS = 30;
const KICK_MS = 300;                    // shown, but no frame this long (a lost TICK): draw one anyway
const TAP_PX = 8;                       // logical px a finger may move and still be a tap
const DIAL_MAX_STEP = 24;               // a bigger jump of the knob's counter is a stale sample

/* The best score is kept next to the installed package; LANEHOP_DATA for tools/sim.js. */
const DATA_DIR = process.env.LANEHOP_DATA || path.join(__dirname, '..', '..', 'data');
const BEST_FILE = path.join(DATA_DIR, 'best.json');

/* FrontCCU's (and X_CCU's) tilt values: by name or ordinal, short or long; centred clears it. */
/* Forward is up the screen: north hops forward, south back, east and west sideways. */
const TILT = { NORD_KURZ_GEDRUECKT: 'forward', NORD_LANG_GEDRUECKT: 'forward', OST_KURZ_GEDRUECKT: 'right', OST_LANG_GEDRUECKT: 'right',
    SUED_KURZ_GEDRUECKT: 'back', SUED_LANG_GEDRUECKT: 'back', WEST_KURZ_GEDRUECKT: 'left', WEST_LANG_GEDRUECKT: 'left',
    1: 'forward', 2: 'forward', 4: 'right', 5: 'right', 7: 'back', 8: 'back', 10: 'left', 11: 'left' };
const CENTRED = ['MITTELSTELLUNG', 0];
const PUSHED = ['DREHGEBER_KURZ_GEDRUECKT', 'DREHGEBER_LANG_GEDRUECKT', 1, 2];
const RELEASED = ['KEINE_BETAETIGUNG', 0];
const tiltOf = (v, last) => TILT[v] || (CENTRED.indexOf(v) >= 0 ? null : last);
/* Knob detents between two counter values (16-bit, wrapping); 0 for an invalid or implausible pair. */
function dialSteps(from, to) {
    if (from === 0xffff || to === 0xffff || from === undefined || to === undefined || from === null || to === null) return 0;
    const steps = ((to - from + 0x18000) % 0x10000) - 0x8000;
    return Math.abs(steps) <= DIAL_MAX_STEP ? steps : 0;
}

function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

const msNow = () => { const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6; };

/** What the main page says. */
function statusText(best, parked, renderer) {
    if (renderer === 'missing') {
        return 'Lane Hop needs mgu-render (the renderer).\nInstall or update it in the Store, then restart the head unit.';
    }
    if (!parked) return 'Lane Hop is available when parked.';
    const record = best > 0 ? 'Best: ' + best + '. ' : '';
    return record + 'Press "Play".\nPress or tap to hop forward, turn the knob to move sideways, tilt or swipe to hop any way.';
}

function readBest() {
    try {
        const v = JSON.parse(fs.readFileSync(BEST_FILE, 'utf8')).best;
        return typeof v === 'number' && v >= 0 ? Math.floor(v) : 0;
    } catch (e) {
        return 0;
    }
}

function writeBest(best) {
    try { fs.mkdirSync(DATA_DIR); } catch (e) { /* there already */ }
    try {
        fs.writeFileSync(BEST_FILE, JSON.stringify({ best }));
    } catch (e) {
        logger.warn(`best score not saved: ${e.message}`);
    }
}

class LaneHop extends OnlineApp {
    constructor() {
        super();
        this._main = null;
        this._states = {};
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._stopping = null;
        this._pageVisible = { embed: false, layer: false };
        this._shown = false;             // the game is on screen and running
        this._covered = false;           // something of the HMI's is over the game page
        this._renderer = 'waiting';      // waiting | ready | missing
        this._controller = false;        // mgu-render can hold the iDrive controller for us
        this._lastText = null;
        this._lastFrame = 0;
        this._lastStep = 0;
        this._touch = null;
        this._ccu = null;                // the last X_CCU event
        this._fccu = null;               // the last FrontCCU sample
        this._width = 0;                 // the box width in logical px

        this.game = new Game();
        this.game.best = readBest();
        this._savedBest = this.game.best;
        this.ops = new draw.Ops();
        this.speed = new Speed(logger);
        this.gpu = null;

        this.on('initialized', () => {
            this._setup().catch((err) => logger.error(`lanehop init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._stop(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._open(uuid));
    }

    _setup() {
        logger.info(`lanehop ${this.getAppId()} starting, best ${this.game.best}`);
        this.speed.start();
        this._startRenderer();
        this._setupFrontCcu();
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

        this._bind(C.play, () => this._openGame());
        // the game page's own button: the HMI presses it when the controller is the HMI's
        this._bind(C.embedFocus, () => this._hmiPress());
        this._bind(C.layerFocus, () => this._hmiPress());
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
                this._pageVisible[k] = isTrue(ev && ev.visible);
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
        const gpu = new render.RenderClient('daniel_lanehop', logger, { mode: 'embed' });
        this.gpu = gpu;
        gpu.on('ready', (screen, info) => {
            if (!info || !info.modes.length) {
                logger.warn('mgu-render: no mgu-render/1 renderer with a mode for this app (install or update mgu-render)');
                this._renderer = 'missing';
                this._update();
                return;
            }
            if (info.modes.indexOf('embed') < 0) gpu.mode('layer');
            const box = gpu.mode() === 'embed' ? info.embedBox : info.appArea;
            const scale = box.h / draw.FIELD_H;
            this._width = box.w / scale;
            gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale, ox: 0, oy: 0 });
            gpu.fps(FPS);
            this._controller = !!info.controller;
            this._renderer = 'ready';
            logger.info(`mgu-render: ${gpu.mode()} ${box.w}x${box.h} at ${box.x},${box.y}, scale ${scale.toFixed(3)}, ` +
                `controller ${this._controller ? 'gate' : 'FrontCCU'}`);
            this._shown = false;         // re-applied below for the new connection
            this._update();
        });
        gpu.on('tick', () => this._frame());
        gpu.on('touch', (phase, x, y) => this._onTouch(phase, x, y));
        gpu.on('ccu', (e) => this._onCcu(e));
        gpu.on('state', (st) => {
            const covered = !st.onScreen || !st.front;
            if (covered !== this._covered) {
                this._covered = covered;
                this._update();
            }
        });
        gpu.on('closed', () => {
            // a layer app is closed when the HMI is touched outside it: leave the game page
            this._closeGame();
        });
        gpu.on('close', () => {
            this._renderer = 'waiting';
            this._shown = false;
        });
        gpu.connect();
        this._kick = setInterval(() => {
            if (this._shown && msNow() - this._lastFrame > KICK_MS) this._frame();
        }, KICK_MS);
    }

    /** One step of the game and one frame, while shown. */
    _frame() {
        if (!this._shown || !this.gpu) return;
        const now = msNow();
        const dt = this._lastStep ? (now - this._lastStep) / 1000 : 0;
        this._lastStep = now;
        const lost = this.game.update(dt);
        if (lost) {
            logger.info(`game over (${lost}) at ${this.game.score}, best ${this.game.best}`);
            if (this.game.best > this._savedBest) {
                this._savedBest = this.game.best;
                writeBest(this.game.best);
            }
        }
        draw.frame(this.ops, this.game, this._width);
        this._lastFrame = now;
        this.gpu.frameWords(this.ops.words());
    }

    /* ---- the gate: what is shown, re-evaluated on every change and four times a second ---- */

    _update() {
        const parked = this.speed.parked();
        const onPage = this._pageVisible.embed || this._pageVisible.layer;
        if (onPage && !parked) {
            logger.info(`car moving (${this.speed.kmh()} km/h): game closed`);
            this._closeGame();
        }
        const show = !!(onPage && parked && this._renderer === 'ready');
        if (show !== this._shown) {
            this._shown = show;
            if (this.gpu) {
                this.gpu.claim(show ? [{ x: 0, y: 0, w: this._width, h: draw.FIELD_H }] : []);
                this.gpu.grab(show && this._controller);
                this.gpu.show(show);
            }
            this._touch = null;
            this._ccu = null;
            this._lastStep = 0;
            if (show) this._frame();
        }
        this.game.pause(!show || this._covered);
        this._render();
    }

    _openGame() {
        if (!this.speed.parked() || this._renderer !== 'ready') {
            this._lastText = null;
            this._render();
            return;
        }
        const page = this.gpu && this.gpu.mode() === 'layer' ? S.layer : S.embed;
        Promise.resolve(this.rhmiApplication.openState(page))
            .catch((err) => logger.warn(`openState ${page} failed: ${err && err.message}`));
    }

    _closeGame() {
        [S.embed, S.layer].forEach((name) => {
            Promise.resolve(this.rhmiApplication && this.rhmiApplication.closeState(name)).catch(() => {});
        });
        this._pageVisible.embed = false;
        this._pageVisible.layer = false;
    }

    /* ---- input ---- */

    _act(dir) {
        if (!this._shown || this._covered) return;
        if (dir === 'press') this.game.press();
        else this.game.move(dir);
    }

    _onTouch(phase, x, y) {
        if (phase === 'down') {
            this._touch = { x, y };
        } else if (phase === 'up' && this._touch) {
            const dx = x - this._touch.x, dy = y - this._touch.y;
            this._touch = null;
            if (Math.abs(dx) < TAP_PX && Math.abs(dy) < TAP_PX) this._act('press');
            else if (Math.abs(dx) > Math.abs(dy)) this._act(dx > 0 ? 'right' : 'left');
            else this._act(dy < 0 ? 'forward' : 'back');
        } else if (phase === 'cancel') {
            this._touch = null;
        }
    }

    /* X_CCU: the controller while mgu-render holds it for us. */
    _onCcu(e) {
        const last = this._ccu;
        const tilt = tiltOf(e.tilt, last ? last.dir : null);
        this._ccu = { knob: e.knob, press: e.press, seq: e.seq, dir: tilt };
        if (!last) {
            // the first event since the grab: no knob to compare yet, but a press or tilt in it counts
            if (e.press) this._act('press');
            else if (tilt) this._act(tilt);
            return;
        }
        const steps = dialSteps(last.knob, e.knob);
        if (steps) this._act(steps > 0 ? 'right' : 'left');
        if (e.press && e.press !== last.press && e.seq !== last.seq) this._act('press');
        if (tilt && tilt !== last.dir) this._act(tilt);
    }

    /* FrontCCU over SOME/IP: the knob and two tilts while the HMI keeps the controller. */
    _setupFrontCcu() {
        let proxy;
        someipBuilders.buildTypedProxy(IF_FRONTCCU, '1')
            .then((p) => { proxy = p; return proxy.init(); })
            .then(() => proxy.waitUntilAvailable())
            .then(() => proxy.statusRotaryEncoderState.subscribe((s) => this._onFrontCcu(s)))
            .then(() => logger.info('FrontCCU subscribed'))
            .catch((err) => logger.warn(`FrontCCU unavailable: ${err && err.message}`));
    }

    _onFrontCcu(s) {
        const last = this._fccu;
        const op = s && s.frontRotaryEncoderOperation;
        const push = s && s.frontRotaryEncoderPushButton;
        const tilt = tiltOf(s && s.frontRotaryEncoderDeflection, last ? last.tilt : null);
        this._fccu = {
            knob: typeof op === 'number' && op !== 0xffff ? op : (last ? last.knob : 0xffff),
            press: PUSHED.indexOf(push) >= 0 ? true : RELEASED.indexOf(push) >= 0 ? false : !!(last && last.press),
            tilt
        };
        if (!last || (this._controller && this.gpu && this.gpu.grabbing)) return;    // X_CCU has it
        const steps = dialSteps(last.knob, this._fccu.knob);
        if (steps) this._act(steps > 0 ? 'right' : 'left');
        // the HMI takes north (its menu) and west (BACK) itself: east hops right, south hops back
        if ((tilt === 'right' || tilt === 'back') && tilt !== last.tilt) this._act(tilt);
    }

    /* The page's button pressed by the HMI: only counts while the controller is the HMI's. */
    _hmiPress() {
        if (this._controller && this.gpu && this.gpu.grabbing) return;
        this._act('press');
    }

    /* ---- the main page ---- */

    _render() {
        const text = statusText(this.game.best, this.speed.parked(), this._renderer);
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

    /* ---- plumbing, as in the Hello and AirPlay apps ---- */

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
        try { handler(); } catch (err) { logger.warn(`${name} failed: ${err && err.message}`); }
    }

    _stop(reason) {
        if (this._stopping) return this._stopping;
        logger.info(`lanehop shutting down (${reason})`);
        clearInterval(this._gate);
        clearInterval(this._kick);
        this.speed.stop();
        if (this.game.best > this._savedBest) writeBest(this.game.best);
        if (this.gpu) { this.gpu.grab(false); this.gpu.claim([]); this.gpu.show(false); this.gpu.close(); }
        this._stopping = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._stopping;
    }
}

const app = new LaneHop();
app.start().catch((err) => {
    logger.error(`lanehop failed to start: ${err && err.message}`);
});

module.exports = { statusText, dialSteps, app };
