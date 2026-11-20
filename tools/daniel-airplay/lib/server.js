'use strict';
// AirPlay control server (RTSP over TCP) for the head unit, Node 8.
const net = require('net');
const dgram = require('dgram');
const EventEmitter = require('events');
const bplist = require('./bplist');
const PairingSession = require('./pairing').PairingSession;
const FairPlay = require('./fairplay').FairPlay;
const mirror = require('./mirror');

const SERVER_HEADER = 'AirTunes/220.68';
const MAX_BODY = 1024 * 1024;

function parseRequests(buffer) {
  const requests = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const head = rest.toString('utf8', 0, headerEnd).split('\r\n');
    const first = head[0].split(' ');
    const headers = {};
    head.slice(1).forEach((line) => {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    const len = parseInt(headers['content-length'] || '0', 10);
    if (len > MAX_BODY) throw new Error('request body too large');
    if (rest.length < headerEnd + 4 + len) break;
    const body = Buffer.from(rest.slice(headerEnd + 4, headerEnd + 4 + len));
    rest = rest.slice(headerEnd + 4 + len);
    requests.push({ method: first[0], uri: first[1] || '/', protocol: first[2] || 'RTSP/1.0', headers: headers, body: body });
  }
  return { requests: requests, rest: rest };
}

function listenTcp(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}
function bindUdp(sock, port) {
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, () => { sock.removeListener('error', reject); resolve(sock.address().port); });
  });
}

/** One NTP-style timing request, as AirPlay receivers send every 3 s. */
function timingRequest() {
  const req = Buffer.alloc(32);
  req[0] = 0x80; req[1] = 0xd2; req[3] = 0x07;
  const now = Date.now() / 1000 + 2208988800;
  req.writeUInt32BE(Math.floor(now) >>> 0, 24);
  req.writeUInt32BE(Math.floor((now % 1) * 4294967296) >>> 0, 28);
  return req;
}

/**
 * Every port is fixed (the head unit's firewall opens them one by one); 0 = any (tests).
 * Events: 'session-start' {deviceName, model, address}, 'video-config', 'video-frame',
 * 'session-end', 'log'.
 * opts: { identity, name, deviceId, txtAirPlay, pi, port, ports: {event, data, timing, audioData, audioControl}, width, height }
 */
