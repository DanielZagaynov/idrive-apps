'use strict';
/**
 * airplayd.js - AirPlay screen-mirroring receiver for the head unit (Node 8, root).
 *
 *  - advertises "<name>" on the car's Wi-Fi hotspot (wlan_bridge) by mDNS
 *  - handles the AirPlay control channel, pairing and FairPlay (lib/)
 *  - pipes the decrypted H.264 to bin/airplay-video, which writes frames to
 *    /dev/shm/mgu-video-daniel-airplay for mgu-render
 *  - opens its ports in the unit's nftables input chain (wlan_bridge only)
 *  - talks to the daniel_airplay app over /run/daniel-airplay/ctl.sock (JSON lines)
 *
 * Every path can be overridden by environment (tests on a PC).
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const execFile = require('child_process').execFile;
const AirPlayReceiver = require('./lib/receiver').AirPlayReceiver;
const VideoSink = require('./lib/video-sink').VideoSink;
const Identity = require('./lib/pairing').Identity;

const TAG = 'daniel-airplay';
const DATA_DIR = process.env.DANIEL_AIRPLAY_DATA || '/var/opt/daniel-airplay/data';
const RUN_DIR = process.env.DANIEL_AIRPLAY_RUN || '/run/daniel-airplay';
const CTL = process.env.DANIEL_AIRPLAY_CTL || path.join(RUN_DIR, 'ctl.sock');
const VIDEO_FILE = process.env.DANIEL_AIRPLAY_VIDEO_FILE || '/dev/shm/mgu-video-daniel-airplay';
const FIREWALL = process.env.DANIEL_AIRPLAY_FIREWALL !== '0';
const HOTSPOT_IF = 'wlan_bridge';

const DEFAULTS = {
  name: 'BMW',
  port: 7100,
  ports: { event: 7101, data: 7102, timing: 7103, audioData: 7104, audioControl: 7105 },
  interfaces: [HOTSPOT_IF, '172.16.222.'],
  width: 1280,
  height: 720,
};

function log(msg) { console.log(new Date().toISOString() + ' ' + msg); }

// ---------- config ----------

function loadConfig() {
  const file = path.join(DATA_DIR, 'config.json');
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { c = {}; }
  let changed = false;
  if (!/^[0-9a-f]{64}$/.test(c.identitySeed || '')) { c.identitySeed = Identity.newSeed().toString('hex'); changed = true; }
  if (!c.pi) {
    const b = crypto.randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    c.pi = [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
    changed = true;
  }
  if (!c.fallbackDeviceId) {
    const b = crypto.randomBytes(6); b[0] = (b[0] & 0xfe) | 0x02;
    c.fallbackDeviceId = Array.prototype.map.call(b, (x) => ('0' + x.toString(16)).slice(-2)).join(':').toUpperCase();
    changed = true;
  }
  if (changed) saveConfig(c);
  return Object.assign({}, DEFAULTS, c, { ports: Object.assign({}, DEFAULTS.ports, c.ports || {}) });
}

function saveConfig(c) {
  const keep = {};
  ['name', 'identitySeed', 'pi', 'fallbackDeviceId', 'port', 'ports', 'interfaces', 'width', 'height'].forEach((k) => { if (c[k] !== undefined) keep[k] = c[k]; });
  try { fs.mkdirSync(DATA_DIR); } catch (e) { if (e.code !== 'EEXIST') log('config: ' + e.message); }
  const file = path.join(DATA_DIR, 'config.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(keep, null, 2));
  fs.renameSync(file + '.tmp', file);
}

// ---------- firewall (nftables, wlan_bridge only) ----------

function nft(args) {
  return new Promise((resolve) => execFile('nft', args, { timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout))));
}

function firewallRules(c) {
  const tcp = [c.port, c.ports.event, c.ports.data].join(', ');
  const udp = [5353, c.ports.timing, c.ports.audioData, c.ports.audioControl].join(', ');
  return [
    ['iifname', HOTSPOT_IF, 'tcp', 'dport', '{ ' + tcp + ' }', 'accept', 'comment', '"' + TAG + '"'],
    ['iifname', HOTSPOT_IF, 'udp', 'dport', '{ ' + udp + ' }', 'accept', 'comment', '"' + TAG + '"'],
  ];
}

const isRoot = () => !process.getuid || process.getuid() === 0;

function removeFirewall() {
  if (!FIREWALL || !isRoot() || process.platform !== 'linux') return Promise.resolve();
  return nft(['-a', 'list', 'chain', 'ip', 'filter', 'input']).then((out) => {
    if (!out) return undefined;
    const handles = [];
    out.split('\n').forEach((l) => { const m = l.match(/comment "daniel-airplay".*# handle (\d+)/); if (m) handles.push(m[1]); });
    return handles.reduce((p, h) => p.then(() => nft(['delete', 'rule', 'ip', 'filter', 'input', 'handle', h])), Promise.resolve());
  });
}

function ensureFirewall(c) {
  if (!FIREWALL || !isRoot() || process.platform !== 'linux') return Promise.resolve();
  return nft(['-a', 'list', 'chain', 'ip', 'filter', 'input']).then((out) => {
    if (out === null) return undefined; // no nft, or no such chain: nothing to open
    const have = (out.match(/comment "daniel-airplay"/g) || []).length;
    if (have >= 2) return undefined;
    return removeFirewall().then(() => firewallRules(c).reduce((p, rule) => p.then(() =>
      nft(['insert', 'rule', 'ip', 'filter', 'input'].concat(rule)).then((r) =>
        log('firewall: ' + (r === null ? 'insert failed for ' : 'opened ') + rule[2] + ' ' + rule[4] + ' on ' + HOTSPOT_IF))), Promise.resolve()));
  });
}

// ---------- state + control socket ----------

const state = { state: 'starting', name: '', device: null, width: 0, height: 0, video: VIDEO_FILE, addresses: [], port: 0, error: null, updated: null };
const clients = new Set();
const statusLine = () => JSON.stringify(Object.assign({ type: 'status' }, state)) + '\n';

function publish() {
  state.updated = new Date().toISOString();
  const line = statusLine();
  clients.forEach((c) => { try { c.write(line); } catch (e) { /* gone */ } });
  try {
    fs.writeFileSync(path.join(RUN_DIR, 'status.json.tmp'), JSON.stringify(state));
    fs.renameSync(path.join(RUN_DIR, 'status.json.tmp'), path.join(RUN_DIR, 'status.json'));
  } catch (e) { /* no run dir */ }
}

function set(patch) { Object.assign(state, patch); publish(); }

let cfg = null;
let receiver = null;
const sink = new VideoSink({ file: VIDEO_FILE, log: log });

function startReceiver() {
  receiver = new AirPlayReceiver({
    name: cfg.name, identitySeed: Buffer.from(cfg.identitySeed, 'hex'), pi: cfg.pi, fallbackDeviceId: cfg.fallbackDeviceId,
    port: cfg.port, ports: cfg.ports, interfaces: cfg.interfaces, width: cfg.width, height: cfg.height,
  });
  receiver.on('log', log);
  receiver.on('session-start', (s) => { log('session: "' + s.deviceName + '" from ' + s.address); set({ state: 'connecting', device: s.deviceName }); });
  receiver.on('video-config', (c) => { sink.config(c); set({ state: 'streaming', width: c.width, height: c.height }); });
  receiver.on('video-frame', (f) => sink.frame(f));
  receiver.on('session-end', () => { log('session: ended'); sink.blank(); set({ state: 'ready', device: null, width: 0, height: 0 }); });
  return receiver.start().then((r) => {
    set({ state: 'ready', name: cfg.name, addresses: r.addresses, port: r.port, error: null });
    log('ready: "' + cfg.name + '" on port ' + r.port + ' (' + (r.addresses.join(', ') || 'hotspot not up yet') + ')');
  }).catch((err) => {
    log('receiver failed: ' + err.stack);
    set({ state: 'error', name: cfg.name, error: err.code === 'EADDRINUSE' ? 'Port in use: ' + err.message : err.message });
  });
}

function stopReceiver() {
  const r = receiver;
  receiver = null;
  return r ? r.stop() : Promise.resolve();
}

function handleCommand(sock, msg) {
  if (msg.cmd === 'status') sock.write(statusLine());
  else if (msg.cmd === 'stop') { if (receiver) receiver.disconnect(); }
  else if (msg.cmd === 'rename') {
    const name = String(msg.name || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 40);
    if (!name || name === cfg.name) return;
    cfg.name = name;
    saveConfig(cfg);
    log('renamed to "' + name + '"');
    stopReceiver().then(startReceiver);
  }
}

function startControl() {
  try { fs.unlinkSync(CTL); } catch (e) { /* none */ }
  const server = net.createServer((sock) => {
    clients.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > 65536) { sock.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch (e) { msg = null; }
        if (msg) handleCommand(sock, msg);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => clients.delete(sock));
    sock.write(statusLine());
  });
  server.listen(CTL, () => {
    // The app runs as its own uid: let it connect.
    if (CTL.indexOf('\\\\.\\pipe\\') !== 0) { try { fs.chmodSync(CTL, 0o666); } catch (e) { log('ctl: chmod ' + e.message); } }
    log('control socket ' + CTL);
  });
  return server;
}

// ---------- main ----------

function main() {
  try { fs.mkdirSync(RUN_DIR); } catch (e) { /* exists */ }
  cfg = loadConfig();
  state.name = cfg.name;
  const ctl = startControl();
  ensureFirewall(cfg).then(startReceiver);
  const fwTimer = setInterval(() => ensureFirewall(cfg), 30000); // a ruleset reload drops our rules

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log('stopping');
    clearInterval(fwTimer);
    sink.stop();
    try { ctl.close(); } catch (e) { /* ignore */ }
    stopReceiver().then(removeFirewall).then(() => process.exit(0), () => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { loadConfig: loadConfig, firewallRules: firewallRules, DEFAULTS: DEFAULTS };