class AirPlayServer extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.port = opts.port;
    this.ports = Object.assign({ event: 0, data: 0, timing: 0, audioData: 0, audioControl: 0 }, opts.ports || {});
    this.connections = new Set();
    this.active = null;
    this.server = net.createServer((sock) => this._onConnection(sock));
    // Video: the phone connects here after SETUP; the active session takes it.
    this.dataServer = net.createServer((sock) => {
      sock.on('error', () => {});
      if (this.active && this.active.mirror) this.active.mirror.attach(sock);
      else { this.log('mirror: video connection with no session, closing'); sock.destroy(); }
    });
    this.eventServer = net.createServer((s) => { s.on('error', () => {}); s.resume(); });
    this.timing = dgram.createSocket('udp4');
    this.audioData = dgram.createSocket('udp4');
    this.audioControl = dgram.createSocket('udp4');
    [this.timing, this.audioData, this.audioControl].forEach((u) => { u.on('error', (e) => this.log('udp: ' + e.message)); u.on('message', () => {}); });
  }

  log(msg) { this.emit('log', msg); }

  listen() {
    return listenTcp(this.server, this.port).then((p) => { this.port = p; })
      .then(() => listenTcp(this.dataServer, this.ports.data)).then((p) => { this.ports.data = p; })
      .then(() => listenTcp(this.eventServer, this.ports.event)).then((p) => { this.ports.event = p; })
      .then(() => bindUdp(this.timing, this.ports.timing)).then((p) => { this.ports.timing = p; })
      .then(() => bindUdp(this.audioData, this.ports.audioData)).then((p) => { this.ports.audioData = p; })
      .then(() => bindUdp(this.audioControl, this.ports.audioControl)).then((p) => { this.ports.audioControl = p; })
      .then(() => this.port);
  }

  close() {
    this.connections.forEach((c) => this._teardown(c, true));
    [this.timing, this.audioData, this.audioControl].forEach((u) => { try { u.close(); } catch (e) { /* ignore */ } });
    this.dataServer.close();
    this.eventServer.close();
    return new Promise((r) => this.server.close(() => r()));
  }

  disconnect() { if (this.active) this._teardown(this.active, true); }

  _onConnection(sock) {
    const conn = {
      sock: sock,
      address: String(sock.remoteAddress).replace(/^::ffff:/, ''),
      pairing: new PairingSession(this.opts.identity),
      fairplay: new FairPlay(),
      buffer: Buffer.alloc(0),
      queue: Promise.resolve(),
      aesKey: null,
      deviceName: null,
      model: null,
      mirror: null,
      timing: null,
      audio: null,
      extras: [],
    };
    this.connections.add(conn);
    sock.setNoDelay(true);
    this.log('control: connection from ' + conn.address);
    sock.on('data', (chunk) => {
      conn.buffer = Buffer.concat([conn.buffer, chunk]);
      let parsed;
      try { parsed = parseRequests(conn.buffer); } catch (err) { this.log('control: ' + err.message); sock.destroy(); return; }
      conn.buffer = parsed.rest;
      parsed.requests.forEach((req) => {
        // Handle strictly in order, one at a time.
        conn.queue = conn.queue.then(() => this._handle(conn, req)).catch((err) => {
          this.log('control: ' + req.method + ' ' + req.uri + ' failed: ' + err.message);
          this._respond(conn, req, 500, {}, null, 'Internal Server Error');
        });
      });
    });
    sock.on('error', (err) => this.log('control: socket error: ' + err.message));
    sock.on('close', () => {
      this.log('control: ' + conn.address + ' disconnected');
      this._teardown(conn, false);
      this.connections.delete(conn);
    });
  }

  _respond(conn, req, status, headers, body, reason) {
    if (conn.sock.destroyed) return;
    const lines = [(req.protocol.indexOf('HTTP') === 0 ? req.protocol : 'RTSP/1.0') + ' ' + status + ' ' + (reason || 'OK')];
    if (req.headers.cseq) lines.push('CSeq: ' + req.headers.cseq);
    lines.push('Server: ' + SERVER_HEADER);
    Object.keys(headers || {}).forEach((k) => lines.push(k + ': ' + headers[k]));
    lines.push('Content-Length: ' + (body ? body.length : 0));
    conn.sock.write(lines.join('\r\n') + '\r\n\r\n');
    if (body && body.length) conn.sock.write(body);
  }

  _plist(conn, req, obj) { this._respond(conn, req, 200, { 'Content-Type': 'application/x-apple-binary-plist' }, bplist.build(obj)); }
  _octets(conn, req, buf) { this._respond(conn, req, 200, { 'Content-Type': 'application/octet-stream' }, buf); }

  _handle(conn, req) {
    const p = req.uri.replace(/^rtsp:\/\/[^/]+/, '').split('?')[0];
    this.log('control: ' + req.method + ' ' + req.uri);
    if (req.method === 'GET' && p === '/info') return this._plist(conn, req, this._info());
    if (req.method === 'POST' && p === '/pair-setup') return this._octets(conn, req, conn.pairing.setup(req.body));
    if (req.method === 'POST' && p === '/pair-verify') return this._octets(conn, req, conn.pairing.verify(req.body));
    if (req.method === 'POST' && p === '/fp-setup') {
      return this._octets(conn, req, req.body.length === 16 ? conn.fairplay.setup(req.body) : conn.fairplay.handshake(req.body));
    }
    if (req.method === 'OPTIONS') return this._respond(conn, req, 200, { Public: 'SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER, POST, GET' });
    if (req.method === 'SETUP') return this._setup(conn, req);
    if (req.method === 'GET_PARAMETER') {
      if (req.body.toString('utf8').indexOf('volume') >= 0) {
        return this._respond(conn, req, 200, { 'Content-Type': 'text/parameters' }, Buffer.from('volume: 0.000000\r\n'));
      }
      return this._respond(conn, req, 200);
    }
    if (req.method === 'RECORD') return this._respond(conn, req, 200, { 'Audio-Latency': '11025', 'Audio-Jack-Status': 'connected; type=analog' });
    if (req.method === 'TEARDOWN') {
      let streams = null;
      if (req.body.length) { try { streams = bplist.parse(req.body).streams; } catch (e) { streams = null; } }
      this._respond(conn, req, 200);
      const onlyAudio = Array.isArray(streams) && streams.length && streams.every((s) => s.type === 96);
      if (onlyAudio) this._closeAudio(conn);
      else this._teardown(conn, false);
      return undefined;
    }
    return this._respond(conn, req, 200); // SET_PARAMETER, FLUSH, /feedback, ...
  }

  _setup(conn, req) {
    const plist = req.body.length ? bplist.parse(req.body) : {};
    if (plist.ekey) {
      conn.aesKey = conn.fairplay.decrypt(plist.ekey);
      conn.deviceName = plist.name || 'iPhone';
      conn.model = plist.model || '';
      if (plist.timingPort) {
        const send = () => { try { this.timing.send(timingRequest(), plist.timingPort, conn.address); } catch (e) { /* closed */ } };
        send();
        const t = setInterval(send, 3000);
        conn.extras.push(() => clearInterval(t));
      }
      this.log('control: session keys ready for "' + conn.deviceName + '" (' + conn.model + ')');
      return this._plist(conn, req, { eventPort: this.ports.event, timingPort: this.ports.timing });
    }

    const replies = [];
    let chain = Promise.resolve();
    (plist.streams || []).forEach((s) => {
      chain = chain.then(() => {
        if (s.type === 110) {
          if (!conn.aesKey) throw new Error('video SETUP before key exchange');
          if (this.active && this.active !== conn) this._teardown(this.active, true); // one phone at a time
          const keys = mirror.deriveStreamKeys(conn.aesKey, conn.pairing.ecdhSecret, s.streamConnectionID);
          const m = new mirror.MirrorStream({ key: keys.key, iv: keys.iv, log: (x) => this.log(x) });
          m.on('config', (c) => this.emit('video-config', c));
          m.on('frame', (f) => this.emit('video-frame', f));
          if (conn.mirror) conn.mirror.close();
          conn.mirror = m;
          this.active = conn;
          this.emit('session-start', { deviceName: conn.deviceName, model: conn.model, address: conn.address });
          replies.push({ type: 110, dataPort: this.ports.data });
        }
        if (s.type === 96) {
          // Audio: accepted and discarded for now (video first).
          conn.audio = () => {};
          replies.push({ type: 96, dataPort: this.ports.audioData, controlPort: this.ports.audioControl });
        }
        return undefined;
      });
    });
    return chain.then(() => this._plist(conn, req, { streams: replies }));
  }

  _closeAudio(conn) { if (conn.audio) { conn.audio(); conn.audio = null; } }

  _teardown(conn, closeSocket) {
    if (conn.mirror) { conn.mirror.close(); conn.mirror = null; }
    this._closeAudio(conn);
    conn.extras.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    conn.extras = [];
    if (this.active === conn) { this.active = null; this.emit('session-end'); }
    if (closeSocket) conn.sock.destroy();
  }

  _info() {
    const o = this.opts;
    const fmt = (type) => ({ type: type, audioInputFormats: 67108860, audioOutputFormats: 67108860 });
    const lat = (type) => ({ type: type, audioType: 'default', inputLatencyMicros: 0, outputLatencyMicros: 0 });
    return {
      txtAirPlay: o.txtAirPlay,
      features: new bplist.UInt64(0x1e, 0x5a7ffff7),
      name: o.name,
      audioFormats: [fmt(100), fmt(101)],
      pi: o.pi,
      vv: 2,
      statusFlags: 68,
      keepAliveLowPower: 1,
      sourceVersion: '220.68',
      pk: o.identity.publicKey,
      keepAliveSendStatsAsBody: 1,
      deviceID: o.deviceId,
      audioLatencies: [lat(100), lat(101)],
      model: 'AppleTV3,2',
      macAddress: o.deviceId,
      displays: [{
        uuid: 'e0ff8a27-6738-3d56-8a16-cc53aacee925',
        widthPhysical: 0, heightPhysical: 0,
        width: o.width, height: o.height, widthPixels: o.width, heightPixels: o.height,
        rotation: false,
        refreshRate: new bplist.Real(1 / 60),
        maxFPS: 30,
        overscanned: false,
        features: 14,
      }],
    };
  }
}

module.exports = { AirPlayServer: AirPlayServer, parseRequests: parseRequests };
